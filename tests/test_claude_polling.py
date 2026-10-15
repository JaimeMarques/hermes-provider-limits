"""Claude polling: one GET per refresh, an hourly reset
probe, cache keys that ignore pool bookkeeping, and a provider-level 429 gate.

Offline: HTTP and the owned-OAuth adapter are mocked; nothing reaches Anthropic.
"""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('limits_api_polling', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)

USAGE = 'https://api.anthropic.com/api/oauth/usage'
CEDAR = USAGE + '?cedar_ember=1&skip_spend=1'
AT_WALL = USAGE + '?at_wall=1&skip_spend=1'
FIVE_RESET = '2026-10-14T06:10:00+00:00'
WEEK_RESET = '2026-10-17T13:00:00+00:00'

# What the plain /usage reply carried: windows, the structured Fable limit and
# reset times. The cedar_ember=1 variant (Claude Code's own) adds cedar_ember.
PLAIN = {
    'five_hour': {'utilization': 4.0, 'resets_at': FIVE_RESET},
    'seven_day': {'utilization': 57.0, 'resets_at': WEEK_RESET},
    'seven_day_opus': None,
    'limits': [{
        'kind': 'weekly_scoped', 'group': 'weekly', 'percent': 20, 'resets_at': WEEK_RESET,
        'scope': {'model': {'display_name': 'Fable', 'id': None}, 'surface': None},
    }],
    'extra_usage': {'is_enabled': False},
    'cedar_ember': None,
    'juniper_tide': None,
}
INELIGIBLE = {'eligible': False, 'ineligible_reason': 'no_grant', 'grants': []}


def cedar_reply(cedar=INELIGIBLE):
    return {**json.loads(json.dumps(PLAIN)), 'cedar_ember': json.loads(json.dumps(cedar))}


@pytest.fixture
def clock(monkeypatch):
    now = [100_000.0]
    monkeypatch.setattr(api, '_quota_cache', api.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0))
    monkeypatch.setattr(api, '_clock', lambda: now[0])
    api._claude_probes.clear()
    yield now
    api._claude_probes.clear()


def owned(monkeypatch, credential_id='c07056', source='manual:hermes_pkce'):
    credential = SimpleNamespace(token='fixture-token', credential_id=credential_id, source=source,
                                 account_identity=None)
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(credential))


def recorder(monkeypatch, cedar=INELIGIBLE, juniper=None, at_wall_error=None):
    calls = []

    def get(url, headers):
        calls.append((url, dict(headers)))
        if url == CEDAR:
            return cedar_reply(cedar)
        if url == AT_WALL:
            if at_wall_error is not None:
                raise at_wall_error
            return {**json.loads(json.dumps(PLAIN)), 'juniper_tide': juniper}
        raise AssertionError(f'unexpected Claude request {url}')

    monkeypatch.setattr(api, 'get_json', get)
    return calls


def test_steady_state_claude_refresh_is_one_cedar_get_with_helper_headers(monkeypatch, clock):
    owned(monkeypatch)
    grant = {'id': 'grant_1', 'resets_left': 1, 'resets_total': 1,
             'starts_at': '2026-01-01T00:00:00Z', 'ends_at': '2099-01-01T00:00:00Z'}
    calls = recorder(monkeypatch, cedar={'eligible': True, 'grants': [grant]})

    result = api.fetch_provider({'id': 'anthropic'})

    assert [url for url, _ in calls] == [CEDAR]
    headers = calls[0][1]
    assert headers['Authorization'] == 'Bearer fixture-token'
    assert headers['anthropic-beta'] == 'oauth-2025-04-20'
    assert [f['value'] for f in result['facts'] if f['display']['label'].get('code') == 'fact.availableResets'] == [1]


def test_cedar_reply_keeps_plain_windows_fable_limit_and_reset_times(monkeypatch, clock):
    owned(monkeypatch)
    calls = recorder(monkeypatch)

    result = api.fetch_provider({'id': 'anthropic'})

    # The plain GET is gone; the cedar reply alone yields what it yielded.
    assert USAGE not in [url for url, _ in calls]
    expected = api.normalize_claude(json.loads(json.dumps(PLAIN)))
    assert result['windows'] == expected['windows']
    assert [(w['id'], w['used_percent'], w['reset_at'], w['period_seconds']) for w in result['windows']] == [
        ('five_hour', 4.0, FIVE_RESET, 18000.0),
        ('seven_day', 57.0, WEEK_RESET, 604800.0),
        ('weekly_scoped_fable', 20.0, WEEK_RESET, 604800.0),
    ]
    # The gated cedar block (no grants, an ineligible_reason) adds only the
    # claude.ai reset link; every other fact is what the plain reply gave.
    assert [f['display']['label'] for f in result['facts'] if 'url' not in f] == [
        f['display']['label'] for f in expected['facts']]
    assert [f['url'] for f in result['facts'] if 'url' in f] == ['https://claude.ai/settings/usage']


