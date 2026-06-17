# Migration Status — Supabase → Cloudflare runtime

**Stage:** 2 — *staging validation / parity testing* (no production cutover).
**Branch:** `migration/cloudflare-runtime`
**Date:** 2026-06-17
**Production status:** ✅ **Unchanged.** Frontend (GitHub Pages) still calls the Supabase
Edge Function. Supabase remains the active production backend. BIOT remains the only
source of truth.

---

## STAGE 2 SUMMARY (latest)

**Parity verdict: PASS.** The Cloudflare Worker is behavior-equivalent to the Supabase Edge
Function across every tested flow. Run in the **real `workerd` runtime** (`wrangler dev`)
against **live BIOT** and diffed against the **live production Supabase** function using one
shared BIOT token. **0 structural ("stable") differences** on every flow; the only diffs are
live telemetry drift, proven by a Worker-vs-Worker self-drift baseline of equal magnitude.

**One real bug found and fixed by parity testing:** workerd does **not** auto-add a
`User-Agent` to subrequests (Deno does). BIOT's edge/WAF returns **403 Forbidden** to any
request with no UA. So the Worker 403'd on every BIOT call until an explicit
`User-Agent: biot-dashboard-cloudflare-worker` header was added in `fetchBiot`. **This would
have broken production cutover** — it is a workerd-vs-Deno runtime difference, not a local
artifact. Verified live: no-UA → 403, any non-empty UA → 200.

**Cloudflare cloud staging deploy: NOT done — blocked on credentials** (see Blockers). The
parity validation was performed in the real `workerd` runtime locally instead, which exercises
the identical Worker code and is the substantive equivalence proof. The remaining step is the
cloud upload itself.

### Parity results (Worker `workerd` local vs live Supabase, same BIOT token)

| Flow | Worker | Supabase | Identical? | Notes |
|---|---|---|---|---|
| `health` | 200 | 200 | ✅ (modulo intended `backend` label + timestamp) | only intentional diff |
| `login` | 200 | 200 | ✅ | same `userId`, keys `[accessToken,refreshToken,userId]` |
| `refresh` | 200 | 200 | ✅ | keys `[accessToken,refreshToken]` both |
| `dashboard` manufacturer, default | 200 | 200 | ✅ stable=0 | drift=16 = live telemetry (self-drift baseline=16) |
| `dashboard` scope=`all` | 200 | 200 | ✅ stable=0 | 121 devices both; drift=12 telemetry |
| `dashboard` scope=`org:00000000-…` | 200 | 200 | ✅ stable=0 | 116 devices both; drift=15 telemetry |
| `dashboard` scope=`dist:<id>` | 200 | 200 | ✅ stable=0 | 0 devices both (identical) |
| `entity` (settings, device M2) | 200 | 200 | ✅ **0 diffs exact** | settings field mapping identical |
| error: dashboard no token | 401 | 401 | ✅ | `{ok:false,error:{message:"Not authenticated. Please log in."}}` |
| error: unknown action | 400 | 400 | ✅ | `"Unknown action: bogus"` |
| error: entity missing id | 400 | 400 | ✅ | `"id parameter is required."` |
| error: login missing fields | 400 | 400 | ✅ | `"username and password are required."` |
| error: bad token | 401 | 401 | ✅ | identical BIOT message `"Authorization failed or token expired"` |

Aggregate: **10 pass, 3 warn (warn = live drift only, stable=0), 0 fail.**

**"Stable" vs "drift" methodology:** the harness (`scripts/parity-check.mjs`) compares devices
keyed by id (order-independent — the table sort key includes connection status, which changes
live), compares identity/structure exactly (viewer, organizations, distributors, scope,
breakdown keys/labels, per-device org/distributor/customFields), and treats live telemetry
(counts, per-device connection/sanitizer/delivery/`rawStatus`) as drift. Equal Worker-vs-Worker
self-drift confirms drift is genuine live data, not a runtime difference.

### Differences found — classification

| Difference | Class | Action |
|---|---|---|
| Missing `User-Agent` → BIOT 403 in workerd | **was a BLOCKER** | ✅ **Fixed** (explicit UA in `fetchBiot`) |
| `meta.backend` / health `backend` label ("Cloudflare Worker" vs "Supabase Edge Function") | harmless/intentional | keep — used to tell runtimes apart |
| `meta.generatedAt` timestamp | harmless | inherent per-request value |
| Live telemetry drift (connection counts, per-device status) between sequential calls | harmless | proven via self-drift baseline; not a code diff |

