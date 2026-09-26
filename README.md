# Hermes Provider Limits

A unified [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) plugin that shows live provider quotas and local Hermes usage in one native page.

[Install in Hermes](hermes://plugin/install?repo=JaimeMarques/hermes-provider-limits&enable=1)

## What it shows

- Only providers configured and enabled in the selected Hermes profile.
- **OpenAI Codex:** every window returned by `wham/usage`, including additional model limits such as Spark, code-review limits, credits, and resets.
- **Claude:** every OAuth subscription window, model-specific windows, and extra-usage allowance when enabled.
- **GLM / Z.ai:** all token and tool/MCP windows returned by the Coding Plan quota API.
- **deepseekv4pro.com:** account quota when the dashboard endpoint accepts the available credential. Its current dashboard uses a separate website session, so a normal inference API key may only produce an explicit “unavailable” state.
- **Hermes history:** per-session, per-model, and per-task calls, tokens, cache, reasoning, and recorded USD cost from the selected profile’s local `state.db`.

Unknown values stay unknown. The plugin does not turn percentages into invented token ceilings, combine incompatible windows, or infer credits from tokens.

## Optional status-bar gauges

On the Usage page, enable **Claude**, **GPT**, or **GLM / Z.ai** independently.
Every gauge defaults **off**, including new connection/profile scopes. Choices
persist per connection and profile; simultaneous windows do not live-sync them.
The Usage page remains available regardless of these switches.

One status root and the Usage page share the same schema-v3 quota request and
React Query cache. With the page closed and every gauge off, no quota query runs.
An open page or any enabled gauge fetches the configured providers together;
hiding one chip is not a provider-disable or account-change operation.

Compact chips show only the unambiguous overall weekly window. Clicking opens a
native popover with used quota, pace when meaningful, reset time, freshness,
profile provenance, and a cooldown-aware Refresh button. When the status-bar
slot is too narrow (even in a wide window), it uses one **Usage** shortcut instead
of clipping some provider chips; all quotas remain accessible on the Usage page.
Claude's popover also shows the 5-hour and provider-confirmed model-scoped
weekly limits, including Fable. Structured names are not merged by display slug;
malformed scoped rows cannot suppress valid overall quota. The opaque `nimbus_quill` codename is not
presented as a guessed model. Missing, rolling, expired, and stale reset/pace
information is not presented as a fresh allowance.

Both Claude and GPT popovers show a read-only **Available resets** row below the
quota sections. A reported zero stays `0`; missing, invalid, or surface-gated
inventory is **Not reported**. This is not the scheduled quota reset countdown.
The row uses the existing facts, localization, and shared cache (including its
900-second stale ceiling and hard-auth revocation); Z.ai has no reset row.

Claude's OAuth discovery uses GET `/api/oauth/usage?cedar_ember=1&skip_spend=1`,
then `?at_wall=1&skip_spend=1` if needed, inside the already-selected credential
adapter. No browser cookies, account switching, redemption, or separate UI
polling is added. Evaluated Cedar offers report `grants[].resets_left` (expired
grants excluded); otherwise an eligible Juniper `arm: "reset"` with explicit
`available` reports one or zero. These describe the OAuth offer inventory, not a
guarantee that a reset is redeemable now or that web-only promotions are visible.
Discovery failures leave ordinary usage intact; authentication failures still
revoke cached data. Null program blocks are unevaluated, not zero.

Schema evidence: [oh-my-pi issue #12883](https://github.com/can1357/oh-my-pi/issues/12883),
[parser and read-only queries at e45b49c](https://github.com/can1357/oh-my-pi/blob/e45b49c0d43206274da9d7594124fc18444240c3/packages/ai/src/usage/claude-reset.ts),
and its [public protocol fixtures](https://github.com/can1357/oh-my-pi/blob/e45b49c0d43206274da9d7594124fc18444240c3/packages/ai/test/claude-reset.test.ts).
Anthropic's [limit reset guide](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset)
confirms occasional eligible grants, session/weekly scope, and expiry, but does
not document this OAuth schema. Tests use source-backed synthetic payloads; no
live reset inventory was verified during implementation.

## Install

Requires **Hermes 0.21.3 or newer** (`v2026.9.14`). Older backends are rejected
before routes mount, including loaders that ignore the manifest version gate.

### Hermes Desktop

Open the install link above, review the repository and selected components, then confirm installation. In **Capabilities → Plugins**, enable the Desktop half if it is not already enabled.

### CLI

```bash
hermes plugins install JaimeMarques/hermes-provider-limits --enable
hermes gateway restart
```

Then open Hermes Desktop, go to **Capabilities → Plugins**, run **Rescan** if needed, and enable **Usage and limits**. The plugin adds:

- **Usage** in the sidebar;
- **Open usage and limits** in the command palette.

Python routes mount when the Hermes backend starts, so a gateway/Desktop restart is required after the first install or a backend update. The JavaScript UI itself hot-reloads.

## Update

```bash
hermes plugins update provider-limits
hermes gateway restart
```

Run **Rescan** in **Capabilities → Plugins** to refresh the Desktop half.

## Security model

- Quota operations are read-only: no inference calls, purchases, quota changes, or reset redemption. Hermes-owned OAuth grants may be refreshed and persisted through Hermes core; this is not an authentication-store read-only monitor.
- Provider credentials are resolved by Hermes in the Python backend and never returned to the renderer.
- Outbound quota requests are HTTPS-only, restricted to exact provider hosts, size-limited, time-bounded, and forbidden from following redirects.
- Error responses do not expose provider bodies, tokens, account identifiers, or emails.
- Local history opens `state.db` read-only and selects accounting columns only; it does not read prompts or messages.
- Cache and singleflight are process-local, isolated by profile and a server-side configuration/credential signature. Provider request floors are 120 seconds for Codex and 180 seconds for Claude, Z.ai, and DeepSeek; the UI checks the shared route every 60 seconds. Rate-limit backoff is capped at 300 seconds; soft failures retain explicitly stale data for at most 900 seconds. Hard authentication/account failures revoke it.
- OAuth selection follows Hermes pool strategy without implicit refresh. Only allowlisted Hermes-owned grants can refresh, at most once per request, proactively near expiry or after one 401. Borrowed Claude Code grants are rejected. An unsuccessful 401 recovery remains a hard failure. Hermes core owns pool seeding, grant persistence, and cross-process refresh locking; the plugin does not read vendor CLI credential files itself.

Third-party plugins execute inside Hermes. Review the source before enabling it.

## Package layout

```text
provider-limits/
├── plugin.yaml
├── __init__.py
├── dashboard/
│   ├── manifest.json
│   ├── plugin_api.py
│   ├── history.py
│   ├── oauth_refresh.py
│   └── quota_cache.py
└── desktop/
    └── plugin.js
```

The Desktop UI calls its backend through the plugin-scoped `ctx.rest` namespace. No build step is required.

## Localization

English is the complete fallback and is currently the only registered bundle. UI copy lives in the `LOCALES` object in `desktop/plugin.js`. Add future translations only as sibling bundles for locale IDs supported by Hermes (`zh`, `zh-hant`, `ja`, `ar`, or `ru`); locale support is add-only, so do not replace or remove the English fallback or register unreachable locale IDs. Missing keys fall back to English.

Page content is reactive to locale changes. Sidebar and command-palette labels are activation-time snapshots: the current Hermes contribution schema accepts plain string labels, so those two labels update only when the plugin is activated again. The plugin does not modify Hermes core to simulate reactive contribution chrome.

Schema v3 adds profile identity, semantic period durations, and bounded freshness metadata. The shared live quota query requires schema v3; update/reload the backend with the frontend. Schema v2 introduced locale-neutral display descriptors and stable problem codes; legacy presentation fields remain temporarily for v1 compatibility. Provider names, named upstream plans, model IDs, session titles, and other upstream values remain literal. Do not add translated prose to new API fields.

## Development

Use [the pinned real-release setup](BACKEND_COMPATIBILITY.md) for Python
verification; it runs against Hermes 0.21.3 and its frozen dependency lock.

Requirements:

- Hermes `0.21.3` or newer (`v2026.9.14`), for the complete backend contract,
  with `requires_hermes: ">=0.21.3"` and an import-time guard for older loaders.
  Defensive UI fallbacks remain for copied JavaScript on older Desktop hosts.
  Releases before `v2026.8.31` lack the `--dt-primary-solid*` theme tokens, so the
  highlighted-option rule falls back to the palette's inverse
  `--theme-foreground` / `--theme-background-seed` pair. Across all 22 older
  theme/mode combinations, text stays at or above 4.748:1 and the highlighted
  row stays at or above 5.351:1 against its surface; the SDK's translucent
  `--dt-accent*` pair falls below AA in Everforest light and Solarized dark.
  Every generation also gets a 2px inset `--theme-foreground` focus outline;
  its minimum contrast against the adjacent popover surface is 5.351:1;
- A Hermes source clone containing the pinned release commits;
- Python dependencies supplied by Hermes (`fastapi`, `PyYAML` for discovery tests);
- Node.js/npm for the ESM/component checks and the pinned Playwright browser gate.

```bash
HERMES_SOURCE_REPO=/path/to/hermes-agent python -m pytest tests -q
python -m py_compile dashboard/plugin_api.py dashboard/history.py
node --check desktop/plugin.js
node --experimental-vm-modules --test tests/test_desktop_i18n.mjs
npm ci --include=dev
npm run install:chromium
npm test
```

`tests/test_select_styles.cjs` renders the plugin's CSS in Chromium against the
resolved ThemeProvider/SDK tokens captured at exact tags `v2026.8.27` (before
`--dt-primary-solid*`) and `v2026.8.31` (the first token generation). It asserts
all 11 built-in themes in light and dark mode stay visible and WCAG AA legible,
and proves the fixture reproduces the reported Everforest/Solarized failures.
Missing Playwright or Chromium is a hard failure rather than a green run with
skipped browser coverage.

Tests use synthetic protocol fixtures and do not require real provider credentials or network access. The release probe exercises real Hermes-owned refresh and persistence against temporary stores with provider HTTP replaced, not live accounts. Status/popover component tests inspect the shipped ESM; Chromium tests cover the inherited themed selectors, not packaged Electron interaction or OAuth service availability.

## Limitations

Provider quota endpoints are not standardized and may change independently of Hermes. The plugin fails closed: it displays an unavailable/stale state rather than fabricating data. `deepseekv4pro.com` currently separates its website session from inference API keys, so authenticated quota retrieval may not be available to Hermes.

## License

[MIT](LICENSE)
