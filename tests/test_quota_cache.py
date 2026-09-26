"""Process-local quota cache reliability tests."""
import importlib.util
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "dashboard/quota_cache.py"


def load_cache_module():
    assert MODULE_PATH.exists(), "quota_cache.py has not been implemented"
    spec = importlib.util.spec_from_file_location("provider_limits_quota_cache", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_provider_fetch_is_reused_inside_its_floor():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    calls = []

    def fetch():
        calls.append(now[0])
        return {"windows": [{"used_percent": 12}]}

    first = cache.get("openai-codex", "profile:credential", fetch)
    now[0] += 119
    second = cache.get("openai-codex", "profile:credential", fetch)

    assert first.good == second.good
    assert second.status == "cached"
    assert calls == [1000.0]


class FetchFailure(Exception):
    def __init__(self, code="network.unreachable", *, status=None, retry_after=0, hard=False):
        super().__init__(code)
        self.code = code
        self.status = status
        self.retry_after = retry_after
        self.hard = hard


def test_one_provider_failure_does_not_invalidate_another_provider():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(clock=lambda: 1000.0, randomness=lambda _a, _b: 0)
    codex = cache.get("openai-codex", "same-identity", lambda: {"quota": 42})

    claude = cache.get(
        "anthropic",
        "same-identity",
        lambda: (_ for _ in ()).throw(FetchFailure()),
    )
    codex_again = cache.get("openai-codex", "same-identity", lambda: {"quota": 99})

    assert claude.status == "unavailable"
    assert claude.good is None
    assert codex_again.good == codex.good == {"quota": 42}


def test_soft_failure_retains_good_data_before_stale_limit():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("openai-codex", "identity", lambda: {"quota": 42})
    now[0] += 120

    result = cache.get(
        "openai-codex", "identity", lambda: (_ for _ in ()).throw(FetchFailure())
    )

    assert result.status == "stale"
    assert result.good == {"quota": 42}
    assert result.age_seconds == 120
    assert result.problem_code == "network.unreachable"


def test_soft_failure_drops_data_after_stale_limit():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("openai-codex", "identity", lambda: {"quota": 42})
    now[0] += cache_module.MAX_STALE_SECONDS + 1

    result = cache.get(
        "openai-codex", "identity", lambda: (_ for _ in ()).throw(FetchFailure())
    )

    assert result.status == "unavailable"
    assert result.good is None
    assert result.fetched_at is None


def test_stale_data_expires_even_while_failure_floor_is_active():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("openai-codex", "identity", lambda: {"quota": 42})
    now[0] += 850
    assert cache.get(
        "openai-codex", "identity", lambda: (_ for _ in ()).throw(FetchFailure())
    ).status == "stale"
    now[0] += 51

    expired = cache.get(
        "openai-codex", "identity", lambda: (_ for _ in ()).throw(AssertionError("floor active"))
    )

    assert expired.status == "unavailable"
    assert expired.good is None
    assert expired.fetched_at is None


def test_hard_auth_failure_clears_good_data_immediately():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("anthropic", "identity", lambda: {"quota": 42})
    now[0] += 180

    result = cache.get(
        "anthropic",
        "identity",
        lambda: (_ for _ in ()).throw(FetchFailure("auth.rejected", status=401)),
    )

    assert result.status == "unavailable"
    assert result.good is None
    assert result.fetched_at is None
    assert result.problem_code == "auth.rejected"


def test_transient_oauth_refresh_failure_retains_bounded_stale_data():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("anthropic", "identity", lambda: {"quota": 42})
    now[0] += 180

    result = cache.get(
        "anthropic",
        "identity",
        lambda: (_ for _ in ()).throw(FetchFailure("auth.refreshFailed", hard=False)),
    )

    assert result.status == "stale"
    assert result.good == {"quota": 42}
    assert result.problem_code == "auth.refreshFailed"


def test_terminal_invalid_grant_revokes_stale_data():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    cache.get("anthropic", "identity", lambda: {"quota": 42})
    now[0] += 180

    result = cache.get(
        "anthropic",
        "identity",
        lambda: (_ for _ in ()).throw(FetchFailure("auth.invalidGrant", hard=True)),
    )

    assert result.status == "unavailable"
    assert result.good is None


def test_credential_or_profile_identity_change_cannot_reuse_old_data():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(clock=lambda: 1000.0, randomness=lambda _a, _b: 0)
    cache.get("openai-codex", "profile-a:credential-a", lambda: {"quota": 42})

    changed = cache.get(
        "openai-codex",
        "profile-b:credential-b",
        lambda: (_ for _ in ()).throw(FetchFailure()),
    )

    assert changed.status == "unavailable"
    assert changed.good is None


def test_rate_limit_retry_after_is_clamped_between_floor_and_backoff_cap():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)

    too_large = cache.get(
        "openai-codex",
        "large-retry-after",
        lambda: (_ for _ in ()).throw(
            FetchFailure("upstream.rateLimited", status=429, retry_after=9999)
        ),
    )
    too_small = cache.get(
        "openai-codex",
        "small-retry-after",
        lambda: (_ for _ in ()).throw(
            FetchFailure("upstream.rateLimited", status=429, retry_after=1)
        ),
    )

    assert too_large.next_refresh_at == 1300.0
    assert too_small.next_refresh_at == 1120.0


