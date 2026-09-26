"""Synthetic protocol fixtures; live integration is a separate explicit probe."""
import asyncio
from email.message import Message
import importlib.util
import json
import sys
from types import SimpleNamespace
import urllib.error
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('limits_api', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)


def test_codex_duration_not_position_and_every_additional_limit():
    payload = {'rate_limit': {'primary_window': {'used_percent': 71, 'limit_window_seconds': 604800}, 'secondary_window': None},
               'additional_rate_limits': [{'limit_name': 'GPT-5.3-Codex-Spark', 'rate_limit': {
                   'primary_window': {'used_percent': 0, 'limit_window_seconds': 18000},
                   'secondary_window': {'used_percent': 22, 'limit_window_seconds': 604800}}}],
               'code_review_rate_limit': {'primary_window': {'used_percent': 12, 'limit_window_seconds': 3600}}}
    windows = api.normalize_codex(payload)['windows']
    assert [(w['group'], w['label']) for w in windows] == [('Codex', '7 d'), ('Revisão de código', '1 h'), ('GPT-5.3-Codex-Spark', '5 h'), ('GPT-5.3-Codex-Spark', '7 d')]
    assert windows[0]['remaining_percent'] == 29
    assert windows[2]['remaining_percent'] == 100
    assert all(w['limit'] is None for w in windows)


def test_codex_windows_expose_semantic_period_seconds_independent_of_position():
    windows = api.normalize_codex({
        'rate_limit': {
            'primary_window': {'used_percent': 8, 'limit_window_seconds': 18000},
            'secondary_window': {'used_percent': 19, 'limit_window_seconds': 604800},
        },
    })['windows']

    assert [window['period_seconds'] for window in windows] == [18000.0, 604800.0]
    assert next(window for window in windows if window['period_seconds'] == 604800)['used_percent'] == 19


def test_codex_exposes_locale_neutral_display_descriptors_without_breaking_v1_fields():
    result = api.normalize_codex({
        'rate_limit': {'primary_window': {'used_percent': 25, 'limit_window_seconds': 604800}},
        'code_review_rate_limit': {'primary_window': {'used_percent': 10, 'limit_window_seconds': 3600}},
        'credits': {'unlimited': True},
    })
    codex, review = result['windows']
    assert codex['display'] == {
        'label': {'kind': 'period', 'value': 7, 'unit': 'day'},
        'group': {'kind': 'literal', 'value': 'Codex'},
    }
    assert review['display']['group'] == {'kind': 'message', 'code': 'group.codeReview'}
    assert codex['unit_code'] == 'percent'
    assert result['facts'][0]['display'] == {
        'label': {'kind': 'message', 'code': 'fact.additionalCredits'},
        'value': {'kind': 'message', 'code': 'value.unlimited'},
    }
    assert codex['label'] == '7 d' and review['group'] == 'Revisão de código'


@pytest.mark.parametrize('count', [0, 2, None, -1, 1.5, True, '2', float('inf'), 2**53])
def test_codex_reset_counts_are_nonnegative_safe_integers(count):
    result = api.normalize_codex({'rate_limit_reset_credits': {'available_count': count}})
    facts = [f for f in result['facts'] if f['display']['label'].get('code') == 'fact.availableResets']
    assert [f['value'] for f in facts] == ([count] if type(count) is int and 0 <= count < 2**53 else [])


def test_borrowed_root_login_change_invalidates_named_profile_quota(tmp_path, monkeypatch):
    from hermes_constants import get_default_hermes_root

    root = tmp_path / '.hermes'
    profile = root / 'profiles' / 'named'
    profile.mkdir(parents=True)
    (root / 'auth.json').write_text('{"credential_pool":{"openai-codex":[{"access_token":"A"}]}}')
    monkeypatch.setenv('HERMES_HOME', str(profile))
    assert get_default_hermes_root() == root
    api._quota_cache.clear()
    reads = []
    monkeypatch.setattr(api, 'fetch_provider', lambda provider: reads.append(provider) or {
        'windows': [{'id': 'seven_day', 'used_percent': len(reads)}], 'facts': []
    })
    provider = {'id': 'openai-codex'}
    first = api.cached_provider(provider, (str(profile), api._signature(profile)))
    (root / 'auth.json').write_text('{"credential_pool":{"openai-codex":[{"access_token":"B"}]}}')
    second = api.cached_provider(provider, (str(profile), api._signature(profile)))
    assert first['windows'][0]['used_percent'] == 1
    assert second['windows'][0]['used_percent'] == 2
    (root / '.anthropic_oauth.json').write_text('{"access_token":"new-root-claude-login"}')
    third = api.cached_provider(provider, (str(profile), api._signature(profile)))
    assert third['windows'][0]['used_percent'] == 3
    assert len(reads) == 3


