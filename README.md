# BIOT Devices Dashboard

Static frontend on **GitHub Pages** backed by a **Supabase Edge Function** that proxies live BIOT API calls server-side.

## Architecture

```
Browser (GitHub Pages)
    │
    │  fetch() — plain HTTPS
    │  POST { action: "login" }   user logs in with their own BIOT credentials
    │  GET  ?action=dashboard  +  x-biot-token: <user's BIOT access JWT>
    ▼
Supabase Edge Function  /functions/v1/biot-dashboard
    │
    │  server-side HTTP — forwards the user's own token to BIOT
    ▼
BIOT API  (api.dev.igin.biot-med.com)
```

BIOT is the **only** source of truth. Supabase is used purely as a server execution environment — no database, no caching.

Data scope is determined entirely by the logged-in user's own BIOT token, not by a shared server credential.

---

## Deploy (one time)

### 1 — Install Supabase CLI and log in

```bash
# Linux
curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
  | tar -xz -C /usr/local/bin

supabase login
supabase link --project-ref qjkrkqyycujmjxbfthev
```

### 2 — Set required secret

```bash
supabase secrets set BIOT_BASE_URL=https://api.dev.igin.biot-med.com
```

### 3 — Deploy the Edge Function

```bash
npx supabase functions deploy biot-dashboard --project-ref qjkrkqyycujmjxbfthev
```

### 4 — Push the frontend

```bash
git push origin main
```

GitHub Pages serves `index.html` / `dashboard.js` / `dashboard.css` directly from `main`.

---

## Dashboard widgets

| Widget | BIOT source |
|---|---|
| Device Connection Status | `GET /device/v2/devices` → `_status._connection._connected` |
| Glove Consumption | `GET /generic-entity/v3/generic-entities/device_event` (GLOVE_TAKEN) |
| Sanitizer Status | `GET /device/v2/devices` → `_status.septol_availability1` |
| Operational Status | `GET /device/v2/devices` → `_status.delivery_available1` |
| Device detail — Status | `_status.*` fields (connectivity, bin level, glove counts) |
| Device detail — Settings | `GET /generic-entity/v1/generic-entities/{current_settings2.id}` |

---

## Key files

| File | Purpose |
|---|---|
| `index.html` | Dashboard shell + Supabase endpoint config |
| `dashboard.js` | All rendering + API fetch logic |
| `dashboard.css` | Visual styles |
| `supabase/functions/biot-dashboard/index.ts` | Edge Function — BIOT proxy |
| `supabase/config.toml` | Supabase project config |
| `.env.example` | Template showing required secrets |

---

## Local development

```bash
supabase functions serve biot-dashboard --env-file .env.local
```

Where `.env.local` (not committed) contains:
```
BIOT_BASE_URL=https://api.dev.igin.biot-med.com
```

Then temporarily change `supabaseEdgeUrl` in `index.html` to `http://localhost:54321/functions/v1/biot-dashboard`.
