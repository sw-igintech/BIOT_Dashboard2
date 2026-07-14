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

> **UPDATE 2026-06-30 — glove metrics decoupled to an async `gloves` action (live on `main`, HEAD `f55b867`).**
> Re-proved the stamshemyafe slowness fresh: it is a BIOT-side ABAC expansion defect **specific to
> `device_event` + that token** (identical query is 200/~0.4s under MFR/EC1/D2 but 414/~90s under
> stamshemyafe; independent of time-window/filter/limit) — **not** machine count (it sees 7 vs the
> manufacturer's 100+). Caching was evaluated and **rejected** (can't cache data BIOT never returns;
> violates the no-DB/no-cache rule). Fix: the `dashboard` action returns everything except gloves
> (marked `pending`); a new `gloves` action loads them asynchronously so the doomed call never blocks
> the page. **Main dashboard: stamshemyafe ~16s→~2s, manufacturer ~8s→~3s**; glove widget shows live
> data where BIOT serves it, "temporarily unavailable" where it 414s. Supabase fallback mirrors it.
> Writeup + rollback: `claude/INVESTIGATION_2026-06-30_glove-async-decoupling.md`.
> *(Repo was relocated to `~/Documents/IGIN_GITHUB/machines_dashboard_CLAUDE`; git/remote unchanged.)*
>
> **Follow-up (same day, frontend-only, `main` @ `72ebcab`, assets `?v=20260630-2`):** glove widget
> now has 4 explicit UI states — a glove-themed "filling" loading animation, real data, an honest
> **real-zero** ("No glove events in the selected period." + 0 tiles), and a clear **unavailable**
> (⚠ + BIOT-timeout message) — so a true zero no longer looks like "nothing loaded" and loading/
> failure are never shown as 0. GitHub Pages rebuild only (no backend change).
>
> **Follow-up 2 (same day, `main` @ `e1417c4`, assets `?v=20260630-3`):** made the async glove load
> **patient** instead of fail-fast. The glove `device_event` path now uses an 85s budget (vs the 15s
> fast-path used everywhere else), so the glove loading animation stays for the full background load
> (~86s for large distributors) and only then resolves to data / real-zero / unavailable — never
> giving up early. Capped at 85s because Deno Deploy aborts a request at ~116s. Verified live: STAM
> gloves run ~86s → clean UNAVAILABLE; MFR → DATA; EC1 → real-zero; main dashboard stays ~1.6s.

> **UPDATE 2026-07-06 — CORRECTION: the prior root-cause attribution is DISPROVEN; D1 gloves still 414
> (no code change).** The 2026-06-30/07-01 conclusion said D1's (`stamshemyafe`) `device_event` 414s
> because its inventory machines were owned by the 261k-event root org `00000000`, and recommended
> re-homing them out of root. **That re-homing was done** — D1's 6 devices are now all under EC1, none
> in root, and root's `device_event` volume collapsed **261,582 → 5,305** — **yet D1's `device_event`
> STILL returns HTTP 414** (now in **~2 s**, not ~90 s). Re-proved fresh: 414 is **token-specific**
> (identical `device_event(EC1)` query is 200/0.3s under EC1, 200/0.4s under MFR) and
> **`device_event`-specific** (cartridge/orgs/bridges/devices all 200 under D1). It is **independent of
> device ownership, event volume, org count, `device_distributor` breadth (D1 = 6 links, all EC1, none
> in root), and JWT scopes (D1 == D2 byte-identical).** True cause: a **BIOT-side ABAC defect that
> materialises D1's user-level permission set into an over-length internal request URI** — now low
> enough to trip even a 6-device distributor. **No our-side query shape avoids it** (POST search
> unsupported; every GET shape 414s); the only mitigation is a service/manufacturer token (rejected
> security change). Live now: D1 dashboard 2.4s, gloves fail **fast** (~4s) → clean UNAVAILABLE — no
> regression, strictly better than the old ~86s wait. **Correct remediation is BIOT-side** (fix the
> device_event ABAC URI build, and/or audit D1's stale device-level authz grants vs D2's). Full proof +
> per-user comparison: `claude/INVESTIGATION_2026-07-06_glove-414-recurrence-devices-rehomed.md`.