def test_reset_probe_runs_at_most_hourly_per_identity_and_its_answer_is_reused(monkeypatch, clock):
    owned(monkeypatch)
    calls = recorder(monkeypatch, juniper={'eligible': True, 'arm': 'reset', 'available': True})

    def refresh():
        calls.clear()
        result = api.fetch_provider({'id': 'anthropic'})
        return [url for url, _ in calls], [f['value'] for f in result['facts']
                                          if f['display']['label'].get('code') == 'fact.availableResets']

    assert refresh() == ([CEDAR, AT_WALL], [1])
    for step in (300, 300, 2999):
        clock[0] += step
        assert refresh() == ([CEDAR], [1])
    clock[0] += 1  # 3600 s after the first probe
    assert refresh() == ([CEDAR, AT_WALL], [1])

    owned(monkeypatch, credential_id='other-login')
    assert refresh() == ([CEDAR, AT_WALL], [1])


def test_reset_probe_is_skipped_while_provider_backoff_is_active(monkeypatch, clock):
    owned(monkeypatch)
    calls = recorder(monkeypatch, juniper={'eligible': True, 'arm': 'reset', 'available': True})
    limited = api.QuotaError('fixture', status=429, code='upstream.rateLimited', retry_after=300)
    api._quota_cache.get('anthropic', 'another-identity', lambda: (_ for _ in ()).throw(limited))

    result = api.fetch_provider({'id': 'anthropic'})

    assert [url for url, _ in calls] == [CEDAR]
    assert result['windows'][0]['used_percent'] == 4.0
    clock[0] += 300
    calls.clear()
    api.fetch_provider({'id': 'anthropic'})
    assert [url for url, _ in calls] == [CEDAR, AT_WALL]


def test_probe_rate_limit_keeps_fresh_quota_and_gates_every_identity(monkeypatch, clock):
    owned(monkeypatch)
    limited = api.QuotaError('fixture', status=429, code='upstream.rateLimited', retry_after=600)
    calls = recorder(monkeypatch, at_wall_error=limited)
    provider = {'id': 'anthropic'}

    first = api.cached_provider(provider, ('profile', 'signature-a'))
    assert first['status'] == 'ok' and first['windows'][0]['used_percent'] == 4.0
    assert [url for url, _ in calls] == [CEDAR, AT_WALL]

    calls.clear()
    clock[0] += 400  # past the 300 s floor, inside the 600 s Retry-After
    other = api.cached_provider(provider, ('profile', 'signature-b'))
    same = api.cached_provider(provider, ('profile', 'signature-a'))
    assert calls == []
    assert other['status'] == 'unavailable' and other['problem']['code'] == 'upstream.rateLimited'
    assert same['status'] == 'ok' and same['windows'][0]['used_percent'] == 4.0
    assert other['next_refresh_at'] == same['next_refresh_at']

    clock[0] += 200
    api.cached_provider(provider, ('profile', 'signature-b'))
    assert [url for url, _ in calls] == [CEDAR]  # probe still inside its hour


# Identity keys ---------------------------------------------------------------

def write_json(path, value):
    path.write_text(json.dumps(value))


def pool_row(row_id, source, priority, **extra):
    return {'id': row_id, 'label': source, 'auth_type': 'oauth', 'priority': priority, 'source': source,
            'access_token': f'{row_id}-access', 'refresh_token': f'{row_id}-refresh',
            'expires_at_ms': 1_800_000_000_000, 'last_status': 'ok', 'last_status_at': None,
            'last_error_code': None, 'last_error_message': None, 'last_error_reason': None,
            'last_error_reset_at': None, 'request_count': 0, **extra}


@pytest.fixture
def homes(tmp_path, monkeypatch):
    root = tmp_path / '.hermes'
    profile = root / 'profiles' / 'named'
    profile.mkdir(parents=True)
    monkeypatch.setenv('HERMES_HOME', str(profile))
    write_json(profile / 'auth.json', {
        'version': 1, 'updated_at': '2026-10-14T00:00:00Z', 'active_provider': 'anthropic',
        'credential_pool': {
            'anthropic': [pool_row('c07056', 'manual:hermes_pkce', 0, base_url='https://api.anthropic.com'),
                          pool_row('ee5d2c', 'claude_code', 1)],
        },
        'providers': {'openai-codex': {'auth_mode': 'chatgpt', 'last_refresh': '2026-10-14T00:00:00Z', 'tokens': {
            'access_token': 'codex-access', 'refresh_token': 'codex-refresh', 'id_token': 'codex-id',
            'account_id': 'account-1'}}},
    })
    write_json(root / 'auth.json', {
        'version': 1, 'updated_at': '2026-10-14T00:00:00Z',
        'credential_pool': {'openai-codex': [pool_row('3bcf35', 'manual:device_code', 0)]},
    })
    return SimpleNamespace(root=root, profile=profile)


