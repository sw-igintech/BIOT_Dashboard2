# 3 — The Frontend (`index.html` + `dashboard.js`)

No framework, no build. `index.html` is the static markup with every element already present (hidden
via a `hidden` CSS class until needed); `dashboard.js` is all the logic; `dashboard.css` is styling.
Open [../../dashboard.js](../../dashboard.js) alongside this.

## `index.html` structure

The whole app is two top-level `<div>`s, one shown at a time:

- **`#loginView`** — the login card (email, password, show/hide toggle, Sign In).
- **`#dashboardView`** — the real app: header, filter bar (From/To date+time, scope dropdown, Apply),
  a 2×2 grid of chart cards (`#connectionChart`, `#gloveChart`, `#sanitizerChart`,
  `#operationalChart`), the **Machines** table, the **Cartridges** table, and a **device detail
  modal** (`#deviceDetailModal`) with Status and Settings tabs.

The `<head>` holds the one config block:

```html
<script>
  window.DASHBOARD_CONFIG = {
    supabaseEdgeUrl: "https://biot-dashboard-staging.sw-igin.deno.net", // ← the backend URL (legacy name)
    supabaseAnonKey: "sb_publishable_…"                                 // ← ignored by Deno backend
  };
</script>
```

External CDN scripts: Chart.js and flatpickr. The `?v=YYYYMMDD-N` query on `dashboard.css`/`dashboard.js`
is a cache-buster — **bump it when you change those files** so GitHub Pages users get the new version.

## `dashboard.js` — how it's organized

The file is grouped into commented sections. Top to bottom:

