# BIOT Devices Dashboard

Static frontend on **GitHub Pages** backed by a **Deno Deploy** backend that proxies live BIOT API calls server-side.

> **Production runtime (since the 2026-06-18 cutover, commit `8721309`):** the active backend is the
> **Deno Deploy** app at **`https://biot-dashboard-staging.sw-igin.deno.net`** (`deno/main.ts`).
> The **Supabase Edge Function remains deployed as an instant fallback** (not the active path).
> **This is version 2.0** — the release where production moved from Supabase to Deno.
> New session? Read **`docs/PROJECT_STATE.md`** first — it is the authoritative handoff doc.

## Architecture (current)

```
Browser (GitHub Pages — index.html / dashboard.js / dashboard.css, served from `main`)
    │
    │  fetch() — plain HTTPS
    │  POST { action: "login" }       user logs in with their own BIOT credentials
    │  POST { action: "refresh" }      token refresh on 401
    │  GET  ?action=dashboard  +  x-biot-token: <user's BIOT access JWT>
    │  GET  ?action=entity&id=<uuid>  +  x-biot-token   (device settings fetch)
    ▼
Deno Deploy  →  https://biot-dashboard-staging.sw-igin.deno.net   (deno/main.ts)   ← ACTIVE PRODUCTION
    │            (Supabase Edge Function still deployed = instant fallback, not active)
    │  server-side HTTP — forwards the user's own token to BIOT
    ▼
BIOT API
```

BIOT is the **only** source of truth. The backend is a pure proxy — no database, no caching, no sync.
Data scope is determined entirely by the logged-in user's own BIOT token, not a shared server credential.
The Deno backend (`deno/main.ts`) is a faithful port of the original Supabase Edge Function
(`supabase/functions/biot-dashboard/index.ts`) — identical request/response contract — plus a larger
`device_event` page size and an explicit `User-Agent`. Health/`meta.backend` report `"Deno Deploy"`.

---

## Deployment

Source of truth is the **`main`** branch. Both layers ship from `main`:

| Layer | How it deploys | Trigger | Where |
|---|---|---|---|
| **Frontend** | GitHub Pages | **Automatic** on push to `main` | `https://sw-igintech.github.io/BIOT_Dashboard2/` |
| **Deno backend** | GitHub Actions → `deno deploy --prod` | **Automatic** on push to `main` touching `deno/**` (also manual `workflow_dispatch`) | `https://biot-dashboard-staging.sw-igin.deno.net` |

- Backend workflow: `.github/workflows/deploy-deno.yml`. It runs **only from `main`** (hard
  `if: github.ref == 'refs/heads/main'` guard + `paths: deno/**`), gates on `deno check`, deploys
  `deno/main.ts` via `--source local`, then smoke-tests `/?action=health`. So production can never be
  deployed from the wrong branch, and broken code can't ship.
- PR validation: `.github/workflows/ci.yml` (`deno check` + frontend/script syntax) runs on PRs to `main`.
- Secrets (GitHub repo): `DENO_DEPLOY_TOKEN`, `BIOT_BASE_URL` (used by the deploy workflow). The token
  must be a **new** Deno Deploy token (classic `deployctl` does not work — org `sw-igin` is on the new
  Deno Deploy; the CLI is `deno deploy`). These are the only two repo secrets.
- Manual backend redeploy: dispatch the workflow, or locally `DENO_DEPLOY_TOKEN=… bash deno/deploy.sh`.

### Rollback (instant)

The cutover is a single line in `index.html`. To revert production to Supabase:

```bash
git revert 8721309 && git push origin main
```

GitHub Pages redeploys the Supabase-pointed `index.html`. No backend redeploy is needed — the Supabase
Edge Function is still live and untouched, and BIOT tokens are backend-agnostic so sessions survive.
Keep Supabase as fallback for a safe window (≈2–4 weeks) before considering decommission.

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

### UI behavior

