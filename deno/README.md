# biot-dashboard — Deno Deploy app (migration target)

Deno-native BIOT proxy for **Deno Deploy**. Faithful copy of the production Supabase Edge
Function (`supabase/functions/biot-dashboard/index.ts`) — same `Deno.serve` handler, same
`Deno.env` config, same request/response contract — plus two proven-safe deltas: `device_event`
page size 1000, and an explicit `User-Agent`. Health/meta report `backend: "Deno Deploy"`.

> ⚠️ **Not production.** The frontend (`index.html`) still points at Supabase. Deploying this
> only publishes a `*.deno.dev` URL. Cutover is a separate, isolated step.
> See `docs/DENO_MIGRATION.md`.

## Entrypoint & config

| Setting | Value |
|---|---|
| Entrypoint | `deno/main.ts` |
| Install command | *(blank — no dependencies)* |
| Build command | *(blank — no build step)* |
| Runtime env var | `BIOT_BASE_URL=https://api.dev.igin.biot-med.com` |

## Local run

```bash
cd deno
BIOT_BASE_URL=https://api.dev.igin.biot-med.com deno task start   # serves on :8000
node ../scripts/smoke-health.mjs http://localhost:8000
```

## Parity vs Supabase (validated)

```bash
WORKER_URL=http://localhost:8000 SUPABASE_ANON_KEY=<publishable> \
  BIOT_USERNAME=… BIOT_PASSWORD=… node ../scripts/parity-check.mjs
```

Validated 2026-06-18 against live BIOT: **10 pass / 3 warn (live drift only) / 0 fail**;
`deno check` clean. The `backend` label (`"Deno Deploy"` vs `"Supabase Edge Function"`) is the
only intentional difference.

## Actions (unchanged contract)

`health` · `login` (POST) · `refresh` (POST) · `dashboard` (GET, `x-biot-token`) ·
`entity` (GET `?id=`, `x-biot-token`). Same envelope `{ ok, data }` / `{ ok:false, error }`.