> **FIX 2026-07-06 — glove false-zero for ALL scoped users (backend, live on `main` @ `0794a18`).**
> QA: *"top glove-consumption section = 0, but the cartridge table below has data"* (D1→EC1). Proven
> two separate issues: (1) **our bug** — `getGloveEventsForOrg` post-filtered GLOVE_TAKEN events by
> `device_event.id ∈ scopedDeviceIds`, but **end-customer-org events carry a NULL device reference**
> (only root-org `igin_device` events populate it), so the old `if (!deviceId || !has) continue`
> dropped **every** event for **every scoped (non-"all") user** → gloves always 0; only the
> manufacturer "all" view (filter skipped) ever showed data. (2) D1 separately 414s (above). Fix
> (1 line): `if (deviceId && !allowedDeviceIds.has(deviceId)) continue;` — count null-ref events (they
> are already org-scoped), still exclude positively-out-of-scope refs (root over-count protection),
> "all" unchanged. Verified live + real-browser A/B: **EC1 0→8, EC2 0→3, EC3 0→24**, MFR 5398
> unchanged, D2 genuine zero, D1 still honest UNAVAILABLE. Backend-only (Deno + Supabase mirror);
> frontend unchanged. Deploy run 28797561473 → success. Rollback: `git revert 0794a18 && git push`.
> Full proof: `claude/INVESTIGATION_2026-07-06_glove-false-zero-null-device-ref.md`.

> **FEATURE 2026-07-06 — Glove Consumption now shows "used / available stock" per size (frontend,
> live on `main` @ `fc04baa`, assets `?v=20260706-1`).** Each glove size tile shows gloves USED in the
> selected period (big number) + a "of N in stock" sub-line = CURRENT available inventory, e.g.
> `Large 6 / of 150 in stock`, with a caption clarifying the split (used = date range; stock =
> current). **Stock source: the BIOT `cartridge` entity's `current_amount` summed by `cartridge_size`,
> already fetched + scoped in the `dashboard` action (`state.summary.cartridges`)** — frontend-only, no
> backend change, no new API call. Honest: stock shown only when known — hidden for manufacturer "all"
> (scopeHint) and no-cartridge scopes. All four glove states preserved; D1 stays UNAVAILABLE (BIOT
> 414). Verified live (EC1 8/265, D2 0/241, MFR data+no-stock, D1 unavailable). GitHub Pages only (no
> backend deploy). Rollback: `git revert fc04baa && git push`. Doc:
> `claude/FEATURE_2026-07-06_glove-used-vs-stock.md`.

