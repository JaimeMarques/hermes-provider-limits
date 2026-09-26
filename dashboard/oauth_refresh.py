"""Narrow adapter for refreshing only Hermes-owned provider OAuth grants."""
from __future__ import annotations

import base64
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from datetime import datetime
import json
import logging
import math
import threading
import time
from typing import Callable

OWNED_SOURCES = {
    "anthropic": {"hermes_pkce", "manual:hermes_pkce", "manual:dashboard_pkce"},
    "openai-codex": {"device_code", "manual:device_code"},
}
_REFRESH_MARGIN_SECONDS = 120.0
_CORE_REFRESH_LOGGERS = (
    "agent.credential_pool",
    "agent.anthropic_credentials",
    "hermes_cli.auth",
    "hermes_cli.auth_codex",
)


class OAuthFailure(Exception):
    def __init__(self, code: str, *, hard: bool = False):
        super().__init__(code)
        self.code = code
        self.hard = hard
        self.status = None
        self.retry_after = 0.0


@dataclass(frozen=True)
class OwnedOAuth:
    provider: str
    credential_id: str
    source: str
    token: str = field(repr=False)
    account_identity: str | None = field(default=None, repr=False)
    expires_at: float | None = None
    needs_refresh: bool = False


def load_pool(provider: str):
    from agent.credential_pool import load_pool as hermes_load_pool
    return hermes_load_pool(provider)


def select_without_refresh(provider: str, entries):
    """Apply Hermes selection semantics on an isolated, non-persisting view."""
    from agent.credential_pool import CredentialPool

    class SelectionView(CredentialPool):
        def _entry_needs_refresh(self, entry) -> bool:
            del entry
            return False

        def _codex_quota_restored_upstream(self, entry) -> bool:
            del entry
            return False

        def _persist(self, **_kwargs) -> None:
            return None

    return SelectionView(provider, entries).select()


def codex_singleton_tokens() -> dict:
    from hermes_cli.auth import get_provider_auth_state
    state = get_provider_auth_state("openai-codex") or {}
    tokens = state.get("tokens") if isinstance(state, dict) else None
    return tokens if isinstance(tokens, dict) else {}


@contextmanager
def _owned_refresh_guard(pool, credential: OwnedOAuth):
    """Pin the grant under core's refresh transaction locks through persistence.

    An ID names a mutable row: core can adopt a different login with that ID
    while handling an old 401. Recheck the authoritative pool row under the
    same locks core uses before permitting its resync/POST/persist path.
    """
    from hermes_cli.auth import _auth_store_lock, _global_auth_file_path

    with ExitStack() as locks:
        locks.enter_context(pool._lock)
        locks.enter_context(_auth_store_lock())
        root = _global_auth_file_path()
        if root is not None:
            locks.enter_context(_auth_store_lock(target_path=root))
        current = [entry for entry in pool.entries()
                   if getattr(entry, "id", None) == credential.credential_id
                   and getattr(entry, "source", None) == credential.source
                   and getattr(entry, "access_token", None) == credential.token]
        if len(current) != 1:
            raise OAuthFailure("account.changed", hard=True)
        if credential.provider == "anthropic":
            from agent.credential_pool import read_credential_pool
            try:
                persisted = [entry for entry in read_credential_pool("anthropic")
                             if isinstance(entry, dict) and entry.get("id") == credential.credential_id]
            except Exception:
                raise OAuthFailure("credentials.unreadable", hard=True) from None
            if (len(persisted) != 1 or persisted[0].get("source") != credential.source
                    or persisted[0].get("access_token") != credential.token
                    or persisted[0].get("refresh_token") != current[0].refresh_token):
                raise OAuthFailure("account.changed", hard=True)
            if credential.source == "hermes_pkce":
                from hermes_constants import get_default_hermes_root, get_hermes_home
                borrowed = credential.credential_id in getattr(pool, "_borrowed_root_ids", ())
                home = get_default_hermes_root() if borrowed else get_hermes_home()
                try:
                    singleton = json.loads((home / ".anthropic_oauth.json").read_text())
                except (OSError, ValueError):
                    raise OAuthFailure("credentials.unreadable", hard=True) from None
                if (not isinstance(singleton, dict)
                        or singleton.get("accessToken") != credential.token
                        or singleton.get("refreshToken") != current[0].refresh_token):
                    raise OAuthFailure("account.changed", hard=True)
        else:
            try:
                singleton = codex_singleton_tokens()
            except Exception:
                raise OAuthFailure("credentials.unreadable", hard=True) from None
            if singleton and (
                    singleton.get("access_token") != credential.token
                    or singleton.get("refresh_token") != current[0].refresh_token):
                raise OAuthFailure("auth.ownedOAuthUnavailable", hard=True)
        yield


@contextmanager
def _suppress_current_thread_refresh_logs():
    """Prevent provider-controlled refresh text from reaching shared logs."""
    thread_id = threading.get_ident()

    class CurrentThreadFilter(logging.Filter):
        def filter(self, record):
            return record.thread != thread_id

    log_filter = CurrentThreadFilter()
    loggers = [logging.getLogger(name) for name in _CORE_REFRESH_LOGGERS]
    for logger in loggers:
        logger.addFilter(log_filter)
    try:
        yield
    finally:
        for logger in loggers:
            logger.removeFilter(log_filter)