@pytest.mark.parametrize('block', [None, [], 'bad', 4, {}])
def test_codex_unknown_reset_block_preserves_quota(block):
    result = api.normalize_codex({'rate_limit_reset_credits': block,
                                  'rate_limit': {'primary_window': {'used_percent': 22}}})
    assert result['facts'] == []
    assert result['windows'][0]['used_percent'] == 22


# Protocol shapes independently checked against oh-my-pi e45b49c, claude-reset.ts
# and its public claude-reset.test.ts. Synthetic values, not live account data.
@pytest.mark.parametrize('count', [0, 2, None, -1, 1.5, True, '2'])
def test_claude_cedar_reset_inventory(count):
    result = api.normalize_claude({'cedar_ember': {'eligible': True, 'grants': [
        cedar_grant(resets_left=count),
        cedar_grant(id='expired', resets_left=3, starts_at='1999-01-01T00:00:00Z', ends_at='2000-01-01T00:00:00Z'),
    ]}, 'juniper_tide': {'eligible': True, 'arm': 'reset', 'available': False}})
    facts = [f for f in result['facts'] if f['display']['label'].get('code') == 'fact.availableResets']
    assert [f['value'] for f in facts] == ([count] if type(count) is int and count >= 0 else [])


@pytest.mark.parametrize('block', [None, {}, {'eligible': False, 'ineligible_reason': 'surface', 'grants': []},
                                  {'eligible': True, 'grants': [{'resets_left': 2, 'ends_at': 'bad'}]}])
def test_claude_unevaluated_gated_or_malformed_resets_stay_unknown(block):
    result = api.normalize_claude({'cedar_ember': block, 'juniper_tide': None,
                                  'seven_day': {'utilization': 22}})
    assert result['facts'] == []
    assert result['windows'][0]['used_percent'] == 22


@pytest.mark.parametrize('available', [True, False, None, 1, 'true'])
def test_claude_juniper_explicit_reset_offer(available):
    result = api.normalize_claude({'cedar_ember': {'eligible': True, 'grants': []},
                                  'juniper_tide': {'eligible': True, 'arm': 'reset', 'available': available}})
    assert [f['value'] for f in result['facts']] == ([int(available)] if type(available) is bool else [])


@pytest.mark.parametrize('failure', [None, 503, 401, 403])
def test_claude_reset_discovery_reuses_selected_credential_and_preserves_auth_failures(monkeypatch, failure):
    calls = []
    selected = SimpleNamespace(token='selected-test-token')
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(selected))

    def get(url, headers):
        calls.append((url, headers))
        if '?' not in url:
            return {'seven_day': {'utilization': 22}, 'cedar_ember': None, 'juniper_tide': None}
        if failure:
            raise api.QuotaError('fixture', status=failure)
        if 'cedar_ember=1' in url:
            return {'cedar_ember': {'eligible': False, 'ineligible_reason': 'no_grant', 'grants': []}}
        return {'juniper_tide': {'eligible': True, 'arm': 'reset', 'available': True}}

    monkeypatch.setattr(api, 'get_json', get)
    if failure in (401, 403):
        with pytest.raises(api.QuotaError) as caught:
            api.fetch_provider({'id': 'anthropic'})
        assert caught.value.status == failure
    else:
        result = api.fetch_provider({'id': 'anthropic'})
        assert result['windows'][0]['used_percent'] == 22
        assert [f['value'] for f in result['facts']] == ([] if failure else [1])
    expected = ['https://api.anthropic.com/api/oauth/usage',
                'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1']
    if failure is None:
        expected.append('https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1')
    assert [url for url, _ in calls] == expected
    assert all(headers['Authorization'] == 'Bearer selected-test-token' for _, headers in calls)


def cedar_grant(**changes):
    return {'id': 'grant_1', 'resets_left': 2, 'resets_total': 3,
            'starts_at': '2026-09-01T00:00:00Z', 'ends_at': '2099-10-01T00:00:00Z',
            'clears': ['five_hour'], 'blocking': [], **changes}


@pytest.mark.parametrize('changes', [
    {'id': None}, {'id': ''}, {'id': 'bad/id'}, {'id': 'A'}, {'id': 'x' * 41},
    {'starts_at': 'bad'}, {'starts_at': ''}, {'starts_at': 123}, {'starts_at': False},
    {'ends_at': ''}, {'ends_at': 123}, {'ends_at': False},
    {'starts_at': '2099-11-01T00:00:00Z'},  # start after expiry
    {'resets_total': -1}, {'resets_total': True}, {'resets_total': '3'},
    {'resets_total': 1.5}, {'resets_total': 1}, {'resets_total': 2**53},
])
def test_claude_grant_invalid_identity_dates_or_total_is_unknown(changes):
    result = api.normalize_claude({
        'seven_day': {'utilization': 22},
        'cedar_ember': {'eligible': True, 'grants': [cedar_grant(**changes)]},
        'juniper_tide': {'eligible': True, 'arm': 'reset', 'available': False},
    })
    assert result['facts'] == []
    assert result['windows'][0]['used_percent'] == 22