No remaining differences are blockers or need correction before cutover.

### Stage 2 coverage limitation (honest scope note)

Only **one** BIOT credential is available locally — a **manufacturer** user
(`ownerOrganizationId = 00000000-…` root). So:
- The **manufacturer** role + login/refresh/dashboard/entity/error flows were tested directly.
- **Organization-scope** and **distributor-scope** behavior was exercised via the manufacturer
  scope dropdown (`org:<id>` returned 116 devices; `dist:<id>` returned 0 — both identical to
  Supabase). This is the same mechanism distributor visibility uses.
- I did **not** log in *as* a separate organization-role user or *as* the real distributor user
  (`stamshemyafe@gmail.com`) — those credentials are not in the local workspace. Those login
  paths run identical code; full role-as-user validation should be repeated at cloud-staging
  time once those test credentials are available.

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

1. **Cloud staging deploy** (the one Stage-2 item still blocked): provide
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (and the account's `workers.dev`
   subdomain), then `wrangler deploy --env staging` (or run the *Deploy Worker (staging)*
   GitHub workflow). Validate the deployed URL with `node scripts/smoke-health.mjs <url>`.
   ⚠️ When BIOT calls run from **real Cloudflare egress**, re-confirm BIOT's WAF does not
   block Cloudflare IP ranges (the UA 403 is fixed; an IP/ASN rule is a separate risk).
2. **Re-run parity from cloud staging** and ideally with org-role + real distributor-user
   credentials (Stage-2 coverage limitation above): `WORKER_URL=<staging-url>
   SUPABASE_ANON_KEY=… BIOT_USERNAME=… BIOT_PASSWORD=… node scripts/parity-check.mjs`.
3. **Custom domain / routing** decision for the Worker (workers.dev URL vs custom domain).
4. **Frontend cutover**: point `window.DASHBOARD_CONFIG.supabaseEdgeUrl` (rename advisable)
   at the Worker URL. Consider dropping the now-unused Supabase anon-key headers.
5. **Frontend hosting** (optional): migrate GitHub Pages → Cloudflare Pages.
6. **Define `[env.production]`** in `wrangler.toml` + a guarded production deploy workflow.
7. **Decommission Supabase** only after the Worker has been validated in production.

### Exact next step
Provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (repo secrets or local env), then
deploy the Worker to the staging environment and re-point the parity harness at the deployed
`workers.dev` URL. Code parity is already proven in the workerd runtime; only the cloud upload
and a cloud-egress re-confirmation remain.

## Intentionally NOT switched in this stage

- Frontend still points at Supabase (`index.html` unchanged).
- Supabase Edge Function + `supabase/config.toml` unchanged and still active.
- No production Cloudflare environment, route, or custom domain.
- No automatic deploys; the only deploy workflow is manual + confirmation-gated.

## Risks / blockers

- **[RESOLVED] Unvalidated against live BIOT.** Stage 2 ran the Worker in the real workerd
  runtime against live BIOT and diffed vs live Supabase — parity PASS (see Stage 2 summary).
- **[RESOLVED, was a blocker] workerd no-User-Agent → BIOT 403.** Fixed with an explicit UA
  in `fetchBiot`.
- **[ACTIVE BLOCKER] Cloudflare deploy credentials missing.** No `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` in env or repo secrets, and `wrangler` is not authenticated
  (`wrangler whoami` → "not authenticated"). The literal cloud staging deploy cannot proceed
  until these are provided. (Local `wrangler dev` needs no auth, which is how parity was run.)
- **Worker secret vs var.** `BIOT_BASE_URL` must be set exactly once — either a `wrangler
  secret` or a `[vars]` entry, not both (`wrangler.toml` ships with `[vars]` commented out).
  For local dev it is set via `cloudflare/worker/.dev.vars` (gitignored).
- **Cloud egress / WAF (to re-check at cloud staging).** The UA 403 is fixed, but BIOT's WAF
  could separately rate-limit or block by IP/ASN. Confirm from real Cloudflare egress.
- **`workers.dev` subdomain** is account-specific; smoke/README URLs use a
  `<your-subdomain>` placeholder to fill in post-deploy.
- **Test-user coverage.** Only a manufacturer credential is available locally; org-role and
  real distributor-user logins were not exercised as separate logins (identical code path).
