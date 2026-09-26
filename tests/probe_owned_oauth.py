"""Exercise released pool loading, selection, refresh and persistence, offline.

Called only in the -I -S release subprocess, with a throwaway HOME and blocked
sockets. The only substituted operations are provider HTTP transports.
"""
import base64
import inspect
import json
import os
from pathlib import Path
from unittest.mock import patch


def probe_owned_oauth(api):
    from agent.credential_pool import CredentialPool
    import agent.account_usage as usage
    import agent.anthropic_credentials as anthropic
    import hermes_cli.auth as auth

    inspect.signature(CredentialPool.try_refresh_matching).bind(None, api_key_hint='token', credential_id='owned')
    # This older resolver remains unsuitable for forced refresh. Do not call it
    # or silently switch to a different account; the new exact-owned pool API
    # is separately exercised below rather than just checked for importability.
    assert 'force_refresh' not in inspect.signature(usage._resolve_codex_usage_credentials).parameters
    home = Path(os.environ['HERMES_HOME'])
    auth_path = home / 'auth.json'

    def jwt(account, exp):
        payload = base64.urlsafe_b64encode(json.dumps({
            'exp': exp, 'https://api.openai.com/auth': {'chatgpt_account_id': account},
        }).encode()).decode().rstrip('=')
        return f'e30.{payload}.synthetic'

    evidence = []
    for provider, source in [('openai-codex', 'device_code'), ('openai-codex', 'manual:device_code'),
                             ('anthropic', 'manual:hermes_pkce')]:
        for proactive in (False, True):
            for status in (401, 403):
                initial = jwt('account-a', 1 if proactive else 9_999_999_999) if provider == 'openai-codex' else 'synthetic-initial'
                refreshed = jwt('account-a', 9_999_999_998) if provider == 'openai-codex' else 'synthetic-refreshed'
                entry = dict(id='owned', source=source, auth_type='oauth', priority=0,
                             access_token=initial, refresh_token='synthetic-refresh',
                             expires_at_ms=1 if proactive else 9_999_999_999_000)
                store = {'version': 1, 'credential_pool': {provider: [entry]}}
                if provider == 'openai-codex':
                    store['providers'] = {provider: {'tokens': {
                        'access_token': initial, 'refresh_token': 'synthetic-refresh',
                    }}}
                auth_path.write_text(json.dumps(store))
                refreshed_payload = {'access_token': refreshed, 'refresh_token': 'synthetic-rotated',
                                     'expires_at_ms': 9_999_999_999_000}
                rejected = api.QuotaError('synthetic rejection', status=status)
                seen = []

                def transport(url, headers):
                    seen.append(headers['Authorization'])
                    if len(seen) == 1 and not proactive:
                        raise rejected
                    if provider == 'openai-codex':
                        assert headers['ChatGPT-Account-Id'] == 'account-a'
                        return {'rate_limit': {'primary_window': {'used_percent': 12, 'limit_window_seconds': 604800}}}
                    return {'seven_day': {'utilization': 12}}

                target, symbol = ((auth, 'refresh_codex_oauth_pure') if provider == 'openai-codex'
                                  else (anthropic, 'refresh_anthropic_oauth_pure'))
                with patch.object(target, symbol, return_value=refreshed_payload) as refresh, \
                     patch.object(api, 'get_json', side_effect=transport), \
                     patch.object(usage, '_resolve_codex_usage_credentials', side_effect=AssertionError('unowned resolver used')):
                    if status == 403 and not proactive:
                        try:
                            api.fetch_provider({'id': provider})
                        except api.QuotaError as exc:
                            assert exc is rejected
                        else:
                            raise AssertionError('403 was not preserved')
                        assert refresh.call_count == 0 and len(seen) == 1
                    else:
                        result = api.fetch_provider({'id': provider})
                        assert result['windows'][0]['used_percent'] == 12
                        assert refresh.call_count == 1
                        successful_reads = 3 if provider == 'anthropic' else 1  # usage + read-only reset probes
                        assert seen == ([] if proactive else [f'Bearer {initial}']) + [f'Bearer {refreshed}'] * successful_reads
                        persisted = json.loads(auth_path.read_text())
                        assert any(row['access_token'] == refreshed for row in persisted['credential_pool'][provider])
                        if provider == 'openai-codex':
                            expected_singleton = refreshed if source == 'device_code' else initial
                            assert persisted['providers'][provider]['tokens']['access_token'] == expected_singleton
                evidence.append(f'{provider}:{source}:{"proactive" if proactive else status}')

    # Missing or failing refresh must retain the original 401, not downgrade it
    # to a soft cache-retaining failure on minimum-version installations.
    initial = jwt('account-a', 9_999_999_999)
    auth_path.write_text(json.dumps({'version': 1, 'providers': {'openai-codex': {'tokens': {
        'access_token': initial, 'refresh_token': 'synthetic-refresh',
    }}}}))
    rejected = api.QuotaError('synthetic unauthorized', status=401)
    for capability in ('missing', 'transient'):
        target, symbol = ((CredentialPool, 'try_refresh_matching') if capability == 'missing'
                          else (auth, 'refresh_codex_oauth_pure'))
        refresh_patch = (patch.object(target, symbol, new=None) if capability == 'missing'
                         else patch.object(target, symbol, side_effect=TimeoutError('synthetic timeout')))
        with refresh_patch, patch.object(api, 'get_json', side_effect=rejected) as transport:
            try:
                api.fetch_provider({'id': 'openai-codex'})
            except api.QuotaError as exc:
                assert exc is rejected
            else:
                raise AssertionError('unrecoverable 401 was not preserved')
            assert transport.call_count == 1
    # Remove the guard capability only after real pool loading/selection. Core
    # cached its own lock function, so an unsafe fallback could still refresh.
    from contextlib import ExitStack
    auth_path.write_text(json.dumps({'version': 1, 'providers': {'openai-codex': {'tokens': {
        'access_token': initial, 'refresh_token': 'synthetic-refresh',
    }}}}))
    with ExitStack() as patches:
        def missing_lock(url, headers):
            patches.enter_context(patch.object(auth, '_auth_store_lock', new=None))
            raise rejected

        refresh = patches.enter_context(patch.object(auth, 'refresh_codex_oauth_pure'))
        transport = patches.enter_context(patch.object(api, 'get_json', side_effect=missing_lock))
        try:
            api.fetch_provider({'id': 'openai-codex'})
        except api.QuotaError as exc:
            assert exc is rejected
        else:
            raise AssertionError('unguarded refresh capability accepted')
        assert refresh.call_count == 0 and transport.call_count == 1
    auth_path.unlink()
    return evidence + ['401:missing-refresh-preserved', '401:transient-refresh-preserved',
                       '401:missing-lock-no-refresh']
