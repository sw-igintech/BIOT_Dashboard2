# PROJECT STATE — authoritative handoff

**Read this first.** It is the single source of truth for where the project stands, what is live,
how it deploys, how to roll back, what is historical, and what remains open. Last updated for the
**v2.0** release (Supabase → Deno production cutover), 2026-06-18.

> **UPDATE 2026-06-29 — BIOT-ABAC hardening + cartridge view (live on `main`, HEAD `35af98c`).**
> Fixes the post-BIOT-permission-change fallout: (1) a per-call BIOT timeout + parallel/isolated
> glove aggregation so large-distributor tokens no longer hang ~90 s ("Unable to load…") — they now
> load in ~16 s and degrade gloves gracefully; (2) a new **Cartridges** table (org/distributor
> scoped; manufacturer "all" shows a "select a scope" hint). The Supabase fallback carries the same
> fixes (+ `device_event` page size 100→1000). Deployed via the normal flow and re-verified live
> (D1/D2/EC1 + manufacturer regression). Full writeup + rollback:
> `claude/INVESTIGATION_2026-06-28_slow-load_and_cartridges.md` (§10).
> **Known upstream defect (BIOT-side, not ours):** `device_event` ABAC times out (→414) for
> large-distributor tokens, so those users show 0 gloves — now handled gracefully.

---

## 1. What this project is

A static **BIOT Devices Dashboard**: operations staff log in with their own BIOT credentials and see
live device connection / glove consumption / sanitizer / operational status, a filterable machine
table, and per-device detail + settings. The backend is a **pure stateless proxy** to the BIOT REST
API (no database, no cache). **BIOT is the only source of truth.** Each user's own BIOT token is
forwarded on every request; data scope comes from that token, not a shared credential.

## 2. Current production architecture (LIVE)

```
Browser ── GitHub Pages (frontend, served from `main`) ──► Deno Deploy (backend) ──► BIOT REST API
```

| Thing | Value |
|---|---|
| Frontend (live) | `https://sw-igintech.github.io/BIOT_Dashboard2/` (GitHub Pages, branch `main`, path `/`) |
| **Backend (live, active)** | **`https://biot-dashboard-staging.sw-igin.deno.net`** — Deno Deploy app `biot-dashboard-staging`, org `sw-igin`, entrypoint `deno/main.ts` |
| Backend fallback (deployed, NOT active) | Supabase Edge Function `https://qjkrkqyycujmjxbfthev.supabase.co/functions/v1/biot-dashboard` |
| Backend source of truth | BIOT (`https://api.dev.igin.biot-med.com`, the `BIOT_BASE_URL` secret) |
| Repo source of truth | branch `main` |
| Version | **v2.0** (tag) — the Supabase→Deno cutover release |

The frontend points at the backend via one line in `index.html`:
`window.DASHBOARD_CONFIG.supabaseEdgeUrl` (the name is legacy; it now holds the **Deno** URL).
`supabaseAnonKey` is still present but ignored by the Deno backend.

## 3. What changed at cutover (v2.0)

- **Cutover commit:** `8721309` on `main` — one line in `index.html`: `supabaseEdgeUrl` switched from
  the Supabase Edge Function to the Deno Deploy URL. Nothing else changed.
- **Validated in real production after cutover** (Playwright against the live GitHub Pages site):
  19 pass / 1 warn / 0 fail; all backend traffic → Deno, 0 → Supabase. (The 1 warn is expected
  negative-path console noise: favicon 404, the deliberate bad-login `500` which is **identical** on
  Deno and Supabase, and a deliberate forced-refresh `401`.)
- The Deno backend `deno/main.ts` is a faithful port of the Supabase Edge Function with two
  proven-safe deltas: `device_event` page size 1000, and an explicit `User-Agent` header.

## 4. Deployment flow (how to ship)

Everything ships from **`main`**.

- **Frontend:** push to `main` → GitHub Pages rebuilds automatically. No workflow needed.
- **Deno backend:** push to `main` touching `deno/**` → `.github/workflows/deploy-deno.yml` runs
  automatically: `deno check` gate → `deno deploy --prod --source local` (uploads `deno/` from main)
  → health smoke test. Can also be run manually (`workflow_dispatch`). The job is hard-guarded to
  `main` only (`if: github.ref == 'refs/heads/main'`), so it can never deploy the wrong branch.
