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
node ../../scripts/smoke-health.mjs https://biot-dashboard-staging.sw-590.workers.dev   # current staging URL
```

## Validating against production behavior

Use the parity harness — it drives identical inputs through this Worker and the live
Supabase function with one shared BIOT token and deep-diffs the responses (order-independent,
drift-aware):

```bash
# Worker running locally via `wrangler dev` on :8787, or pass a deployed staging URL.
source ../../claude/biot_credentials.env   # BIOT_USERNAME / BIOT_PASSWORD / BIOT_BASE_URL (local only)
WORKER_URL=http://localhost:8787 \
SUPABASE_ANON_KEY=<publishable key from index.html> \
node ../../scripts/parity-check.mjs
```

It checks health, login, refresh, dashboard (manufacturer + scope variants), entity/settings,
and all error envelopes. Stage 2 result: **10 pass, 3 warn (live drift only), 0 fail** — see
`docs/MIGRATION_STATUS.md`. The `meta.backend` field (`"Cloudflare Worker"` vs
`"Supabase Edge Function"`) is the only intentional difference.

> **Runtime note:** BIOT's edge returns **403** to requests with no `User-Agent`. Deno's fetch
> adds one automatically; **workerd does not**, so `fetchBiot` sets an explicit `User-Agent`.
> Do not remove it or every BIOT call will 403.

## Why this isn't wired to the frontend yet

Production safety. Cutover (pointing `index.html`'s `supabaseEdgeUrl` at the Worker, or
fronting it with a custom domain) is a later, deliberate migration stage gated on
preview validation.
