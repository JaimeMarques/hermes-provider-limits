"""Bounded, process-local provider quota caching."""
from __future__ import annotations

import copy
from dataclasses import dataclass
import math
import random
import re
import threading
import time
from typing import Callable

POLL_FLOOR = {
    "anthropic": 180.0,
    "openai-codex": 120.0,
    "zai": 180.0,
    "deepseekv4pro": 180.0,
}
MAX_STALE_SECONDS = 900.0
BACKOFF_CAP_SECONDS = 300.0


@dataclass
class CacheEntry:
    good: dict | None
    fetched_at: float | None
    next_refresh_at: float
    attempts: int
    problem_code: str | None
    identity_key: str


@dataclass(frozen=True)
class CacheView:
    good: dict | None
    fetched_at: float | None
    next_refresh_at: float
    status: str
    age_seconds: float | None
    problem_code: str | None


class QuotaCache:
    def __init__(self, *, clock: Callable[[], float] = time.time,
                 randomness: Callable[[float, float], float] = random.uniform,
                 max_entries: int = 64):
        self._clock = clock
        self._randomness = randomness
        self._max_entries = max(2, max_entries)
        self._entries: dict[tuple[str, str], CacheEntry] = {}
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._lock_users: dict[tuple[str, str], int] = {}
        self._guard = threading.Lock()

    def clear(self) -> None:
        with self._guard:
            self._entries.clear()
            self._locks = {
                key: lock for key, lock in self._locks.items()
                if self._lock_users.get(key, 0)
            }

    def get(self, provider_id: str, identity_key: str, fetch: Callable[[], dict]) -> CacheView:
        key = (identity_key, provider_id)
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
            self._lock_users[key] = self._lock_users.get(key, 0) + 1
        try:
            with lock:
                return self._get_locked(key, provider_id, identity_key, fetch)
        finally:
            with self._guard:
                users = self._lock_users.get(key, 0) - 1
                if users > 0:
                    self._lock_users[key] = users
                else:
                    self._lock_users.pop(key, None)
                    if key not in self._entries:
                        self._locks.pop(key, None)
                    self._evict_locked()

    def _get_locked(self, key: tuple[str, str], provider_id: str, identity_key: str,
                    fetch: Callable[[], dict]) -> CacheView:
        now = self._clock()
        entry = self._entries.get(key)
        if entry is not None and now < entry.next_refresh_at:
            age = None if entry.fetched_at is None else now - entry.fetched_at
            if entry.problem_code and entry.good is not None and (
                    age is None or age < 0 or age > MAX_STALE_SECONDS):
                entry.good = None
                entry.fetched_at = None
            status = "stale" if entry.problem_code and entry.good is not None else (
                "unavailable" if entry.problem_code else "cached"
            )
            return self._view(entry, now, status)

        try:
            good = copy.deepcopy(fetch())
        except Exception as exc:
            failed_at = self._clock()
            code = getattr(exc, "code", None)
            if not isinstance(code, str) or not re.fullmatch(r"[a-z][A-Za-z0-9.-]{0,63}", code):
                code = "provider.fetchFailed"
            age = (failed_at - entry.fetched_at
                   if entry is not None and entry.fetched_at is not None else None)
            hard_codes = {
                "account.changed", "auth.forbidden", "auth.invalidGrant", "auth.oauthRequired",
                "auth.ownedOAuthRequired", "auth.ownedOAuthUnavailable", "auth.rejected",
            }
            hard = (bool(getattr(exc, "hard", False))
                    or getattr(exc, "status", None) in (401, 403)
                    or code.startswith("credentials.")
                    or code in hard_codes)
            retain = (entry is not None and entry.good is not None and age is not None
                      and 0 <= age <= MAX_STALE_SECONDS and not hard)
            retained_good = copy.deepcopy(entry.good) if entry is not None and retain else None
            retained_at = entry.fetched_at if entry is not None and retain else None
            is_rate_limit = getattr(exc, "status", None) == 429 or code == "upstream.rateLimited"
            attempts = min((entry.attempts if entry is not None else 0) + 1, 10) if is_rate_limit else 0
            wait = POLL_FLOOR.get(provider_id, 180.0)
            if is_rate_limit:
                wait = self._rate_limit_wait(provider_id, attempts, getattr(exc, "retry_after", 0))
            entry = CacheEntry(
                good=retained_good,
                fetched_at=retained_at,
                next_refresh_at=failed_at + wait,
                attempts=attempts,
                problem_code=code,
                identity_key=identity_key,
            )
            self._store(key, entry)
            return self._view(entry, failed_at, "stale" if retain else "unavailable")
        fetched_at = self._clock()
        retry_after = good.pop("_rate_limit_retry_after", None)
        attempts = 0
        wait = POLL_FLOOR.get(provider_id, 180.0)
        if retry_after is not None:
            # Optional enrichment may fail while ordinary quota remains fresh.
            attempts = min((entry.attempts if entry is not None else 0) + 1, 10)
            wait = self._rate_limit_wait(provider_id, attempts, retry_after)
        entry = CacheEntry(
            good=good,
            fetched_at=fetched_at,
            next_refresh_at=fetched_at + wait,
            attempts=attempts,
            problem_code=None,
            identity_key=identity_key,
        )
        self._store(key, entry)
        return self._view(entry, fetched_at, "fresh")

    def _rate_limit_wait(self, provider_id: str, attempts: int, raw_retry_after) -> float:
        retry_after = float(raw_retry_after) if isinstance(raw_retry_after, (int, float)) else 0.0
        if not math.isfinite(retry_after):
            retry_after = 0.0
        exponential = min(60.0 * 2 ** (attempts - 1), BACKOFF_CAP_SECONDS)
        return min(BACKOFF_CAP_SECONDS, max(
            POLL_FLOOR.get(provider_id, 180.0),
            exponential + self._randomness(0.0, 15.0),
            max(0.0, min(retry_after, BACKOFF_CAP_SECONDS)),
        ))

    def _store(self, key: tuple[str, str], entry: CacheEntry) -> None:
        with self._guard:
            self._entries[key] = entry
            self._evict_locked(protected=key)

    def _evict_locked(self, protected: tuple[str, str] | None = None) -> None:
        if len(self._entries) <= self._max_entries:
            return
        target = max(1, self._max_entries // 2)
        oldest = sorted(self._entries, key=lambda item: self._entries[item].next_refresh_at)
        for obsolete in oldest:
            if len(self._entries) <= target:
                break
            if obsolete == protected or self._lock_users.get(obsolete, 0):
                continue
            self._entries.pop(obsolete, None)
            self._locks.pop(obsolete, None)

    @staticmethod
    def _view(entry: CacheEntry, now: float, status: str) -> CacheView:
        age = None if entry.fetched_at is None else max(0.0, now - entry.fetched_at)
        return CacheView(copy.deepcopy(entry.good), entry.fetched_at, entry.next_refresh_at,
                         status, age, entry.problem_code)