- **PR validation:** `.github/workflows/ci.yml` runs `deno check` + frontend/script syntax on PRs to `main`.
- **Secrets (GitHub repo):** exactly two — `DENO_DEPLOY_TOKEN` (a **new** Deno Deploy token — classic
  `deployctl` does not work), and `BIOT_BASE_URL`. (The old `CLOUDFLARE_*` secrets were deleted.)
- **Manual backend deploy (local):** `DENO_DEPLOY_TOKEN=… bash deno/deploy.sh`.

**Summary — automatic vs manual:**
- Automatic: frontend (Pages on `main`), Deno backend (Actions on push to `main` + `deno/**`).
- Manual (optional): Deno backend via `workflow_dispatch` or `deno/deploy.sh`.
- Nothing requires a human approval gate; safety comes from the `main`-only guard + `deno check` gate
  + PR CI. Production can only ever be the code on `main`.

## 5. Rollback (instant, preserved)

```bash
git revert 8721309 && git push origin main
```

GitHub Pages redeploys the Supabase-pointed `index.html`. **No backend redeploy needed** — the
Supabase Edge Function is still live and untouched; BIOT tokens are backend-agnostic so in-flight
sessions survive. Keep Supabase as fallback for ≈2–4 weeks before considering decommission.

(Backend-only rollback, if ever needed: redeploy a previous revision from the Deno dashboard, or
re-run the deploy workflow on a reverted `main`.)

## 6. Historical / superseded (do not treat as active)

- **Supabase** — was the production backend until 2026-06-18; now **fallback only**. Code:
  `supabase/functions/biot-dashboard/index.ts`, `supabase/config.toml`. Still deployed for rollback.
- **Cloudflare Workers** — an earlier migration attempt, **abandoned/superseded by Deno**, now retired.
  The `migration/cloudflare-runtime` branch was deleted; the work is preserved only as the tag
  **`archive/cloudflare-runtime`** (`git checkout archive/cloudflare-runtime` to inspect). It is not a
  production path. The associated `CLOUDFLARE_*` repo secrets were deleted.
- The `migration/deno-runtime` branch was fast-forward-merged into `main` and deleted. Only `main`
  remains as a branch.

## 7. Backend contract (unchanged across runtimes)

Single endpoint, multiplexed by `action` (POST body or `?action=`):
- `health` (no auth) → `{ ok, backend, timestamp }`
- `login` (POST `{username,password}`) → `{ ok, data:{ accessToken, refreshToken, userId } }`
- `refresh` (POST `{refreshToken}`) → `{ ok, data:{ accessToken, refreshToken } }`
- `dashboard` (GET, `x-biot-token` header) → full dashboard payload
- `entity` (GET `?id=`, `x-biot-token`) → single generic entity (device settings)

Auth = the user's own BIOT JWT forwarded as `Bearer` upstream; on 401 the frontend refreshes once and
retries; persistent 401 → re-login. 12-hour absolute session timeout (`auth_session_start`). CORS
allows `authorization, x-client-info, apikey, content-type, x-biot-token`. Confirmed BIOT field names
and scope/distributor logic are documented in `docs/DENO_MIGRATION.md` and the project memory.

## 8. Open items (non-blocking)

- **Real-user UI pass** for a real **organization-role** user and the real **distributor** user
  (`stamshemyafe@gmail.com`): not done — no credentials in the workspace (only the manufacturer
  account `matan@igintech.com`). Manufacturer role + org/distributor **scopes** (via the manufacturer
  dropdown) were validated. Run when credentials exist.
- **Decommission Supabase** after the fallback window — only when confident; until then keep it.
- **Optional:** a dedicated production-named Deno app/custom domain instead of the `*-staging` name.

*(Done in cleanup: the abandoned Cloudflare branch was retired to tag `archive/cloudflare-runtime`
and `CLOUDFLARE_*` secrets deleted.)*

## 9. Validation / dev tooling

- `scripts/smoke-health.mjs <url> [--retries N --delay MS]` — asserts `?action=health` ok.
- `scripts/parity-check.mjs` (`WORKER_URL=<backend> SUPABASE_ANON_KEY=… BIOT_USERNAME=… BIOT_PASSWORD=…`)
  — deep-diffs any backend vs Supabase (drift-aware). Last run vs Deno: 10 pass / 3 warn (live drift) / 0 fail.
- `deno/preview/serve-preview.mjs` + `deno/preview/e2e-preview.mjs` — real-browser UI validation
  against any backend without touching production `index.html`.
- Local credentials live in `claude/` (gitignored): `biot_credentials.env`, `BIOT_API_REFERENCE.md`.
