#!/usr/bin/env node
// Parity harness: drive identical inputs through a candidate backend (e.g. the Deno Deploy
// app) and the Supabase Edge Function and deep-diff the responses. Uses ONE BIOT login token
// for all dashboard/entity calls against BOTH backends, so upstream BIOT data is identical
// and any difference is attributable to the proxy runtime — not to auth or data drift.
//
// No secrets embedded. Config via env:
//   WORKER_URL        candidate backend base URL (e.g. the Deno Deploy app URL)
//   SUPABASE_URL      (default production edge function — the comparison/fallback backend)
//   SUPABASE_ANON_KEY (Supabase publishable key — already public in index.html)
//   BIOT_USERNAME / BIOT_PASSWORD  (sourced from claude/biot_credentials.env)
//
// Volatile fields (timestamps, intentional backend label) are normalized out before diff.

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const SUPABASE_URL = process.env.SUPABASE_URL ||
  "https://qjkrkqyycujmjxbfthev.supabase.co/functions/v1/biot-dashboard";
const ANON = process.env.SUPABASE_ANON_KEY || "";
const USER = process.env.BIOT_USERNAME;
const PASS = process.env.BIOT_PASSWORD;

const W = { name: "Worker", url: WORKER_URL, anon: "" };
const S = { name: "Supabase", url: SUPABASE_URL, anon: ANON };

const results = [];
function record(flow, pass, detail) {
  results.push({ flow, pass, detail });
  const tag = pass === true ? "PASS" : pass === "WARN" ? "WARN" : "FAIL";
  console.log(`[${tag}] ${flow}${detail ? " — " + detail : ""}`);
}

async function call(backend, { method = "GET", action, query = {}, token, body }) {
  const headers = { Accept: "application/json" };
  if (backend.anon) { headers["apikey"] = backend.anon; headers["Authorization"] = `Bearer ${backend.anon}`; }
  if (token) headers["x-biot-token"] = token;
  let url = backend.url;
  let init = { method, headers };
  if (method === "GET") {
    const qs = new URLSearchParams({ ...(action ? { action } : {}), ...query, _: String(Date.now()) });
    url = `${backend.url}?${qs.toString()}`;
  } else {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ action, ...body });
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { __nonjson: text.slice(0, 300) }; }
  return { status: res.status, json };
}

// ---- diff helpers ----------------------------------------------------------
const VOLATILE = new Set(["meta.backend", "meta.generatedAt"]);
function isVolatile(path) {
  if (VOLATILE.has(path)) return true;
  return false;
}
function diff(a, b, path = "", out = []) {
  if (isVolatile(path)) return out;
  const ta = typeof a, tb = typeof b;
  if (a === null || b === null || ta !== "object" || tb !== "object") {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, a, b });
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push({ path, a: `${Array.isArray(a)}`, b: `${Array.isArray(b)}` }); return out; }
    if (a.length !== b.length) out.push({ path: path + ".length", a: a.length, b: b.length });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
}

