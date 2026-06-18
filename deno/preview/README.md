# Frontend preview → Deno backend (non-production)

Run the **real production frontend** against the **live Deno Deploy backend** without touching
production. Used for end-to-end UI validation.

> ⚠️ Non-production only. Production `index.html` is never modified — it still points at Supabase.
> This preview rewrites only the `DASHBOARD_CONFIG` block **in memory** and shows a teal
> "PREVIEW — Deno backend" banner.

## 1. Serve the preview

```bash
node deno/preview/serve-preview.mjs          # http://localhost:8789
# override: PREVIEW_PORT=9000 PREVIEW_BACKEND_URL=<deno-url> node deno/preview/serve-preview.mjs
```

`serve-preview.mjs` reads the production `index.html`, swaps `supabaseEdgeUrl` to
`https://biot-dashboard-staging.sw-igin.deno.net` (and blanks the Supabase anon key, which the
Deno backend ignores), injects the banner, and serves the unchanged `dashboard.js` /
`dashboard.css` / `logo.svg` from the repo root. Nothing on disk changes.

Open http://localhost:8789 and log in with a real BIOT account.

## 2. Automated end-to-end UI test (Playwright)

`e2e-preview.mjs` drives a real Chromium through the preview and validates login, bad-login error,
dashboard load, table, search, filter chips, date filter, charts, metrics, glove metrics,
manufacturer scope (org + distributor), device modal + settings (entity) fetch, 401→refresh→retry,
and logout — and asserts **all** backend traffic hits Deno (never Supabase).

Playwright is intentionally **not** a repo dependency. Install it out-of-tree and run:

```bash
# one-time, out of tree:
mkdir -p /tmp/e2e && (cd /tmp/e2e && npm init -y >/dev/null && npm i playwright)
ln -sfn /tmp/e2e/node_modules ./node_modules     # repo node_modules is gitignored

# run (preview server must be up):
source claude/biot_credentials.env               # BIOT_USERNAME / BIOT_PASSWORD (local only)
CHROME_BIN=/usr/bin/google-chrome-stable PREVIEW_URL=http://localhost:8789 \
  node deno/preview/e2e-preview.mjs

rm -f ./node_modules                             # cleanup symlink when done
```

Result (2026-06-18): **19 pass, 1 warn, 0 fail** (the warn is expected negative-path console noise:
favicon 404, deliberate bad-login 500, forced-refresh 401 — all identical to Supabase). See
`docs/DENO_MIGRATION.md`.
