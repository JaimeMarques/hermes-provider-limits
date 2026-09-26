"""Subprocess-only real-release contract probe; never uses a user's profile.

Invoked by test_backend_compatibility.py with python -I -S. Third-party wheels
come from the test interpreter, but .pth/editable hooks are never executed.
"""
import ast
import importlib
import importlib.util
import inspect
import json
import os
import re
from pathlib import Path
import socket
import sys

release, plugin, mode, *wheels = sys.argv[1:]
release, plugin = Path(release).resolve(), Path(plugin).resolve()
sys.path[:] = [str(release), *wheels, *sys.path]

# No live provider requests, even if an upstream resolver changes behavior.
def no_network(*args, **kwargs):
    raise AssertionError('release compatibility probe attempted network access')
socket.create_connection = no_network
socket.socket.connect = no_network

import hermes_cli
assert Path(hermes_cli.__file__).is_relative_to(release)
assert Path(os.environ['HERMES_HOME']).is_relative_to(Path(os.environ['HOME']))
backend = plugin / 'dashboard/plugin_api.py'
spec = importlib.util.spec_from_file_location('release_limits_api', backend)
assert spec is not None and spec.loader is not None
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
try:
    spec.loader.exec_module(api)
except RuntimeError as exc:
    assert mode == 'reject', str(exc)
    assert 'requires Hermes >=0.21.3' in str(exc), str(exc)
    assert hermes_cli.__version__ in str(exc), str(exc)
    # The guard must precede all newer imports, not catch a partial startup.
    assert 'hermes_cli.config_effective' not in sys.modules
    assert 'hermes_cli.web_server_profiles' not in sys.modules
    print(json.dumps({'version': hermes_cli.__version__, 'guard': 'rejected before backend imports'}))
    sys.exit(0)

# Deliberately exercise the previously broken call before declaring rejection
# missing: the RED run reproduces the original ModuleNotFoundError verbatim.
assert api.discover() == []
assert mode == 'support', 'unsupported release was not rejected at backend import'

# Audit EVERY direct Hermes symbol used anywhere in the shipped backend, even
# imports in provider branches that an empty-profile route would not visit.
contract = []
for file in sorted((plugin / 'dashboard').glob('*.py')):
    for node in ast.walk(ast.parse(file.read_text())):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith(('hermes_cli', 'agent.', 'hermes_constants')):
            module = importlib.import_module(node.module)
            for alias in node.names:
                assert hasattr(module, alias.name), f'{node.module}.{alias.name}'
                contract.append(f'{node.module}.{alias.name}')

from agent.account_usage import _resolve_codex_usage_credentials, _codex_backend_urls, _codex_headers
from agent.anthropic_credentials import resolve_anthropic_token, _is_oauth_token
from hermes_cli.runtime_provider import resolve_runtime_provider
from hermes_cli.config_providers import _normalize_custom_provider_entry
inspect.signature(_resolve_codex_usage_credentials).bind(None, None)
# Exercise the replacement owned-OAuth adapter against real released pool
# loading, selection, locking, refresh and persistence (provider HTTP faked).
probe_spec = importlib.util.spec_from_file_location('probe_owned_oauth', plugin / 'tests/probe_owned_oauth.py')
assert probe_spec is not None and probe_spec.loader is not None
probe = importlib.util.module_from_spec(probe_spec)
probe_spec.loader.exec_module(probe)
oauth_evidence = probe.probe_owned_oauth(api)
blocker_spec = importlib.util.spec_from_file_location('probe_oauth_blockers', plugin / 'tests/probe_oauth_blockers.py')
assert blocker_spec is not None and blocker_spec.loader is not None
blockers = importlib.util.module_from_spec(blocker_spec)
blocker_spec.loader.exec_module(blockers)
oauth_evidence += blockers.probe_codex_login_change(api)
oauth_evidence += blockers.probe_codex_atomic_guard(api)
oauth_evidence += blockers.probe_anthropic_login_change(api)
oauth_evidence += blockers.probe_anthropic_singleton_login_change(api)
oauth_evidence += blockers.probe_anthropic_borrowed_singleton_login_change(api)
oauth_evidence += blockers.probe_anthropic_invalid_grant_revokes_cache(api)
inspect.signature(resolve_anthropic_token).bind()
inspect.signature(resolve_runtime_provider).bind(requested='zai')
inspect.signature(_normalize_custom_provider_entry).bind({}, provider_key='example')
assert len(_codex_backend_urls('https://chatgpt.com/backend-api')) == 3
assert _codex_headers('synthetic-token', 'synthetic-account')['Authorization'] == 'Bearer synthetic-token'
assert _is_oauth_token('sk-ant-oat01-synthetic')
assert not _is_oauth_token('not-oauth')

