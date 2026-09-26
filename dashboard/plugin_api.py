"""Read-only account quotas. Provider secrets never cross the renderer boundary."""
from __future__ import annotations

import asyncio
from email.utils import parsedate_to_datetime
import hashlib
import importlib.util
import json
import math
import re
import sys

import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from hermes_cli import __version__ as _hermes_version
from packaging.version import InvalidVersion, Version

# Old loaders ignore requires_hermes. Refuse backend import before registering
# routes or touching profile/credential APIs that those runtimes do not ship.
try:
    _supported_hermes = Version(_hermes_version) >= Version('0.21.3')
except InvalidVersion:
    _supported_hermes = False
if not _supported_hermes:
    raise RuntimeError(
        f'Provider Limits requires Hermes >=0.21.3; found {_hermes_version}. '
        'Upgrade Hermes before enabling this plugin.'
    )

from fastapi import APIRouter, HTTPException, Query

_history_spec = importlib.util.spec_from_file_location(__name__ + '_history', Path(__file__).with_name('history.py'))
_history = importlib.util.module_from_spec(_history_spec)
sys.modules[_history_spec.name] = _history
_history_spec.loader.exec_module(_history)

_cache_spec = importlib.util.spec_from_file_location(__name__ + '_quota_cache', Path(__file__).with_name('quota_cache.py'))
_quota_cache_module = importlib.util.module_from_spec(_cache_spec)
sys.modules[_cache_spec.name] = _quota_cache_module
_cache_spec.loader.exec_module(_quota_cache_module)
QuotaCache = _quota_cache_module.QuotaCache

_oauth_spec = importlib.util.spec_from_file_location(__name__ + '_oauth_refresh', Path(__file__).with_name('oauth_refresh.py'))
_oauth_refresh = importlib.util.module_from_spec(_oauth_spec)
sys.modules[_oauth_spec.name] = _oauth_refresh
_oauth_spec.loader.exec_module(_oauth_refresh)
request_with_owned_oauth = _oauth_refresh.request_with_owned_oauth

router = APIRouter()
TTL = 60
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
NAMES = {"openai-codex": "Codex", "anthropic": "Claude", "deepseekv4pro": "DeepSeek V4 Pro", "zai": "GLM · Z.ai"}
LINKS = {"openai-codex": "https://chatgpt.com/codex/settings/usage", "anthropic": "https://claude.ai/settings/usage", "deepseekv4pro": "https://deepseekv4pro.com/dashboard", "zai": "https://z.ai/manage-apikey/subscription"}
_quota_cache = QuotaCache()
PROBLEM_PARAM_KEYS = {"upstream.http": frozenset({"status"})}


class QuotaError(Exception):
    """Only static, credential-free messages and allowlisted problem metadata are exposed."""

    def __init__(self, message, status=None, *, code="provider.fetchFailed", params=None,
                 retryable=None, retry_after=0.0, hard=False):
        super().__init__(message)
        self.status = status
        self.code = code
        self.params = dict(params or {})
        self.retryable = bool(status == 429) if retryable is None else bool(retryable)
        self.retry_after = retry_after
        self.hard = hard

    def problem(self):
        allowed = PROBLEM_PARAM_KEYS.get(self.code, ())
        params = {key: self.params[key] for key in allowed if key in self.params}
        return {"code": self.code, "params": params, "retryable": self.retryable}


