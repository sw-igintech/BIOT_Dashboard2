# 6 — Maintenance playbook

Recipes for the changes you're most likely to make. Each one lists the files to touch and the gotchas.

## Golden rules

1. **BIOT is the source of truth.** There's no DB to migrate and no cache to invalidate. If data looks
   wrong, the question is almost always "what did BIOT return?" — not "what did we store?".
2. **Keep the backend a pure proxy.** No database, no cache, no shared credentials, no scheduled jobs.
   That constraint is deliberate (it's what makes rollback instant and the system auditable).
3. **Mirror backend changes into the Supabase twin** (`supabase/functions/biot-dashboard/index.ts`) or
   accept that a rollback loses them.
4. **Bump the `?v=` cache-buster** in `index.html` when you edit `dashboard.js` / `dashboard.css`.
5. **Validate before you ship:** `deno check` (backend), the preview server (frontend), and — if you
   have BIOT creds — `scripts/parity-check.mjs`.

## Recipe: add a new status widget (e.g. "Bin Full")

1. **Backend** ([../../deno/main.ts](../../deno/main.ts)):
   - Confirm the BIOT field on `_status` (add it to `normalizeDevice` if not already surfaced).
   - Add a `*_BREAKDOWN` label array near the top.
   - Write a `getXxxSummary(devices)` aggregator (copy `getSanitizerSummary`).
   - Add its result to the object returned by `buildDashboard`.
2. **Frontend HTML** ([../../index.html](../../index.html)): add a `<article class="card chart-card">`
   with a `<canvas>`, a metrics `<div>`, and a legend `<div>`, mirroring the existing cards.
3. **Frontend JS** ([../../dashboard.js](../../dashboard.js)): add colors to `CHART_COLORS`, the same
   `*_BREAKDOWN`, a `normalizeChartSection(...)` call in `normalizeDashboardSummary`, and
   `renderMetrics`/`renderLegend`/`upsertChart` calls in `renderSummary`.
4. Bump `?v=`. Mirror the backend aggregator into the Supabase twin.

## Recipe: a widget suddenly shows blanks / wrong numbers

Almost always a **renamed or moved BIOT field**. Steps:

1. Log in as a real user in the preview and open a device in the detail modal — see which fields are `—`.
2. Check the raw BIOT payload: hit `?action=dashboard` (or `?action=entity&id=…`) directly with a valid
   `x-biot-token` and inspect the JSON, or add a temporary `console.error(JSON.stringify(...))` in the
   relevant `normalize*` function and read Deno Deploy logs.
3. Compare against the [confirmed field table](04-biot-concepts.md#-confirmed-field-reference). Update
   the `nestedGet([...])` path(s) in `normalizeDevice` / `populateStatusTab` / `populateSettingsTab`.

## Recipe: the glove widget shows "temporarily unavailable"

This is usually **not a bug** — it's the known BIOT `device_event` ABAC defect (see
[04-biot-concepts.md](04-biot-concepts.md)). For large-distributor tokens BIOT times out (~90s → 414)
and the UI degrades gracefully by design. Verify before "fixing":

- Does it happen only for large-distributor scopes, and do smaller org scopes load fine? → expected.
- Does it happen for *everyone*, including small orgs? → then something real changed. Check:
  - `GLOVE_FETCH_TIMEOUT_MS` (backend, 85s) vs `GLOVE_REQUEST_TIMEOUT_MS` (frontend, 150s) — the
    frontend budget must exceed the backend's.
  - Deno Deploy's ~116s hard request cap — don't raise the backend budget past ~90s.
  - The `event_code` / `_creationTime` / `_ownerOrganization.id` filter shape in `getGloveEventsForOrg`.

Do **not** try to "cache" gloves to work around this — you can't cache data BIOT never returns, and it
violates the no-DB rule. This was evaluated and rejected (see PROJECT_STATE 2026-06-30 note).

## Recipe: point at a different BIOT environment (e.g. staging → prod)

Change the **`BIOT_BASE_URL`** env var — locally when starting the backend, and in the Deno Deploy app
settings (+ the `BIOT_BASE_URL` GitHub secret) for production. No code change.

## Recipe: change the scope/filtering logic

The scope model lives entirely in the backend: `parseScopeToken`, `resolveScope`, `deviceMatchesScope`,
`cartridgeMatchesScope`, and `buildDistributorToOrgsMap`. Read the big comment above `deviceMatchesScope`
first — it documents *why* org-role users and the manufacturer "all" view are never filtered client-side
(over-filtering previously broke real distributor users). Test any change against all three: a
manufacturer (all + a specific org + a specific distributor), an org user, and a distributor user.

## Recipe: swap the logo / branding

Replace [../../logo.svg](../../logo.svg) (referenced twice in `index.html`, on the login card and the
header). The product name text ("IGIN SMART" / "IOT") is inline in `index.html`.

## Recipe: change the session length

`SESSION_MAX_MS` in [../../dashboard.js](../../dashboard.js) (currently 12h). It's an absolute timeout
from login, not reset by refresh — change the constant and bump `?v=`.

## Where to look when something breaks

| Symptom | Look at |
|---------|---------|
| Can't log in | `loginProxy` (backend), `loginRequest`/`handleLoginFormSubmit` (frontend), BIOT `/ums/v2/users/login` |
| Logged in but dashboard 401s / kicks to login | token refresh path: `performTokenRefresh` + the 401 retry in `appsScriptRequest`; 12h session expiry |
| Whole dashboard slow/hangs | a fast-path BIOT call exceeding 15s; check which one in Deno logs. Gloves should NEVER slow the main dashboard — if they do, the async split regressed |
| Gloves unavailable | expected for large distributors (BIOT 414); see recipe above |
| Cartridges empty with a hint | expected in the manufacturer "all" view (`scopeHint`); pick a scope |
| Charts blank | Chart.js CDN blocked, or `upsertChart` got an empty breakdown |
| Changes not showing for users | forgot to bump `?v=` in `index.html` |

## Key references

- [../PROJECT_STATE.md](../PROJECT_STATE.md) — authoritative current state, deploy, rollback, open items.
- [../DENO_MIGRATION.md](../DENO_MIGRATION.md) — the full Supabase→Deno migration + live validation record.
- `claude/` (gitignored) — BIOT API reference, credentials, and detailed investigation write-ups.
</content>