@pytest.mark.parametrize('second, expected', [(cedar_grant(), 2), (cedar_grant(resets_left=1), None),
                                             (cedar_grant(ends_at=None), None),
                                             (cedar_grant(id='grant_2'), 4)])
def test_claude_grants_deduplicate_identity_and_reject_conflicts(second, expected):
    assert api.claude_reset_count({'cedar_ember': {'eligible': True, 'grants': [cedar_grant(), second]}}) == expected


@pytest.mark.parametrize('dates', [
    {'starts_at': '2099-09-01T00:00:00Z'},
    {'starts_at': '1999-01-01T00:00:00Z', 'ends_at': '2000-01-01T00:00:00Z'},
])
def test_claude_inactive_grants_do_not_establish_current_inventory(dates):
    payload = {'cedar_ember': {'eligible': True, 'grants': [cedar_grant(**dates)]}}
    assert api.claude_reset_count(payload) is None  # Juniper remains unevaluated.
    payload['cedar_ember']['grants'].append(cedar_grant(id='active'))
    assert api.claude_reset_count(payload) == 2


@pytest.mark.parametrize('juniper', [None, {}, {'eligible': False, 'ineligible_reason': 'surface'}])
def test_claude_cedar_zero_requires_evaluated_juniper(juniper):
    assert api.claude_reset_count({
        'cedar_ember': {'eligible': True, 'grants': []}, 'juniper_tide': juniper,
    }) is None


@pytest.mark.parametrize('cedar', [None, {'eligible': False, 'ineligible_reason': 'surface', 'grants': []}])
def test_claude_juniper_zero_requires_evaluated_cedar(cedar):
    assert api.claude_reset_count({
        'cedar_ember': cedar,
        'juniper_tide': {'eligible': True, 'arm': 'reset', 'available': False},
    }) is None


@pytest.mark.parametrize('juniper_result', [True, False, None, 503])
def test_claude_inline_cedar_zero_does_not_skip_juniper_discovery(monkeypatch, juniper_result):
    calls = []
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(SimpleNamespace(token='fixture')))

    def get(url, headers):
        calls.append(url)
        if 'at_wall=1' in url:
            if juniper_result == 503:
                raise api.QuotaError('fixture', status=503)
            return {'juniper_tide': None if juniper_result is None else {
                'eligible': True, 'arm': 'reset', 'available': juniper_result,
            }}
        return {'seven_day': {'utilization': 22}, 'cedar_ember': {'eligible': True, 'grants': []},
                'juniper_tide': None}

    monkeypatch.setattr(api, 'get_json', get)
    result = api.fetch_provider({'id': 'anthropic'})
    assert any('at_wall=1' in url for url in calls)
    assert result['windows'][0]['used_percent'] == 22
    assert [f['value'] for f in result['facts']] == ([int(juniper_result)] if type(juniper_result) is bool else [])


@pytest.mark.parametrize('probe_query', ['cedar_ember=1', 'at_wall=1'])
def test_optional_reset_rate_limit_keeps_fresh_quota_and_cache_cooldown(monkeypatch, probe_query):
    now = [1000.0]
    cache = api.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    monkeypatch.setattr(api, '_quota_cache', cache)
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(SimpleNamespace(token='fixture')))
    calls = []

    def get(url, headers):
        calls.append(url)
        if '?' not in url:
            return {'seven_day': {'utilization': 22}}
        if probe_query in url:
            raise api.QuotaError('fixture', status=429, code='upstream.rateLimited', retry_after=300)
        return {'cedar_ember': {'eligible': True, 'grants': []}}

    monkeypatch.setattr(api, 'get_json', get)
    provider, scope = {'id': 'anthropic'}, ('profile', 'fixture')
    result = api.cached_provider(provider, scope)
    assert result['status'] == 'ok'
    assert result['windows'][0]['used_percent'] == 22
    assert result['facts'] == []
    assert result['fetched_at'] == '1970-01-01T00:16:40+00:00'
    assert result['next_refresh_at'] == '1970-01-01T00:21:40+00:00'
    assert 'retry_after' not in json.dumps(result)
    request_count = len(calls)
    now[0] = 1181
    assert api.cached_provider(provider, scope)['windows'] == result['windows']
    assert len(calls) == request_count
    now[0] = 1300
    api.cached_provider(provider, scope)
    assert len(calls) == request_count * 2


