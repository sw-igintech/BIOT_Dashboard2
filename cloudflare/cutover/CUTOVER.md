# Production cutover runbook — Supabase → Cloudflare

> **STATUS: PREPARED, NOT EXECUTED.** Production still points at Supabase. This file describes
> the exact, isolated final step and how to undo it. Nothing here has been applied.

## The exact cutover change (single line)

Production frontend is a static `index.html` served by GitHub Pages from `main`. The cutover
is **one line** — `window.DASHBOARD_CONFIG.supabaseEdgeUrl` in `index.html`:

```diff
-      supabaseEdgeUrl: "https://qjkrkqyycujmjxbfthev.supabase.co/functions/v1/biot-dashboard",
+      supabaseEdgeUrl: "https://biot-dashboard-prod.sw-590.workers.dev",
```

A ready-to-apply patch is saved next to this file: `index.html.cutover.patch`. The
`supabaseAnonKey` line is intentionally left unchanged — the Worker ignores it (CORS allows the
header), so keeping it makes the diff minimal and the rollback trivial. (Optional later cleanup:
blank the anon key; not required for correctness.)

## Prerequisites before applying (go/no-go checklist)

- [ ] **Workers Paid plan enabled** on the Cloudflare account (raises subrequest cap 50→1000;
      otherwise very large tenants silently drop the glove widget). See `docs/MIGRATION_STATUS.md`.
- [ ] **Production Worker deployed** via the gated `Deploy Worker (production)` GitHub workflow
      (manual `workflow_dispatch`, type `deploy-production`, `production` environment approval).
      That workflow becomes runnable only after this branch is merged to `main`.
- [ ] **Confirm the real production Worker URL** from the deploy workflow output and make sure it
      matches the patch (`https://biot-dashboard-prod.sw-590.workers.dev`, unless a custom domain
      was chosen — then edit the patch URL).
- [ ] **Health + parity green against the production URL**:
      `node scripts/smoke-health.mjs https://biot-dashboard-prod.sw-590.workers.dev` and
      `WORKER_URL=<prod-url> SUPABASE_ANON_KEY=… BIOT_USERNAME=… BIOT_PASSWORD=… node scripts/parity-check.mjs`.
- [ ] **End-to-end UI green against the production URL**:
      `PREVIEW_BACKEND_URL=<prod-url> node cloudflare/preview/serve-preview.mjs` then run
      `cloudflare/preview/e2e-preview.mjs`.
- [ ] **Real-user UI pass** for a real organization-role user and the real distributor user
      (`stamshemyafe@gmail.com`) — still UNVALIDATED as separate logins (no credentials in the
      workspace). Validate before/at cutover.

## Applying the cutover (when all boxes are checked)

Do it in its own small commit/PR on `main` (NOT bundled with other changes):

```bash
git checkout main && git pull
git apply cloudflare/cutover/index.html.cutover.patch   # or hand-edit the one line
git add index.html
git commit -m "cutover: point production frontend at Cloudflare Worker"
git push        # GitHub Pages redeploys index.html from main
```

Then verify the live site loads, login works, and dashboard/charts/modal/settings render.

## Rollback (simple, immediate)

Supabase remains fully deployed and untouched, so rollback is just reverting the one line:

```bash
git revert <cutover-commit>      # restores the Supabase URL
git push                         # GitHub Pages redeploys the Supabase-pointed index.html
```

- No backend redeploy needed — the Supabase Edge Function never stopped running.
- Tokens are BIOT tokens (backend-agnostic), so in-flight sessions keep working after rollback.
- Keep Supabase live for a safe window (e.g. 2–4 weeks) post-cutover before any decommission.

## What is NOT part of cutover (later, separate)
- Removing/decommissioning the Supabase Edge Function and `supabase/` config.
- Removing the staging auto-deploy / migration-branch tooling.
- Optional GitHub Pages → Cloudflare Pages frontend hosting move.
