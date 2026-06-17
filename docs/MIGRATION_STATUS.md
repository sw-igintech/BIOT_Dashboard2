# Migration Status — Supabase → Cloudflare runtime

**Stage:** 4 — *non-production frontend preview + end-to-end UI validation* (no cutover).
**Branch:** `migration/cloudflare-runtime`
**Date:** 2026-06-17
**Production status:** ✅ **Unchanged.** Frontend (GitHub Pages) still calls the Supabase
Edge Function. Supabase remains the active production backend. BIOT remains the only
source of truth. Production `index.html` still points at Supabase (verified on disk).

---

## STAGE 4 SUMMARY (latest)

**Real UI, end-to-end, against the real Cloudflare staging Worker: ✅ PASS — no
migration-specific issues found.** Drove a real Chromium browser (Playwright) through the
actual `dashboard.js`/`dashboard.css` UI, talking to
`https://biot-dashboard-staging.sw-590.workers.dev`. **19 pass, 1 warn, 0 fail**, and **all
backend traffic went to Cloudflare (11 hits) with 0 to Supabase.**

### Preview path (non-production, zero-drift)
`cloudflare/preview/serve-preview.mjs` — a local server that serves the **unmodified
production frontend** but rewrites **only** the `window.DASHBOARD_CONFIG` block **in memory**
to point at the Cloudflare staging Worker (and blanks the Supabase anon key, which the Worker
ignores), plus a red "PREVIEW — Cloudflare staging" banner. **No file on disk is changed** —
production `index.html` stays the single source of truth, so the preview cannot drift and
production is untouched. (Confirmed: `index.html` on disk still contains the Supabase URL.)
Automated test: `cloudflare/preview/e2e-preview.mjs` (Playwright; creds via env; Playwright is
not a repo dependency). See `cloudflare/preview/README.md`.

### End-to-end UI results (preview → real Cloudflare staging)

| UI flow | Result | Evidence |
|---|---|---|
| Preview loads + login view + banner | ✅ | banner present |
| Error handling: bad login | ✅ | `#loginError` shows "Login Failed" |
| Login → dashboard view | ✅ | dashboard HTTP 200 |
| User info | ✅ | `matan@igintech.com` |
| Machine table render | ✅ | 115 rows, count badge 115 |
| Charts (4) render | ✅ | connection/glove/sanitizer/operational 375×300 |
| Metric widgets | ✅ | all four populated |
| Glove metrics non-zero (subrequest fix) | ✅ | Total Events 824 (S177/M236/L191/XL220) |
| Search filter | ✅ | "M2" → 1/115 rows, all match |
| Filter chips (All/Connected/Disconnected) | ✅ | all=121, connected=6, disconnected=115 |
| Date/time filter → Apply reload | ✅ | flatpickr set + dashboard HTTP 200 |
| Scope selector (manufacturer) | ✅ | optgroups [Distributors, Organizations] |
| Scope: select organization | ✅ | `org:00000000-…` → HTTP 200, count 117 |
| Scope: select distributor | ✅ | `dist:f2f84f75-…` → HTTP 200 |
| Device modal (Status tab) | ✅ | id=M2, conn=Disconnected |
| Settings tab → entity fetch | ✅ | entity HTTP 200, no error |
| 401 → refresh → retry recovery | ✅ | corrupted access token; refresh POST seen; dashboard HTTP 200 |
| Logout | ✅ | returns to login, token cleared |
| Backend routing guard | ✅ | Cloudflare hits=11, **Supabase hits=0**, actions=[dashboard,entity] |
| Console/JS errors | ⚠️ WARN | see below — all expected negative-path noise |

### The one WARN — explained, not a defect
Console resource errors observed: **404, 500, 401**. All are expected and identical to
Supabase behavior:
- **404** = `/favicon.ico` (browser auto-request; the app defines no favicon — same on prod).
- **500** = the deliberate bad-login test. **Both Cloudflare and Supabase return identical
  `HTTP 500 {"ok":false,"error":{"message":"Login Failed"}}`** for invalid credentials (BIOT
  returns a non-401 status that the proxy surfaces as 500). Pre-existing behavior, not a
  migration difference; the UI correctly shows "Login Failed".
- **401** = the deliberate forced-refresh test (corrupted access token → 401 → refresh).

No functional assertion failed; no migration-specific UI/backend issue was discovered, so
**nothing needed fixing** in Stage 4.

### Roles/scopes actually tested
- **Manufacturer** (`matan@igintech.com`): logged in directly — full UI validated.
- **Organization scope** and **distributor scope**: exercised via the manufacturer scope
  dropdown (`org:00000000-…` → 117 devices; `dist:f2f84f75-…` → 200), the same mechanism the
  app uses. Distributor hierarchy + field mappings render correctly in the modal/table.
