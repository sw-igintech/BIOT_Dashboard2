# 2 — The Backend (`deno/main.ts`)

One file, ~1800 lines, no dependencies (just `Deno.serve` and `fetch`). This chapter walks it
section by section. Open [../../deno/main.ts](../../deno/main.ts) alongside this.

## Big picture

```
Deno.serve(handler)                    ← the single HTTP entry point
  └─ switch on `action`:
       health    → static JSON
       login     → loginProxy()        → BIOT /ums/v2/users/login
       refresh   → refreshProxy()      → BIOT /ums/v2/users/token/refresh
       dashboard → buildDashboard()    ─┐
       gloves    → buildGloves()       ─┤─ both call resolveDashboardContext()
       entity    → fetchBiot()直接      │
                                        │
resolveDashboardContext()  ←────────────┘  the shared "who am I + what devices + what scope" resolver
  ├─ getCurrentUser()      → /ums/v2/users/self
  ├─ getDevices()          → /device/v2/devices
  ├─ getDistributors()     → generic-entities/distributor
  ├─ getOrgDistributorBridges() → generic-entities/organization_to_distributor
  ├─ deriveOrganizations() / resolveScope() / deviceMatchesScope()
  └─ returns DashboardContext

fetchBiot()                ← the ONE HTTP helper every BIOT call goes through
```

## Section 1 — The request handler (`Deno.serve`, lines ~141–313)

Everything enters through a single `Deno.serve(async (req) => …)` callback.

- **CORS preflight:** an `OPTIONS` request returns immediately with `CORS_HEADERS`.
- **Parse inputs:** query params go into a `params` object; a POST body is JSON-parsed (malformed
  bodies are ignored, not fatal).
- **Pick the action:** `body.action ?? params.action ?? "dashboard"`. So the action can come from the
  POST body (login/refresh) or the query string (dashboard/gloves/entity), defaulting to `dashboard`.
- **Dispatch:** a series of `if (action === …)` blocks. Each auth-required action
  (`dashboard`, `gloves`, `entity`) first checks for the `x-biot-token` header and returns `401` if
  missing.
- **Error funnel:** the whole body is wrapped in `try/catch`. A `BiotAuthError` becomes a `401`;
  anything else becomes a `500` with the message. Two tiny helpers, `ok()` and `err()`, build JSON
  responses with CORS + content-type headers.

**Response envelope.** Every response is `{ ok: true, data: … }` or `{ ok: false, error: { message } }`.
The frontend relies on this shape everywhere (see `appsScriptRequest` in [03-frontend.md](03-frontend.md)).

### The five actions

| Action | Method | Auth | Returns |
|--------|--------|------|---------|
| `health` | GET/POST | none | `{ ok, backend:"Deno Deploy", timestamp }` |
| `login` | POST | none (creds in body) | `{ accessToken, refreshToken, userId }` |
| `refresh` | POST | refreshToken in body | `{ accessToken, refreshToken }` |
| `dashboard` | GET | `x-biot-token` | full dashboard payload (gloves pending) |
| `gloves` | GET | `x-biot-token` | glove aggregation only |
| `entity` | GET `?id=` | `x-biot-token` | one raw BIOT generic entity (device settings) |

## Section 2 — Config & auth proxies (lines ~319–372)

- `getBaseUrl()` reads the **`BIOT_BASE_URL`** env var (e.g. `https://api.dev.igin.biot-med.com`).
  This is the *only* required configuration. If it's missing, the backend throws. On Deno Deploy it's
  set in the app settings; locally you set it before `deno task start`.
- `loginProxy(username, password)` — POSTs to BIOT `/ums/v2/users/login`, then digs the tokens out of
  BIOT's nested response (`accessJwt.token`, `refreshJwt.token`) using the `nestedGet` helper. The
  server never keeps these — it just relays them to the browser.
- `refreshProxy(refreshToken)` — same idea against `/ums/v2/users/token/refresh`.

**Note:** the backend has no credentials of its own. It never logs in on its own behalf. Every data
call uses the token the browser sends.

## Section 3 — `resolveDashboardContext()` — the shared brain (lines ~396–472)

Both `buildDashboard` and `buildGloves` start here. It figures out **who the user is, what devices
they can see, and what scope is selected**, then returns a `DashboardContext`. Steps:

1. **`resolveDateRange(params)`** — parse `from`/`to`/`fromIso`/`toIso`/`timezone`. Defaults to the
   last 30 days if absent. Only glove events are time-filtered; device status is current-state.
