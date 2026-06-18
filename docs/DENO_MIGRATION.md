# Deno Deploy migration — safe preparation (NO cutover)

**Branch:** `migration/deno-runtime` (off `main`)
**Date:** 2026-06-18
**Production status:** ✅ **Untouched.** GitHub Pages still serves `index.html` from `main`,
which still points at the Supabase Edge Function. Supabase remains the active backend. BIOT is
the only source of truth. Nothing in this branch changes that.

## Why Deno Deploy fits this repo

The current production backend (`supabase/functions/biot-dashboard/index.ts`) is **already
Deno-native** — it uses `Deno.serve(...)` and `Deno.env.get(...)`. Deno Deploy runs exactly that
model, so the backend ports with **zero runtime shims**. `deno/main.ts` is a faithful copy of it
plus two proven-safe deltas (page size 1000, explicit `User-Agent`) and a `"Deno Deploy"` label.

Validated 2026-06-18 in a real local Deno runtime against **live BIOT**, diffed vs the **live
production Supabase** function: **10 pass / 3 warn (live telemetry drift only, 0 structural diffs)
/ 0 fail**; `deno check` clean.

---

## The Deno UI constraint we must respect

The Deno "Create App" screen says:

> "After creating the app, the main branch of your GitHub repository will be built and
> automatically deployed to production."

### What that actually means (important)
"Production" here is the **Deno app's own production deployment at a `*.deno.dev` URL** — it is
**NOT** our real production. Our real production is:

```
GitHub Pages (serves index.html from branch `main`, path /)  →  Supabase Edge Function  →  BIOT
```

