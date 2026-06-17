# Migration Status — Supabase → Cloudflare runtime

**Stage:** 1 — *preparation + parallel runtime* (no production cutover).
**Branch:** `migration/cloudflare-runtime`
**Date:** 2026-06-17
**Production status:** ✅ **Unchanged.** Frontend (GitHub Pages) still calls the Supabase
Edge Function. Supabase remains the active production backend. BIOT remains the only
source of truth.

---

## Current production architecture (preserved)

```
Browser (GitHub Pages: index.html / dashboard.js / dashboard.css)
   │  fetch() → window.DASHBOARD_CONFIG.supabaseEdgeUrl
   ▼
Supabase Edge Function  /functions/v1/biot-dashboard   (Deno)   ← ACTIVE PRODUCTION
   │  forwards user's own BIOT Bearer token
   ▼
BIOT REST APIs (api.dev.igin.biot-med.com)
```

## Target architecture (being prepared in parallel)

```
GitHub (source of truth) ──GitHub Actions (CI/CD)──► Cloudflare Worker  ← NEW RUNTIME (staging only)
                                                          │  forwards user's BIOT token
                                                          ▼
                                                     BIOT REST APIs
Frontend hosting: GitHub Pages today → Cloudflare Pages later (not done in this stage)
```

---

## What was done in this stage

### 1. Backend contract mapped
`docs/BACKEND_CONTRACT.md` documents the exact current contract (endpoints, methods,
headers, CORS, auth/refresh flow, error shapes, dashboard payload, BIOT upstream calls,
scope/role logic). This is the compatibility target.

### 2. Parallel Cloudflare Worker built
`cloudflare/worker/src/index.ts` is a **faithful, behavior-compatible port** of
`supabase/functions/biot-dashboard/index.ts`. All logic is reproduced verbatim except the
runtime shims:
- `Deno.serve(handler)` → `export default { fetch(req, env) }`
- `Deno.env.get("BIOT_BASE_URL")` → `env.BIOT_BASE_URL` (threaded via `BiotConfig`)
- `meta.backend` / health `backend` report `"Cloudflare Worker"` (only intentional diff,
  used to tell responses apart during validation)

Verified: `tsc --noEmit` passes; `wrangler deploy --dry-run` bundles cleanly for the
Workers runtime (33.98 KiB).

### 3. Cloudflare scaffolding
- `cloudflare/worker/wrangler.toml` — `name=biot-dashboard-staging`, `[env.staging]` only.
  **No `[env.production]` defined** (no cutover target by design).
- `cloudflare/worker/package.json` — scripts: `dev`, `deploy:staging`, `typecheck`, `smoke`.
- `cloudflare/worker/tsconfig.json` — strict, `@cloudflare/workers-types`.
- `cloudflare/worker/.dev.vars.example` — local `BIOT_BASE_URL` template (real `.dev.vars`
  gitignored).
- `cloudflare/worker/README.md` — setup/deploy/validation guide.

### 4. GitHub Actions CI/CD
- `.github/workflows/ci.yml` — on PRs + `migration/**` pushes: worker typecheck +
  `wrangler deploy --dry-run` (no secrets), and `node --check dashboard.js`. **No deploy.**
- `.github/workflows/deploy-worker-staging.yml` — **`workflow_dispatch` only**, requires
  typing `deploy-staging` to confirm, bound to a `staging` GitHub Environment. Pushes
  `BIOT_BASE_URL` as a Worker secret and runs `wrangler deploy --env staging`. Never runs on
  push/merge; has no production target.

### 5. Smoke test
`scripts/smoke-health.mjs` — hits `?action=health` against any backend URL and asserts
`ok:true`. Works against both runtimes (no auth needed).

### 6. Docs
This file + `docs/BACKEND_CONTRACT.md`. Root `README.md` got an additive *Migration (in
progress)* section pointing here; production deploy instructions left intact.

---

## What is ready for preview testing

- Deploy the Worker to staging (manual): set `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, `BIOT_BASE_URL` repo secrets → run the *Deploy Worker (staging)*
  workflow, **or** locally `cd cloudflare/worker && npx wrangler deploy --env staging`.
- Validate: `node scripts/smoke-health.mjs <staging-url>`, then log in via the Worker and
  diff the `dashboard` payload against the Supabase function for the same user/date-range
  (`meta.backend` distinguishes them).

## What remains before cutover (later stages)

1. **Deploy + validate** the Worker against the live BIOT env with real manufacturer,
   single-org, and distributor users; diff payloads vs Supabase until byte-equivalent
   (modulo `meta.backend`/timestamps).
2. **Custom domain / routing** decision for the Worker (workers.dev URL vs custom domain).
3. **Frontend cutover**: point `window.DASHBOARD_CONFIG.supabaseEdgeUrl` (rename advisable)
   at the Worker URL. Consider dropping the now-unused Supabase anon-key headers.
4. **Frontend hosting** (optional): migrate GitHub Pages → Cloudflare Pages.
5. **Define `[env.production]`** in `wrangler.toml` + a guarded production deploy workflow.
6. **Decommission Supabase** only after the Worker has been validated in production.

## Intentionally NOT switched in this stage

- Frontend still points at Supabase (`index.html` unchanged).
- Supabase Edge Function + `supabase/config.toml` unchanged and still active.
- No production Cloudflare environment, route, or custom domain.
- No automatic deploys; the only deploy workflow is manual + confirmation-gated.

## Risks / blockers

- **Unvalidated against live BIOT.** The port is line-for-line faithful and typechecks, but
  has not yet been run against the live API. Behavioral diffing is the gate for stage 2.
- **Worker secret vs var.** `BIOT_BASE_URL` must be set exactly once — either a `wrangler
  secret` or a `[vars]` entry, not both (`wrangler.toml` ships with `[vars]` commented out).
- **Cloudflare account not yet provisioned** in this repo's secrets — staging deploy is
  blocked until `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are added.
- **`workers.dev` subdomain** is account-specific; smoke/README URLs use a
  `<your-subdomain>` placeholder to fill in post-deploy.
