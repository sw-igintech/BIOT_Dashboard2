# 5 — Local dev, deployment & rollback

> For the copy-paste "just get it running" steps, see
> [../how_to_start_dev_env.md](../how_to_start_dev_env.md). This chapter explains *why* each piece
> exists and covers deploy/rollback/CI.

## Running locally

The frontend and backend are independent, so "local dev" is really two processes:

### Backend (Deno)

```bash
cd deno
BIOT_BASE_URL=https://api.dev.igin.biot-med.com deno task start   # serves on :8000
```

`deno task start` (defined in [../../deno/deno.json](../../deno/deno.json)) runs
`deno run --allow-net --allow-env main.ts`. The only required env var is `BIOT_BASE_URL`. There's a
`.env` in the repo root holding the dev value; it's used by tooling, but for `deno task start` you set
the var inline (or export it) as shown.

> **PowerShell note:** `VAR=value cmd` is bash syntax. In PowerShell do
> `$env:BIOT_BASE_URL = "…"` on its own line first, then `deno task start`.

Check it: `node scripts/smoke-health.mjs http://localhost:8000` should report the health endpoint OK.

### Frontend (preview server)

You don't want to edit `index.html`'s backend URL just to test locally. Instead,
[../../deno/preview/serve-preview.mjs](../../deno/preview/serve-preview.mjs) serves the **real**
frontend files but rewrites the `DASHBOARD_CONFIG` block **in memory** to point at whatever backend you
choose, and injects a "PREVIEW" banner. Nothing on disk changes.

```bash
PREVIEW_BACKEND_URL=http://localhost:8000 node deno/preview/serve-preview.mjs   # :8789 → your local backend
node deno/preview/serve-preview.mjs                                             # :8789 → live staging backend (default)
```

The second form (no env var) is the fastest sanity check — it needs no local backend and no Deno at
all, just Node.

## Deployment — everything ships from `main`

| Layer | How | Trigger |
|-------|-----|---------|
| **Frontend** | GitHub Pages | **Automatic** on any push to `main`. No workflow needed. |
| **Backend** | GitHub Actions → `deno deploy --prod` | **Automatic** on push to `main` touching `deno/**`; also manual via `workflow_dispatch`. |

- Backend workflow: [../../.github/workflows/deploy-deno.yml](../../.github/workflows/deploy-deno.yml).
  It is hard-guarded to `main` only (`if: github.ref == 'refs/heads/main'` + `paths: deno/**`), runs
  `deno check` as a gate, deploys `deno/main.ts`, then smoke-tests `/?action=health`. So a broken build
  or wrong branch can't reach production.
- PR validation: [../../.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs `deno check` +
  frontend syntax checks on PRs to `main`.
- **Repo secrets (exactly two):** `DENO_DEPLOY_TOKEN` (must be a **new** Deno Deploy token — the classic
  `deployctl` doesn't work for the `sw-igin` org) and `BIOT_BASE_URL`.
- Manual backend deploy from your machine: `DENO_DEPLOY_TOKEN=… bash deno/deploy.sh`.

Live URLs: frontend `https://sw-igintech.github.io/BIOT_Dashboard2/`, backend
`https://biot-dashboard-staging.sw-igin.deno.net`.

## Bump the cache-buster when you change frontend assets

`index.html` loads `dashboard.css?v=…` and `dashboard.js?v=…`. GitHub Pages + browsers cache
aggressively; **bump the `?v=` value** (both files) whenever you change them, or users keep the old
version. (Pattern used: `?v=YYYYMMDD-N`.)

## Rollback (instant)

The Supabase Edge Function is still deployed as a live fallback. To revert production to it, change the
one config line back (the cutover was commit `8721309`):

```bash
git revert 8721309 && git push origin main
```

GitHub Pages redeploys the Supabase-pointed `index.html`. **No backend redeploy needed** — BIOT tokens
are backend-agnostic, so live sessions survive. This is why the Supabase twin
(`supabase/functions/biot-dashboard/index.ts`) is kept in sync and not deleted. See
[../PROJECT_STATE.md](../PROJECT_STATE.md) §5.

## Validation scripts

| Script | What it does |
|--------|--------------|
| `scripts/smoke-health.mjs <url> [--retries N --delay MS]` | Asserts `?action=health` returns ok. Used by the deploy workflow and locally. |
| `scripts/parity-check.mjs` | Deep-diffs any backend vs the Supabase reference (login/refresh/dashboard/entity + error envelopes). Env: `WORKER_URL`, `SUPABASE_ANON_KEY`, `BIOT_USERNAME`, `BIOT_PASSWORD`. |
| `deno/preview/e2e-preview.mjs` | Playwright end-to-end UI test through the preview server. Playwright is intentionally installed out-of-tree (not a repo dependency). |

Next: [06-maintenance-playbook.md](06-maintenance-playbook.md).
</content>
