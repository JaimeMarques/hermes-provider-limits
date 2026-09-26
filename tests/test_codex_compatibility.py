"""Codex ownership-aware refresh preserves the upstream 401/403 safety contract."""
import pytest

from test_quota import api
from test_oauth_refresh import FakePool, credential, synthetic_jwt


@pytest.mark.parametrize('status', [401, 403])
def test_owned_codex_refreshes_only_after_unauthorized(monkeypatch, tmp_path, status):
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'profile'))
    current = credential('openai-codex', source='device_code',
                         token=synthetic_jwt('account', exp=9_999_999_999))
    fresh = credential('openai-codex', source='device_code',
                       token=synthetic_jwt('account', exp=9_999_999_998))
    pool = FakePool(current, fresh)
    requests = []
    rejected = api.QuotaError('synthetic rejection', status=status)

    def get_json(url, headers):
        assert url == 'https://chatgpt.com/backend-api/wham/usage'
        assert headers['ChatGPT-Account-Id'] == 'account'
        requests.append(headers['Authorization'])
        if len(requests) == 1:
            raise rejected
        return {'rate_limit': {'primary_window': {'used_percent': 12, 'limit_window_seconds': 18000}}}

    monkeypatch.setattr(api._oauth_refresh, 'load_pool', lambda _provider: pool)
    monkeypatch.setattr(api, 'get_json', get_json)
    if status == 401:
        result = api.fetch_provider({'id': 'openai-codex'})
        assert result['windows'][0]['used_percent'] == 12
        assert pool.refresh_calls == [(current.access_token, current.id)]
        assert requests == [f'Bearer {current.access_token}', f'Bearer {fresh.access_token}']
    else:
        with pytest.raises(api.QuotaError) as error:
            api.fetch_provider({'id': 'openai-codex'})
        assert error.value is rejected
        assert pool.refresh_calls == []
        assert requests == [f'Bearer {current.access_token}']