// Order-independent, drift-aware dashboard comparison.
//
// Live BIOT telemetry changes between two sequential calls (a device connects/disconnects,
// glove events accrue), which also reorders the device table (sort key includes connection
// status). So array-index diffs are meaningless. Instead we:
//   - compare STABLE identity/structure exactly (viewer, organizations, distributors, scope,
//     breakdown keys/labels, and per-device id/org/distributor/customFields keyed by id)
//   - tolerate live TELEMETRY (counts, per-device connection/sanitizer/delivery/rawStatus)
// A `compareDashboard` returns { stable: [...], drift: [...] }. Empty `stable` == parity.
const TELEMETRY_DEVICE_FIELDS = new Set([
  "connected", "connectionStatus", "connectionStatusKey", "lastConnectedAt",
  "deliveryAvailable", "sanitizerStatus", "sanitizerStatusKey", "sanitizerValue", "rawStatus",
]);
function compareDashboard(wj, sj) {
  const stable = [], drift = [];
  const w = wj?.data || {}, s = sj?.data || {};

  // Identity/structure that must be identical (independent of live telemetry).
  for (const key of ["viewer", "organizations", "distributors"]) {
    for (const d of diff(w[key], s[key], key)) stable.push(d);
  }
  // scope: compare everything except organizationIds ordering (set-equal) — but they are
  // built deterministically, so a plain diff is fine; still classify here for clarity.
  for (const d of diff(w.scope, s.scope, "scope")) stable.push(d);

  // Partial failures must match: if one backend silently degraded a widget (e.g. hit a runtime
  // subrequest/time limit) and the other did not, that is a STRUCTURAL difference, not telemetry
  // drift.
  const wpf = Object.keys(w.meta?.partialFailures || {}).sort().join(",");
  const spf = Object.keys(s.meta?.partialFailures || {}).sort().join(",");
  if (wpf !== spf) stable.push({ path: "meta.partialFailures.keys", a: wpf || "(none)", b: spf || "(none)" });

  // Summary widgets: breakdown KEYS/LABELS are structural; VALUES/counts are telemetry.
  for (const widget of ["connection", "operational", "sanitizer", "gloves"]) {
    const wb = (w[widget]?.breakdown || []), sb = (s[widget]?.breakdown || []);
    const wkeys = wb.map((x) => x.key).join(","), skeys = sb.map((x) => x.key).join(",");
    const wlabels = wb.map((x) => x.label).join(","), slabels = sb.map((x) => x.label).join(",");
    if (wkeys !== skeys) stable.push({ path: `${widget}.breakdown.keys`, a: wkeys, b: skeys });
    if (wlabels !== slabels) stable.push({ path: `${widget}.breakdown.labels`, a: wlabels, b: slabels });
    // counts/totals can legitimately drift
    if (JSON.stringify(w[widget]?.counts) !== JSON.stringify(s[widget]?.counts))
      drift.push({ path: `${widget}.counts`, a: w[widget]?.counts, b: s[widget]?.counts });
  }

  // Devices keyed by id (order-independent). Device population should be identical.
  const wd = new Map((w.devices?.items || []).map((d) => [d.id, d]));
  const sd = new Map((s.devices?.items || []).map((d) => [d.id, d]));
  const onlyW = [...wd.keys()].filter((k) => !sd.has(k));
  const onlyS = [...sd.keys()].filter((k) => !wd.has(k));
  if (onlyW.length) drift.push({ path: "devices.onlyInWorker", a: onlyW.length, b: onlyW.slice(0, 5) });
  if (onlyS.length) drift.push({ path: "devices.onlyInSupabase", a: onlyS.length, b: onlyS.slice(0, 5) });
  for (const [id, a] of wd) {
    const b = sd.get(id); if (!b) continue;
    for (const f of Object.keys({ ...a, ...b })) {
      if (TELEMETRY_DEVICE_FIELDS.has(f)) {
        if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) drift.push({ path: `device[${id}].${f}`, a: a[f], b: b[f] });
      } else {
        for (const d of diff(a[f], b[f], `device[${id}].${f}`)) stable.push(d);
      }
    }
  }
  return { stable, drift };
}

function pickToken(loginJson) {
  return loginJson?.data?.accessToken;
}

