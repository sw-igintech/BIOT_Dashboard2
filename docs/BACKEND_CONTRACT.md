# Backend Runtime Contract (compatibility target for migration)

This document captures the **exact current contract** of the active backend
(`supabase/functions/biot-dashboard/index.ts`). It is the compatibility target the
Cloudflare Worker (`cloudflare/worker/src/index.ts`) must match before any cutover.

Source of truth verified against `main` and the frontend (`dashboard.js`, `index.html`)
on the migration branch as of 2026-06-17.

---

## 1. Transport & endpoint shape

- **Single endpoint, multiplexed by `action`.** The frontend's `supabaseEdgeUrl`
  (`window.DASHBOARD_CONFIG.supabaseEdgeUrl` in `index.html`) points at one URL.
- `action` is read from the **POST JSON body** first, else the **query string**, else
  defaults to `"dashboard"`.
- **POST** is used for `login` and `refresh` (body carries credentials/token).
- **GET** is used for `dashboard` and `entity` (auth via header, params via query).
- The frontend appends a cache-buster query param `_=<Date.now()>` on GETs. The backend
  ignores unknown params.

### Headers the frontend sends (must be tolerated + CORS-allowed)

- `Content-Type: application/json`
- `x-biot-token: <user's BIOT access JWT>` (on GET `dashboard` / `entity`)
- `apikey: <supabase anon key>` and `Authorization: Bearer <supabase anon key>` — sent on
  every request because the current host is Supabase. **The backend logic ignores these**,
  but CORS must allow them or the browser preflight fails.