@pytest.mark.parametrize('inline', [False, True])
def test_claude_reported_cedar_resets_stop_extra_discovery(monkeypatch, inline):
    calls = []
    block = {'eligible': True, 'grants': [cedar_grant(starts_at=None, ends_at=None)]}
    monkeypatch.setattr(api, 'request_with_owned_oauth', lambda provider, request: request(SimpleNamespace(token='fixture')))

    def get(url, headers):
        calls.append(url)
        return {'cedar_ember': block if inline or '?' in url else None}

    monkeypatch.setattr(api, 'get_json', get)
    assert api.fetch_provider({'id': 'anthropic'})['facts'][0]['value'] == 2
    assert len(calls) == (1 if inline else 2)


@pytest.mark.parametrize('status,age', [(503, 180), (503, 901), (401, 180), (403, 180)])
def test_reset_facts_share_quota_cache_expiry_and_auth_revocation(status, age):
    now = [1000.0]
    cache = api.QuotaCache(clock=lambda: now[0], randomness=lambda _a, _b: 0)
    good = api.normalize_codex({'rate_limit_reset_credits': {'available_count': 2}})
    cache.get('openai-codex', 'fixture', lambda: good)
    now[0] += age
    def failed():
        raise api.QuotaError('fixture', status=status)
    result = cache.get('openai-codex', 'fixture', failed)
    if status == 503 and age <= 900:
        assert result.status == 'stale'
        assert result.good['facts'][0]['value'] == 2
    else:
        assert result.good is None


def test_claude_small_percent_and_unknown_windows_not_discarded():
    windows = api.normalize_claude({'five_hour': {'utilization': 0.5}, 'seven_day': None,
                                  'seven_day_new_model': {'utilization': 42},
                                  'extra_usage': {'is_enabled': True, 'monthly_limit': 1000, 'used_credits': 125}})['windows']
    assert windows[0]['used_percent'] == 0.5
    assert windows[0]['remaining_percent'] == 99.5
    assert windows[1]['used_percent'] == 42
    assert windows[2]['remaining'] == 875


def test_claude_known_and_unknown_windows_expose_semantic_period_seconds():
    windows = api.normalize_claude({
        'five_hour': {'utilization': 1},
        'seven_day': {'utilization': 2},
        'future_window': {'utilization': 3},
    })['windows']

    assert [window['period_seconds'] for window in windows] == [18000.0, 604800.0, None]


def test_claude_structured_fable_limit_replaces_nimbus_quill_codename():
    reset = '2026-09-26T13:00:00+00:00'
    windows = api.normalize_claude({
        'seven_day': {'utilization': 10, 'resets_at': reset},
        'nimbus_quill': {'utilization': 0, 'resets_at': None},
        'limits': [{
            'kind': 'weekly_scoped',
            'group': 'weekly',
            'percent': 0,
            'resets_at': reset,
            'scope': {'model': {'display_name': 'Fable', 'id': None}, 'surface': None},
        }],
    })['windows']

    assert [window['id'] for window in windows] == ['seven_day', 'weekly_scoped_fable']
    assert windows[1]['label'] == 'Fable · 7 d'
    assert windows[1]['display']['label'] == {
        'kind': 'message', 'code': 'window.modelPeriod', 'args': ['Fable', 7, 'day'],
    }
    assert windows[1]['used_percent'] == 0
    assert windows[1]['reset_at'] == reset
    assert windows[1]['period_seconds'] == 604800.0
    assert all(window['label'] != 'nimbus quill' for window in windows)


@pytest.mark.parametrize('malformed', [
    {'limits': 7},
    {'limits': {'kind': 'weekly_scoped'}},
    {'limits': [{'kind': 'weekly_scoped', 'scope': 'bad'}]},
    {'limits': [{'kind': 'weekly_scoped', 'scope': ['bad']}]},
    {'limits': [{'kind': 'weekly_scoped', 'scope': {'model': 'bad'}}]},
    {'limits': [{'kind': 'weekly_scoped', 'scope': {'model': ['bad']}}]},
])
def test_claude_malformed_scoped_limits_preserve_valid_overall_window(malformed):
    result = api.normalize_claude({'seven_day': {'utilization': 12}, **malformed})
    assert [(w['id'], w['used_percent']) for w in result['windows']] == [('seven_day', 12)]


def test_claude_scoped_window_ids_do_not_merge_colliding_models_or_surfaces():
    limits = [
        {'kind': 'weekly_scoped', 'percent': percent,
         'scope': {'model': {'display_name': name}, 'surface': surface}}
        for name, surface, percent in [('Fable', None, 1), ('Fable', 'api', 2),
                                       ('Fable!', None, 3), ('!!!', None, 4), ('???', None, 5)]
    ]
    payload = {'weekly_scoped_fable': {'utilization': 6}, 'limits': limits}
    windows = api.normalize_claude(payload)['windows']
    assert len(windows) == 6
    assert len({w['id'] for w in windows}) == len(windows)
    assert [w['used_percent'] for w in windows] == [6, 1, 2, 3, 4, 5]
    assert [w['id'] for w in api.normalize_claude(payload)['windows']] == [w['id'] for w in windows]