def mutate(path, change):
    data = json.loads(path.read_text())
    change(data)
    write_json(path, data)


BOOKKEEPING = {
    'request_count': lambda d: d['credential_pool']['anthropic'][0].update(request_count=7),
    'last_status': lambda d: d['credential_pool']['anthropic'][0].update(
        last_status='exhausted', last_status_at=1791937000.0, last_error_code=429,
        last_error_message='limited', last_error_reason='rate_limit', last_error_reset_at=1791938000.0),
    'token_rotation': lambda d: d['credential_pool']['anthropic'][0].update(
        access_token='rotated-access', refresh_token='rotated-refresh', expires_at_ms=1_900_000_000_000),
    'updated_at': lambda d: d.update(updated_at='2026-10-14T01:00:00Z'),
    'codex_singleton_rotation': lambda d: d['providers']['openai-codex'].update(
        last_refresh='2026-10-14T01:00:00Z',
        tokens={'access_token': 'new', 'refresh_token': 'new', 'id_token': 'new', 'account_id': 'account-1'}),
}


@pytest.mark.parametrize('name', sorted(BOOKKEEPING))
def test_identity_key_ignores_pool_bookkeeping_and_same_row_token_rotation(homes, name):
    before = api._signature(homes.profile)
    mutate(homes.profile / 'auth.json', BOOKKEEPING[name])
    assert api._signature(homes.profile) == before


def test_identity_key_ignores_root_pool_bookkeeping_and_singleton_token_rotation(homes):
    write_json(homes.root / '.anthropic_oauth.json', {'accessToken': 'a', 'refreshToken': 'r', 'expiresAt': 1})
    before = api._signature(homes.profile)
    mutate(homes.root / 'auth.json', lambda d: d['credential_pool']['openai-codex'][0].update(
        request_count=9, access_token='rotated', refresh_token='rotated', last_status='exhausted'))
    write_json(homes.root / '.anthropic_oauth.json', {'accessToken': 'b', 'refreshToken': 's', 'expiresAt': 2})
    assert api._signature(homes.profile) == before


IDENTITY_CHANGES = {
    'login_new_row': lambda d: d['credential_pool']['anthropic'].append(pool_row('a1b2c3', 'manual:hermes_pkce', 2)),
    'logout_row_removed': lambda d: d['credential_pool']['anthropic'].pop(0),
    'switch_selected_row': lambda d: [d['credential_pool']['anthropic'][0].update(priority=1),
                                      d['credential_pool']['anthropic'][1].update(priority=0)],
    'same_id_new_source': lambda d: d['credential_pool']['anthropic'][0].update(source='manual:dashboard_pkce'),
    'codex_account_switch': lambda d: d['providers']['openai-codex']['tokens'].update(account_id='account-2'),
    'codex_singleton_logout': lambda d: d['providers'].pop('openai-codex'),
}


@pytest.mark.parametrize('name', sorted(IDENTITY_CHANGES))
def test_identity_key_changes_on_login_logout_or_credential_switch(homes, name):
    before = api._signature(homes.profile)
    mutate(homes.profile / 'auth.json', IDENTITY_CHANGES[name])
    assert api._signature(homes.profile) != before


def test_identity_key_changes_on_root_login_or_singleton_login(homes):
    first = api._signature(homes.profile)
    mutate(homes.root / 'auth.json', lambda d: d['credential_pool'].setdefault('anthropic', []).append(
        pool_row('e6911c', 'claude_code', 0)))
    second = api._signature(homes.profile)
    write_json(homes.root / '.anthropic_oauth.json', {'accessToken': 'a', 'refreshToken': 'r', 'expiresAt': 1})
    third = api._signature(homes.profile)
    (homes.root / '.anthropic_oauth.json').unlink()
    fourth = api._signature(homes.profile)
    assert len({first, second, third}) == 3
    assert fourth == second


def test_identity_key_keeps_cache_and_backoff_across_pool_persists(homes, monkeypatch, clock):
    reads = []

    def fetch(provider):
        reads.append(provider)
        raise api.QuotaError('fixture', status=429, code='upstream.rateLimited', retry_after=0)

    monkeypatch.setattr(api, 'fetch_provider', fetch)
    provider = {'id': 'anthropic'}
    first = api.cached_provider(provider, ('profile', api._signature(homes.profile)))
    mutate(homes.profile / 'auth.json', BOOKKEEPING['request_count'])
    mutate(homes.profile / 'auth.json', BOOKKEEPING['token_rotation'])
    clock[0] += 60
    second = api.cached_provider(provider, ('profile', api._signature(homes.profile)))
    assert len(reads) == 1
    assert first['problem']['code'] == second['problem']['code'] == 'upstream.rateLimited'