def test_repeated_rate_limits_use_bounded_exponential_backoff():
    cache_module = load_cache_module()
    now = [1000.0]
    cache = cache_module.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    def failure():
        raise FetchFailure("upstream.rateLimited", status=429)

    waits = []
    for _ in range(4):
        result = cache.get("openai-codex", "identity", failure)
        waits.append(result.next_refresh_at - now[0])
        now[0] = result.next_refresh_at

    assert waits == [120.0, 120.0, 240.0, 300.0]


def test_entry_and_lock_tables_are_bounded_together():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(
        clock=lambda: 1000.0, randomness=lambda _a, _b: 0, max_entries=4,
    )

    for index in range(12):
        cache.get("openai-codex", f"identity-{index}", lambda: {"quota": 42})

    assert len(cache._entries) <= 4
    assert len(cache._locks) <= 4


def test_clear_releases_preserved_lock_after_last_user_exits():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(clock=lambda: 1000.0, randomness=lambda _a, _b: 0)
    cache.get("openai-codex", "identity", lambda: {"quota": 42})
    key = ("identity", "openai-codex")
    exiting = threading.Event()
    release = threading.Event()

    class PausingExitLock:
        def __init__(self):
            self._lock = threading.Lock()

        def __enter__(self):
            self._lock.acquire()
            return self

        def __exit__(self, *_args):
            exiting.set()
            assert release.wait(timeout=2)
            self._lock.release()

        def locked(self):
            return self._lock.locked()

    cache._locks[key] = PausingExitLock()
    worker = threading.Thread(
        target=cache.get,
        args=("openai-codex", "identity", lambda: {"quota": 99}),
    )
    worker.start()
    assert exiting.wait(timeout=1)
    cache.clear()
    release.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert key not in cache._locks


def test_pending_key_lock_cannot_be_evicted_and_split():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(
        clock=lambda: 1000.0, randomness=lambda _a, _b: 0, max_entries=2,
    )
    key = ("identity", "openai-codex")
    entered = threading.Event()
    allow_acquire = threading.Event()
    first_fetch_started = threading.Event()
    second_fetch_started = threading.Event()
    release_fetch = threading.Event()

    class PausingLock:
        def __init__(self):
            self._lock = threading.Lock()
            self._first = True

        def __enter__(self):
            if self._first:
                self._first = False
                entered.set()
                assert allow_acquire.wait(timeout=2)
            self._lock.acquire()
            return self

        def __exit__(self, *_args):
            self._lock.release()

        def locked(self):
            return self._lock.locked()

    cache._locks[key] = PausingLock()
    cache._entries[key] = cache_module.CacheEntry(
        good={"quota": 0}, fetched_at=0.0, next_refresh_at=0.0, attempts=0,
        problem_code=None, identity_key="identity",
    )
    errors = []

    def fetch(started):
        started.set()
        assert release_fetch.wait(timeout=2)
        return {"quota": 42}

    def run(fetch_started):
        try:
            cache.get("openai-codex", "identity", lambda: fetch(fetch_started))
        except BaseException as exc:  # surface worker assertion failures
            errors.append(exc)

    first = threading.Thread(target=run, args=(first_fetch_started,))
    first.start()
    assert entered.wait(timeout=1)

    cache.get("openai-codex", "other-a", lambda: {"quota": 1})
    cache.get("openai-codex", "other-b", lambda: {"quota": 2})

    second = threading.Thread(target=run, args=(second_fetch_started,))
    second.start()
    assert second_fetch_started.wait(timeout=1)
    allow_acquire.set()
    split = first_fetch_started.wait(timeout=0.2)
    release_fetch.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not errors
    assert not first.is_alive() and not second.is_alive()
    assert split is False


def test_cache_rebounds_after_all_entries_were_in_use_during_eviction():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(
        clock=lambda: 1000.0, randomness=lambda _a, _b: 0, max_entries=2,
    )
    worker_count = 12
    all_entered = threading.Barrier(worker_count)
    all_stored = threading.Barrier(worker_count)

    class SynchronizedExitLock:
        def __init__(self):
            self._lock = threading.Lock()

        def __enter__(self):
            self._lock.acquire()
            all_entered.wait(timeout=2)
            return self

        def __exit__(self, *_args):
            all_stored.wait(timeout=2)
            self._lock.release()

        def locked(self):
            return self._lock.locked()

    for index in range(worker_count):
        cache._locks[(f"identity-{index}", "openai-codex")] = SynchronizedExitLock()

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [
            executor.submit(
                cache.get, "openai-codex", f"identity-{index}",
                lambda index=index: {"quota": index},
            )
            for index in range(worker_count)
        ]
        [future.result(timeout=3) for future in futures]

    assert len(cache._entries) <= 2
    assert len(cache._locks) <= 2
    assert cache._lock_users == {}


def test_concurrent_callers_for_one_identity_perform_one_fetch():
    cache_module = load_cache_module()
    cache = cache_module.QuotaCache(clock=lambda: 1000.0, randomness=lambda _a, _b: 0)
    calls = []
    fetch_started = threading.Event()

    def fetch():
        calls.append(1)
        fetch_started.set()
        time.sleep(0.05)
        return {"quota": 42}

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(cache.get, "openai-codex", "identity", fetch)
        assert fetch_started.wait(timeout=1)
        second = executor.submit(cache.get, "openai-codex", "identity", fetch)
        results = [first.result(timeout=2), second.result(timeout=2)]

    assert len(calls) == 1
    assert [result.good for result in results] == [{"quota": 42}, {"quota": 42}]
