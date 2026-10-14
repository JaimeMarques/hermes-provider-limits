"""Claude reset inventory hidden from this login: point to claude.ai instead.

The OAuth usage reply for the Claude Code login carries cedar_ember with no
grants and an ineligible_reason ("surface"), and juniper_tide null, while
claude.ai shows the resets. Like the owner's gnome-ai-limits helper, the
plugin then reports "resets: see claude.ai" with a link, not a count.

Offline: HTTP and the owned-OAuth adapter are mocked; nothing reaches Anthropic.
"""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('limits_api_reset_link', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)

USAGE = 'https://api.anthropic.com/api/oauth/usage'
CEDAR = USAGE + '?cedar_ember=1&skip_spend=1'
AT_WALL = USAGE + '?at_wall=1&skip_spend=1'
CLAUDE_USAGE_PAGE = 'https://claude.ai/settings/usage'
RESET_LABEL = {'kind': 'message', 'code': 'fact.availableResets'}
SEE_CLAUDE_AI = {'kind': 'message', 'code': 'value.seeClaudeAi'}


def surface_gated():
    payload = json.loads((ROOT / 'tests/fixtures/claude_usage_surface_gated.json').read_text())
    payload.pop('_comment')
    return payload


def reset_facts(result):
    return [f for f in result['facts'] if f['display']['label'] == RESET_LABEL]


def grant(**changes):
    return {'id': 'grant_1', 'resets_left': 2, 'resets_total': 3,
            'starts_at': '2026-09-01T00:00:00Z', 'ends_at': '2099-10-01T00:00:00Z', **changes}


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    now = [100_000.0]
    monkeypatch.setattr(api, '_quota_cache', api.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0))
    monkeypatch.setattr(api, '_clock', lambda: now[0])
    api._claude_probes.clear()
    yield now
    api._claude_probes.clear()


def test_surface_gated_reply_reports_resets_on_claude_ai_with_link():
    result = api.normalize_claude(surface_gated())

    assert reset_facts(result) == [{
        'label': 'Reposições disponíveis', 'value': None,
        'display': {'label': RESET_LABEL, 'value': SEE_CLAUDE_AI},
        'url': CLAUDE_USAGE_PAGE,
    }]
    # The link is the provider's own usage page, the one the helper opens.
    assert reset_facts(result)[0]['url'] == api.LINKS['anthropic']
    assert [(w['id'], w['used_percent']) for w in result['windows']] == [('five_hour', 5.0), ('seven_day', 65.0)]


@pytest.mark.parametrize('reason', ['surface', 'no_grant'])
def test_any_ineligible_reason_with_no_grants_points_to_claude_ai(reason):
    payload = surface_gated()
    payload['cedar_ember']['ineligible_reason'] = reason
    assert [f.get('url') for f in reset_facts(api.normalize_claude(payload))] == [CLAUDE_USAGE_PAGE]


@pytest.mark.parametrize('cedar', [
    None, {}, {'eligible': False, 'grants': []}, {'eligible': False, 'ineligible_reason': '', 'grants': []},
    {'eligible': False, 'ineligible_reason': None, 'grants': []},
    {'eligible': True, 'grants': [{'resets_left': 2, 'ends_at': 'bad'}]},
])
def test_without_an_ineligible_reason_the_reset_row_stays_unreported(cedar):
    payload = surface_gated()
    payload['cedar_ember'] = cedar
    assert reset_facts(api.normalize_claude(payload)) == []


def test_eligible_grants_keep_the_count_and_no_link():
    payload = surface_gated()
    payload['cedar_ember'] = {'eligible': True, 'grants': [grant()]}
    facts = reset_facts(api.normalize_claude(payload))
    assert [f['value'] for f in facts] == [2]
    assert all('url' not in f and 'value' not in f['display'] for f in facts)


def test_juniper_five_hour_reset_keeps_the_count_and_no_link():
    payload = surface_gated()
    payload['juniper_tide'] = {'eligible': True, 'arm': 'reset', 'available': True}
    facts = reset_facts(api.normalize_claude(payload))
    assert [f['value'] for f in facts] == [1]
    assert all('url' not in f and 'value' not in f['display'] for f in facts)


def test_fetch_keeps_the_hourly_probe_and_reports_the_link_when_it_finds_nothing(monkeypatch, clean_state):
    credential = SimpleNamespace(token='fixture-token', credential_id='c07056', source='manual:hermes_pkce',
                                 account_identity=None)
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(credential))
    calls = []

    def get(url, headers):
        calls.append(url)
        if url in (CEDAR, AT_WALL):
            return surface_gated()
        raise AssertionError(f'unexpected Claude request {url}')

    monkeypatch.setattr(api, 'get_json', get)

    first = api.fetch_provider({'id': 'anthropic'})
    clean_state[0] += 300
    second = api.fetch_provider({'id': 'anthropic'})

    # Same at_wall cadence as before: one probe, then reused for the hour.
    assert calls == [CEDAR, AT_WALL, CEDAR]
    for result in (first, second):
        assert [(f['value'], f.get('url')) for f in reset_facts(result)] == [(None, CLAUDE_USAGE_PAGE)]


def test_fetch_probe_reporting_a_five_hour_reset_wins_over_the_link(monkeypatch, clean_state):
    credential = SimpleNamespace(token='fixture-token', credential_id='c07056', source='manual:hermes_pkce',
                                 account_identity=None)
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(credential))

    def get(url, headers):
        payload = surface_gated()
        if url == AT_WALL:
            payload['juniper_tide'] = {'eligible': True, 'arm': 'reset', 'available': True}
        return payload

    monkeypatch.setattr(api, 'get_json', get)
    facts = reset_facts(api.fetch_provider({'id': 'anthropic'}))
    assert [(f['value'], f.get('url')) for f in facts] == [(1, None)]