def number(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def stamp(value):
    if value in (None, ""):
        return None
    try:
        n = number(value)
        if n is not None:
            if n <= 0:
                return None
            return datetime.fromtimestamp(n / 1000 if n > 1e11 else n, timezone.utc).isoformat()
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.replace(tzinfo=dt.tzinfo or timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def display_message(code, *args):
    value = {"kind": "message", "code": code}
    if args:
        value["args"] = list(args)
    return value


def display_literal(value):
    return {"kind": "literal", "value": str(value)}


def period_display(seconds):
    n = number(seconds)
    if n is None or n <= 0:
        return display_message("window.unspecified")
    for size, unit in ((86400, "day"), (3600, "hour"), (60, "minute")):
        if n % size == 0:
            return {"kind": "period", "value": n / size, "unit": unit}
    return {"kind": "period", "value": n, "unit": "second"}


def duration(seconds):
    n = number(seconds)
    if n is None or n <= 0:
        return "Janela não indicada"
    for size, unit in ((86400, "d"), (3600, "h"), (60, "min")):
        if n % size == 0:
            return f"{n / size:g} {unit}"
    return f"{n:g} s"


def window(key, label, group="Geral", *, used=None, limit=None, remaining=None,
           percent=None, reset=None, period=None, unit="%", details=None, unlimited=False,
           label_display=None, group_display=None, unit_code="percent", period_seconds=None):
    used, limit, remaining, percent = map(number, (used, limit, remaining, percent))
    period_seconds = number(period_seconds)
    if period_seconds is not None and period_seconds <= 0:
        period_seconds = None
    if remaining is None and limit is not None and used is not None:
        remaining = max(0, limit - used)
    if used is None and limit is not None and remaining is not None:
        used = max(0, limit - remaining)
    if percent is None and used is not None and limit is not None and limit > 0:
        percent = used / limit * 100
    # A missing numeric value stays unknown, never zero; overage stays visible.
    if percent is not None and percent < 0:
        percent = None
    return {"id": key, "label": label, "group": group, "used": used, "limit": limit,
            "remaining": remaining, "used_percent": percent,
            "remaining_percent": max(0, 100 - percent) if percent is not None else None,
            "reset_at": stamp(reset), "period": period, "period_seconds": period_seconds, "unit": unit,
            "details": details or [], "unlimited": unlimited,
            "display": {"label": label_display or display_literal(label),
                        "group": group_display or display_literal(group)},
            "unit_code": unit_code}


def fact(label, value, *, label_display=None, value_display=None, unit_code=None):
    result = {"label": label, "value": value,
              "display": {"label": label_display or display_literal(label)}}
    if value_display is not None:
        result["display"]["value"] = value_display
    if unit_code is not None:
        result["unit_code"] = unit_code
    return result


def reset_count(value):
    """Counts cross JSON into JavaScript: reject coercion and unsafe integers."""
    return int(value) if type(value) in (int, float) and 0 <= value < 2**53 and int(value) == value else None


def normalize_codex(payload):
    windows, facts = [], []
    groups = [("codex", "Codex", display_literal("Codex"), payload.get("rate_limit")),
              ("review", "Revisão de código", display_message("group.codeReview"), payload.get("code_review_rate_limit"))]
    for i, item in enumerate(payload.get("additional_rate_limits") or []):
        if isinstance(item, dict):
            raw_group = item.get("limit_name") or item.get("metered_feature")
            group = str(raw_group or "Limite adicional")
            group_display = display_literal(raw_group) if raw_group else display_message("group.additionalLimit")
            groups.append((f"additional-{i}", group, group_display, item.get("rate_limit")))
    for prefix, group, group_display, limits in groups:
        if not isinstance(limits, dict):
            continue
        for key, row in limits.items():
            if not isinstance(row, dict) or not key.endswith("window"):
                continue
            seconds = row.get("limit_window_seconds")
            label = duration(seconds)
            windows.append(window(f"{prefix}-{key}", label, group, percent=row.get("used_percent"),
                                  reset=row.get("reset_at"), period=label, period_seconds=seconds,
                                  label_display=period_display(seconds), group_display=group_display))
    credits = payload.get("credits") or {}
    if credits.get("unlimited"):
        facts.append(fact("Créditos adicionais", "Ilimitados",
                          label_display=display_message("fact.additionalCredits"),
                          value_display=display_message("value.unlimited"), unit_code="api_credit"))
    elif number(credits.get("balance")) is not None:
        facts.append(fact("Créditos adicionais", credits["balance"],
                          label_display=display_message("fact.additionalCredits"), unit_code="api_credit"))
    resets = payload.get("rate_limit_reset_credits")
    count = reset_count(resets.get("available_count")) if isinstance(resets, dict) else None
    if count is not None:
        facts.append(fact("Reposições disponíveis", count,
                          label_display=display_message("fact.availableResets")))
    spend = payload.get("spend_control") or {}
    if number(spend.get("individual_limit")) is not None:
        facts.append(fact("Limite individual de despesa", spend["individual_limit"],
                          label_display=display_message("fact.individualSpendLimit")))
    return {"windows": windows, "facts": facts, "plan": payload.get("plan_type"), "source": "chatgpt.com · wham/usage"}


def claude_reset_count(payload):
    """Read evaluated OAuth offers, not scheduled reset times (see README sources)."""
    cedar = payload.get("cedar_ember")
    count = None
    if isinstance(cedar, dict) and cedar.get("eligible") is True and isinstance(cedar.get("grants"), list):
        count, seen = 0, {}
        now = datetime.now(timezone.utc)
        for grant in cedar["grants"]:
            if not isinstance(grant, dict):
                return None
            grant_id = grant.get("id")
            if not isinstance(grant_id, str) or not re.fullmatch(r"[a-z0-9_-]{1,40}", grant_id):
                return None
            remaining = reset_count(grant.get("resets_left"))
            total = reset_count(grant.get("resets_total"))
            if remaining is None or ("resets_total" in grant and (total is None or total < remaining)):
                return None
            dates = []
            for field in ("starts_at", "ends_at"):
                raw = grant.get(field)
                if raw is None:
                    dates.append(None)
                    continue
                if not isinstance(raw, str) or not raw.strip():
                    return None
                try:
                    date = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
                except ValueError:
                    return None
                dates.append(date.replace(tzinfo=date.tzinfo or timezone.utc))
            start, expiry = dates
            if start is not None and expiry is not None and start >= expiry:
                return None
            if grant_id in seen:
                if seen[grant_id] != grant:
                    return None
                continue
            seen[grant_id] = grant
            # starts_at is the grant's start, not the next automatic quota reset.
            # Count banked inventory, not usable_now (which is wall/cooldown gated).
            if (start is None or start <= now) and (expiry is None or expiry > now):
                count += remaining
        if count > 0:
            return reset_count(count)
    juniper = payload.get("juniper_tide")
    if (isinstance(juniper, dict) and juniper.get("eligible") is True
            and juniper.get("arm") == "reset" and type(juniper.get("available")) is bool):
        if juniper["available"]:
            return 1
        if count == 0:
            return 0
    # A zero needs both inventories evaluated. Null or surface-gated programs
    # leave discovery incomplete even when the other program reports zero.
    return None


def normalize_claude(payload):
    labels = {"five_hour": ("5 h", {"kind": "period", "value": 5, "unit": "hour"}),
              "seven_day": ("7 d", {"kind": "period", "value": 7, "unit": "day"}),
              "seven_day_opus": ("Opus · 7 d", display_message("window.modelPeriod", "Opus", 7, "day")),
              "seven_day_sonnet": ("Sonnet · 7 d", display_message("window.modelPeriod", "Sonnet", 7, "day")),
              "seven_day_oauth_apps": ("Apps OAuth · 7 d", display_message("window.oauthAppsPeriod", 7, "day"))}
    windows, facts = [], []
    for key, row in payload.items():
        if key in {"extra_usage", "nimbus_quill"} or not isinstance(row, dict) or "utilization" not in row:
            continue
        legacy, label_display = labels.get(key, (key.replace("_", " "), display_literal(key.replace("_", " "))))
        period_seconds = 18000 if key == "five_hour" else (604800 if key.startswith("seven_day") else None)
        # Anthropic utilization is already a percentage: 0.5 means 0.5%, NOT 50%.
        windows.append(window(key, legacy, "Claude", percent=row.get("utilization"), reset=row.get("resets_at"),
                              label_display=label_display, group_display=display_literal("Claude"),
                              period_seconds=period_seconds))
    limits = payload.get("limits")
    for limit in limits if isinstance(limits, list) else []:
        if not isinstance(limit, dict) or limit.get("kind") != "weekly_scoped":
            continue
        scope = limit.get("scope")
        if not isinstance(scope, dict):
            continue
        model = scope.get("model")
        if not isinstance(model, dict):
            continue
        model_name = model.get("display_name")
        percent = number(limit.get("percent"))
        if not isinstance(model_name, str) or not model_name.strip() or percent is None:
            continue
        model_name = model_name.strip()
        model_slug = "_".join(part for part in "".join(
            character.lower() if character.isalnum() else " " for character in model_name
        ).split() if part)
        # Display names are not identities: distinct surfaces/models can share
        # one name or normalize to the same slug. Never merge those buckets.
        base_key = f"weekly_scoped_{model_slug or 'model'}"
        key, suffix = base_key, 2
        used_ids = {item['id'] for item in windows}
        while key in used_ids:
            key = f"{base_key}_{suffix}"
            suffix += 1
        windows.append(window(key, f"{model_name} · 7 d", "Claude",
                              percent=percent, reset=limit.get("resets_at"),
                              label_display=display_message("window.modelPeriod", model_name, 7, "day"),
                              group_display=display_literal("Claude"), period_seconds=604800))
    extra = payload.get("extra_usage") or {}
    if extra.get("is_enabled"):
        currency = extra.get("currency")
        windows.append(window("extra_usage", "Utilização extra mensal", "Claude",
                              used=extra.get("used_credits"), limit=extra.get("monthly_limit"),
                              percent=extra.get("utilization"), reset=extra.get("resets_at"),
                              unit=str(currency or "créditos (API)"),
                              label_display=display_message("window.extraUsageMonthly"),
                              group_display=display_literal("Claude"),
                              unit_code="currency" if currency else "api_credit"))
        if currency:
            windows[-1]["currency_code"] = str(currency).upper()
            places = number(extra.get("decimal_places"))
            if places is not None and places.is_integer() and 0 <= places <= 9:
                windows[-1]["decimal_places"] = int(places)
    elif "is_enabled" in extra:
        facts.append(fact("Utilização extra", "Desativada",
                          label_display=display_message("fact.extraUsage"),
                          value_display=display_message("value.disabled")))
    count = claude_reset_count(payload)
    if count is not None:
        facts.append(fact("Reposições disponíveis", count,
                          label_display=display_message("fact.availableResets")))
    return {"windows": windows, "facts": facts, "plan": None, "source": "api.anthropic.com · oauth/usage"}


def normalize_zai(payload):
    data = payload.get("data", payload)
    if not isinstance(data, dict) or not isinstance(data.get("limits"), list):
        raise QuotaError("A API da Z.ai não devolveu os limites esperados.",
                         code="response.unexpectedShape", retryable=False)
    windows = []
    for i, row in enumerate(data["limits"]):
        if not isinstance(row, dict):
            continue
        kind = row.get("type", "Limite")
        unit, count = number(row.get("unit")), number(row.get("number"))
        period_units = {1: ("min", "minute"), 3: ("h", "hour"), 4: ("d", "day"), 5: ("mês", "month"), 6: ("semana", "week")}
        period_multipliers = {1.0: 60, 3.0: 3600, 4.0: 86400, 6.0: 604800}
        legacy_unit, semantic_unit = period_units.get(unit, ("unid. de período", None))
        period = f"{count:g} {legacy_unit}" if count is not None else "Período não indicado"
        label = {"TOKENS_LIMIT": "Tokens", "TIME_LIMIT": "Ferramentas / MCP"}.get(kind, str(kind))
        group_display = ({"TOKENS_LIMIT": display_message("group.tokens"),
                          "CREDIT_LIMIT": display_message("group.credits"),
                          "TIME_LIMIT": display_message("group.toolsMcp")}.get(kind, display_literal(kind)))
        if count is None:
            label_display = display_message("period.unspecified")
        elif semantic_unit:
            label_display = {"kind": "period", "value": count, "unit": semantic_unit}
        else:
            label_display = display_message("period.units", count)
        cap = row.get("total") if "total" in row else row.get("usage")
        unit_code = {"TIME_LIMIT": "call", "CREDIT_LIMIT": "credit",
                     "TOKENS_LIMIT": "token"}.get(kind, "unknown")
        details = [fact(str(d.get("modelCode", "Ferramenta")), d["usage"],
                        label_display=(display_literal(d["modelCode"]) if d.get("modelCode")
                                       else display_message("detail.tool")),
                        unit_code=unit_code)
                   for d in row.get("usageDetails", []) if isinstance(d, dict) and number(d.get("usage")) is not None]
        windows.append(window(f"{kind}-{i}", period, label, used=row.get("currentValue"),
                              limit=cap, remaining=row.get("remaining"), percent=row.get("percentage"),
                              reset=row.get("nextResetTime"), period=period,
                              unit="chamadas" if kind == "TIME_LIMIT" else "tokens", details=details,
                              label_display=label_display, group_display=group_display,
                              unit_code=unit_code,
                              period_seconds=(count * period_multipliers[unit]
                                              if count is not None and unit in period_multipliers else None)))
    return {"windows": windows, "facts": [], "plan": data.get("level"), "source": "api.z.ai · monitor/usage/quota/limit"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Quota credentials never follow redirects, even within a provider.
        raise QuotaError("O endpoint de utilização mudou de endereço; pedido interrompido por segurança.",
                         code="security.redirectBlocked", retryable=False)


def get_json(url, headers):
    parsed = urllib.parse.urlsplit(url)
    allowed = {"chatgpt.com", "api.anthropic.com", "api.z.ai", "open.bigmodel.cn", "api.deepseekv4pro.com", "deepseekv4pro.com"}
    if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.port not in (None, 443):
        raise QuotaError("Endpoint de utilização não autorizado.",
                         code="security.endpointNotAllowed", retryable=False)
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": UA, **headers})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise QuotaError("Resposta de utilização demasiado grande.",
                                 code="response.tooLarge", retryable=False)
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise QuotaError("Resposta de utilização inválida.",
                                 code="response.unexpectedShape", retryable=False)
            return result
    except urllib.error.HTTPError as exc:
        # Never expose bodies/URLs: some providers echo credentials in them.
        messages = {401: "Autenticação expirada ou recusada. Verifique o fornecedor no Hermes.",
                    403: "O fornecedor recusou acesso aos dados de utilização.",
                    429: "Pedidos de utilização temporariamente limitados pelo fornecedor."}
        codes = {401: "auth.rejected", 403: "auth.forbidden", 429: "upstream.rateLimited"}
        retry_after = 0.0
        if exc.code == 429:
            value = exc.headers.get("Retry-After", 0)
            try:
                retry_after = float(value)
            except (TypeError, ValueError):
                try:
                    retry_at = parsedate_to_datetime(str(value))
                    if retry_at.tzinfo is None:
                        retry_at = retry_at.replace(tzinfo=timezone.utc)
                    retry_after = (retry_at - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError, OverflowError):
                    retry_after = 0.0
            if not math.isfinite(retry_after):
                retry_after = 0.0
        raise QuotaError(messages.get(exc.code, f"A API de utilização respondeu HTTP {exc.code}."),
                         status=exc.code, code=codes.get(exc.code, "upstream.http"),
                         params={"status": exc.code}, retryable=exc.code == 429 or exc.code >= 500,
                         retry_after=max(0.0, retry_after)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise QuotaError("Não foi possível contactar a API de utilização. Tente novamente dentro de um minuto.",
                         code="network.unreachable", retryable=True) from None
    except (ValueError, UnicodeError):
        raise QuotaError("O fornecedor não devolveu JSON de utilização válido.",
                         code="response.invalidJson", retryable=False) from None


def _read_auth(home):
    try:
        return json.loads((home / "auth.json").read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise QuotaError("Não foi possível ler as credenciais do perfil Hermes.",
                         code="credentials.unreadable", retryable=False) from None


def enabled_custom_routes(cfg):
    from hermes_cli.config_providers import is_provider_enabled, _normalize_custom_provider_entry

    def identity(entry):
        url = urllib.parse.urlsplit(entry["base_url"])
        return url._replace(scheme=url.scheme.lower(), netloc=url.netloc.lower(), path=url.path.rstrip("/"), fragment="").geturl()

    # Canonical route declarations supersede legacy duplicates, but disabling one
    # named entry must not veto a separate enabled entry sharing the same host.
    declared_routes, active = set(), []
    for key, raw in (cfg.get("providers") or {}).items():
        if not isinstance(raw, dict):
            continue
        entry = _normalize_custom_provider_entry({k: v for k, v in raw.items() if k != "enabled"}, provider_key=key)
        if entry:
            declared_routes.add(identity(entry))
            if is_provider_enabled(raw):
                active.append(entry)
    for raw in cfg.get("custom_providers") or []:
        if not isinstance(raw, dict) or not is_provider_enabled(raw):
            continue
        entry = _normalize_custom_provider_entry({k: v for k, v in raw.items() if k != "enabled"})
        if entry and identity(entry) not in declared_routes:
            active.append(entry)
    return active


def discover():
    """Current profile's configured/enabled providers only; never scan other homes."""
    from hermes_constants import get_hermes_home
    from hermes_cli.config_effective import load_user_config_effective
    from agent.secret_scope import get_secret
    from hermes_cli.config_providers import is_provider_enabled
    cfg = load_user_config_effective()
    auth = _read_auth(get_hermes_home())
    configs, auths, pools = cfg.get("providers") or {}, auth.get("providers") or {}, auth.get("credential_pool") or {}
    model = cfg.get("model") or {}
    main = model.get("provider") if isinstance(model, dict) else None
    envs = {"anthropic": ("ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"), "zai": ("ZAI_API_KEY", "Z_AI_API_KEY")}
    result = []
    for provider in ("openai-codex", "anthropic", "zai"):
        pc, ac = configs.get(provider) or {}, auths.get(provider) or {}
        if not is_provider_enabled(pc) or not is_provider_enabled(ac):
            continue
        enabled = bool(pc or ac or pools.get(provider) or main == provider or any(get_secret(k, "") for k in envs.get(provider, ())))
        if enabled:
            result.append({"id": provider, "route": provider})
    # Endpoint identity, not model name or a substring, identifies reseller credentials.
    hosts = {"api.deepseekv4pro.com": "deepseekv4pro", "deepseekv4pro.com": "deepseekv4pro", "api.z.ai": "zai", "open.bigmodel.cn": "zai"}
    seen = {row["id"] for row in result}
    for p in enabled_custom_routes(cfg):
        host = urllib.parse.urlsplit(p.get("base_url", "")).hostname
        kind = hosts.get(host)
        if kind is None or kind in seen:
            continue
        seen.add(kind)
        result.append({"id": kind, "route": p.get("provider_key") or p["name"], "base_url": p["base_url"]})
    return result


def fetch_provider(provider):
    kind = provider["id"]
    if kind == "openai-codex":
        def fetch_codex(credential):
            headers = {"Authorization": f"Bearer {credential.token}", "User-Agent": "codex-cli"}
            if credential.account_identity:
                headers["ChatGPT-Account-Id"] = credential.account_identity
            return normalize_codex(get_json("https://chatgpt.com/backend-api/wham/usage", headers))

        return request_with_owned_oauth("openai-codex", fetch_codex)
    if kind == "anthropic":
        def fetch_claude(credential):
            url = "https://api.anthropic.com/api/oauth/usage"
            headers = {"Authorization": f"Bearer {credential.token}", "anthropic-beta": "oauth-2025-04-20",
                       "User-Agent": "claude-code/2.1.0"}
            payload = get_json(url, headers)
            retry_after = None
            # Read-only discovery belongs to this same credential and quota cache.
            # Never infer zero from the unevaluated null blocks in plain /usage.
            if claude_reset_count(payload) is None:
                try:
                    for field, query in (("cedar_ember", "cedar_ember=1"), ("juniper_tide", "at_wall=1")):
                        probe = get_json(f"{url}?{query}&skip_spend=1", headers)
                        payload[field] = probe.get(field)
                        if (claude_reset_count(payload) or 0) > 0:
                            break
                except QuotaError as exc:
                    if exc.status in (401, 403) or exc.hard:
                        raise
                    # Optional discovery failure must not hide ordinary quotas.
                    payload.pop("cedar_ember", None)
                    payload.pop("juniper_tide", None)
                    if exc.status == 429:
                        retry_after = exc.retry_after
            result = normalize_claude(payload)
            if retry_after is not None:
                # Internal cache metadata, removed before serialization.
                result["_rate_limit_retry_after"] = retry_after
            return result

        return request_with_owned_oauth("anthropic", fetch_claude)
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime = resolve_runtime_provider(requested=provider["route"])
    token = runtime.get("api_key")
    if not isinstance(token, str) or not token:
        raise QuotaError("Não existe uma chave utilizável para este fornecedor no perfil Hermes.",
                         code="credentials.missing", retryable=False)
    host = urllib.parse.urlsplit(runtime.get("base_url") or provider.get("base_url") or "").hostname
    if kind == "zai":
        if host not in ("api.z.ai", "open.bigmodel.cn"):
            raise QuotaError("O endereço GLM configurado não corresponde à Z.ai/Zhipu.",
                             code="provider.endpointMismatch", retryable=False)
        data = get_json(f"https://{host}/api/monitor/usage/quota/limit", {"Authorization": token})
        if data.get("success") is False:
            raise QuotaError("A Z.ai não aceitou a consulta da quota do Coding Plan.",
                             code="provider.queryRejected", retryable=False)
        return normalize_zai(data)
    if host not in ("api.deepseekv4pro.com", "deepseekv4pro.com"):
        raise QuotaError("A credencial não pertence ao endpoint deepseekv4pro.com configurado.",
                         code="provider.endpointMismatch", retryable=False)
    return fetch_deepseek(token)


def normalize_deepseek(payload):
    if not isinstance(payload.get("plans"), list):
        raise QuotaError("O dashboard DeepSeek não devolveu a lista de planos esperada.",
                         code="response.unexpectedShape", retryable=False)
    windows, facts, names, plan_displays = [], [], [], []
    for i, plan in enumerate(payload["plans"]):
        if not isinstance(plan, dict):
            continue
        name_raw = plan.get("planName") or plan.get("planSlug")
        name = str(name_raw or f"Plano {i + 1}")
        name_display = display_literal(name_raw) if name_raw else display_message("plan.unnamed", i + 1)
        names.append(name)
        plan_displays.append(name_display)
        quota = plan.get("quota")
        if plan.get("quotaStatus") == "unavailable" or not isinstance(quota, dict):
            facts.append(fact(name, "Quota indisponível no fornecedor", label_display=name_display,
                              value_display=display_message("value.providerQuotaUnavailable")))
            continue
        for key, row in quota.items():
            if not isinstance(row, dict) or not any(k in row for k in ("limitCredits", "usedCredits", "remainingCredits")):
                continue
            label = {"fiveHour": "5 h", "sevenDay": "7 d"}.get(key, key)
            label_display = ({"fiveHour": {"kind": "period", "value": 5, "unit": "hour"},
                              "sevenDay": {"kind": "period", "value": 7, "unit": "day"}}
                             .get(key, display_literal(key)))
            details = [] if row.get("resetAt") else [fact("Início da janela", "No primeiro pedido",
                        label_display=display_message("fact.windowStart"),
                        value_display=display_message("value.firstRequest"))]
            windows.append(window(f"plan-{i}-{key}", label, name, used=row.get("usedCredits"),
                                  limit=row.get("limitCredits"), remaining=row.get("remainingCredits"),
                                  reset=row.get("resetAt"), unit="créditos", details=details,
                                  label_display=label_display, group_display=name_display,
                                  unit_code="flash_credit",
                                  period_seconds={"fiveHour": 18000, "sevenDay": 604800}.get(key)))
        for model, usage in (quota.get("usageByModel") or {}).items():
            if isinstance(usage, dict) and number(usage.get("chargedCredits")) is not None:
                label_display = (display_message("fact.modelChargedCredits", name, model)
                                 if name_raw else
                                 display_message("fact.unnamedPlanModelChargedCredits", i + 1, model))
                facts.append(fact(f"{name} · {model} · créditos debitados", usage["chargedCredits"],
                                  label_display=label_display,
                                  unit_code="flash_credit"))
        if plan.get("currentPeriodEnd"):
            value = stamp(plan["currentPeriodEnd"])
            label_display = (display_message("fact.periodEnd", name)
                             if name_raw else display_message("fact.unnamedPlanPeriodEnd", i + 1))
            facts.append(fact(f"{name} · fim do período", value or "Não indicado",
                              label_display=label_display,
                              value_display=({"kind": "timestamp", "value": value}
                                             if value else display_message("value.notIndicated"))))
    if windows:
        facts.append(fact("Unidade do plano", "Créditos Flash-equivalentes; não USD",
                          label_display=display_message("fact.planUnit"),
                          value_display=display_message("value.flashEquivalentCredits")))
    return {"windows": windows, "facts": facts, "plan": " / ".join(names) or None,
            "plan_display": {"kind": "list", "items": plan_displays} if plan_displays else None,
            "source": "deepseekv4pro.com · api/quota/me"}


def fetch_deepseek(token):
    try:
        payload = get_json("https://deepseekv4pro.com/api/quota/me", {"Authorization": f"Bearer {token}"})
    except QuotaError as exc:
        if exc.status in (401, 403):
            raise QuotaError("A quota requer sessão iniciada no site deepseekv4pro.com; a API key do Hermes não dá acesso a estes dados. Consulte «Abrir no fornecedor». Nenhuma quota foi estimada.",
                             status=exc.status, code="provider.siteSessionRequired", retryable=False) from None
        raise
    return normalize_deepseek(payload)


def _signature(home):
    # Hash stays server-side, isolates cache on credential/config change.
    digest = hashlib.sha256()
    from hermes_constants import get_default_hermes_root
    paths = [home / name for name in ("config.yaml", "auth.json", ".env", ".anthropic_oauth.json")]
    root = get_default_hermes_root()
    if root.resolve() != home.resolve():
        # Hermes can borrow the default profile's OAuth pool/auth singleton.
        # A root login/logout must invalidate a named profile's cached quota
        # even when nothing in that named profile's directory has changed.
        paths.extend((root / "auth.json", root / ".anthropic_oauth.json"))
    for path in paths:
        if path.is_file():
            digest.update(str(path).encode())
            digest.update(path.read_bytes())
    from agent.secret_scope import current_secret_scope
    digest.update(json.dumps(dict(current_secret_scope() or {}), sort_keys=True).encode())
    return digest.hexdigest()


_PROBLEM_COPY = {
    "account.changed": "A conta selecionada mudou durante a atualização; os dados anteriores foram revogados.",
    "auth.accountIdentityUnavailable": "Não foi possível verificar a identidade da conta OAuth selecionada.",
    "auth.invalidGrant": "A sessão OAuth expirou e requer nova autenticação no Hermes.",
    "auth.ownedOAuthRequired": "Os limites requerem uma sessão OAuth pertencente a este perfil Hermes.",
    "auth.ownedOAuthUnavailable": "A sessão OAuth selecionada não pode ser atualizada com segurança.",
    "auth.refreshFailed": "Não foi possível atualizar temporariamente a sessão OAuth.",
    "auth.rejected": "Autenticação expirada ou recusada. Verifique o fornecedor no Hermes.",
    "auth.forbidden": "O fornecedor recusou acesso aos dados de utilização.",
    "credentials.missing": "Não existe uma credencial utilizável para este fornecedor no perfil Hermes.",
    "credentials.unreadable": "Não foi possível ler as credenciais do perfil Hermes.",
    "network.unreachable": "Não foi possível contactar a API de utilização. Tente novamente dentro de um minuto.",
    "provider.noLimits": "O fornecedor não devolveu limites ou saldos para esta conta.",
    "upstream.rateLimited": "Pedidos de utilização temporariamente limitados pelo fornecedor.",
}


def _problem_from_code(code):
    retryable = code in {
        "auth.refreshFailed", "network.unreachable", "upstream.rateLimited", "provider.fetchFailed",
    } or code == "upstream.http"
    return {"code": code, "params": {}, "retryable": retryable}


def cached_provider(provider, scope):
    base = {"id": provider["id"], "name": NAMES[provider["id"]], "url": LINKS[provider["id"]],
            "status": "ok", "windows": [], "facts": [], "plan": None, "plan_display": None, "source": None,
            "fetched_at": None, "age_seconds": None, "next_refresh_at": None,
            "error": None, "problem": None}

    def fetch_nonempty():
        data = fetch_provider(provider)
        if not data.get("windows") and not data.get("facts"):
            raise QuotaError("O fornecedor não devolveu limites ou saldos para esta conta.",
                             code="provider.noLimits", retryable=False)
        return data

    identity_key = "\0".join(str(part) for part in scope)
    view = _quota_cache.get(provider["id"], identity_key, fetch_nonempty)
    if view.good is not None:
        base.update(view.good)
    base["status"] = "ok" if view.status in {"fresh", "cached"} else view.status
    base["fetched_at"] = (datetime.fromtimestamp(view.fetched_at, timezone.utc).isoformat()
                          if view.fetched_at is not None else None)
    base["age_seconds"] = view.age_seconds
    base["next_refresh_at"] = datetime.fromtimestamp(view.next_refresh_at, timezone.utc).isoformat()
    if view.problem_code:
        base["error"] = _PROBLEM_COPY.get(
            view.problem_code,
            "Não foi possível obter a utilização com as credenciais deste perfil. Verifique o fornecedor no Hermes.",
        )
        base["problem"] = _problem_from_code(view.problem_code)
    return base


@router.get("/quota")
async def quota(profile: str | None = Query(default=None, max_length=100)):
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_constants import get_hermes_home
    with _config_profile_scope(profile):
        home = get_hermes_home()
        profile_name = profile or "current"
        profile_identity = {
            "name": profile_name,
            "id": hashlib.sha256(str(home.resolve()).encode()).hexdigest(),
        }
        try:
            providers = await asyncio.to_thread(discover)
            scope = (profile_identity["id"], await asyncio.to_thread(_signature, home))
            rows = await asyncio.gather(*(asyncio.to_thread(cached_provider, p, scope) for p in providers))
        except QuotaError as exc:
            return {"schema_version": 3, "providers": [], "error": str(exc), "problem": exc.problem(),
                    "profile": profile_name, "profile_identity": profile_identity,
                    "refresh_seconds": TTL, "checked_at": datetime.now(timezone.utc).isoformat()}
        return {"schema_version": 3, "providers": rows, "profile": profile_name,
                "profile_identity": profile_identity, "refresh_seconds": TTL,
                "checked_at": datetime.now(timezone.utc).isoformat(), "error": None, "problem": None}


@router.get('/history')
async def history(
    provider: Literal['openai-codex', 'anthropic', 'deepseekv4pro', 'zai'],
    profile: str | None = Query(default=None, max_length=100),
    q: str = Query(default='', max_length=200),
    model: str = Query(default='', max_length=200),
    model_missing: bool | None = Query(default=None),
    sort: Literal['tokens', 'recent'] = 'tokens',
    offset: int = Query(default=0, ge=0, le=1_000_000),
    limit: int = Query(default=25, ge=1, le=100),
):
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_constants import get_hermes_home
    with _config_profile_scope(profile):
        if provider not in {p['id'] for p in await asyncio.to_thread(discover)}:
            raise HTTPException(
                status_code=404,
                detail='Fornecedor não ativo neste perfil.',
                headers={'X-Problem-Code': 'history.providerInactive'},
            )
        result = await asyncio.to_thread(_history.load_history, get_hermes_home() / 'state.db', provider,
                                         query=q, model=model, model_missing=model_missing,
                                         sort=sort, offset=offset, limit=limit)
        return {**result, 'profile': profile or 'current', 'checked_at': datetime.now(timezone.utc).isoformat()}