2. **`getCurrentUser()`** → `/ums/v2/users/self` — identifies the viewer.
3. **`buildViewerIdentity()`** — derives a clean `Viewer`: `userId`, `displayName`, `email`, `role`
   (`"manufacturer"` vs `"organization"`, inferred from group names containing "manufacturer"),
   `groups`, and `ownerOrganizationId`.
4. **Parallel fan-out** (`Promise.all`) of three independent calls: `getDevices`, `getDistributors`,
   `getOrgDistributorBridges`. The last two are wrapped in `safeWidget` so a failure returns `[]`
   instead of breaking the whole request (they're only meaningful for manufacturers anyway).
5. **`deriveOrganizations()`** — walks the self payload + device list to build the org list for the
   dropdown. **`buildDistributorToOrgsMap()`** — turns the bridge entities into
   `distributorId → [childOrgId, …]`.
6. **`resolveScope()`** — turns the requested scope token into a `ResolvedScope` (see below).
7. **Client-side scope filter** — for a *specific* scope only, filter `rawDevices` with
   `deviceMatchesScope`. For the manufacturer "all" view and for org-role users, **trust BIOT's ABAC**
   and don't filter (filtering there risks silently dropping devices — see the long comment at
   lines ~435–443 and the `deviceMatchesScope` note).
8. Normalize the surviving devices (`normalizeDevice`) and compute `eventOrgIds` (the owner-org set the
   glove query will fan out over).

### The scope model (manufacturer-only feature)

A **manufacturer** user gets a dropdown to narrow the view. The selection is encoded as a token:

| Token | `ResolvedScope.kind` | Meaning |
|-------|---------------------|---------|
| `all` (or empty) | `all` | No filtering — show everything BIOT returned. |
| `org:<uuid>` | `organization` | Only devices whose `_ownerOrganization.id` matches. |
| `dist:<uuid>` | `distributor` | Devices linked to the distributor **either** directly (`device_distributor.id`) **or** via a child org (through the `organization_to_distributor` bridge). |

`parseScopeToken` also accepts a bare legacy UUID and disambiguates it against the known org/dist sets.
Unknown values fall back to `all` rather than erroring. **Organization-role users** don't get a
dropdown at all — they're locked to their own org, and their device list is trusted from BIOT as-is
(`deviceMatchesScope` returns `true` immediately for them). The reasoning is documented in the big
comment above `deviceMatchesScope` (lines ~1036–1075): a real distributor user's token legitimately
returns devices across several owner-orgs, so client-side owner-org filtering would wrongly drop them.

## Section 4 — `buildDashboard()` vs `buildGloves()` (lines ~476–596)

**`buildDashboard`** assembles the fast payload:

- `connection` — `getConnectionSummary()`: counts connected/disconnected/unknown.
- `devices` — `getAllDevices()`: every device, flattened for the table, sorted disconnected-first.
- `operational` — `getOperationalSummary()`: operational = `delivery_available1 === true`.
- `sanitizer` — `getSanitizerSummary()`: available/unavailable/unknown from `septol_availability1`.
- `cartridges` — fetched **only** when the result set is bounded: org-role users, or a manufacturer
  who picked a specific scope. The manufacturer "all" view skips it (too many; would be slow / trip
  rate limits) and returns `scopeHint: true` so the UI shows "select a scope" instead.
- `gloves: { …empty, pending: true }` — a placeholder telling the frontend "load me separately."
- `meta.partialFailures` — a map of any widget that failed but didn't kill the request.

**`buildGloves`** does *only* the glove aggregation via `getGloveSummary`, using the same
`resolveDashboardContext`. It reports `meta.partialFailures.gloves` when some owner-orgs timed out but
others succeeded (partial data is still shown).

## Section 5 — BIOT data calls (lines ~602–735)

All of these paginate with the same pattern (`limit`/`page`, stop when a short page or `totalPages` is
reached) and go through `fetchBiot`:

- `getCurrentUser` — `/ums/v2/users/self`
- `getDevices` — `/device/v2/devices` (100/page)
- `getDistributors` — `generic-entities/distributor`
- `getCartridges` — `generic-entities/cartridge` (1000/page, capped at 50 pages; **do not** add a
  `_templateName` filter — BIOT now rejects it)
- `getOrgDistributorBridges` — `generic-entities/organization_to_distributor`