### CORS (exact)

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type, x-biot-token
Access-Control-Allow-Methods: GET, POST, OPTIONS
```
`OPTIONS` returns `200` with body `"ok"` and the CORS headers.

---

## 2. Actions

### `health`  (GET or POST)
- **Auth:** none.
- **Response:** `200` `{ ok: true, backend: <string>, timestamp: <ISO> }`.
- Note: `backend` differs by runtime — `"Supabase Edge Function"` vs `"Cloudflare Worker"`.
  This is the **only** intentional contract difference and is used to tell responses apart
  during validation.

### `login`  (POST `{ action:"login", username, password }`)
- **Auth:** none.
- Proxies BIOT `POST /ums/v2/users/login` (accepts BIOT status 200 or 201).
- **Success:** `200` `{ ok: true, data: { accessToken, refreshToken, userId } }`
  - `accessToken` ← `accessJwt.token`, `refreshToken` ← `refreshJwt.token`, `userId` ← `userId`.
- **Missing fields:** `400` `{ ok:false, error:{ message:"username and password are required." } }`.
- **No access token from BIOT:** `500` with the error message.

### `refresh`  (POST `{ action:"refresh", refreshToken }`)
- **Auth:** none.
- Proxies BIOT `POST /ums/v2/users/token/refresh` (status 200 or 201).
- **Success:** `200` `{ ok:true, data:{ accessToken, refreshToken } }` (refresh token falls
  back to the supplied one if BIOT omits a new one).
- **Missing field:** `400` `{ ok:false, error:{ message:"refreshToken is required." } }`.

### `dashboard`  (GET `?action=dashboard&from&to&fromIso&toIso&timezone&organizationId`)
- **Auth:** `x-biot-token` header **required**; missing → `401`
  `{ ok:false, error:{ message:"Not authenticated. Please log in." } }`.
- Query params:
  - `from`, `to` — `YYYY-MM-DD` (default: last 30 days, UTC).
  - `fromIso`, `toIso` — full UTC ISO strings for glove-event time filtering (frontend builds
    these from local date+time). Fallback: `${from}T00:00:00.000Z` / `${to}T23:59:59.999Z`.
  - `timezone` — display only (default `"UTC"`).
  - `organizationId` — encoded scope token: `"all"` | `"org:<id>"` | `"dist:<id>"`. A bare
    UUID is accepted (legacy) and disambiguated against known org/distributor id sets.
  - `from > to` → `500` with `"The start date must be on or before the end date."`.
- **Success:** `200` `{ ok:true, data: <dashboard payload> }` (see §3).

### `entity`  (GET `?action=entity&id=<uuid>`)
- **Auth:** `x-biot-token` required (same 401 as dashboard).
- Proxies BIOT `GET /generic-entity/v1/generic-entities/{id}`.
- **Missing id:** `400` `{ ok:false, error:{ message:"id parameter is required." } }`.
- **Success:** `200` `{ ok:true, data: <raw BIOT entity> }`. Used to fetch device settings;
  the frontend reads lowercase fields (`software_version.name`, `glovedefaultsize`,
  `useridentificationrequired`, `septolservingvolume`, `septolcurrentside`,
  `promptforactivationtosecondglove`, `septolmandatoryuse`, `bintotalcapacity`).

### Unknown action → `400` `{ ok:false, error:{ message:"Unknown action: <x>" } }`.

---

## 3. Dashboard payload shape (`data`)

```jsonc
{
  "viewer": { "userId", "displayName", "email", "role": "manufacturer"|"organization",
              "groups": [string], "ownerOrganizationId" },
  "scope":  { "from", "to", "fromIso", "toIso", "timezone",
              "organizationId": "all"|"org:<id>"|"dist:<id>",   // echo token
              "kind": "all"|"organization"|"distributor",
              "organizationIds": [string], "organizationLabel": string },
  "organizations": [ { "id", "name" } ],
  "distributors":  [ { "id", "name" } ],
  "connection":  { "total", "counts": {connected,disconnected,unknown}, "breakdown": [...] },
  "devices":     { "total", "items": [ <device item> ] },
  "operational": { "total", "counts": {operational,non_operational}, "breakdown": [...] },
  "gloves":      { "total", "counts": {small,medium,large,extraLarge,unknown}, "breakdown": [...] },
  "sanitizer":   { "total", "counts": {available,unavailable,unknown}, "breakdown": [...],
                   "devices": [ { "id","status","statusKey","value" } ] },
  "meta": { "generatedAt": <ISO>, "backend": <string>, "partialFailures": { "gloves"?: <msg> } }
}
```

`breakdown` entries are `{ key, label, value, percentage }`.

**Device item** (in `devices.items`, sorted disconnected → unknown → connected, then by
`lastConnectedAt` asc):
```
id, organizationId, organizationName, distributorId, distributorName,
connected (bool|null), connectionStatus, connectionStatusKey, lastConnectedAt,
sanitizerStatus, sanitizerStatusKey, deliveryAvailable (bool|null),
rawStatus  (full BIOT _status object),
customFields (all non-"_"-prefixed device root fields, incl. current_settings2 ref)
```

---

## 4. BIOT upstream calls (unchanged across runtimes)

| Purpose | Call |
|---|---|
| Login | `POST /ums/v2/users/login` |
| Refresh | `POST /ums/v2/users/token/refresh` |
| Self / role | `GET /ums/v2/users/self` |
| Devices (paged ×100) | `GET /device/v2/devices?searchRequest={limit,page}` → `.data` |
| Distributors | `GET /generic-entity/v3/generic-entities/distributor` |
| Org↔distributor bridges | `GET /generic-entity/v3/generic-entities/organization_to_distributor` |
| Glove events | `GET /generic-entity/v3/generic-entities/device_event` filter `event_code=GLOVE_TAKEN`, `_ownerOrganization.id`, `_creationTime` range |
| Settings entity | `GET /generic-entity/v1/generic-entities/{current_settings2.id}` |

- Upstream auth: `Authorization: Bearer <user's accessToken>` (forwarded; no server credential).
- BIOT `401` → backend returns `401` with `{ ok:false, error:{ message } }`. The frontend
  refreshes once and retries; persistent 401 clears localStorage and shows login.
- Glove-summary failures are swallowed (`safeWidget`) and surfaced under
  `meta.partialFailures.gloves` rather than failing the whole dashboard.

## 5. Scope / role logic (must match exactly)

- Role inferred from `/users/self` groups: any group containing `"manufacturer"` →
  `manufacturer`, else `organization`.
- **Manufacturer**: may select `all` / `org:<id>` / `dist:<id>`. `all` trusts the BIOT
  response with no client filter. `organization` filters by `_ownerOrganization.id`.
  `distributor` matches `device.device_distributor.id === id` **OR** owner org ∈ the
  distributor's child orgs (from bridge entities).
- **Organization-role users** (incl. real distributor users with `groups:[]`): **never**
  filtered client-side — BIOT ABAC already returns exactly their permitted device set.
  Locked to their own org in the scope selector (selector hidden in UI).

See the project memory and `dashboard.js` for confirmed BIOT field names.
