#!/usr/bin/env node
// Minimal smoke test: GET ?action=health against a deployed backend and assert ok:true.
// Works against either runtime (Supabase Edge Function or Cloudflare Worker) — both
// implement the `health` action and return { ok: true, backend, timestamp }.
//
// Usage:
//   node scripts/smoke-health.mjs <base-url> [--retries N] [--delay MS]
//   SMOKE_URL=<base-url> node scripts/smoke-health.mjs
//
// --retries/--delay tolerate first-deploy workers.dev propagation lag (Cloudflare 1042).
// Exit 0 on success, 1 on failure. No secrets required (health needs no auth).

const args = process.argv.slice(2);
let url = process.env.SMOKE_URL;
let retries = 1;
let delay = 3000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--retries") { retries = Number(args[++i]); }
  else if (args[i] === "--delay") { delay = Number(args[++i]); }
  else if (!args[i].startsWith("--")) { url = args[i]; }
}

if (!url) {
  console.error("Usage: node scripts/smoke-health.mjs <base-url> [--retries N] [--delay MS]");
  process.exit(1);
}

const target = `${url}${url.includes("?") ? "&" : "?"}action=health`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt() {
  const res = await fetch(target, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch {
    return { okFlag: false, msg: `Non-JSON response (status ${res.status}): ${text.slice(0, 160)}` };
  }
  if (!res.ok || !payload || payload.ok !== true) {
    return { okFlag: false, msg: `Health check failed (status ${res.status}): ${JSON.stringify(payload)}` };
  }
  return { okFlag: true, msg: `Health OK — backend="${payload.backend}" at ${payload.timestamp}` };
}

let last = "";
for (let i = 1; i <= retries; i++) {
  try {
    const r = await attempt();
    if (r.okFlag) { console.log(`✓ ${r.msg}`); process.exit(0); }
    last = r.msg;
  } catch (e) {
    last = `Request error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (i < retries) { console.log(`… attempt ${i}/${retries} failed (${last}); retrying in ${delay}ms`); await sleep(delay); }
}
console.error(`✗ ${last}`);
process.exit(1);