def test_claude_currency_keeps_legacy_minor_units_and_exposes_decimal_scale():
    result = api.normalize_claude({'extra_usage': {
        'is_enabled': True, 'monthly_limit': 10000, 'used_credits': 2219,
        'utilization': 22.19, 'currency': 'USD', 'decimal_places': 2,
    }})
    extra = result['windows'][0]
    assert extra['used'] == 2219
    assert extra['limit'] == 10000
    assert extra['remaining'] == 7781
    assert extra['unit'] == 'USD'
    assert extra['unit_code'] == 'currency'
    assert extra['currency_code'] == 'USD'
    assert extra['decimal_places'] == 2


def test_every_provider_exposes_semantic_descriptors_for_known_copy_and_raw_upstream_names():
    claude = api.normalize_claude({
        'five_hour': {'utilization': 5},
        'seven_day_new_model': {'utilization': 8},
        'extra_usage': {'is_enabled': False},
    })
    assert claude['windows'][0]['display']['label'] == {'kind': 'period', 'value': 5, 'unit': 'hour'}
    assert claude['windows'][1]['display']['label'] == {'kind': 'literal', 'value': 'seven day new model'}
    assert claude['facts'][0]['display']['value'] == {'kind': 'message', 'code': 'value.disabled'}

    zai = api.normalize_zai({'data': {'limits': [
        {'type': 'TOKENS_LIMIT', 'unit': 6, 'number': 1, 'percentage': 3},
        {'type': 'TIME_LIMIT', 'unit': 3, 'number': 5, 'usage': 100, 'currentValue': 7,
         'remaining': 93, 'percentage': 7, 'usageDetails': [{'modelCode': 'search', 'usage': 7}]},
    ]}})
    assert zai['windows'][0]['display']['group'] == {'kind': 'message', 'code': 'group.tokens'}
    assert zai['windows'][1]['display']['label'] == {'kind': 'period', 'value': 5, 'unit': 'hour'}
    assert zai['windows'][1]['unit_code'] == 'call'
    assert zai['windows'][1]['details'][0]['display']['label'] == {'kind': 'literal', 'value': 'search'}

    deepseek = api.normalize_deepseek({'plans': [{'planName': 'Coding', 'quota': {
        'fiveHour': {'limitCredits': 100, 'usedCredits': 10, 'remainingCredits': 90},
        'usageByModel': {'deepseek-flash': {'chargedCredits': 10}},
    }}]})
    assert deepseek['windows'][0]['display']['label'] == {'kind': 'period', 'value': 5, 'unit': 'hour'}
    assert deepseek['windows'][0]['display']['group'] == {'kind': 'literal', 'value': 'Coding'}
    assert deepseek['plan_display'] == {
        'kind': 'list', 'items': [{'kind': 'literal', 'value': 'Coding'}],
    }
    assert deepseek['facts'][-1]['display']['value'] == {'kind': 'message', 'code': 'value.flashEquivalentCredits'}


def test_deepseek_unnamed_plan_has_locale_neutral_provider_descriptor():
    result = api.normalize_deepseek({'plans': [{'quota': {
        'fiveHour': {'limitCredits': 100, 'usedCredits': 10, 'remainingCredits': 90},
    }}]})

    assert result['plan'] == 'Plano 1'
    assert result['plan_display'] == {
        'kind': 'list',
        'items': [{'kind': 'message', 'code': 'plan.unnamed', 'args': [1]}],
    }


def test_deepseek_unnamed_composite_facts_use_numeric_plan_descriptors():
    result = api.normalize_deepseek({'plans': [
        {'quota': {'usageByModel': {'deepseek-flash': {'chargedCredits': 12}}},
         'currentPeriodEnd': '2026-09-18T17:00:00Z'},
        {'planName': 'Coding',
         'quota': {'usageByModel': {'deepseek-chat': {'chargedCredits': 7}}},
         'currentPeriodEnd': '2026-09-19T17:00:00Z'},
    ]})

    unnamed_charged, unnamed_period, named_charged, named_period = result['facts']
    assert unnamed_charged['label'] == 'Plano 1 · deepseek-flash · créditos debitados'
    assert unnamed_charged['display']['label'] == {
        'kind': 'message',
        'code': 'fact.unnamedPlanModelChargedCredits',
        'args': [1, 'deepseek-flash'],
    }
    assert unnamed_period['label'] == 'Plano 1 · fim do período'
    assert unnamed_period['display']['label'] == {
        'kind': 'message', 'code': 'fact.unnamedPlanPeriodEnd', 'args': [1],
    }
    assert named_charged['display']['label'] == {
        'kind': 'message', 'code': 'fact.modelChargedCredits',
        'args': ['Coding', 'deepseek-chat'],
    }
    assert named_period['display']['label'] == {
        'kind': 'message', 'code': 'fact.periodEnd', 'args': ['Coding'],
    }