## Section 6 — ⭐ The glove aggregation (lines ~740–906)

This is the tricky part. `getGloveSummary`:

1. Takes the list of owner-org ids and queries each **independently and in parallel** (`Promise.all`).
2. Per org, `getGloveEventsForOrg` paginates `device_event` filtered by
   `event_code = "GLOVE_TAKEN"`, `_ownerOrganization.id`, and the `_creationTime` window, using the
   **big** page size `EVENT_PAGE_SIZE = 1000`.
3. When a specific scope is selected, events are additionally post-filtered by `allowedDeviceIds`
   (because `device_event` has no distributor reference — you have to match on the source device id).
4. Each event's `event_cartridge_size` is normalized to small/medium/large/extraLarge/unknown and
   counted.

**Resilience is the whole point here:**
- Querying orgs in parallel means one org's ~90s timeout doesn't serialize behind the others.
- If **some** orgs fail, their counts are dropped and `partialOrgFailures` is reported (partial data
  still shown).
- If **every** org fails, it throws → `safeWidget` catches it → `meta.partialFailures.gloves` is set →
  the frontend shows "temporarily unavailable" (never a fake "0 gloves").

## Section 7 — Normalization (lines ~1042–1234, 1543–1556)

BIOT's payloads have inconsistent, underscore-prefixed, deeply nested field names. The `normalize*`
functions flatten them into the clean shapes the frontend expects:

- `normalizeDevice` — pulls connection, sanitizer, delivery, distributor, the full `_status` object
  (`rawStatus`, used by the detail modal), and all non-`_` root fields (`customFields`, which includes
  `current_settings2` used to fetch settings).
- `normalizeCartridge`, `normalizeDistributors` — same idea for those entity types.
- `normalizeConnectionStatus` / `normalizeSanitizerStatus` / `normalizeGloveSize` — map raw
  booleans/strings to `{ key, label }` pairs. The confirmed BIOT field names are documented inline
  (e.g. `_status._connection._connected`, `_status.septol_availability1`,
  `_status.delivery_available1`, `_status.bin_level1`, `_status.total_*_gloves`). See
  [04-biot-concepts.md](04-biot-concepts.md) for the full field reference.

## Section 8 — The HTTP helper `fetchBiot()` (lines ~1609–1683) & timeouts

Every BIOT call goes through `fetchBiot`. It:

- Builds the URL + query, sets `Accept` and an explicit `User-Agent: biot-dashboard-deno` (BIOT's WAF
  403s requests with no UA), adds `Authorization: Bearer <token>` when given.
- Applies an **`AbortController` timeout** and converts an abort into a readable
  "BIOT request timed out after Ns" error.
- Parses JSON (non-JSON → error), maps `401` → `BiotAuthError`, and enforces `expectedStatuses`.

**Two timeout budgets — this matters:**

| Constant | Value | Used by |
|----------|-------|---------|
| `BIOT_FETCH_TIMEOUT_MS` | **15 s** | Everything on the fast path (self, devices, distributor, bridge, cartridge). These normally return in 1–2s; 15s just guards against a hang. |
| `GLOVE_FETCH_TIMEOUT_MS` | **85 s** | *Only* the glove `device_event` calls. Deliberately patient because that endpoint legitimately takes ~90s for large distributors. **Capped at 85s** because Deno Deploy aborts a request at ~116s — 85s leaves margin for the rest of the work. |

If you ever raise the glove budget past ~90s, you'll start hitting Deno Deploy's hard request limit.
The real fix beyond that would be a poll/background-job architecture — deliberately not built, because
the failing path is a deterministic BIOT 414 (nothing to wait for).

## Section 9 — Small utilities (lines ~1689–1815)

`extractItems` (find the array in a variably-shaped payload), `extractTotalPages`,
`extractErrorMessage`, `buildBreakdown` (counts → chart breakdown with percentages), `zeroCounts`,
`nestedGet` (safe deep property access), `firstNonEmpty`. Nothing surprising — these absorb BIOT's
inconsistency so the rest of the code can be clean.

## The Supabase twin

`supabase/functions/biot-dashboard/index.ts` is a near-identical copy of this file for the old Supabase
runtime, kept only as a rollback fallback. **If you change backend logic, mirror it there too** (or
accept that a rollback would lose the change). See [05-local-dev-and-deploy.md](05-local-dev-and-deploy.md).

Next: [03-frontend.md](03-frontend.md).
</content>
