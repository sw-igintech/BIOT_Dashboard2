#!/usr/bin/env node
// Minimal smoke test: GET ?action=health against a deployed backend and assert ok:true.
// Works against either runtime (Supabase Edge Function or Cloudflare Worker) — both
// implement the `health` action and return { ok: true, backend, timestamp }.
//
// Usage:
//   node scripts/smoke-health.mjs <base-url>
//   SMOKE_URL=<base-url> node scripts/smoke-health.mjs
//
// Exit 0 on success, 1 on failure. No secrets required (health needs no auth).

const url = process.argv[2] || process.env.SMOKE_URL;
if (!url) {
  console.error("Usage: node scripts/smoke-health.mjs <base-url>  (or set SMOKE_URL)");
  process.exit(1);
}

const target = `${url}${url.includes("?") ? "&" : "?"}action=health`;

try {
  const res = await fetch(target, { method: "GET", headers: { Accept: "application/json" } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch {
    console.error(`✗ Non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }
  if (!res.ok || !payload || payload.ok !== true) {
    console.error(`✗ Health check failed (status ${res.status}):`, JSON.stringify(payload));
    process.exit(1);
  }
  console.log(`✓ Health OK — backend="${payload.backend}" at ${payload.timestamp}`);
  process.exit(0);
} catch (e) {
  console.error(`✗ Request error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