def test_zai_all_windows_absolute_and_percentage():
    windows = api.normalize_zai({'data': {'level': 'MAX', 'limits': [
        {'type': 'TOKENS_LIMIT', 'unit': 3, 'number': 5, 'percentage': 18, 'nextResetTime': 1790000000000},
        {'type': 'TOKENS_LIMIT', 'unit': 6, 'number': 1, 'percentage': 0},
        {'type': 'TIME_LIMIT', 'unit': 5, 'number': 1, 'usage': 100, 'currentValue': 17, 'remaining': 83, 'percentage': 17,
         'usageDetails': [{'modelCode': 'search', 'usage': 17}]},
        {'type': 'NEW_LIMIT', 'unit': 4, 'number': 2, 'percentage': 32}]}})['windows']
    assert len(windows) == 4
    assert [w['label'] for w in windows] == ['5 h', '1 semana', '1 mês', '2 d']
    assert windows[0]['used'] is None  # do not fabricate absolute usage from rounded %
    assert windows[0]['reset_at'].startswith('2026-')
    assert windows[2]['remaining'] == 83
    assert windows[3]['group'] == 'NEW_LIMIT'


def test_zai_credit_limit_keeps_v1_fields_and_adds_credit_semantics():
    credit = api.normalize_zai({'data': {'limits': [{
        'type': 'CREDIT_LIMIT', 'unit': 3, 'number': 5, 'usage': 100,
        'currentValue': 25, 'remaining': 75, 'percentage': 25,
    }]}})['windows'][0]

    assert credit['group'] == 'CREDIT_LIMIT'
    assert credit['unit'] == 'tokens'
    assert credit['display']['group'] == {'kind': 'message', 'code': 'group.credits'}
    assert credit['unit_code'] == 'credit'


def test_zai_unknown_period_enum_retains_known_count_semantically_and_in_v1_text():
    item = api.normalize_zai({'data': {'limits': [{
        'type': 'TOKENS_LIMIT', 'unit': 999, 'number': 1234, 'percentage': 5,
    }]}})['windows'][0]

    assert item['label'] == '1234 unid. de período'
    assert item['period'] == '1234 unid. de período'
    assert item['display']['label'] == {
        'kind': 'message', 'code': 'period.units', 'args': [1234],
    }
    assert item['period_seconds'] is None


def test_zai_known_period_units_expose_semantic_period_seconds():
    windows = api.normalize_zai({'data': {'limits': [
        {'type': 'TOKENS_LIMIT', 'unit': 3, 'number': 5, 'percentage': 1},
        {'type': 'TOKENS_LIMIT', 'unit': 6, 'number': 1, 'percentage': 2},
    ]}})['windows']

    assert [window['period_seconds'] for window in windows] == [18000.0, 604800.0]


def test_zai_window_and_usage_detail_units_follow_limit_kind_without_changing_v1_units():
    windows = api.normalize_zai({'data': {'limits': [
        {'type': 'TIME_LIMIT', 'unit': 3, 'number': 5, 'usage': 10,
         'usageDetails': [{'modelCode': 'tool', 'usage': 2}]},
        {'type': 'CREDIT_LIMIT', 'unit': 3, 'number': 5, 'usage': 20,
         'usageDetails': [{'modelCode': 'credit-model', 'usage': 3}]},
        {'type': 'TOKENS_LIMIT', 'unit': 3, 'number': 5, 'usage': 30,
         'usageDetails': [{'modelCode': 'token-model', 'usage': 4}]},
        {'type': 'FUTURE_LIMIT', 'unit': 3, 'number': 5, 'usage': 40,
         'usageDetails': [{'modelCode': 'future-model', 'usage': 5}]},
    ]}})['windows']

    assert [window['unit'] for window in windows] == ['chamadas', 'tokens', 'tokens', 'tokens']
    assert [window['unit_code'] for window in windows] == ['call', 'credit', 'token', 'unknown']
    assert [window['details'][0]['unit_code'] for window in windows] == [
        'call', 'credit', 'token', 'unknown',
    ]
    assert all('unit' not in window['details'][0] for window in windows)


@pytest.mark.parametrize('v', [None, '', True, float('inf'), float('nan'), 'unlimited'])
def test_missing_and_invalid_never_become_zero(v):
    w = api.window('a', 'a', percent=v)
    assert w['used_percent'] is None
    assert w['remaining_percent'] is None