Deno Deploy **cannot** touch any of that: it does not serve GitHub Pages, does not change
`index.html`, does not touch Supabase. (Verified: GitHub Pages source = branch `main`, and that
is independent of the repo's default branch.) So even a worst-case accidental main deploy only
publishes a `deno.dev` URL that nothing points to — **real production stays 100% intact.**

That said, we still want the **first deployment to be correct and from the right branch**, and we
do **not** want to establish `main` as the auto-deploying production branch yet. So we make the
Deno app deploy our dedicated branch, never `main`.

---

## Repo structure decision

| Question | Answer |
|---|---|
| Is the repo **root** suitable as the Deno app as-is? | **No.** The root is the static frontend (`index.html`/`dashboard.js`); there is no server entrypoint at root. Pointing Deno at the root/main would build something with no valid `Deno.serve` entrypoint. |
| Does the repo need a dedicated Deno app dir/entrypoint? | **Yes.** Added `deno/` with entrypoint **`deno/main.ts`** and `deno/deno.json`. |
| Is root deployment correct or wrong? | **Wrong.** The Deno entrypoint must be set to `deno/main.ts`. |
| Is the repo safe to connect directly to Deno as-is? | Selecting the repo is fine. **Creating with the defaults (branch `main`, root entrypoint) is wrong** — it would build `main`, which has no `deno/main.ts`. Use the dedicated branch + entrypoint below. |
| What must exist before creating the app? | The `deno/main.ts` entrypoint + `deno/deno.json` on a branch Deno will deploy. Both exist on `migration/deno-runtime` (this branch). |

`deno/main.ts` exists **only** on `migration/deno-runtime`, **not** on `main`. This is a safety
property: if Deno ever tried to build `main` with entrypoint `deno/main.ts`, it would simply not
find the file and fail harmlessly (no deployment), never touching real production.

---

## Safe deployment strategy

**Deploy the dedicated branch, never `main`.** Concretely: make the Deno app's **production
branch = `migration/deno-runtime`** and its **entrypoint = `deno/main.ts`**. Then:
- the initial build deploys *our* branch (which has the entrypoint) to a `deno.dev` URL — correct;
- `main` is not the production branch, so it is not auto-deployed to the app's production.

This is layered on top of the structural guarantee that `deno.dev` ≠ real production.

---

## EXACT operator steps in the Deno UI (do this — it is now safe)

You are in the Create-App screen with org `sw-igin`, repo `sw-igintech/BIOT_Dashboard2`, and
`BIOT_BASE_URL=https://api.dev.igin.biot-med.com` already entered. **Before clicking Create:**

1. **Production branch / Branch:** change it from `main` to **`migration/deno-runtime`**.
   - If you see a branch / "Production branch" selector, set it to `migration/deno-runtime`.
   - ✅ If you CAN set it → safe to proceed.
   - ⛔ If the UI gives **no way to change the branch before Create** (it insists on `main`),
     **STOP — do not click Create.** Use the fallback in the next section instead.
2. **Entrypoint:** set to **`deno/main.ts`**.
3. **Install command:** leave **blank** (no dependencies).
4. **Build command / build step:** leave **blank** (no build — it is a plain `Deno.serve` app).
5. **Environment variables:** keep **`BIOT_BASE_URL = https://api.dev.igin.biot-med.com`**.
   Add nothing else. (Do **not** add BIOT_USERNAME/PASSWORD — unused; do not add Supabase keys.)
6. **Create App.** It builds `migration/deno-runtime` and serves it at a `…deno.dev` URL.
7. Tell me the resulting `*.deno.dev` URL. I will then run smoke + parity + end-to-end UI
   validation against it (no production change).

### Fallback (only if the UI forces branch = main)
Don't create via the GitHub auto-deploy flow. Two safe options:
- **(a) Temporarily set the GitHub default branch** to `migration/deno-runtime` (Settings →
  Branches), create the Deno app (it deploys our branch), then restore the default to `main`.
  This is safe: GitHub **Pages** is pinned to `main` independently of the default branch, so
  production is unaffected. *(I can do this for you on request; it's a repo-settings change.)*
- **(b) Manual deploy via `deployctl`** (no GitHub auto-deploy): `deployctl deploy --project=<app>
  --entrypoint=deno/main.ts` from `migration/deno-runtime`. This needs a **Deno Deploy access
  token** (see below).

---

## Do you need a new token/credential?

- **GitHub-integration flow (recommended path above):** **No new token.** The Deno↔GitHub app is
  already connected (the repo is selectable), and `BIOT_BASE_URL` is the only runtime secret.
- **`deployctl` fallback only:** yes — a **Deno Deploy access token** (`DENO_DEPLOY_TOKEN`,
  created in the Deno dashboard → Account → Access Tokens). Needed *only* if you use option (b).

---

## After the app exists: validate (still no cutover)

```bash
node scripts/smoke-health.mjs https://<app>.deno.dev
WORKER_URL=https://<app>.deno.dev SUPABASE_ANON_KEY=<publishable> \
  BIOT_USERNAME=… BIOT_PASSWORD=… node scripts/parity-check.mjs
PREVIEW_BACKEND_URL=https://<app>.deno.dev   # (frontend preview, if desired)
```

## Cutover (LATER, separate, one line) and rollback

- **Cutover** = point `index.html` `supabaseEdgeUrl` at the validated `…deno.dev` URL, in its own
  small commit on `main`. **Not done here.**
- **Rollback** = `git revert` that one-line commit and push; GitHub Pages redeploys the
  Supabase-pointed `index.html`. Supabase stays live and untouched (keep it for weeks post-cutover).

## Go / no-go before cutover
- [x] `deno/main.ts` entrypoint exists on `migration/deno-runtime`, `deno check` clean, parity PASS locally.
- [ ] Deno app created from `migration/deno-runtime` (NOT main); `…deno.dev` URL known.
- [ ] Smoke + parity + E2E green against the real `…deno.dev` URL.
- [ ] Real-user UI pass for a real organization-role user and the real distributor user
      (`stamshemyafe@gmail.com`) — **still no credentials in the workspace** (only the manufacturer
      account is available); validate when credentials exist.
- [ ] Cutover applied as its own one-line commit on `main`, with Supabase kept as rollback.
