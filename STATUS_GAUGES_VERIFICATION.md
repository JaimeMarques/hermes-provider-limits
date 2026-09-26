# Optional status gauges: review and verification

## Integration boundary

- Base: JaimeMarques/hermes-provider-limits `main` at
  `a57032f318ee75e354210dcae09307502257ca9b` (prerequisite PRs #1 and #2 merged).
- Feature source: `8fbb54f5a5c5f888bdc276a2a50bd693aca4cbc6` on the existing
  `integration-status-gauges` branch. Only its delta after foundation
  `409b96f6287789c118cb5791293beb3a300f5a1b` was applied to the upstream tree.
  The prerequisite foundation commits were not replayed.
- The existing `>=0.21.3` manifest/import guard, history implementation,
  selector contrast fixture, and history endpoint/provider/query mutation
  tests remain. The old general Codex resolver is intentionally replaced by
  exact-owned pool refresh, with its 401/403 safety behavior tested against
  the actual minimum release rather than assumed compatible.

## Changed scope

- `desktop/plugin.js`: independently optional, default-off Claude/GPT/Z.ai
  status gauges; connection/profile preferences; one shared schema-v3 quota
  query; canonical weekly chips and native click popovers, including Claude
  Fable; localized usage/pace/reset/freshness and bounded retries.
- `dashboard/plugin_api.py`, `quota_cache.py`, `oauth_refresh.py`: semantic
  periods, structured scoped Claude limits, versioned profile identity,
  provider floors, process-local singleflight/cache, 900-second stale ceiling,
  capped backoff, exact-owned OAuth selection/refresh and redacted failures.
- Tests: backend cache/OAuth/normalization, shared QueryObserver transitions,
  settings/status rendering, minimum-release contract/refresh/persistence.
  Existing history, localization, discovery, and browser selector tests remain.
- README/compatibility documentation and pinned Query core test dependency.

### Additional integration fixes (regressions observed RED, then GREEN)

1. Malformed Claude `limits`, `scope`, or `model` containers could discard the
   provider's otherwise valid windows. Invalid scoped entries are now skipped.
2. Repeated or slug-colliding display names generated duplicate React window
   keys. Each returned bucket now keeps its own collision-free ID; no unknown
   buckets are combined and no model identity is inferred from punctuation.
3. A transient/missing OAuth refresh after a 401 became a soft failure and
   could retain unauthorized cached quota. It now preserves the original 401.
4. React Query retained old data after HTTP authentication or profile/schema
   rejection. The shared cache is explicitly revoked; success → hard failure
   → soft failure cannot resurrect it. Hard failures get no immediate retry.
5. Frontend transport outages could display quota older than 900 seconds;
   the Usage page also rewrote hard provider states as stale. Both surfaces
   now share the bounded transport-failure presentation path.
6. Independent review exposed an account-switch race inside released core's
   refresh resynchronization. Codex refresh now validates owned identity under
   the core pool/profile/root transaction locks through persistence. Real-core
   competing-writer probes cover local and root-fallback stores.
7. Released core can swallow terminal Anthropic refresh rejection as an
   exhausted entry and `None`. Ambiguous refresh results now revoke quota;
   this also clears cached quota for swallowed transient failures rather than
   risking retention after revoked authorization.
8. Paused, error-free queries now expire on both surfaces via display-only
   timers, including when `fetched_at` is absent. These timers do not poll or
   mutate the shared cache. Real React/Query Chromium tests advance time.
9. Storage cleanup uses the supported `ctx.onDispose` lifecycle and ownership
   checks so a late old disposer cannot detach a replacement registration.

## Local gates

Run using Hermes **0.21.3** (`v2026.9.14`,
`345cd2b057a452236de401d3534b8502a7465e8d`) and `uv sync --frozen --extra dev`,
Python 3.11.16, and isolated test HOME/HERMES_HOME. See
[BACKEND_COMPATIBILITY.md](BACKEND_COMPATIBILITY.md) for reproduction.

| Gate | Result |
| --- | --- |
| Upstream baseline Python suite | 58 passed |
| Candidate full Python suite, including required pinned-release subprocesses | 114 passed, no skips |
| Desktop ESM/component/real QueryObserver and freshness browser suite | 66 passed, no skips |
| Playwright Chromium selector/theme suite | 48 passed, no skips |
| Hermes 0.21.3 `plugins validate . --json` | `ok: true`, no warnings |
| Python compilation, JavaScript syntax, diff whitespace | Pass |
| Initial-candidate Ruff baseline comparison | 15 baseline diagnostics; 13 candidate diagnostics; zero new diagnostics |
| Initial-candidate added production-line security scan | No matches |

Pinned probes reject 0.20.3 and 0.21.2 before newer imports; 0.21.3 executes
actual discovery, scoped FastAPI routes and empty SQLite history, plus real
pool loading/selection/refresh/persistence against temporary stores. Provider
HTTP alone is replaced by synthetic responses. Source origins are asserted;
network is blocked in the release subprocess. Added SDK exports and the exact
minimum release's Query core pin are checked. Browser tests retain both the
full theme matrix and known-broken contrast controls. The final combined suites
were independently rerun at `c713aceb888c3ecd3f9f9f51a34015c37c0c3bb1`.
Use `npm ci --include=dev` when the shell defaults to production dependencies,
and use the pinned release's own Python interpreter for its compiled wheels.

## Limits / review handoff

- No installation, backend restart, live authentication mutation, provider
  network request, push, or PR creation is part of this candidate.
- No packaged Electron interaction/visual approval or real OAuth service
  validation is claimed. Popover tests inspect the actual ESM's component
  contract; browser tests cover selectors, not native popover focus/dismissal.
- Cache is process-local; quota requests are not coalesced across independent
  backend processes. Hermes core owns cross-process OAuth refresh locks.
- Preferences persist per connection/profile but do not live-sync between
  simultaneous windows. Active-page/any-gauge queries still fetch all active
  supported providers. Disabling a chip does not disable its provider.
- The live query requires schema v3, so a stale schema-v2 backend must be
  reloaded along with this update. Legacy presentation adapters remain tested.
- Independent closure review passed at `c713aceb888c3ecd3f9f9f51a34015c37c0c3bb1`
  with zero blockers. This is not a GitHub CI or maintainer approval claim.