def _jwt_claims(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        result = json.loads(decoded)
        return result if isinstance(result, dict) else {}
    except (IndexError, ValueError, TypeError, UnicodeError, json.JSONDecodeError):
        return {}


def _account_identity(provider: str, token: str) -> str | None:
    if provider != "openai-codex":
        return None
    auth = _jwt_claims(token).get("https://api.openai.com/auth")
    account = auth.get("chatgpt_account_id") if isinstance(auth, dict) else None
    return account if isinstance(account, str) and account else None


def _expiry(entry, provider: str) -> float | None:
    value = getattr(entry, "expires_at_ms", None)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value) / 1000.0
    value = getattr(entry, "expires_at", None)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return parsed.timestamp()
        except (ValueError, OverflowError):
            pass
    if provider == "openai-codex":
        value = _jwt_claims(str(getattr(entry, "access_token", ""))).get("exp")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return float(value)
    return None


def _snapshot(entry, provider: str, now: float) -> OwnedOAuth:
    if entry is None:
        raise OAuthFailure("credentials.missing", hard=True)
    source = str(getattr(entry, "source", ""))
    if source not in OWNED_SOURCES.get(provider, set()):
        raise OAuthFailure("auth.ownedOAuthRequired", hard=True)
    if getattr(entry, "auth_type", None) != "oauth":
        raise OAuthFailure("auth.oauthRequired", hard=True)
    token = getattr(entry, "access_token", None)
    credential_id = getattr(entry, "id", None)
    if not isinstance(token, str) or not token or not isinstance(credential_id, str) or not credential_id:
        raise OAuthFailure("credentials.missing", hard=True)
    if getattr(entry, "last_status", None) == "dead":
        raise OAuthFailure("auth.invalidGrant", hard=True)
    account_identity = _account_identity(provider, token)
    if provider == "openai-codex" and account_identity is None:
        raise OAuthFailure("auth.accountIdentityUnavailable", hard=True)
    expires_at = _expiry(entry, provider)
    return OwnedOAuth(
        provider=provider,
        credential_id=credential_id,
        source=source,
        token=token,
        account_identity=account_identity,
        expires_at=expires_at,
        needs_refresh=expires_at is not None and expires_at <= now + _REFRESH_MARGIN_SECONDS,
    )


def _select_owned(provider: str, now: float):
    if provider not in OWNED_SOURCES:
        raise OAuthFailure("provider.oauthRefreshUnsupported", hard=True)
    try:
        pool = load_pool(provider)
        entries = pool.entries()
        selected = select_without_refresh(provider, entries)
    except OAuthFailure:
        raise
    except Exception:
        raise OAuthFailure("credentials.unreadable", hard=True) from None
    return pool, _snapshot(selected, provider, now)


def _refresh_owned(pool, credential: OwnedOAuth, now: float) -> OwnedOAuth:
    matches = [entry for entry in pool.entries()
               if getattr(entry, "id", None) == credential.credential_id
               and getattr(entry, "source", None) == credential.source
               and getattr(entry, "auth_type", None) == "oauth"
               and getattr(entry, "access_token", None) == credential.token]
    if len(matches) != 1 or not getattr(matches[0], "refresh_token", None):
        raise OAuthFailure("auth.ownedOAuthUnavailable", hard=True)
    if _account_identity(credential.provider, credential.token) != credential.account_identity:
        raise OAuthFailure("account.changed", hard=True)
    try:
        with _suppress_current_thread_refresh_logs(), _owned_refresh_guard(pool, credential):
            updated = pool.try_refresh_matching(
                api_key_hint=credential.token,
                credential_id=credential.credential_id,
            )
    except OAuthFailure:
        raise
    except Exception as exc:
        error_code = str(getattr(exc, "code", "") or "").lower()
        terminal = bool(getattr(exc, "relogin_required", False)) or any(
            marker in error_code for marker in ("invalid_grant", "refresh_token_expired")
        )
        raise OAuthFailure("auth.invalidGrant" if terminal else "auth.refreshFailed", hard=terminal) from None
    if updated is None:
        current = next((entry for entry in pool.entries()
                        if getattr(entry, "id", None) == credential.credential_id), None)
        terminal = current is None or getattr(current, "last_status", None) == "dead"
        # Released core collapses both invalid_grant and transport errors into
        # an exhausted row + None (not necessarily dead). No trustworthy error
        # classification survives. Fail closed without inventing invalidGrant;
        # a previously authorized quota must not survive this ambiguous result.
        raise OAuthFailure("auth.invalidGrant" if terminal else "auth.refreshFailed", hard=True)
    refreshed = _snapshot(updated, credential.provider, now)
    current_rows = [entry for entry in pool.entries()
                    if getattr(entry, "id", None) == credential.credential_id]
    current = _snapshot(current_rows[0], credential.provider, now) if len(current_rows) == 1 else None
    if (refreshed.credential_id != credential.credential_id
            or refreshed.source != credential.source
            or current is None
            or current.credential_id != credential.credential_id
            or current.source != credential.source
            or current.token != refreshed.token
            or refreshed.account_identity != credential.account_identity
            or current.account_identity != credential.account_identity):
        raise OAuthFailure("account.changed", hard=True)
    return refreshed


def request_with_owned_oauth(provider: str, request: Callable[[OwnedOAuth], dict],
                             *, now: Callable[[], float] = time.time) -> dict:
    pool, credential = _select_owned(provider, now())
    refreshed = False
    if credential.needs_refresh:
        credential = _refresh_owned(pool, credential, now())
        refreshed = True
    try:
        return request(credential)
    except Exception as exc:
        if getattr(exc, "status", None) != 401 or refreshed:
            raise
        try:
            credential = _refresh_owned(pool, credential, now())
        except OAuthFailure as refresh_error:
            if refresh_error.hard and refresh_error.code != "auth.refreshFailed":
                raise
            # A rejected access token is not a soft transport outage. Preserve
            # the original 401 if refresh is transient, unclassified, or the
            # host lacks its exact-match capability; never revive stale quota.
            raise exc from None
    return request(credential)
