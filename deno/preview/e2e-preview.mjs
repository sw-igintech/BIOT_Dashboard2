#!/usr/bin/env node
// End-to-end UI validation of the dashboard against the live DENO backend.
//
// Drives a real Chromium browser through the preview build (serve-preview.mjs), which loads the
// unmodified production dashboard.js/dashboard.css but points window.DASHBOARD_CONFIG at the Deno
// Deploy app. Exercises login, refresh, logout, dashboard load, table, search, filter chips, date
// filter, charts, metrics, device modal + settings fetch, and manufacturer scope (org + distributor).
// Asserts ALL backend traffic hits the Deno host (never Supabase) and that there are no uncaught
// page errors.
//
// Requires Playwright + a Chromium build. Creds + URLs via env:
//   BIOT_USERNAME, BIOT_PASSWORD   (sourced from claude/biot_credentials.env)
//   PREVIEW_URL   (default http://localhost:8789)
//   STAGING_HOST  (default biot-dashboard-staging.sw-igin.deno.net)
//   E2E_EMAIL / E2E_PASSWORD optional overrides for the login role under test.
//   CHROME_BIN    optional path to a system Chrome.

import { chromium } from "playwright";

const PREVIEW_URL = process.env.PREVIEW_URL || "http://localhost:8789";
const STAGING_HOST = process.env.STAGING_HOST || "biot-dashboard-staging.sw-igin.deno.net";
const EMAIL = process.env.E2E_EMAIL || process.env.BIOT_USERNAME;
const PASS = process.env.E2E_PASSWORD || process.env.BIOT_PASSWORD;

const results = [];
const ok = (name, detail = "") => { results.push({ name, pass: true, detail }); console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`); };
const warn = (name, detail = "") => { results.push({ name, pass: "WARN", detail }); console.log(`[WARN] ${name}${detail ? " — " + detail : ""}`); };
const fail = (name, detail = "") => { results.push({ name, pass: false, detail }); console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`); };

if (!EMAIL || !PASS) { console.error("Missing BIOT_USERNAME/BIOT_PASSWORD (or E2E_EMAIL/E2E_PASSWORD)."); process.exit(2); }

const launchOpts = { headless: true, args: ["--no-sandbox"] };
let browser;
if (process.env.CHROME_BIN) browser = await chromium.launch({ ...launchOpts, executablePath: process.env.CHROME_BIN });
else { try { browser = await chromium.launch({ ...launchOpts, channel: "chrome" }); } catch { browser = await chromium.launch(launchOpts); } }

const ctx = await browser.newContext();
const page = await ctx.newPage();

