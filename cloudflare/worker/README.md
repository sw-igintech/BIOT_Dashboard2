# biot-dashboard — Cloudflare Worker (parallel migration target)

This Worker is a **behavior-compatible port** of the active Supabase Edge Function
(`supabase/functions/biot-dashboard/index.ts`). It exists so the Cloudflare runtime
can be deployed to a **preview/staging URL** and validated against the exact same
request/response contract **before any production cutover**.

> ⚠️ **Not production.** The dashboard frontend still calls the Supabase Edge
> Function. Nothing here changes that. See `docs/MIGRATION_STATUS.md`.

## Contract

Identical to the Supabase Edge Function. See `docs/BACKEND_CONTRACT.md` for the full
spec. Summary:

| Action | Method | Auth | Returns |
|---|---|---|---|
| `health` | GET/POST | none | `{ ok, backend, timestamp }` |
| `login` | POST `{username,password}` | none | `{ ok, data: { accessToken, refreshToken, userId } }` |
| `refresh` | POST `{refreshToken}` | none | `{ ok, data: { accessToken, refreshToken } }` |
| `dashboard` | GET `?action=dashboard&...` | `x-biot-token` header | `{ ok, data: <dashboard payload> }` |
| `entity` | GET `?action=entity&id=<uuid>` | `x-biot-token` header | `{ ok, data: <generic entity> }` |

CORS allows `authorization, x-client-info, apikey, content-type, x-biot-token` — so the
existing frontend (which still sends the Supabase anon key headers) works unchanged when
pointed here.

## Setup

```bash
cd cloudflare/worker
npm install
```

### Configure the BIOT base URL

```bash
npx wrangler secret put BIOT_BASE_URL        # paste https://api.dev.igin.biot-med.com
```

(Or uncomment the `[vars]` block in `wrangler.toml` for a plaintext value — not both.)

### Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in BIOT_BASE_URL (gitignored)
npx wrangler dev
node ../../scripts/smoke-health.mjs http://localhost:8787
```

### Deploy to staging (manual)

```bash
npm run typecheck
npx wrangler deploy --env staging
node ../../scripts/smoke-health.mjs https://biot-dashboard-staging.<your-subdomain>.workers.dev
```

## Validating against production behavior

To compare this Worker's output to the live Supabase function, log in through both and
diff the `dashboard` payloads for the same user/date-range. The `meta.backend` field
distinguishes responses (`"Cloudflare Worker"` vs `"Supabase Edge Function"`).

## Why this isn't wired to the frontend yet

Production safety. Cutover (pointing `index.html`'s `supabaseEdgeUrl` at the Worker, or
fronting it with a custom domain) is a later, deliberate migration stage gated on
preview validation.