1. **Constants** — `CHART_COLORS`, the `*_BREAKDOWN` label pairs (mirror the backend's), timeouts,
   `SESSION_MAX_MS`.
2. **`state`** — the single in-memory state object (charts, current summary, filters, search terms,
   selected device, a `requestId` for race-guarding).
3. **`auth`** — a small module wrapping `localStorage` for tokens + session.
4. **Chart plugin** — a custom Chart.js plugin that draws the big number in the doughnut hole.
5. **Bootstrap + `wireUi`** — event wiring on `DOMContentLoaded`.
6. **Auth/login flow.**
7. **`refreshDashboard` + rendering** — the heart of the UI.
8. **Glove widget** (its own state machine).
9. **Tables, device modal, formatting helpers.**
10. **HTTP layer** (`appsScriptRequest`, login, refresh).

## Auth & session (lines ~87–132, 284–332)

- Tokens live in `localStorage` under `auth_token`, `auth_refresh_token`, `auth_user`,
  `auth_session_start`.
- **12-hour absolute session** (`SESSION_MAX_MS`). The clock starts at login and is **not** reset by
  token refreshes — after 12h you must log in again. `isAuthenticated()` = has a token AND not expired.
- On login success, `auth.setTokens()` stores everything and stamps the session start.
- `handleAuthFailure()` clears tokens, destroys charts, and returns to the login view. It's called
  whenever a request comes back `401` and a refresh can't save it.

## Bootstrap (lines ~179–259)

On `DOMContentLoaded`: set default dates (last 14 days), `wireUi()` (attach all event listeners), then
either show the dashboard and `refreshDashboard()` (if authenticated) or show login. `wireUi` wires the
Apply button, the scope dropdown (refreshes on change), login/logout, the modal close/backdrop/Escape,
the machine + cartridge search inputs (live filtering), the connection filter chips, the detail tabs,
the password toggle, and initializes the flatpickr date pickers (display `DD/MM/YY`, underlying value
stays `YYYY-MM-DD`).

## ⭐ `refreshDashboard()` — the main flow (lines ~350–412)

This runs on load, on Apply, and on scope change. Steps:

1. Guard: backend configured? authenticated? valid date range?
2. **`const requestId = ++state.requestId`** — this is the **race guard**. Every render step later
   checks `if (requestId !== state.requestId) return`, so if the user clicks Apply again mid-flight,
   the stale response is discarded. Remember this pattern — it's used in three places.
3. Show loading UI and **set the glove widget to "loading" up front** (so the glove card animates
   during the whole refresh, not just after).
4. Build `params` from the date range + scope, call `appsScriptRequest(params)` (the `dashboard`
   action).
5. On success: store `state.summary`, render the org selector, render everything
   (`renderSummary`), then **fire `refreshGloves(params, requestId)`** — fire-and-forget, guarded by
   the same `requestId`.
6. On error: destroy charts, show the error banner.

## Rendering (lines ~414–509)

- `renderOrganizationSelector` — only for manufacturers; builds the dropdown with two optgroups
  (Distributors as `dist:<id>`, Organizations as `org:<id>`) plus "All organizations". Hidden for
  everyone else.
- `renderSummary` — renders the metric tiles + legends + doughnut charts for connection, sanitizer,
  operational (gloves are handled separately), then the machines and cartridges tables. The connection
  chart/legend are **clickable** — clicking a segment or legend row calls `setConnectionFilter` which
  filters the machines table and scrolls to it.
- `upsertChart` — creates a Chart.js doughnut the first time, or updates it in place on later renders
  (so charts animate instead of flickering). The center number comes from the custom `centerText`
  plugin.

## ⭐ The glove widget state machine (lines ~511–632)

The glove card has **four explicit, visually distinct states**, driven by `setGloveState(kind, payload)`:

| `kind` | When | What the user sees |
|--------|------|--------------------|
| `"loading"` | during refresh + while the async glove fetch runs | animated "filling glove" SVG + "Loading glove data… can take a minute or two" |
| `"data"` | glove total > 0 | metric tiles + doughnut + legend + HIGH DEMAND badge + PRO TIP |
| `"zero"` | BIOT succeeded, genuinely no events | "No glove events in the selected period." + all-zero tiles (an *honest* zero, not an error) |
| `"unavailable"` | the glove query failed/timed out upstream | ⚠ + "temporarily unavailable (BIOT upstream timeout). The rest of the dashboard is live." |

The reason for four states instead of "loading / done": a real zero and a failure both produce
`total === 0`, but they mean completely different things. `refreshGloves` distinguishes them by
checking `meta.partialFailures.gloves`:

```
total > 0                       → "data"
total === 0 AND failureMsg set  → "unavailable"   (upstream failed — NOT a real zero)
total === 0 AND no failure      → "zero"          (genuine no-events)
```

`refreshGloves` uses the longer `GLOVE_REQUEST_TIMEOUT_MS` (150 s) so the browser stays patient while
the backend waits out BIOT's slow path (backend caps its own wait at 85s). It's also `requestId`-guarded
so a stale glove response from a previous refresh is dropped.

`renderGloveHighlight` finds the highest-consumption size and adds a **HIGH DEMAND** badge to its
legend row plus a **PRO TIP** stock recommendation.

## Normalization on the client (lines ~711–845)

Even though the backend already shapes data, the frontend re-normalizes defensively via
`normalizeDashboardSummary` and friends (`normalizeChartSection`, `normalizeDevices`,
`normalizeCartridges`, `normalizeSanitizerSection`). This makes the UI robust to missing/partial
fields — every section always has `total`, `counts`, `breakdown`, etc., so render code never crashes on
a missing property.

## Tables & the device modal (lines ~851–1195)

- **Machines table** (`renderMachinesTable`) — filtered by `state.connectionFilter`
  (all/connected/disconnected chips) and `state.machineSearch` (live text). Rows are clickable → open
  the detail modal.
- **Cartridges table** (`renderCartridgesTable`) — shows the inventory, or the "select a scope" hint
  when the backend sent `scopeHint: true` (manufacturer "all" view).
- **Device detail modal** (`openDeviceDetail`):
  - **Status tab** (`populateStatusTab`) — synchronous; reads `device.rawStatus` (connectivity, delivery,
    sanitizer, bin level, gloves-in-stock) plus org/distributor rows (manufacturer only).
  - **Settings tab** (`populateSettingsTab`) — **async**; the device object only has a *reference*
    (`customFields.current_settings2.id`), so it fires an `entity` request to fetch the actual settings
    entity (SW version, default glove size, NFC required, sanitizer settings, …). Guarded so switching
    devices mid-fetch doesn't show stale data.

## The HTTP layer (lines ~1413–1614)

- **`appsScriptRequest(params, timeoutMs?)`** — the workhorse for GET actions (`dashboard`, `gloves`,
  `entity`). It:
  1. Checks auth, builds the URL with a cache-busting `_=<timestamp>` param and the `x-biot-token`
     header.
  2. On a `401` on the **first** attempt, calls `performTokenRefresh()` and retries once. If refresh
     fails → `handleAuthFailure()` (back to login).
  3. Unwraps the `{ ok, data }` envelope; throws on `ok: false`.
  (The legacy name comes from an original Google Apps Script backend — it now talks to Deno.)
- **`loginRequest` / `refreshTokenRequest`** — POST the `login`/`refresh` actions.
- **`getEdgeUrl` / `getAnonKey`** — read the config block. The anon key is still sent as `apikey` +
  `Authorization` headers for Supabase-fallback compatibility; the Deno backend ignores them.

## Date/time handling (lines ~1644–1714)

The user picks local date + time. `buildDateRangePayload` converts local → UTC ISO
(`new Date("YYYY-MM-DDTHH:MM:ss").toISOString()`) and sends both the display dates and the ISO
strings. **Only glove events are time-filtered** (by BIOT `_creationTime`); connection/sanitizer/
operational are current-state snapshots and ignore the date range.

Next: [04-biot-concepts.md](04-biot-concepts.md).
</content>