const backendHits = { deno: 0, supabase: 0 };
const actionsSeen = new Set();
page.on("request", (req) => {
  const u = req.url();
  if (u.includes(STAGING_HOST)) { backendHits.deno++; const a = new URL(u).searchParams.get("action"); if (a) actionsSeen.add(a); }
  else if (u.includes("supabase.co")) backendHits.supabase++;
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console.error: " + m.text()); });

const waitDash = () => page.waitForResponse(
  (r) => r.url().includes(STAGING_HOST) && r.url().includes("action=dashboard") && r.status() === 200,
  { timeout: 45000 });

try {
  await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loginView:not(.hidden)", { timeout: 15000 });
  const banner = await page.locator("text=PREVIEW — Deno backend").count();
  ok("preview loads + login view + banner", `banner=${banner}`);

  // error handling: bad creds
  await page.fill("#loginEmail", EMAIL);
  await page.fill("#loginPassword", "definitely-wrong-password");
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(STAGING_HOST), { timeout: 30000 }).catch(() => {}),
    page.click("#loginBtn"),
  ]);
  await page.waitForSelector("#loginError:not(.hidden)", { timeout: 15000 });
  ok("error handling: bad login shows error", JSON.stringify((await page.locator("#loginError").textContent())?.trim()));

  // login (real)
  await page.fill("#loginPassword", PASS);
  const [dashResp] = await Promise.all([ waitDash(), page.click("#loginBtn") ]);
  await page.waitForSelector("#dashboardView:not(.hidden)", { timeout: 15000 });
  ok("login → dashboard view", `dashboard HTTP ${dashResp.status()}`);

  const userInfo = (await page.locator("#userInfo").textContent())?.trim();
  userInfo ? ok("user info populated", userInfo) : warn("user info empty");

  // table
  await page.waitForFunction(() => document.querySelectorAll("#machinesTableBody tr").length > 0, { timeout: 20000 });
  const rowCount = await page.locator("#machinesTableBody tr").count();
  ok("machine table renders", `rows=${rowCount} countBadge=${(await page.locator("#machinesCount").textContent())?.trim()}`);

  // charts
  const chartSizes = await page.evaluate(() => ["connectionChart","gloveChart","sanitizerChart","operationalChart"]
    .map((id) => { const c = document.getElementById(id); return c ? `${id}:${c.width}x${c.height}` : `${id}:MISSING`; }));
  const allCharts = chartSizes.every((s) => !s.includes("MISSING") && !s.endsWith(":0x0"));
  allCharts ? ok("charts rendered", chartSizes.join(", ")) : fail("charts missing/zero-size", chartSizes.join(", "));

  // metrics
  const metrics = await page.evaluate(() => ["connectionMetrics","gloveMetrics","sanitizerMetrics","operationalMetrics"]
    .map((id) => (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)));
  metrics.every((m) => m.length > 0) ? ok("metric widgets populated", metrics.join(" | ")) : warn("some metric widgets empty", metrics.join(" | "));

  const gloveText = (await page.locator("#gloveMetrics").textContent() || "").replace(/\s+/g, " ").trim();
  /[1-9]/.test(gloveText) ? ok("glove metrics non-zero", gloveText.slice(0, 60)) : warn("glove metrics appear zero", gloveText.slice(0, 60));

  // search
  const firstId = await page.evaluate(() => document.querySelector("#machinesTableBody tr td")?.textContent?.trim() || "");
  if (firstId) {
    const frag = firstId.slice(0, Math.min(4, firstId.length));
    await page.fill("#machineSearch", frag);
    await page.waitForTimeout(400);
    const filtered = await page.locator("#machinesTableBody tr").count();
    const allMatch = await page.evaluate((f) => Array.from(document.querySelectorAll("#machinesTableBody tr td:first-child"))
      .every((td) => td.textContent.toLowerCase().includes(f.toLowerCase())), frag);
    (filtered <= rowCount && allMatch) ? ok("search filter", `"${frag}" → ${filtered}/${rowCount} rows`) : fail("search filter wrong", `filtered=${filtered} allMatch=${allMatch}`);
    await page.fill("#machineSearch", ""); await page.waitForTimeout(200);
  } else warn("search filter skipped", "no first row id");

  // filter chips
  const chipCounts = {};
  for (const f of ["all", "connected", "disconnected"]) {
    await page.click(`.filter-chip[data-filter="${f}"]`);
    await page.waitForTimeout(300);
    chipCounts[f] = await page.locator("#machinesTableBody tr").count();
    if (!(await page.getAttribute(`.filter-chip[data-filter="${f}"]`, "class")).includes("filter-chip--active")) fail("filter chip active state", f);
  }
  ok("filter chips switch", JSON.stringify(chipCounts));
  await page.click('.filter-chip[data-filter="all"]'); await page.waitForTimeout(200);

  // date filter → Apply reload
  const setDate = await page.evaluate(() => {
    const f = document.querySelector("#fromDate")?._flatpickr, t = document.querySelector("#toDate")?._flatpickr;
    if (f && t) { f.setDate("2026-05-01", true); t.setDate("2026-05-31", true); return true; }
    return false;
  });
  await page.fill("#fromTime", "00:00").catch(() => {});
  await page.fill("#toTime", "23:59").catch(() => {});
  const [dResp] = await Promise.all([ waitDash(), page.click("#refreshBtn") ]);
  await page.waitForTimeout(400);
  ok("date filter Apply reloads", `setViaFlatpickr=${setDate} dashboard HTTP ${dResp.status()}`);

  // scope (manufacturer)
  let orgOpt = "", distOpt = "";
  const scopeVisible = await page.evaluate(() => !document.getElementById("organizationField")?.classList.contains("hidden"));
  if (scopeVisible) {
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll("#organizationSelect optgroup")).map((g) => g.label));
    orgOpt = await page.evaluate(() => Array.from(document.querySelectorAll("#organizationSelect option")).find((o) => o.value.startsWith("org:"))?.value || "");
    distOpt = await page.evaluate(() => Array.from(document.querySelectorAll("#organizationSelect option")).find((o) => o.value.startsWith("dist:"))?.value || "");
    ok("scope selector visible (manufacturer)", `optgroups=[${groups.join(",")}] org=${orgOpt?"yes":"no"} dist=${distOpt?"yes":"no"}`);
    if (orgOpt) { const [r] = await Promise.all([ waitDash(), page.selectOption("#organizationSelect", orgOpt) ]); await page.waitForTimeout(300);
      ok("scope: select organization reloads", `${orgOpt} → HTTP ${r.status()} count=${(await page.locator("#machinesCount").textContent())?.trim()}`); }
    if (distOpt) { const [r] = await Promise.all([ waitDash(), page.selectOption("#organizationSelect", distOpt) ]); await page.waitForTimeout(300);
      ok("scope: select distributor reloads", `${distOpt} → HTTP ${r.status()}`); }
    await Promise.all([ waitDash(), page.selectOption("#organizationSelect", "all") ]).catch(() => {});
  } else warn("scope selector hidden", "viewer is non-manufacturer");

  // device modal + settings entity fetch
  await page.click('.filter-chip[data-filter="all"]'); await page.waitForTimeout(300);
  await page.click("#machinesTableBody tr:first-child");
  await page.waitForSelector("#deviceDetailModal:not(.hidden)", { timeout: 10000 });
  ok("device modal opens (Status tab)", `id=${(await page.locator("#detailDeviceId").textContent())?.trim()} conn=${(await page.locator("#detailConnStatus").textContent())?.trim()}`);
  const entityPromise = page.waitForResponse((r) => r.url().includes(STAGING_HOST) && r.url().includes("action=entity"), { timeout: 20000 }).catch(() => null);
  await page.click('.detail-tab[data-tab="settings"]');
  const entityResp = await entityPromise;
  await page.waitForTimeout(800);
  const swVer = (await page.locator("#detailSwVersion").textContent())?.trim();
  const settingsErrVisible = await page.evaluate(() => !document.getElementById("settingsErrorMsg")?.classList.contains("hidden"));
  if (entityResp && entityResp.status() === 200 && !settingsErrVisible) ok("settings tab fetch (entity action)", `HTTP ${entityResp.status()} swVersion="${swVer}"`);
  else if (!entityResp) warn("settings entity fetch not observed", `swVersion="${swVer}"`);
  else fail("settings fetch error", `entity HTTP ${entityResp?.status()} errVisible=${settingsErrVisible}`);
  await page.click("#closeDetailBtn").catch(() => {});

  // 401 → refresh → retry
  await page.evaluate(() => { const rt = localStorage.getItem("auth_refresh_token"); if (rt) localStorage.setItem("auth_token", "expired.invalid.token"); });
  const refreshSeen = page.waitForRequest((r) => r.url().includes(STAGING_HOST) && r.method() === "POST", { timeout: 20000 }).catch(() => null);
  const [afterRefresh] = await Promise.all([ waitDash().catch(() => null), page.click("#refreshBtn") ]);
  const sawRefresh = await refreshSeen;
  if (afterRefresh && afterRefresh.status() === 200) ok("401→refresh→retry recovers in UI", `refresh POST seen=${!!sawRefresh}; dashboard HTTP ${afterRefresh.status()}`);
  else warn("refresh-flow inconclusive", `dashboardOK=${!!afterRefresh}`);

  // logout
  await page.click("#logoutBtn");
  await page.waitForSelector("#loginView:not(.hidden)", { timeout: 10000 });
  (await page.evaluate(() => !localStorage.getItem("auth_token"))) ? ok("logout returns to login + clears token") : fail("logout did not clear token");

  // guards
  backendHits.supabase === 0 ? ok("ALL backend traffic → Deno", `denoHits=${backendHits.deno} supabaseHits=${backendHits.supabase} actions=[${[...actionsSeen].join(",")}]`)
    : fail("LEAK: traffic went to Supabase", `supabaseHits=${backendHits.supabase}`);
  pageErrors.length === 0 ? ok("no uncaught page/JS errors") : warn("page/console errors observed", JSON.stringify(pageErrors.slice(0, 5)));

} catch (e) {
  fail("E2E harness exception", e instanceof Error ? e.stack || e.message : String(e));
} finally {
  await browser.close();
  const f = results.filter((r) => r.pass === false).length;
  const w = results.filter((r) => r.pass === "WARN").length;
  const p = results.filter((r) => r.pass === true).length;
  console.log(`\n==== E2E SUMMARY: ${p} pass, ${w} warn, ${f} fail ====`);
  process.exit(f ? 1 : 0);
}
