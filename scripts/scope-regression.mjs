#!/usr/bin/env node
// scope-regression.mjs — distributor-scope regression check for the "root-org leak" fix.
//
// Verifies that a distributor scope never inherits the shared manufacturer root organization
// (00000000-…) as a served/child org, so devices / cartridges / glove events / sanitizer /
// operational / machine list are all scoped correctly. Exercises the REAL backend end-to-end
// (buildDistributorToOrgsMap → resolveScope → deviceMatchesScope / cartridgeMatchesScope / glove
// aggregation) with live BIOT data, in the same integration style as parity-check.mjs.
//
// Usage:
//   BIOT_BASE_URL=https://api.dev.igin.biot-med.com \
//   BIOT_USERNAME=<manufacturer email> BIOT_PASSWORD=<pw> \
//   BACKEND_URL=http://localhost:8000 node scripts/scope-regression.mjs
//   (BACKEND_URL defaults to the live Deno Deploy staging backend.)
//
// No credentials are committed — they come from the environment (sourced locally from
// claude/biot_credentials.env, which is gitignored).

const BIOT_BASE = process.env.BIOT_BASE_URL || "https://api.dev.igin.biot-med.com";
const BACKEND = process.env.BACKEND_URL || "https://biot-dashboard-staging.sw-igin.deno.net";
const USER = process.env.BIOT_USERNAME;
const PASS = process.env.BIOT_PASSWORD;
const UA = "biot-dashboard-deno";
const ROOT_ORG = "00000000-0000-0000-0000-000000000000";