def test_overage_kept_and_zero_limit_not_infinite():
    w = api.window('a', 'a', used=120, limit=100)
    assert w['used_percent'] == 120 and w['remaining'] == 0
    assert api.window('a', 'a', used=0, limit=0)['used_percent'] is None


def test_provider_failures_expose_stable_problem_codes_with_safe_copy(monkeypatch):
    api._quota_cache.clear()
    monkeypatch.setattr(api, 'fetch_provider', lambda _p: (_ for _ in ()).throw(
        api.QuotaError('legacy safe copy', status=403, code='auth.forbidden', retryable=False)))

    result = api.cached_provider({'id': 'openai-codex'}, ('profile', 'signature'))

    assert result['status'] == 'unavailable'
    assert result['error'] == 'O fornecedor recusou acesso aos dados de utilização.'
    assert result['problem'] == {'code': 'auth.forbidden', 'params': {}, 'retryable': False}


def test_quota_error_serializes_only_params_allowlisted_for_its_code():
    upstream = api.QuotaError(
        'safe', status=503, code='upstream.http',
        params={'status': 503, 'url': 'https://secret.invalid', 'account': 'private'},
    )
    auth = api.QuotaError(
        'safe', status=401, code='auth.rejected',
        params={'status': 401, 'token': 'must-not-serialize'},
    )
    unknown = api.QuotaError('safe', code='future.code', params={'status': 418})

    assert upstream.problem()['params'] == {'status': 503}
    assert auth.problem()['params'] == {}
    assert unknown.problem()['params'] == {}


def test_cache_dedup_stale_error_redacted_and_profile_isolated(monkeypatch):
    now = [1000]
    monkeypatch.setattr(api, '_quota_cache', api.QuotaCache(
        clock=lambda: now[0], randomness=lambda _a, _b: 0,
    ))
    calls = []
    def fetch(p):
        calls.append(p)
        return {'windows': [api.window('a', '7 d', percent=12)], 'facts': []}
    monkeypatch.setattr(api, 'fetch_provider', fetch)
    p = {'id': 'openai-codex'}
    a = api.cached_provider(p, ('A', 'sigA'))
    assert api.cached_provider(p, ('A', 'sigA')) == a
    assert len(calls) == 1
    api.cached_provider(p, ('B', 'sigB'))
    assert len(calls) == 2
    now[0] += 120
    def failure(p):
        raise RuntimeError('secret-should-never-render')
    monkeypatch.setattr(api, 'fetch_provider', failure)
    stale = api.cached_provider(p, ('A', 'sigA'))
    assert stale['status'] == 'stale' and stale['fetched_at'] == a['fetched_at']
    assert 'secret-should-never-render' not in json.dumps(stale)
    new_account = api.cached_provider(p, ('A', 'changed-signature'))
    assert new_account['status'] == 'unavailable' and new_account['windows'] == []


def test_plugin_provider_cache_uses_bounded_quota_cache_service():
    assert isinstance(api._quota_cache, api.QuotaCache)
    assert not hasattr(api, '_cache')
    assert not hasattr(api, '_locks')


def test_discovery_real_scoped_homes_A_B_A(tmp_path, monkeypatch):
    from hermes_cli.web_server_profiles import _hermes_home_scope as hermes_home_override
    from agent.secret_scope import set_secret_scope, reset_secret_scope, set_multiplex_active
    import yaml
    homes = [tmp_path / 'A', tmp_path / 'B']
    for home in homes:
        home.mkdir()
    (homes[0] / 'config.yaml').write_text(yaml.safe_dump({'model': {'provider': 'openai-codex'}, 'providers': {
        'deepseek': {'base_url': 'https://api.deepseekv4pro.com/v1', 'enabled': True},
        'anthropic': {'enabled': False}}}))
    (homes[0] / 'auth.json').write_text(json.dumps({'credential_pool': {'anthropic': [{'access_token': 'synthetic-not-real'}]}}))
    (homes[1] / 'config.yaml').write_text(yaml.safe_dump({'model': {'provider': 'local'}, 'providers': {
        'zai': {'enabled': True}, 'deepseek': {'base_url': 'https://api.deepseekv4pro.com/v1', 'enabled': False}},
        'custom_providers': [{'name': 'Old duplicate', 'base_url': 'https://api.deepseekv4pro.com/v1'}]}))
    token = set_secret_scope({})
    try:
        outputs = []
        for home in [homes[0], homes[1], homes[0]]:
            with hermes_home_override(home):
                outputs.append({p['id'] for p in api.discover()})
        assert outputs == [{'openai-codex', 'deepseekv4pro'}, {'zai'}, {'openai-codex', 'deepseekv4pro'}]
    finally:
        reset_secret_scope(token)


