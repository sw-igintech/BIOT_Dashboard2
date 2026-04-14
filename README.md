# BIOT Devices Dashboard

Static frontend on **GitHub Pages** backed by a **Supabase Edge Function** that proxies live BIOT API calls server-side.

## Architecture

```
Browser (GitHub Pages)
    │
    │  fetch() — plain HTTPS, no JSONP, no Google auth
    ▼
Supabase Edge Function  /functions/v1/biot-dashboard
    │
    │  server-side HTTP — BIOT credentials never leave the server
    ▼
BIOT API  (api.dev.igin.biot-med.com)
```

BIOT is the **only** source of truth. Supabase is used purely as a server execution environment.

---

## Deploy (one time)

### 1 — Install Supabase CLI and log in

```bash
# macOS
brew install supabase/tap/supabase

# Linux
curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
  | tar -xz -C /usr/local/bin

supabase login                                        # opens browser
supabase link --project-ref qjkrkqyycujmjxbfthev
```

### 2 — Set BIOT secrets

```bash
supabase secrets set \
  BIOT_BASE_URL=https://api.dev.igin.biot-med.com \
  BIOT_USERNAME=your-biot-username \
  BIOT_PASSWORD=your-biot-password
```

### 3 — Deploy the Edge Function

```bash
supabase functions deploy biot-dashboard --no-verify-jwt
```

### 4 — Push the frontend

```bash
git push origin main
```

GitHub Pages will serve the updated `index.html` / `dashboard.js` / `dashboard.css` automatically.

---

## Dashboard widgets

| Widget | BIOT source |
|---|---|
| Device Connection Status | `GET /device/v2/devices` → `_status._connection._connected` |
| Offline Devices table | same → `_status._connection._lastConnectedTime` |
| Sanitizer Status chart | same → `_status.septol_availability1` |
| Sanitizer Devices table | same |
| Glove Consumption | `GET /generic-entity/v3/generic-entities/device_event` (GLOVE_TAKEN, all pages) |

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
| `apps-script/Code.gs` | **ARCHIVED** — old backend, not active |

---

## Local development

```bash
# Create .env.local (not committed)
echo "BIOT_BASE_URL=https://api.dev.igin.biot-med.com" >> .env.local
echo "BIOT_USERNAME=..." >> .env.local
echo "BIOT_PASSWORD=..." >> .env.local

supabase functions serve biot-dashboard --env-file .env.local
```

Then temporarily change `supabaseEdgeUrl` in `index.html` to `http://localhost:54321/functions/v1/biot-dashboard`.