async function main() {
  if (!USER || !PASS) { console.error("Missing BIOT_USERNAME / BIOT_PASSWORD in env."); process.exit(2); }

  // 1) HEALTH ---------------------------------------------------------------
  {
    const w = await call(W, { action: "health" });
    const s = await call(S, { action: "health" });
    const d = diff(w.json, s.json);
    const okShape = w.json.ok === true && s.json.ok === true &&
      typeof w.json.backend === "string" && typeof s.json.backend === "string" &&
      typeof w.json.timestamp === "string" && typeof s.json.timestamp === "string";
    // backend label + timestamp are expected to differ.
    const onlyExpected = d.every((x) => x.path === "backend" || x.path === "timestamp");
    record("health", okShape && onlyExpected, `worker.backend="${w.json.backend}" supabase.backend="${s.json.backend}"; status ${w.status}/${s.status}`);
  }

  // 2) LOGIN ----------------------------------------------------------------
  // Separate logins per backend (tokens are per-login). Compare shape + userId.
  const wLogin = await call(W, { method: "POST", action: "login", body: { username: USER, password: PASS } });
  const sLogin = await call(S, { method: "POST", action: "login", body: { username: USER, password: PASS } });
  {
    const shape = (j) => j?.ok === true && typeof pickToken(j) === "string" &&
      typeof j.data.refreshToken === "string" && "userId" in j.data;
    const sameUser = wLogin.json?.data?.userId === sLogin.json?.data?.userId;
    record("login", shape(wLogin.json) && shape(sLogin.json) && sameUser,
      `status ${wLogin.status}/${sLogin.status}; userId match=${sameUser}; keys=[${Object.keys(wLogin.json.data || {}).join(",")}]`);
  }

  const token = pickToken(wLogin.json) || pickToken(sLogin.json);
  if (!token) { record("FATAL", false, "no access token from login; aborting authed flows"); return finish(); }

  // 3) REFRESH --------------------------------------------------------------
  // Use the independent refresh token from each backend's own login (refresh rotates it).
  {
    const wr = await call(W, { method: "POST", action: "refresh", body: { refreshToken: wLogin.json.data.refreshToken } });
    const sr = await call(S, { method: "POST", action: "refresh", body: { refreshToken: sLogin.json.data.refreshToken } });
    const shape = (j) => j?.ok === true && typeof j.data?.accessToken === "string" && typeof j.data?.refreshToken === "string";
    record("refresh", shape(wr.json) && shape(sr.json),
      `status ${wr.status}/${sr.status}; keys=[${Object.keys(wr.json.data || {}).join(",")}]/[${Object.keys(sr.json.data || {}).join(",")}]`);
  }

  // Fixed, CLOSED past date range → stable glove-event window (reduces drift).
  const range = { from: "2026-05-01", to: "2026-05-31", fromIso: "2026-05-01T00:00:00.000Z", toIso: "2026-05-31T23:59:59.999Z", timezone: "UTC" };

  // 4) DASHBOARD (default scope) — same token to both, back-to-back ----------
  let viewer, organizations = [], distributors = [], sampleSettingsId = null, sampleEntityDeviceId = null;
  {
    const w = await call(W, { action: "dashboard", token, query: range });
    const s = await call(S, { action: "dashboard", token, query: range });
    // Self-drift baseline: two Worker calls back-to-back. Any "drift" here proves the
    // telemetry is genuinely live (not a Worker-vs-Supabase difference).
    const w2 = await call(W, { action: "dashboard", token, query: range });
    viewer = w.json?.data?.viewer;
    organizations = w.json?.data?.organizations || [];
    distributors = w.json?.data?.distributors || [];
    for (const it of (w.json?.data?.devices?.items || [])) {
      const sid = it?.customFields?.current_settings2?.id;
      if (sid) { sampleSettingsId = sid; sampleEntityDeviceId = it.id; break; }
    }
    const selfBaseline = compareDashboard(w.json, w2.json);
    const { stable, drift } = compareDashboard(w.json, s.json);
    record("dashboard:default", stable.length === 0 ? (drift.length ? "WARN" : true) : false,
      `role=${viewer?.role} scope.kind=${w.json?.data?.scope?.kind} orgs=${organizations.length} dists=${distributors.length}; STABLE diffs=${stable.length}, drift=${drift.length} (Worker-vs-Worker self-drift=${selfBaseline.drift.length}/stable=${selfBaseline.stable.length})`);
    if (stable.length) console.log("   STABLE diffs (must be 0):", JSON.stringify(stable.slice(0, 12), null, 0));
    if (drift.length) console.log("   drift(sample, live telemetry):", JSON.stringify(drift.slice(0, 4), null, 0));
  }

  // 5) DASHBOARD scope variants --------------------------------------------
  for (const tok of [{ k: "all", q: { ...range, organizationId: "all" } },
                     ...(organizations[0] ? [{ k: `org:${organizations[0].id}`, q: { ...range, organizationId: `org:${organizations[0].id}` } }] : []),
                     ...(distributors[0] ? [{ k: `dist:${distributors[0].id}`, q: { ...range, organizationId: `dist:${distributors[0].id}` } }] : [])]) {
    const w = await call(W, { action: "dashboard", token, query: tok.q });
    const s = await call(S, { action: "dashboard", token, query: tok.q });
    const { stable, drift } = compareDashboard(w.json, s.json);
    record(`dashboard:scope=${tok.k}`, stable.length === 0 ? (drift.length ? "WARN" : true) : false,
      `wKind=${w.json?.data?.scope?.kind} sKind=${s.json?.data?.scope?.kind} wDevices=${w.json?.data?.devices?.total} sDevices=${s.json?.data?.devices?.total}; STABLE=${stable.length} drift=${drift.length}`);
    if (stable.length) console.log("   STABLE diffs (must be 0):", JSON.stringify(stable.slice(0, 12), null, 0));
  }

  // 6) ENTITY / settings fetch ----------------------------------------------
  if (sampleSettingsId) {
    const w = await call(W, { action: "entity", token, query: { id: sampleSettingsId } });
    const s = await call(S, { action: "entity", token, query: { id: sampleSettingsId } });
    const diffs = diff(w.json, s.json);
    record("entity:settings", diffs.length === 0,
      `device=${sampleEntityDeviceId} settingsId=${sampleSettingsId}; diffs=${diffs.length}; status ${w.status}/${s.status}`);
    if (diffs.length) console.log("   diffs:", JSON.stringify(diffs.slice(0, 10), null, 0));
  } else {
    record("entity:settings", "WARN", "no device with current_settings2.id found in scope — skipped");
  }

  // 7) ERROR ENVELOPES ------------------------------------------------------
  // 7a missing auth on dashboard → 401
  {
    const w = await call(W, { action: "dashboard", query: range });
    const s = await call(S, { action: "dashboard", query: range });
    const d = diff(w.json, s.json);
    record("error:dashboard-no-token", w.status === 401 && s.status === 401 && d.length === 0,
      `status ${w.status}/${s.status}; body=${JSON.stringify(w.json)}; diffs=${d.length}`);
  }
  // 7b unknown action → 400
  {
    const w = await call(W, { action: "bogus", token });
    const s = await call(S, { action: "bogus", token });
    const d = diff(w.json, s.json);
    record("error:unknown-action", w.status === 400 && s.status === 400 && d.length === 0,
      `status ${w.status}/${s.status}; body=${JSON.stringify(w.json)}`);
  }
  // 7c entity missing id → 400
  {
    const w = await call(W, { action: "entity", token });
    const s = await call(S, { action: "entity", token });
    const d = diff(w.json, s.json);
    record("error:entity-missing-id", w.status === 400 && s.status === 400 && d.length === 0,
      `status ${w.status}/${s.status}; body=${JSON.stringify(w.json)}`);
  }
  // 7d login missing fields → 400
  {
    const w = await call(W, { method: "POST", action: "login", body: { username: "", password: "" } });
    const s = await call(S, { method: "POST", action: "login", body: { username: "", password: "" } });
    const d = diff(w.json, s.json);
    record("error:login-missing-fields", w.status === 400 && s.status === 400 && d.length === 0,
      `status ${w.status}/${s.status}; body=${JSON.stringify(w.json)}`);
  }
  // 7e bad token → 401 (envelope shape; message text from BIOT may vary)
  {
    const w = await call(W, { action: "dashboard", token: "not-a-real-token", query: range });
    const s = await call(S, { action: "dashboard", token: "not-a-real-token", query: range });
    const shape = (j) => j && j.ok === false && j.error && typeof j.error.message === "string";
    record("error:bad-token-401", w.status === 401 && s.status === 401 && shape(w.json) && shape(s.json),
      `status ${w.status}/${s.status}; wMsg="${w.json?.error?.message}" sMsg="${s.json?.error?.message}"`);
  }

  finish();
}

function finish() {
  const fails = results.filter((r) => r.pass === false);
  const warns = results.filter((r) => r.pass === "WARN");
  console.log(`\n==== SUMMARY: ${results.filter((r) => r.pass === true).length} pass, ${warns.length} warn, ${fails.length} fail ====`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e); process.exit(3); });