> **INVESTIGATION 2026-07-06 — BIOT support (Sasho) distributor-scope hypothesis: DISPROVEN (no code
> change).** Sasho claimed distributor glove failure is because we scope `device_event` by
> `_ownerOrganization.id` (org rule) instead of distributor rules, and to fix it use distributor
> filtering or "resolve visible devices then query events by those devices". Tested every alternative
> live under D1's token: our org query, **no filter (pure ABAC)**, **by `device_event.id IN [devices]`**,
> single device id, `device_distributor.id`, and even a 134-char no-filter request — **ALL return
> HTTP 414**; identical URLs succeed under MFR. So the 414 is a BIOT-internal ABAC URI overflow,
> **token-specific and query-independent** — removing the org filter and using device-based filtering
> (exactly Sasho's fixes) both still 414. Also **D2 is a distributor on the same code path and its
> `device_event` returns 200** (0 events), so it is **not** a distributor-class issue — only D1's token.
> D2's zero is itself BIOT-side: its orgs' events all carry a **null device reference**, so a
> distributor (device-based ABAC) is served none — for every query shape. **Root cause = two BIOT-side
> defects: (1) `device_event` ABAC URI overflow for D1's token (414); (2) null `device_event→device`
> references, which also break Sasho's own device-based approach.** Our org+device-post-filter logic is
> correct (D2 proves it) and is not the cause. No our-side fix possible without a service-token ABAC
> bypass (rejected). Top-vs-bottom (D1): top `device_event`→414→UNAVAILABLE, bottom `cartridge`→200→16;
> different endpoints, BIOT-side. Full proof: `claude/INVESTIGATION_2026-07-06_sasho-distributor-scope-hypothesis.md`.

> **RETEST 2026-07-07 — BIOT deployed a fix to dev; verified (no code change). PARTIAL.** ✅ The
> **`device_event` 414 is ELIMINATED** — D1 (`stamshemyafe`) now returns 200 (~0.5s) for every query
> shape (was 414); D2 (`noamkatsir`) and EC1 (`ligeva`) still work; no regressions (machines/cartridges/
> other widgets fine, MFR DATA 5562). D1's dashboard now loads fast and the glove widget shows a clean
> **REAL-ZERO** ("0 used · of 925 in stock") instead of the ⚠ unavailable overlay. ❌ **BUT distributor
> glove DATA still doesn't load:** D1 now sees 472 device_events (all with populated device refs) but
> **0 GLOVE_TAKEN**, because **GLOVE_TAKEN events still carry `device_event = null`** (verified D1/EC1/MFR:
> EC1 has 10, all null-ref) and BIOT's (now device-linkage-based) distributor ABAC serves none. ❌ **The
> distributor GET-by-id access control is NOT enforced:** as D1 (serves EC1/EC2 only) I read foreign EC3
> `drum`, `device_current_settings`, and `device_event` by id (v1 AND v3) → all 200; should be blocked.
> Two BIOT-side items remain: (a) populate `device_event→device` on GLOVE_TAKEN; (b) enforce GET-by-id
> ABAC for drum + device_current_settings. Message-for-Sasho + full evidence:
> `claude/RETEST_2026-07-07_biot-fix-verification.md`.

> **AUDIT 2026-07-07 — skeptical re-validation of everything told Sasho (no code change).** Headlines
> hold (414 fixed ✓; null-ref + GET-by-id AC remain ✗), but found **1 overstatement + 2 nuances** to
> correct: (1) **CORRECTION** — we said "*every* GLOVE_TAKEN event has null device ref"; that's WRONG —
> **root-org glove events ARE linked** (18,363, populated); the null-ref is **specific to end-customer
> orgs** EC1/EC2/EC3. Verified null is a REAL property (same via search AND GET-by-id, e.g. EC1 event
> `185feb37…` → device_event:null) not a list artifact. (2) **NUANCE** — **noam (D2) is ALSO affected**
> by null-refs (EC2/EC3 hold only D2's devices; their 4+24 glove events are null-ref → D2 sees 0), not a
> "clean genuine zero"; it just has no 414. (3) **NUANCE** — ligeva's "DATA(8)" is window-dependent
> (events ≥16d old → default 13-day view shows real-zero; data on widening); unchanged by the fix.
> GET-by-id gap STRENGTHENED: D1's SEARCH is correctly scoped (12 EC1 drums) but GET-by-id returns
> entities from **fully-foreign orgs** (test-igin-org, Org Sample, Test-4.11.25) → all 200, for drum/
> settings/cartridge/device_event. No our-side bug; nothing mis-blamed on BIOT. Corrected message for
> Sasho + full proof: `claude/AUDIT_2026-07-07_sasho-claims-revalidation.md`.

> **RE-VALIDATION 2026-07-08 — Sasho's follow-up GET-by-id fix + glove-linkage explanation (no code
> change).** ❌ **The follow-up GET-by-id fix did NOT take effect for distributors.** Org admins are
> correctly restricted (EC1/EC2/EC3 → **403** on a foreign drum), but distributor D1 still reads foreign
> drums/settings by id (v1 AND v3) from EVERY org tested (EC3, test-igin-org, Org Sample, Test-4.11.25)
> → all **200**. So the gap is **distributor-specific** (D1 & D2, both root-homed) and still open. ✅
> **Sasho's glove-linkage explanation CONFIRMED** by a same-query/different-token proof: `device_event
> (EC1, GLOVE_TAKEN, 120d)` returns **10** rows for MFR and the EC1 **org admin** (all `device_event=null`)
> but **0** for **distributor** D1 (device-link ABAC excludes null-linked rows); D2 identical (EC2 4/0,
> EC3 24/0). **CORRECTION to Sasho:** our query shape is NOT the lever — BIOT returns 0 to D1 for org
> filter, no filter, AND `device_event.id IN [devices]` alike, so no dashboard query change surfaces the
> data; fix is 100% BIOT-side (populate `device_event→device` on end-customer-org glove events; root
> events already linked). No regressions; distributors show honest REAL-ZERO ("0 used · N in stock"),
> org admins DATA (window-dependent). No our-side bug. Proof + message for Sasho:
> `claude/REVALIDATION_2026-07-08_sasho-followup.md`.

> **VERIFICATION 2026-07-08 (later) — Sasho's exact GET-by-id URLs + stam gloves now WORK (no code
> change).** ✅ **GET-by-id fix confirmed on the exact path Sasho tested** — as stam, `GET /generic-entity/
> v3/generic-entities/drum/24657ff7…` and `…/device_current_settings/66b03f7c…` now return **403
> ACCESS_DENIED**; stam's OWN drum/settings via the same v3 path still 200 (correct, not over-blocking).
> ⚠️ **Remaining gap:** the **v1 id-only path** `/generic-entity/v1/generic-entities/{id}` is **still
> open** (foreign → 200) — org admins are blocked there too, so it's distributor-specific; and it's the
> path our dashboard's `entity` action uses. BIOT should extend enforcement to v1. ✅ **stam glove
> consumption now WORKS with real data (DATA 41):** fresh GLOVE_TAKEN events with a populated
> `device_event` link were generated on dev today (device `Machine-26-080726`); stam sees the 40 linked
> events. Proves the historical-vs-current split — EC1 admin sees 50 (=40 linked + 10 old null-ref),
> distributor sees exactly the 40 linked. UI renders DATA (tiles+chart+used/stock), no errors. **No need
> to generate more events.** D2/noam still 0 (no freshly-linked events on its devices yet — residual
> historical data, not a path failure). Full sweep: D1 DATA(41)/EC1 DATA(49)/EC2 DATA(3)/EC3 DATA(24)/
> MFR DATA(5661); no 414/regression. Proof + Sasho message: `claude/VERIFICATION_2026-07-08b_sasho-getbyid-and-gloves.md`.

> **HARDENING 2026-07-12 — `entity` action migrated off the open v1 path to the ABAC-enforced v3 path
> (LIVE on `main` @ `ef7c97e`, backend-only).** The device-settings `entity` action fetched
> `device_current_settings` via `GET /generic-entity/v1/generic-entities/{id}` — a path BIOT does NOT
> enforce distributor ABAC on. Switched to the template-scoped `GET /generic-entity/v3/generic-entities/
> device_current_settings/{id}` (BIOT enforces it: distributor foreign → 403). **Verified:** v3 returns a
> byte-identical settings body for permitted ids; all users' OWN device settings still load (200); the
> distributor foreign leak via our proxy is now closed (D1 → EC3 settings: v1 200 → v3 403/action 500);
> real-browser Settings tab identical on v1 vs v3 (Machine-26-080726 → small/5/left/No/Yes). Full
> dashboard sweep clean, no regression (only the `entity` action changed; Deno + Supabase mirror; frontend
> unchanged, no asset bump). Deno deploy run 29191288984 → success. **Remaining BIOT-side (not ours):**
> `v1/generic-entities/{id}` still open on BIOT (we no longer use it); v3 `device_current_settings` still
> permits org-admin cross-org reads (unlike `drum`). Rollback: `git revert ef7c97e && git push`. Full
> proof: `claude/HARDENING_2026-07-12_entity-v3-migration.md`.

> **FIX 2026-07-14 — distributor scope no longer inherits the manufacturer root org (LIVE on `main` @
> `a88a697`, backend-only).** A manufacturer selecting distributor **BEMAR Srl** saw **126 devices /
> 7,810 cartridges / 5,546 gloves / manufacturer-level sanitizer+operational**, while BIOT's
> "Distributor Devices" tab shows **0**. Root cause: an `organization_to_distributor` bridge incorrectly
> links the shared manufacturer **root org `00000000`** to BEMAR (also `dist1`, `Matan test`), and
> `buildDistributorToOrgsMap` added root to the distributor's child-org set → `resolveScope`
> `organizationIds=[root]` → every distributor-scoped widget expanded to the whole estate. **Fix (single
> central guard):** `buildDistributorToOrgsMap` now skips bridges whose owner org is the root org (plus
> the existing missing/`<<Global>>` skip); this one spot feeds `resolveScope`, so devices, cartridges,
> glove events, sanitizer, operational, and the machine list are all corrected. Deno + Supabase mirror
> in parity; frontend unchanged. **Verified live (23/23 regression, both local + deployed):** BEMAR
> 126→**0** devices (gloves 5546→0, cartridges 7810→**58** = its own direct stock, all widget counts →0);
> `dist1`→0; `Matan test`→1 (direct only); **D1 8 / D2 2 unchanged; manufacturer all 136 unchanged**.
> `scripts/scope-regression.mjs` added. **BIOT data NOT mutated** (risky on shared dev data; guard makes
> it safe regardless) — 3 invalid bridge entities still need admin cleanup:
> `07d980b1-…`(root→BEMAR), `b39ce951-…`(root→dist1), `3c1e7f5f-…`(root→Matan test). Rollback:
> `git revert a88a697 && git push`. Full proof: `claude/INVESTIGATION_2026-07-14_bemar-distributor-scope.md`.

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