- **Not tested as separate logins:** a real organization-role user and the real distributor
  user (`stamshemyafe@gmail.com`) — those credentials are not in the local workspace. Their
  login path is identical code (validated at the API level in Stage 2/3); a real-user UI login
  should be repeated when those credentials are available, before cutover.

---

## STAGE 3 SUMMARY (latest)

**Real Cloudflare staging deploy: ✅ SUCCEEDED.**
**Exact staging URL:** **`https://biot-dashboard-staging.sw-590.workers.dev`**
(Worker name `biot-dashboard-staging`, account subdomain `sw-590`, version deployed via
GitHub Actions.)

**Parity verdict against the REAL deployed Worker: PASS.** 10 pass / 3 warn / 0 fail; every
warn is live-telemetry drift with **0 structural diffs** (equal Worker-vs-Worker self-drift
baseline). Validated from real Cloudflare egress, not local wrangler dev.

**One real blocker found by real-egress testing — and FIXED in-stage:**
- Manufacturer-wide (`all` / large org) dashboards returned `gloves = 0` with
  `meta.partialFailures.gloves = "Too many subrequests by single Worker invocation"`.
  **Cause:** Cloudflare Workers cap subrequests per invocation (**50 Free / 1000 Paid**).
  Glove events paginated at 100/page needed ~48 `device_event` requests; combined with
  device/distributor/self calls it overflowed 50, and `safeWidget` swallowed the failure →
  glove counts silently showed **0**. Deno (Supabase) has no such cap, so it was never hit.
- **Fix:** raised `device_event` page size 100 → 1000 (`EVENT_PAGE_SIZE`; BIOT honors
  `limit=1000`, verified live), cutting ~48 pages to ~5. After redeploy, staging gloves =
  **4745** (small 1278 / medium 679 / large 1960 / xl 828), exactly matching Supabase, and
  `meta.partialFailures = {}`.
- **Residual note:** the fix raises the subrequest ceiling ~10×, not infinitely. A very
  large tenant could still exceed 50 on the **Free** plan → **production should run on the
  Workers Paid plan (1000 subrequests).** Tracked as a pre-cutover item, not a code blocker.

**Live-egress / WAF concern (Stage-2 carry-over): RESOLVED.** Login, refresh, and all
dashboard/entity calls succeeded from real Cloudflare egress → BIOT returned 200s. With the
explicit `User-Agent` (Stage 2 fix) in place, BIOT's WAF did **not** block Cloudflare IPs/ASN.

### Parity results — REAL staging Worker (`…sw-590.workers.dev`) vs live Supabase

| Flow | Worker (staging) | Supabase | Identical? | Notes |
|---|---|---|---|---|
| `health` | 200 | 200 | ✅ (modulo intended `backend` label + timestamp) | |
| `login` | 200 | 200 | ✅ | same `userId`; **proves real CF egress→BIOT works** |
| `refresh` | 200 | 200 | ✅ | keys `[accessToken,refreshToken]` |
| `dashboard` manufacturer default | 200 | 200 | ✅ stable=0 | drift=12 telemetry (self-drift=12) |
| `dashboard` scope=`all` | 200 | 200 | ✅ stable=0 | 121 devices both; **gloves 4745 both** |
| `dashboard` scope=`org:00000000-…` | 200 | 200 | ✅ stable=0 | 117 devices both |
| `dashboard` scope=`dist:<id>` | 200 | 200 | ✅ stable=0 | 0 devices both |
| `entity` (settings, device M2) | 200 | 200 | ✅ **0 diffs exact** | |
| error: no token | 401 | 401 | ✅ | identical envelope |
| error: unknown action | 400 | 400 | ✅ | `"Unknown action: bogus"` |
| error: entity missing id | 400 | 400 | ✅ | `"id parameter is required."` |
| error: login missing fields | 400 | 400 | ✅ | `"username and password are required."` |
| error: bad token | 401 | 401 | ✅ | identical BIOT message |

### Differences found — classification (Stage 3)

| Difference | Class | Action |
|---|---|---|
| Workers subrequest cap → gloves silently 0 on wide scopes | **was a BLOCKER** | ✅ **Fixed** (page size 100→1000); re-validated |
| Free-plan 50-subrequest ceiling still finite for huge tenants | needs-attention (not a code blocker) | Use **Workers Paid (1000)** for prod |
| `meta.backend` label / `meta.generatedAt` | harmless/intentional | keep |
| Live telemetry drift (counts, per-device status, glove totals between calls) | harmless | proven via self-drift baseline |
| First-deploy `workers.dev` propagation lag (CI smoke 1042 on first run) | harmless/operational | smoke retried fine; redeploys serve immediately |