from fastapi import FastAPI
from fastapi.testclient import TestClient
app = FastAPI()
app.include_router(api.router)
with TestClient(app) as client:
    quota = client.get('/quota')
    assert quota.status_code == 200, quota.text
    assert quota.json()['providers'] == []
    history = client.get('/history?provider=openai-codex&q=probe')
    assert history.status_code == 404, history.text
    # An enabled provider exercises successful history/SQLite without credentials
    # or provider network calls. Config is real, scopes/imports are not mocked.
    home = Path(os.environ['HERMES_HOME'])
    (home / 'config.yaml').write_text('model:\n  provider: openai-codex\n')
    assert api.discover() == [{'id': 'openai-codex', 'route': 'openai-codex'}]
    history = client.get('/history?provider=openai-codex&q=probe')
    assert history.status_code == 200, history.text
    assert history.json()['total_sessions'] == 0
    assert not (home / 'state.db').exists()
    selected = home / 'profiles' / 'probe'
    selected.mkdir(parents=True)
    (selected / 'config.yaml').write_text('{}\n')
    scoped_quota = client.get('/quota?profile=probe')
    assert scoped_quota.status_code == 200, scoped_quota.text
    assert scoped_quota.json()['providers'] == []
    scoped_history = client.get('/history?provider=openai-codex&profile=probe')
    assert scoped_history.status_code == 404, scoped_history.text
    assert client.get('/history?provider=openai-codex').status_code == 200

# The new Desktop exports and QueryFunctionContext.client are also part of
# the minimum contract. The real QueryObserver tests use this exact core pin.
sdk = (release / 'apps/desktop/src/sdk/index.ts').read_text()
exports = set(re.findall(r'export (?:const|function|class) (\w+)', sdk))
for block in re.findall(r'export\s*\{([^}]+)\}', sdk):
    exports.update(part.strip().split(' as ')[-1] for part in block.split(','))
for name in ('atom', 'Switch', 'Popover', 'PopoverTrigger', 'PopoverContent', 'STATUSBAR_AREAS'):
    assert name in exports, f'missing SDK export {name}'
release_lock = json.loads((release / 'package-lock.json').read_text())
plugin_lock = json.loads((plugin / 'package-lock.json').read_text())
assert release_lock['packages']['node_modules/@tanstack/query-core']['version'] == plugin_lock['packages']['node_modules/@tanstack/query-core']['version']

# Prevent a partial checkout or editable host installation masking missing APIs.
for name, module in list(sys.modules.items()):
    if name == 'hermes_constants' or name == 'hermes_cli' or name.startswith(('hermes_cli.', 'agent.')):
        origin = getattr(module, '__file__', None)
        if origin:
            assert Path(origin).resolve().is_relative_to(release), (name, origin)
print(json.dumps({'version': hermes_cli.__version__, 'discovery': 'passed',
                  'routes': ['quota:200', 'history:404', 'history:200'],
                  'contract': sorted(set(contract)), 'owned_oauth': oauth_evidence}))