def test_quota_response_declares_schema_three_with_private_profile_identity(monkeypatch):
    monkeypatch.setattr(api, 'discover', lambda: [])
    monkeypatch.setattr(api, '_signature', lambda _home: 'test-signature')

    result = asyncio.run(api.quota(profile=None))

    assert result['schema_version'] == 3
    assert result['profile_identity']['name'] == 'current'
    assert len(result['profile_identity']['id']) == 64
    assert result['profile_identity']['id'] == result['profile_identity']['id'].lower()
    assert all(character in '0123456789abcdef' for character in result['profile_identity']['id'])
    assert '/' not in json.dumps(result['profile_identity'])
    assert result['problem'] is None
    assert result['providers'] == []


def test_safety_and_protocol_failures_have_stable_semantic_codes():
    with pytest.raises(api.QuotaError) as invalid_zai:
        api.normalize_zai({})
    assert invalid_zai.value.code == 'response.unexpectedShape'

    with pytest.raises(api.QuotaError) as wrong_host:
        api.get_json('https://example.com/usage', {'Authorization': 'synthetic'})
    assert wrong_host.value.code == 'security.endpointNotAllowed'

    with pytest.raises(api.QuotaError) as redirect:
        api.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test')
    assert redirect.value.code == 'security.redirectBlocked'


def test_rate_limited_http_error_carries_retry_after_only_inside_backend(monkeypatch):
    headers = Message()
    headers['Retry-After'] = '9999'

    class Opener:
        def open(self, _request, timeout):
            assert timeout == 15
            raise urllib.error.HTTPError(
                'https://chatgpt.com/redacted', 429, 'limited', headers, None,
            )

    monkeypatch.setattr(api.urllib.request, 'build_opener', lambda *_handlers: Opener())

    with pytest.raises(api.QuotaError) as limited:
        api.get_json('https://chatgpt.com/backend-api/wham/usage', {})

    assert limited.value.retry_after == 9999
    assert limited.value.problem() == {
        'code': 'upstream.rateLimited', 'params': {}, 'retryable': True,
    }


@pytest.mark.parametrize('retry_after', [
    'Fri, 31 Dec 2999 23:59:59 GMT',
    'Fri Dec 31 23:59:59 2999',
])
def test_http_date_retry_after_is_parsed_and_clamped_by_quota_cache(monkeypatch, retry_after):
    headers = Message()
    headers['Retry-After'] = retry_after

    class Opener:
        def open(self, _request, timeout):
            assert timeout == 15
            raise urllib.error.HTTPError(
                'https://chatgpt.com/redacted', 429, 'limited', headers, None,
            )

    monkeypatch.setattr(api.urllib.request, 'build_opener', lambda *_handlers: Opener())

    with pytest.raises(api.QuotaError) as limited:
        api.get_json('https://chatgpt.com/backend-api/wham/usage', {})

    assert limited.value.retry_after > 300
    cache = api.QuotaCache(clock=lambda: 1000.0, randomness=lambda _a, _b: 0)
    view = cache.get(
        'openai-codex', 'http-date',
        lambda: (_ for _ in ()).throw(limited.value),
    )
    assert view.next_refresh_at == 1300.0


def test_oauth_provider_fetches_use_owned_adapter_without_returning_identity(monkeypatch):
    adapter_calls = []
    http_calls = []

    def owned(provider, request):
        adapter_calls.append(provider)
        return request(SimpleNamespace(token=f'{provider}-secret', account_identity='private-account'))

    def get_json(url, headers):
        http_calls.append((url, headers))
        if 'anthropic.com' in url:
            return {'seven_day': {'utilization': 12}}
        return {'rate_limit': {'primary_window': {
            'used_percent': 23, 'limit_window_seconds': 604800,
        }}}

    monkeypatch.setattr(api, 'request_with_owned_oauth', owned)
    monkeypatch.setattr(api, 'get_json', get_json)

    results = [
        api.fetch_provider({'id': 'anthropic'}),
        api.fetch_provider({'id': 'openai-codex'}),
    ]

    assert adapter_calls == ['anthropic', 'openai-codex']
    assert [url for url, _ in http_calls] == [
        'https://api.anthropic.com/api/oauth/usage',
        'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1',
        'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1',
        'https://chatgpt.com/backend-api/wham/usage',
    ]
    assert http_calls[-1][1]['ChatGPT-Account-Id'] == 'private-account'
    serialized = json.dumps(results)
    assert 'secret' not in serialized
    assert 'private-account' not in serialized


def test_no_redirects_or_wrong_hosts():
    with pytest.raises(api.QuotaError):
        api.get_json('https://example.com/usage', {'Authorization': 'synthetic'})
    with pytest.raises(api.QuotaError):
        api.get_json('https://api.z.ai.evil.test/usage', {})
    with pytest.raises(api.QuotaError):
        api.get_json('http://api.z.ai/usage', {})
    with pytest.raises(api.QuotaError):
        api.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test')