No remaining differences are blockers. The only outstanding pre-cutover *recommendation* is
the Workers Paid plan for subrequest headroom.

### Workflow / secret wiring (verified + fixed)
- Repo secrets present and used: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `BIOT_BASE_URL` (all repo-level; accessible to the job). `staging` GitHub Environment is
  auto-created on first run — harmless.
- **Fixed:** workflow ordered `secret put` before `deploy` (first deploy would
  `script_not_found`); now deploys first, then sets the secret (auto-redeploys), then runs a
  real health smoke test against the captured URL.
- **Fixed:** a `workflow_dispatch`-only workflow that never ran on the default branch is not
  dispatchable (`gh workflow run` → 404). Added a `push: migration/**` trigger so the staging
  deploy runs from the migration branch (staging-only; no production target). Manual
  `workflow_dispatch` + confirm path retained. **Revisit before cutover** — production deploys
  must stay manual + gated, and this push-trigger should be narrowed/removed at that time.

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

1. **[DONE in Stage 3]** ~~Cloud staging deploy + real-egress parity.~~ Deployed to
   `https://biot-dashboard-staging.sw-590.workers.dev`; parity PASS; WAF/egress confirmed OK;
   subrequest blocker fixed.
2. **Workers Paid plan** (pre-cutover recommendation): enable to raise the subrequest cap
   from 50 → 1000 so large tenants never silently drop the glove widget. Re-validate wide
   scopes after enabling.
3. **Wider test-user coverage**: re-run parity with a real org-role user and the real
   distributor user (`stamshemyafe@gmail.com`) — only a manufacturer credential is available
   locally; those login paths are identical code but unexercised as separate logins.
4. **Custom domain / routing** decision for the Worker (workers.dev URL vs custom domain).
5. **Frontend cutover**: point `window.DASHBOARD_CONFIG.supabaseEdgeUrl` (rename advisable)
   at the Worker URL. Consider dropping the now-unused Supabase anon-key headers.
6. **Frontend hosting** (optional): migrate GitHub Pages → Cloudflare Pages.
7. **Define `[env.production]`** in `wrangler.toml` + a guarded production deploy workflow;
   narrow/remove the `push: migration/**` auto-deploy trigger so production stays manual+gated.
8. **Decommission Supabase** only after the Worker has been validated in production.

### Exact next step
Stage 4 done: the real UI is validated end-to-end against Cloudflare staging (preview path in
`cloudflare/preview/`). The next safe steps toward production readiness, in order:
1. **Enable the Workers Paid plan** (1000 subrequests) so very large tenants never silently
   drop the glove widget; re-run `e2e-preview.mjs` to confirm.
2. **Real-user UI pass** with an organization-role user and the real distributor user once
   those credentials are available (Stage 4 covered manufacturer + scoped views only).
3. **Pick the production Worker address** (custom domain vs `workers.dev`) and define
   `[env.production]` in `wrangler.toml` + a manual, gated production deploy workflow; narrow
   the `push: migration/**` auto-deploy trigger so production never auto-deploys.
4. **Then, and only then, the production cutover**: point `window.DASHBOARD_CONFIG.supabaseEdgeUrl`
   in the real `index.html` at the Worker (own commit/PR), keep Supabase as instant rollback,
   and decommission Supabase only after production validation.
No production `index.html` change and no Supabase removal in this stage.

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
- **[RESOLVED] Cloudflare deploy credentials.** Repo secrets configured; staging deployed via
  GitHub Actions to `https://biot-dashboard-staging.sw-590.workers.dev`.
- **[RESOLVED, was a blocker] Workers subrequest cap → silent gloves=0.** Fixed by raising the
  `device_event` page size to 1000. Production should still move to Workers Paid for headroom.
- **Worker secret vs var.** `BIOT_BASE_URL` must be set exactly once — either a `wrangler
  secret` or a `[vars]` entry, not both (`wrangler.toml` ships with `[vars]` commented out).
  For local dev it is set via `cloudflare/worker/.dev.vars` (gitignored).
- **[RESOLVED] Cloud egress / WAF.** Confirmed from real Cloudflare egress (`sw-590`): BIOT
  returns 200s; no IP/ASN block observed. (Re-check if BIOT WAF rules change.)
- **`workers.dev` subdomain** is `sw-590` for this account; staging URL is
  `https://biot-dashboard-staging.sw-590.workers.dev`.
- **Test-user coverage.** Only a manufacturer credential is available locally; org-role and
  real distributor-user logins were not exercised as separate logins (identical code path).