if (!USER || !PASS) { console.error("Missing BIOT_USERNAME / BIOT_PASSWORD in env."); process.exit(2); }

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  [PASS] ${n}${d ? " — " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  [FAIL] ${n}${d ? " — " + d : ""}`); };

async function biot(token, path, query) {
  const url = BIOT_BASE + path + (query ? "?" + new URLSearchParams(query) : "");
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA, Authorization: "Bearer " + token } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, j };
}
async function login(u, p) {
  const r = await fetch(BIOT_BASE + "/ums/v2/users/login", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ username: u, password: p }) });
  return (await r.json())?.accessJwt?.token;
}
async function dashboard(token, scopeToken) {
  const r = await fetch(`${BACKEND}/?action=dashboard&organizationId=${encodeURIComponent(scopeToken)}`, { headers: { "x-biot-token": token, "User-Agent": UA } });
  return (await r.json())?.data;
}
async function gloves(token, scopeToken) {
  const r = await fetch(`${BACKEND}/?action=gloves&organizationId=${encodeURIComponent(scopeToken)}`, { headers: { "x-biot-token": token, "User-Agent": UA } });
  return (await r.json())?.data;
}

(async () => {
  console.log(`scope-regression vs backend ${BACKEND} (BIOT ${BIOT_BASE})`);
  const token = await login(USER, PASS);
  if (!token) { console.error("login failed"); process.exit(2); }

  // Resolve distributor ids + ground-truth direct-device counts (device_distributor) from BIOT.
  const dists = (await biot(token, "/generic-entity/v3/generic-entities/distributor", { searchRequest: JSON.stringify({ limit: 200, page: 0 }) })).j?.data || [];
  const idByName = {}; for (const d of dists) idByName[d._name] = d._id;
  let all = [], page = 0;
  while (true) { const r = await biot(token, "/device/v2/devices", { searchRequest: JSON.stringify({ limit: 100, page }) }); const it = r.j?.data || []; all.push(...it); if (it.length < 100) break; page++; }
  const totalEstate = all.length;
  const rootDevices = all.filter((d) => d._ownerOrganization?.id === ROOT_ORG).length;
  const directCount = (name) => all.filter((d) => d.device_distributor?.id === idByName[name]).length;

  // --- Manufacturer "all" — must still see the full estate ---
  console.log("\n# Manufacturer all scope");
  const allDash = await dashboard(token, "all");
  allDash?.scope?.kind === "all" ? ok("all: scope.kind=all") : bad("all: scope.kind", JSON.stringify(allDash?.scope?.kind));
  allDash?.devices?.total === totalEstate ? ok(`all: full estate ${totalEstate} devices`) : bad("all: device total", `${allDash?.devices?.total} != ${totalEstate}`);

  // --- BEMAR-style: 0 direct devices + invalid root bridge → must be 0, no root leak ---
  for (const name of ["BEMAR Srl", "dist1"]) {
    console.log(`\n# ${name} (invalid root bridge, ${directCount(name)} direct devices)`);
    const id = idByName[name];
    if (!id) { bad(`${name}: not found`); continue; }
    const d = await dashboard(token, `dist:${id}`);
    d?.scope?.kind === "distributor" ? ok(`${name}: scope.kind=distributor`) : bad(`${name}: scope.kind`, JSON.stringify(d?.scope?.kind));
    !(d?.scope?.organizationIds || []).includes(ROOT_ORG) ? ok(`${name}: root org NOT in scope.organizationIds`) : bad(`${name}: root org leaked into organizationIds`, JSON.stringify(d?.scope?.organizationIds));
    d?.devices?.total === directCount(name) ? ok(`${name}: devices = ${directCount(name)} (== BIOT direct)`) : bad(`${name}: devices`, `${d?.devices?.total} (expected ${directCount(name)})`);
    d?.devices?.total < rootDevices ? ok(`${name}: no root-estate leak (< ${rootDevices})`) : bad(`${name}: root-estate leak`, `${d?.devices?.total} >= ${rootDevices}`);
    const g = await gloves(token, `dist:${id}`);
    const gt = g?.gloves?.total ?? "?";
    (gt === 0 || gt < 1000) ? ok(`${name}: gloves not manufacturer-level (${gt})`) : bad(`${name}: manufacturer-level gloves`, `${gt}`);
    (d?.cartridges?.total ?? 0) < 100 ? ok(`${name}: cartridges not manufacturer-level (${d?.cartridges?.total})`) : bad(`${name}: manufacturer-level cartridges`, `${d?.cartridges?.total}`);
  }

  // --- Matan test: 1 direct + Multisana(real) + root(invalid) → keep direct/legit, drop root ---
  {
    const name = "Matan test"; console.log(`\n# ${name} (mixed: real bridge + invalid root bridge)`);
    const id = idByName[name];
    const d = await dashboard(token, `dist:${id}`);
    !(d?.scope?.organizationIds || []).includes(ROOT_ORG) ? ok(`${name}: root org NOT in scope`) : bad(`${name}: root leaked`, JSON.stringify(d?.scope?.organizationIds));
    d?.devices?.total < rootDevices ? ok(`${name}: no root-estate leak (${d?.devices?.total} < ${rootDevices})`) : bad(`${name}: root leak`, `${d?.devices?.total}`);
    d?.devices?.total >= directCount(name) ? ok(`${name}: keeps ≥ direct devices (${d?.devices?.total} ≥ ${directCount(name)})`) : bad(`${name}: dropped direct`, `${d?.devices?.total}`);
  }

  // --- D1 / D2: legitimate distributors — unchanged, real customer orgs preserved ---
  for (const name of ["D1", "D2"]) {
    console.log(`\n# ${name} (legitimate distributor, ${directCount(name)} direct devices)`);
    const id = idByName[name];
    const d = await dashboard(token, `dist:${id}`);
    d?.scope?.kind === "distributor" ? ok(`${name}: scope.kind=distributor`) : bad(`${name}: scope.kind`);
    !(d?.scope?.organizationIds || []).includes(ROOT_ORG) ? ok(`${name}: no root org`) : bad(`${name}: root leaked`);
    d?.devices?.total >= directCount(name) && d?.devices?.total < rootDevices ? ok(`${name}: legit scope ${d?.devices?.total} devices (≥ ${directCount(name)} direct, < estate)`) : bad(`${name}: device total`, `${d?.devices?.total}`);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