- **Machine table filter:** All / Disconnected (default) / Connected chips. Clicking a doughnut segment or legend row also sets the filter and scrolls to the table.
- **Machine search:** Live partial-match field in the table header — filters by device ID as the user types.
- **Device detail:** Opens as a centered modal on row click. Two tabs: Status (from device `_status` fields) and Settings (async-fetched via the `entity` action). Status tab shows the device's End User org and Distributor (the latter from `device_distributor` on the BIOT device payload). Closes on backdrop click or Escape.
- **Glove chart:** Legend shows a HIGH DEMAND badge on the highest-consumption size. A PRO TIP row below the chart recommends stocking the top size.
- **Scope selector (manufacturer only):** Two optgroups — *Distributors* and *Organizations*. Selecting a distributor scopes the dashboard to every device whose `device_distributor.id` is that distributor **OR** whose owner organization is a **legitimate customer org** linked to that distributor via an `organization_to_distributor` bridge entity. The shared manufacturer **root organization** (`00000000-…`) and null/`<<Global>>` bridge owners are **never** treated as a distributor customer org (guard in `buildDistributorToOrgsMap`) — an invalid bridge linking root → a distributor would otherwise expand that scope to the entire estate (see `claude/INVESTIGATION_2026-07-14_bemar-distributor-scope.md`). Selecting an organization scopes to devices owned by that org. "All organizations" disables scope filtering.
- **Non-manufacturer users (incl. distributor users):** The scope selector is hidden. The dashboard shows exactly the device set BIOT returned under that user's token — no additional client-side scope filtering. Verified live with the D1 distributor user (`groups: []`, `ownerOrganizationId: <manufacturer root org>`): BIOT returned the 4 expected devices spanning the distributor's own org and child orgs, and the dashboard passes them through unchanged.

---

## Key files

| File | Purpose |
|---|---|
| `index.html` | Dashboard shell + backend endpoint config (`DASHBOARD_CONFIG.supabaseEdgeUrl` — now the Deno URL) |
| `dashboard.js` | All rendering + API fetch logic |
| `dashboard.css` | Visual styles |
| `deno/main.ts` | **Active production backend** — Deno Deploy BIOT proxy |
| `deno/deploy.sh` | Local Deno redeploy helper |
| `deno/preview/` | Non-prod preview server + Playwright E2E (point the real frontend at any backend URL) |
| `.github/workflows/deploy-deno.yml` | Auto/ manual production backend deploy (main only) |
| `.github/workflows/ci.yml` | PR validation |
| `scripts/parity-check.mjs` | Backend parity harness (any backend URL vs Supabase) |
| `scripts/smoke-health.mjs` | Health smoke test |
| `docs/PROJECT_STATE.md` | **Authoritative handoff / current-state doc** |
| `docs/DENO_MIGRATION.md` | Full Supabase→Deno migration record (cutover, validation, rollback) |
| `supabase/functions/biot-dashboard/index.ts` | Supabase Edge Function — **fallback only** (historical active backend) |
| `supabase/config.toml` | Supabase project config (`verify_jwt = false`) — fallback only |

---

## Local development

**Deno backend (current):**
```bash
cd deno
BIOT_BASE_URL=<your-biot-base-url> deno task start   # serves on :8000
node ../scripts/smoke-health.mjs http://localhost:8000
```

**Frontend preview against any backend (non-production):**
```bash
PREVIEW_BACKEND_URL=https://biot-dashboard-staging.sw-igin.deno.net node deno/preview/serve-preview.mjs
# serves the real frontend with the config rewritten in-memory; production index.html is untouched
```

---

## Fallback & historical paths

- **Supabase (fallback, not active):** the Edge Function `supabase/functions/biot-dashboard/index.ts`
  remains deployed for instant rollback. To operate/redeploy it:
  ```bash
  supabase login && supabase link --project-ref <ref>
  supabase secrets set BIOT_BASE_URL=<your-biot-base-url>
  npx supabase functions deploy biot-dashboard --project-ref <ref>
  ```
  (`verify_jwt = false`; authenticated by the user's own BIOT token.) `BIOT_USERNAME`/`BIOT_PASSWORD`
  are not used at runtime.
- **Cloudflare Workers (abandoned, retired):** an earlier migration attempt, **superseded by Deno**.
  Its branch was removed; the work is preserved only as the tag **`archive/cloudflare-runtime`**
  (`git checkout archive/cloudflare-runtime` to inspect). It is **not** a production path and never was.
  The associated `CLOUDFLARE_*` repo secrets have been deleted.
