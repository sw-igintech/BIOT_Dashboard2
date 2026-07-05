# 1 — Architecture

## The three layers

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. BROWSER  (GitHub Pages: index.html + dashboard.js + dashboard.css)         │
│    - Renders login screen and dashboard                                       │
│    - Stores the user's BIOT tokens in localStorage                            │
│    - Calls the backend over plain HTTPS fetch()                               │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                 │  fetch()  (token in body on login,
                                 │            in `x-biot-token` header otherwise)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. DENO BACKEND  (Deno Deploy: deno/main.ts)                                   │
│    - Single HTTP handler, multiplexed by an `action` parameter                │
│    - Forwards the user's token to BIOT as `Authorization: Bearer`             │
│    - Normalizes + aggregates BIOT responses into clean JSON for the UI        │
│    - NO database, NO cache, NO shared credentials                             │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                 │  server-side HTTPS fetch()
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. BIOT REST API  (https://api.dev.igin.biot-med.com)                         │
│    - The single source of truth for users, devices, events, cartridges        │
│    - Enforces per-token permissions (ABAC)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why a backend at all? Why not call BIOT directly from the browser?

Two reasons:

1. **CORS.** BIOT's API doesn't send the CORS headers a browser needs to call it cross-origin. The Deno
   proxy sits in the middle and adds permissive CORS headers (`Access-Control-Allow-Origin: *`) so the
   browser is happy.
2. **Shaping + fan-out.** A single dashboard render needs data from *many* BIOT endpoints
   (`/users/self`, `/devices`, `distributor`, `organization_to_distributor`, `cartridge`,
   `device_event`). Doing that fan-out and normalization server-side keeps the frontend simple and
   means one browser request = one dashboard payload.

The backend deliberately does **not** add auth, storage, or business logic beyond scope filtering. It's
as thin as it can be while solving CORS + shaping.

## How one page load flows end-to-end

### Step 1 — Login (once)

```
Browser  ── POST { action:"login", username, password } ──▶  Deno
Deno     ── POST /ums/v2/users/login ─────────────────────▶  BIOT
Deno     ◀── { accessJwt, refreshJwt, userId } ───────────   BIOT
Browser  ◀── { accessToken, refreshToken, userId } ───────   Deno
Browser  stores tokens in localStorage, starts a 12h session clock
```

### Step 2 — Dashboard (every refresh / Apply click)

```
Browser  ── GET ?action=dashboard&from=…&to=…   (x-biot-token: <user JWT>) ──▶  Deno
Deno resolves context, in parallel:
    ── GET /ums/v2/users/self            (who am I? role? org?)
    ── GET /device/v2/devices            (the fleet)
    ── GET .../distributor               (manufacturer only, best-effort)
    ── GET .../organization_to_distributor (org↔distributor bridges, best-effort)
Deno (conditionally) ── GET .../cartridge   (only for a specific scope)
Deno aggregates → connection / operational / sanitizer / cartridges summaries
Browser  ◀── { viewer, scope, organizations, distributors, connection, devices,
               operational, sanitizer, cartridges, gloves:{pending:true}, meta } ── Deno
Browser renders everything EXCEPT gloves immediately.
```

### Step 3 — Gloves (fired async right after the dashboard renders)

```
Browser  ── GET ?action=gloves&from=…&to=…   (x-biot-token) ──▶  Deno
Deno     ── GET .../device_event  (GLOVE_TAKEN events, per owner-org, in parallel) ──▶ BIOT
Deno aggregates glove counts by size
Browser  ◀── { gloves:{ total, counts, breakdown }, meta } ── Deno
Browser renders the glove widget (or a "temporarily unavailable" state).
```

**Why gloves are split out** is the single most important architectural decision in this codebase —
see the box below.

### Step 4 — Device detail settings (on demand, when a row is clicked)

```
Browser  ── GET ?action=entity&id=<settingsId>  (x-biot-token) ──▶  Deno
Deno     ── GET /generic-entity/v1/generic-entities/<id> ────────▶  BIOT
Browser  ◀── raw settings entity ── Deno  →  fills the Settings tab
```

## ⭐ The one thing you must understand: the glove async decoupling

BIOT's `device_event` endpoint (which holds glove-dispense events) runs a permission-expansion step
(ABAC) whose cost depends on how many entities the calling token can see. **For large-distributor
tokens permitted into the manufacturer's root org, this call takes ~90 seconds and then fails with
HTTP 414** — a deterministic, BIOT-side defect that IGIN cannot fix from this codebase.

If gloves were part of the main `dashboard` action, that one slow call would make the *entire*
dashboard take 90s or hang. So the design splits the work into **two backend actions**:

- **`dashboard`** — everything fast and reliable (~1–3s). Returns `gloves: { pending: true }`.
- **`gloves`** — only the slow/unreliable glove aggregation, on a *patient* budget (up to 85s), fetched
  separately by the browser after the page already rendered.

The result: the dashboard is always fast, and the glove widget independently shows a loading
animation → then real data, a genuine "no events" zero, or an honest "temporarily unavailable"
message. This is covered in depth in [02-backend.md](02-backend.md) and [03-frontend.md](03-frontend.md).

## Statelessness — what "no database" really means

- The backend keeps **zero** state between requests. Restarting it loses nothing.
- The only place any state lives is the **browser's localStorage**: the user's access token, refresh
  token, cached user info, and the session-start timestamp. That's it.
- "Scope" (which org/distributor a manufacturer is viewing) is not stored server-side either — it's
  passed in the request (`organizationId`) and echoed back so the dropdown stays sticky.

This is why rollback is trivial and why the backend can be redeployed at any time without data
migration. Next: [02-backend.md](02-backend.md).
</content>
