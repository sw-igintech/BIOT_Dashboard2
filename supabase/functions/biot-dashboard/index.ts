// biot-dashboard — Supabase Edge Function
//
// Pure BIOT proxy. No database. No caching. No sync.
// Frontend → this function → BIOT APIs → Frontend.
//
// Required secret (supabase secrets set):
//   BIOT_BASE_URL   https://api.dev.igin.biot-med.com
//
// Actions:
//   POST { action: "login", username, password }   → { accessToken, refreshToken, userId }
//   POST { action: "refresh", refreshToken }        → { accessToken, refreshToken }
//   GET  ?action=dashboard&...  (x-biot-token hdr) → full dashboard payload

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-biot-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CONNECTION_BREAKDOWN: [string, string][] = [
  ["connected", "Connected"],
  ["disconnected", "Disconnected"],
  ["unknown", "Unknown"],
];

const OPERATIONAL_BREAKDOWN: [string, string][] = [
  ["operational", "Operational"],
  ["non_operational", "Non-Operational"],
];

const SANITIZER_BREAKDOWN: [string, string][] = [
  ["available", "Available"],
  ["unavailable", "Unavailable"],
  ["unknown", "Unknown"],
];

const GLOVE_BREAKDOWN: [string, string][] = [
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
  ["extraLarge", "Extra Large"],
  ["unknown", "Unknown"],
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BiotConfig {
  baseUrl: string;
}

interface DateRange {
  from: string;
  to: string;
  fromIso: string;
  toIso: string;
  timezone: string;
}

interface Viewer {
  userId: string | null;
  displayName: string;
  email: string | null;
  role: "manufacturer" | "organization";
  groups: string[];
  ownerOrganizationId: string | null;
}

interface Organization {
  id: string;
  name: string;
}

interface Distributor {
  id: string;
  name: string;
}

interface NormalizedDevice {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  // Distributor link (confirmed live 2026-05-19): device.device_distributor is a reference
  // object { id, name, templateName: "distributor" }. Null when the device has no
  // distributor assigned. Drives distributor-scope filtering and the Distributor row
  // in the device detail panel.
  distributorId: string | null;
  distributorName: string | null;
  connected: boolean | null;
  connectionStatus: string;
  connectionStatusKey: string;
  lastConnectedAt: string | null;
  sanitizerStatus: string;
  sanitizerStatusKey: string;
  sanitizerValue: unknown;
  // Delivery available — drives the Operational widget.
  // Confirmed field: _status.delivery_available1 (boolean, confirmed 2026-04-28).
  deliveryAvailable: boolean | null;
  // Full _status object — allows frontend to read device state fields.
  // Confirmed fields (live API 2026-04-28):
  //   _connection._connected, _connection._lastConnectedTime, _connection._ipAddress
  //   connectivity_interface, connectivity_rssi, connectivity_apn, connectivity_ssid
  //   bin_level1 (integer), lid_status1, delivery_available1, septol_availability1
  //   total_small_gloves, total_medium_gloves, total_large_gloves, total_extra_large_gloves
  // Fields that do NOT exist (socket simulator only):
  //   septol (numeric level), trash (fraction), cartridge (slot count)
  rawStatus: Record<string, unknown>;
  // Non-system device root fields (non-underscore-prefixed).
  // Includes the current_settings2 reference object: { id: UUID, templateName: "device_current_settings", ... }
  // Use customFields.current_settings2.id + the "entity" action to fetch actual settings values.
  // Settings field names in the entity are lowercase: glovedefaultsize, useridentificationrequired, etc.
  customFields: Record<string, unknown>;
}

// Thrown when BIOT returns 401 so the Edge Function can propagate it
class BiotAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiotAuthError";
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { params[k] = v; });

    // Parse JSON body for POST requests
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { /* ignore malformed body */ }
    }

    const action = (typeof body.action === "string" ? body.action : null) ?? params.action ?? "dashboard";

    // ── health ──────────────────────────────────────────────────────────────
    if (action === "health") {
      return ok({ ok: true, backend: "Supabase Edge Function", timestamp: new Date().toISOString() });
    }

    // ── login ───────────────────────────────────────────────────────────────
    if (action === "login") {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        return err({ ok: false, error: { message: "username and password are required." } }, 400);
      }
      const data = await loginProxy(username, password);
      return ok({ ok: true, data });
    }

    // ── token refresh ────────────────────────────────────────────────────────
    if (action === "refresh") {
      const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
      if (!refreshToken) {
        return err({ ok: false, error: { message: "refreshToken is required." } }, 400);
      }
      const data = await refreshProxy(refreshToken);
      return ok({ ok: true, data });
    }

    // ── dashboard ────────────────────────────────────────────────────────────
    if (action === "dashboard") {
      const userToken = req.headers.get("x-biot-token");
      if (!userToken) {
        return new Response(
          JSON.stringify({ ok: false, error: { message: "Not authenticated. Please log in." } }),
          { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      const data = await buildDashboard(params, userToken);
      return ok({ ok: true, data });
    }

    // ── gloves — glove metrics only (loaded asynchronously, off the dashboard critical path) ──
    if (action === "gloves") {
      const userToken = req.headers.get("x-biot-token");
      if (!userToken) {
        return new Response(
          JSON.stringify({ ok: false, error: { message: "Not authenticated. Please log in." } }),
          { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      const data = await buildGloves(params, userToken);
      return ok({ ok: true, data });
    }

    // ── entity — fetch a single generic entity by ID (used for device settings) ──
    if (action === "entity") {
      const userToken = req.headers.get("x-biot-token");
      if (!userToken) {
        return new Response(
          JSON.stringify({ ok: false, error: { message: "Not authenticated. Please log in." } }),
          { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
      const entityId = params.id ?? "";
      if (!entityId) {
        return err({ ok: false, error: { message: "id parameter is required." } }, 400);
      }
      const config: BiotConfig = { baseUrl: getBaseUrl() };
      const data = await fetchBiot(config, "GET", `/generic-entity/v1/generic-entities/${entityId}`, {
        accessToken: userToken,
      });
      return ok({ ok: true, data });
    }

    return err({ ok: false, error: { message: `Unknown action: ${action}` } }, 400);
  } catch (e) {
    if (e instanceof BiotAuthError) {
      return new Response(
        JSON.stringify({ ok: false, error: { message: e.message } }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[biot-dashboard]", message);
    return err({ ok: false, error: { message } }, 500);
  }
});

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const baseUrl = Deno.env.get("BIOT_BASE_URL");
  if (!baseUrl) throw new Error("BIOT_BASE_URL secret is not set.");
  return baseUrl;
}

// ---------------------------------------------------------------------------
// Auth proxy helpers
// ---------------------------------------------------------------------------

async function loginProxy(username: string, password: string): Promise<Record<string, unknown>> {
  const config: BiotConfig = { baseUrl: getBaseUrl() };
  const payload = await fetchBiot(config, "POST", "/ums/v2/users/login", {
    body: { username, password },
    expectedStatuses: [200, 201],
  });
  const accessToken = nestedGet(payload, ["accessJwt", "token"]) as string | null;
  const refreshToken = nestedGet(payload, ["refreshJwt", "token"]) as string | null;
  const userId = payload.userId as string | null;
  if (!accessToken) throw new Error("BIOT login did not return an access token.");
  return { accessToken, refreshToken, userId };
}

async function refreshProxy(refreshToken: string): Promise<Record<string, unknown>> {
  const config: BiotConfig = { baseUrl: getBaseUrl() };
  const payload = await fetchBiot(config, "POST", "/ums/v2/users/token/refresh", {
    body: { refreshToken },
    expectedStatuses: [200, 201],
  });
  const accessToken = nestedGet(payload, ["accessJwt", "token"]) as string | null;
  const newRefreshToken = nestedGet(payload, ["refreshJwt", "token"]) as string | null;
  if (!accessToken) throw new Error("Token refresh did not return a new access token.");
  return { accessToken, refreshToken: newRefreshToken ?? refreshToken };
}

// ---------------------------------------------------------------------------
// Dashboard builder
// ---------------------------------------------------------------------------

// Shared scope/device context resolved once per request. Used by BOTH the `dashboard` action
// (everything except gloves) and the `gloves` action (glove aggregation only). Splitting the two
// keeps the slow/unreliable glove-event query (BIOT `device_event` ABAC can take ~90s and 414 for
// some distributor tokens — see claude/ docs) OFF the main dashboard's critical path.
interface DashboardContext {
  config: BiotConfig;
  dateRange: DateRange;
  viewer: Viewer;
  organizations: Organization[];
  distributors: Distributor[];
  scope: ResolvedScope;
  scopedDevices: NormalizedDevice[];
  scopedDeviceIds: Set<string>;
  eventOrgIds: string[];
}

async function resolveDashboardContext(params: Record<string, string>, accessToken: string): Promise<DashboardContext> {
  const config: BiotConfig = { baseUrl: getBaseUrl() };
  const dateRange = resolveDateRange(params);

  // User supplies their own accessToken — no server-side login needed
  const selfPayload = await getCurrentUser(config, accessToken);
  const viewer = buildViewerIdentity({}, selfPayload);
  // Parallelise the three independent BIOT calls. Distributors and bridge entities
  // are only meaningful for manufacturer accounts (org-role users are locked to
  // their own org id and can't pick a distributor) but the cost is small and the
  // simpler control flow is worth the few extra round-trips.
  const [rawDevices, rawDistributors, rawBridges] = await Promise.all([
    getDevices(config, accessToken),
    safeWidget(() => getDistributors(config, accessToken), [] as unknown[], () => {}),
    safeWidget(() => getOrgDistributorBridges(config, accessToken), [] as unknown[], () => {}),
  ]);
  const organizations = deriveOrganizations(viewer, selfPayload, rawDevices);
  const distributors = normalizeDistributors(rawDistributors);
  // distributor id → list of child org ids (from organization_to_distributor bridges)
  const distributorToOrgIds = buildDistributorToOrgsMap(rawBridges);
  const scope = resolveScope(viewer, organizations, distributors, distributorToOrgIds, params.organizationId);

  // When a manufacturer views all organizations, trust the API response
  // entirely — the BIOT API already scopes results to the authenticated
  // user's visibility. Client-side filtering in this case can silently drop
  // devices whose ownerOrganization wasn't captured by deriveOrganizations.
  // Only apply client-side scope filtering when a specific scope is selected.
  const needsClientFilter = scope.kind !== "all";
  const scopedRaw = rawDevices.filter((d) => !needsClientFilter || deviceMatchesScope(d, scope, viewer));
  const scopedDevices: NormalizedDevice[] = scopedRaw.map(normalizeDevice);
  const scopedDeviceIds = new Set(scopedDevices.map((d) => d.id));

  // Compute the org id set used for glove-event queries. Glove events filter only
  // by _ownerOrganization.id, so we need to query each owner-org represented in the
  // scoped device set (and post-filter events by device id to avoid over-counting).
  const eventOrgIds = scope.kind === "all"
    ? scope.organizationIds
    : Array.from(new Set(scopedDevices.map((d) => d.organizationId).filter((id): id is string => !!id)));

  return { config, dateRange, viewer, organizations, distributors, scope, scopedDevices, scopedDeviceIds, eventOrgIds };
}

// Glove aggregation, served by the dedicated `gloves` action so it never blocks the main dashboard.
async function buildGloves(params: Record<string, string>, accessToken: string): Promise<Record<string, unknown>> {
  const ctx = await resolveDashboardContext(params, accessToken);
  const widgetErrors: Record<string, string> = {};
  const gloves = await safeWidget(
    () => getGloveSummary(
      ctx.config, accessToken, ctx.eventOrgIds, ctx.dateRange,
      ctx.scope.kind === "all" ? null : ctx.scopedDeviceIds,
    ),
    emptyGloveSummary(),
    (msg) => { widgetErrors.gloves = msg; },
  );
  if (typeof gloves.partialOrgFailures === "number" && gloves.partialOrgFailures > 0) {
    widgetErrors.gloves = `Glove data unavailable for ${gloves.partialOrgFailures} organization(s) (BIOT upstream timeout); showing partial totals.`;
  }
  return {
    gloves,
    scope: { organizationId: ctx.scope.selectedToken, kind: ctx.scope.kind },
    meta: { generatedAt: new Date().toISOString(), backend: "Supabase Edge Function", partialFailures: widgetErrors },
  };
}

async function buildDashboard(params: Record<string, string>, accessToken: string): Promise<Record<string, unknown>> {
  const ctx = await resolveDashboardContext(params, accessToken);
  const { config, dateRange, viewer, organizations, distributors, scope, scopedDevices } = ctx;
  const widgetErrors: Record<string, string> = {};
  // Cartridges. Fetched only when the result set is bounded and actionable: for org-role users
  // (locked to their own org — small set) and for a manufacturer who has picked a specific
  // org/distributor scope. The manufacturer "all" view is intentionally skipped — it would pull
  // thousands of cartridges (heavy payload, slow, and a wide fan-out that can trip BIOT rate
  // limiting); instead the frontend shows a "select a scope" hint. BIOT ABAC already scopes the
  // result; cartridgeMatchesScope additionally honors the manufacturer scope-dropdown selection.
  const shouldFetchCartridges = viewer.role === "organization" || scope.kind !== "all";
  let scopedCartridges: Record<string, unknown>[] = [];
  if (shouldFetchCartridges) {
    const rawCartridges = await safeWidget(
      () => getCartridges(config, accessToken),
      [] as unknown[],
      (msg) => { widgetErrors.cartridges = msg; },
    );
    scopedCartridges = rawCartridges
      .filter((c) => cartridgeMatchesScope(c, scope, viewer))
      .map(normalizeCartridge);
  }

  return {
    viewer,
    scope: {
      from: dateRange.from,
      to: dateRange.to,
      fromIso: dateRange.fromIso,
      toIso: dateRange.toIso,
      timezone: dateRange.timezone,
      // organizationId carries the encoded scope token ("all" | "org:<id>" | "dist:<id>")
      // so the frontend can echo it back on its next request. The legacy value "all"
      // and a bare uuid (treated as "org:<id>") continue to work.
      organizationId: scope.selectedToken,
      kind: scope.kind,
      organizationIds: scope.organizationIds,
      organizationLabel: scope.label,
    },
    organizations,
    distributors,
    connection: getConnectionSummary(scopedDevices),
    // All devices (connected + disconnected + unknown) — frontend filters by connectionStatusKey
    devices: getAllDevices(scopedDevices),
    // Operational summary: Operational = delivery_available === true, Non-Operational = otherwise
    operational: getOperationalSummary(scopedDevices),
    // Gloves loaded asynchronously via the `gloves` action (off the dashboard critical path).
    gloves: { ...emptyGloveSummary(), pending: true },
    sanitizer: getSanitizerSummary(scopedDevices),
    // scopeHint=true → cartridges deliberately not fetched (manufacturer "all"); frontend shows
    // "select an organization or distributor to view cartridges" instead of an empty table.
    cartridges: { total: scopedCartridges.length, items: scopedCartridges, scopeHint: !shouldFetchCartridges },
    meta: {
      generatedAt: new Date().toISOString(),
      backend: "Supabase Edge Function",
      partialFailures: widgetErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// BIOT API calls
// ---------------------------------------------------------------------------

async function getCurrentUser(config: BiotConfig, accessToken: string): Promise<Record<string, unknown>> {
  return fetchBiot(config, "GET", "/ums/v2/users/self", { accessToken });
}

async function getDevices(config: BiotConfig, accessToken: string): Promise<unknown[]> {
  const allDevices: unknown[] = [];
  let page = 0;

  while (true) {
    const searchRequest = { limit: 100, page };
    const payload = await fetchBiot(config, "GET", "/device/v2/devices", {
      accessToken,
      query: { searchRequest: JSON.stringify(searchRequest) },
    });

    const items = extractItems(payload, ["devices", "items", "data", "results"]);
    if (!items.length) break;

    allDevices.push(...items);

    const totalPages = extractTotalPages(payload);
    if (totalPages !== null && page + 1 >= totalPages) break;
    if (items.length < 100) break;

    page += 1;
  }

  return allDevices;
}

// Distributor entities (templateName "distributor"). Confirmed live 2026-05-19:
// returns { data: [{ _id, _name, _ownerOrganization, ... }] }.
async function getDistributors(config: BiotConfig, accessToken: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let page = 0;
  while (true) {
    const payload = await fetchBiot(config, "GET", "/generic-entity/v3/generic-entities/distributor", {
      accessToken,
      query: { searchRequest: JSON.stringify({ limit: 100, page }) },
    });
    const items = extractItems(payload, ["data", "items", "results"]);
    if (!items.length) break;
    all.push(...items);
    const totalPages = extractTotalPages(payload);
    if (totalPages !== null && page + 1 >= totalPages) break;
    if (items.length < 100) break;
    page += 1;
  }
  return all;
}

// Cartridge inventory entities (templateName "cartridge"). Confirmed live 2026-06-28.
// IMPORTANT: the V3 search path already scopes to the "cartridge" template — do NOT add a
// `_templateName` filter (BIOT now rejects it with REQUEST_VALIDATION_FAILED / HTTP 400).
// BIOT ABAC scopes the result to what the caller may see (e.g. a distributor sees its
// cartridges across the orgs it serves plus its <<Global>>-owned stock).
async function getCartridges(config: BiotConfig, accessToken: string): Promise<unknown[]> {
  const LIMIT = 1000;
  const PAGE_CAP = 50; // safety bound (~50k cartridges)
  const all: unknown[] = [];
  let page = 0;
  // Sequential pagination (no parallel burst — a wide fan-out of concurrent BIOT calls can trip
  // upstream rate limiting). This path only runs for org/distributor scopes, whose cartridge
  // sets are small (one or two pages); the manufacturer "all" view does not fetch cartridges.
  while (page <= PAGE_CAP) {
    const payload = await fetchBiot(config, "GET", "/generic-entity/v3/generic-entities/cartridge", {
      accessToken,
      query: { searchRequest: JSON.stringify({ limit: LIMIT, page }) },
    });
    const items = extractItems(payload, ["data", "items", "results"]);
    if (!items.length) break;
    all.push(...items);
    if (items.length < LIMIT) break;
    page += 1;
  }
  return all;
}

// organization_to_distributor bridge entities (confirmed live 2026-05-19):
// _ownerOrganization is the child organization; organization_distributor is the
// reference to the distributor entity. Used to map orgs → distributor(s).
async function getOrgDistributorBridges(config: BiotConfig, accessToken: string): Promise<unknown[]> {
  const all: unknown[] = [];
  let page = 0;
  while (true) {
    const payload = await fetchBiot(config, "GET", "/generic-entity/v3/generic-entities/organization_to_distributor", {
      accessToken,
      query: { searchRequest: JSON.stringify({ limit: 100, page }) },
    });
    const items = extractItems(payload, ["data", "items", "results"]);
    if (!items.length) break;
    all.push(...items);
    const totalPages = extractTotalPages(payload);
    if (totalPages !== null && page + 1 >= totalPages) break;
    if (items.length < 100) break;
    page += 1;
  }
  return all;
}

async function getGloveSummary(
  config: BiotConfig,
  accessToken: string,
  organizationIds: string[],
  dateRange: DateRange,
  // When non-null, only events whose source device is in this set are counted.
  // Required for distributor scope: device_event has no distributor reference, so
  // we query each owner-org and post-filter by the in-scope device ids.
  allowedDeviceIds: Set<string> | null,
): Promise<Record<string, unknown>> {
  const orgIds = organizationIds.filter((id) => !!id);

  // Query each owner-org independently and IN PARALLEL. Two reasons:
  //   1. Resilience: BIOT's device_event ABAC expansion fails (timeout → 414) for some
  //      tokens on some orgs (notably large-distributor tokens on the manufacturer root
  //      org). A single failing org must not zero out the entire glove widget — only the
  //      org(s) that actually failed are dropped, and the rest still count.
  //   2. Latency: with the 15s per-call timeout, sequential querying of N orgs could cost
  //      up to N×15s. Parallel querying bounds the worst case to ~one timeout window.
  const results = await Promise.all(orgIds.map(async (organizationId) => {
    try {
      const { counts, total } = await getGloveEventsForOrg(
        config, accessToken, organizationId, dateRange, allowedDeviceIds,
      );
      return { ok: true as const, counts, total };
    } catch (e) {
      return { ok: false as const, organizationId, message: e instanceof Error ? e.message : "failed" };
    }
  }));

  const counts = zeroCounts(GLOVE_BREAKDOWN);
  let total = 0;
  let failedOrgs = 0;
  for (const r of results) {
    if (r.ok) {
      total += r.total;
      for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
    } else {
      failedOrgs += 1;
    }
  }

  // If EVERY org failed, surface it as a full widget failure (safeWidget marks
  // meta.partialFailures.gloves and the frontend renders an empty glove chart) rather
  // than silently reporting a real "0 gloves".
  if (orgIds.length > 0 && failedOrgs === orgIds.length) {
    throw new Error("Glove events could not be loaded for any organization (BIOT upstream timeout).");
  }

  const summary: Record<string, unknown> = { total, counts, breakdown: buildBreakdown(counts, GLOVE_BREAKDOWN) };
  // Partial failure: some orgs returned, some didn't. Report how many were dropped so
  // buildDashboard can flag it in meta.partialFailures without hiding the data we do have.
  if (failedOrgs > 0) summary.partialOrgFailures = failedOrgs;
  return summary;
}

// Paginate GLOVE_TAKEN events for a single owner-org. Throws on the first BIOT error so the
// caller can isolate per-org failures.
async function getGloveEventsForOrg(
  config: BiotConfig,
  accessToken: string,
  organizationId: string,
  dateRange: DateRange,
  allowedDeviceIds: Set<string> | null,
): Promise<{ counts: Record<string, number>; total: number }> {
  const counts = zeroCounts(GLOVE_BREAKDOWN);
  let total = 0;
  let page = 0;

  {
    while (true) {
      const searchRequest = {
        filter: {
          event_code: { eq: "GLOVE_TAKEN" },
          "_ownerOrganization.id": { eq: organizationId },
          // Time filtering:
          // fromIso and toIso are full UTC ISO strings built by the frontend from the
          // user's selected local date+time, converted to UTC via Date.toISOString().
          // BIOT's _creationTime stores timestamps in UTC.
          // This means the filter is: "show events where _creationTime is between
          // fromIso and toIso (both in UTC)".
          // The frontend converts: local 00:00 → UTC equivalent. This is correct behavior
          // because users expect to filter by their local clock.
          // Limitation: if the BIOT Grafana dashboard uses a different configured timezone,
          // results may differ. This has not been independently verified.
          _creationTime: { from: dateRange.fromIso, to: dateRange.toIso },
        },
        // device_event is high-volume (thousands/month). BIOT honors limit=1000 (proven live;
        // same delta the Deno backend uses). At limit=100 the root org needs ~16 deep-offset
        // pages whose cost grows per page, pushing a manufacturer "all" load past the 90s
        // frontend timeout. 1000/page keeps it to a couple of fast round-trips.
        limit: 1000,
        page,
      };

      const payload = await fetchBiot(
        config, "GET",
        "/generic-entity/v3/generic-entities/device_event",
        // Patient budget — async glove path, off the dashboard critical path.
        { accessToken, query: { searchRequest: JSON.stringify(searchRequest) }, timeoutMs: GLOVE_FETCH_TIMEOUT_MS },
      );

      const items = extractItems(payload, ["items", "data", "results", "rows", "entities", "genericEntities"]);
      if (!items.length) break;

      for (const item of items) {
        if (allowedDeviceIds) {
          // device_event.device_event references the source device; .id holds the device's
          // `_id`. Proven live 2026-07-06: end-customer-org events carry a **null** ref (only
          // root-org events populate it). Only exclude events positively attributable to an
          // out-of-scope device (ref present AND not allowed) — still drops the root-org
          // over-count; null-ref events are already org-scoped so they are COUNTED. The old
          // `!deviceId` test dropped every null-ref event → false zero for scoped users. See
          // claude/INVESTIGATION_2026-07-06_glove-false-zero-null-device-ref.md.
          const deviceRef = (item as Record<string, unknown>).device_event;
          const deviceId = deviceRef && typeof deviceRef === "object"
            ? String((deviceRef as Record<string, unknown>).id ?? "")
            : "";
          if (deviceId && !allowedDeviceIds.has(deviceId)) continue;
        }
        const norm = normalizeGloveSize((item as Record<string, unknown>).event_cartridge_size);
        counts[norm.key] += 1;
        total += 1;
      }

      const totalPages = extractTotalPages(payload);
      if (totalPages !== null && page + 1 >= totalPages) break;
      if (items.length < 1000) break;
      page += 1;
    }
  }

  return { counts, total };
}

function emptyGloveSummary(): Record<string, unknown> {
  const counts = zeroCounts(GLOVE_BREAKDOWN);
  return { total: 0, counts, breakdown: buildBreakdown(counts, GLOVE_BREAKDOWN) };
}

// ---------------------------------------------------------------------------
// Safe widget wrapper — glove failure doesn't kill the dashboard
// ---------------------------------------------------------------------------

async function safeWidget<T>(
  fn: () => Promise<T>,
  fallback: T,
  onError: (msg: string) => void,
): Promise<T> {
  try { return await fn(); } catch (e) {
    onError(e instanceof Error ? e.message : "Widget request failed.");
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Device aggregation
// ---------------------------------------------------------------------------

function getConnectionSummary(devices: NormalizedDevice[]): Record<string, unknown> {
  const counts = zeroCounts(CONNECTION_BREAKDOWN);
  for (const d of devices) counts[d.connectionStatusKey] += 1;
  return { total: devices.length, counts, breakdown: buildBreakdown(counts, CONNECTION_BREAKDOWN) };
}

// Returns ALL devices (connected + disconnected + unknown) so the frontend can filter
function getAllDevices(devices: NormalizedDevice[]): Record<string, unknown> {
  const items = devices.map((d) => ({
    id: d.id,
    organizationId: d.organizationId,
    organizationName: d.organizationName,
    // Per-device distributor link (device_distributor.{id,name}). Surfaced on the
    // Device detail modal Status tab.
    distributorId: d.distributorId,
    distributorName: d.distributorName,
    connected: d.connected,
    connectionStatus: d.connectionStatus,
    connectionStatusKey: d.connectionStatusKey,
    lastConnectedAt: d.lastConnectedAt,
    sanitizerStatus: d.sanitizerStatus,
    sanitizerStatusKey: d.sanitizerStatusKey,
    // Drives Operational widget and Delivery row
    deliveryAvailable: d.deliveryAvailable,
    // Full _status object — frontend uses this for the detail panel Status tab
    rawStatus: d.rawStatus,
    // Non-system device root fields — frontend uses this for the detail panel Settings tab
    customFields: d.customFields,
  }));
  // Default sort: disconnected first, then by lastConnectedAt ascending
  items.sort((a, b) => {
    const keyOrder: Record<string, number> = { disconnected: 0, unknown: 1, connected: 2 };
    const ao = keyOrder[a.connectionStatusKey] ?? 1;
    const bo = keyOrder[b.connectionStatusKey] ?? 1;
    if (ao !== bo) return ao - bo;
    return (a.lastConnectedAt ?? "") < (b.lastConnectedAt ?? "") ? -1 : 1;
  });
  return { total: items.length, items };
}

// Operational summary.
// Definition: Operational = delivery_available === true, Non-Operational = everything else.
// Business rule: a machine is Operational when it can deliver (gloves + sanitizer ready).
// Field: _status.delivery_available (snake_case, consistent with septol_availability1).
// Falls back to non_operational when the field is absent (null).
function getOperationalSummary(devices: NormalizedDevice[]): Record<string, unknown> {
  const counts = { operational: 0, non_operational: 0 };
  for (const d of devices) {
    if (d.deliveryAvailable === true) {
      counts.operational += 1;
    } else {
      counts.non_operational += 1;
    }
  }
  const total = devices.length;
  const breakdown = buildBreakdown(counts, OPERATIONAL_BREAKDOWN);
  return { total, counts, breakdown };
}

function getSanitizerSummary(devices: NormalizedDevice[]): Record<string, unknown> {
  const counts = zeroCounts(SANITIZER_BREAKDOWN);
  const items: Record<string, unknown>[] = [];
  for (const d of devices) {
    counts[d.sanitizerStatusKey] += 1;
    items.push({ id: d.id, status: d.sanitizerStatus, statusKey: d.sanitizerStatusKey, value: d.sanitizerValue });
  }
  const order: Record<string, number> = { unavailable: 0, unknown: 1, available: 2 };
  items.sort((a, b) => {
    const ao = order[a.statusKey as string] ?? 9;
    const bo = order[b.statusKey as string] ?? 9;
    return ao !== bo ? ao - bo : String(a.id).localeCompare(String(b.id));
  });
  return { total: items.length, counts, breakdown: buildBreakdown(counts, SANITIZER_BREAKDOWN), devices: items };
}

// ---------------------------------------------------------------------------
// Device normalization
// ---------------------------------------------------------------------------

// Scope model:
//  kind="all"           — no device filter applied
//  kind="organization"  — match device._ownerOrganization.id ∈ scope.organizationIds
//  kind="distributor"   — match (device.device_distributor.id === scope.id)
//                         OR (device._ownerOrganization.id ∈ scope.organizationIds)
//                         The OR implements the "see all machines under me" rule:
//                         case 1 (per-device link) and case 2 (via child org).
//
// Organization-role users (anything that is not a manufacturer) are NEVER filtered
// client-side regardless of scope kind: BIOT's ABAC already returned exactly the
// device set that user is permitted to see. Verified live 2026-05-19 with the D1
// distributor user (stamshemyafe@gmail.com, ownerOrganizationId=00000000-..., groups=[]):
// BIOT returns 4 devices spanning two owner orgs (igin and EC1). Applying the
// previous _ownerOrganization.id filter against viewer.ownerOrganizationId
// (00000000-...) dropped the EC1-owned devices — case 2 was broken for real
// distributor users. Trusting BIOT here is also correct for ordinary org-only
// users: BIOT returns only their org's devices, so the filter is a no-op for them.
function deviceMatchesScope(device: unknown, scope: ResolvedScope, viewer: Viewer): boolean {
  if (viewer.role === "organization") return true;

  const ownerOrgId = firstNonEmpty([
    nestedGet(device, ["_ownerOrganization", "id"]),
    nestedGet(device, ["ownerOrganization", "id"]),
  ]) as string | null;
  const distId = nestedGet(device, ["device_distributor", "id"]) as string | null;

  if (scope.kind === "all") return true;
  if (scope.kind === "distributor") {
    if (distId && distId === scope.id) return true;
    return !!ownerOrgId && scope.organizationIds.includes(ownerOrgId);
  }
  // explicit organization selection (manufacturer scope dropdown)
  return !!ownerOrgId && scope.organizationIds.includes(ownerOrgId);
}

// Cartridge scope match — mirrors deviceMatchesScope. Org-role users and the manufacturer
// "all" view are never filtered (trust BIOT ABAC). A manufacturer org selection matches by
// owner-org; a distributor selection matches by cartridge_distributor.id OR child-org membership.
function cartridgeMatchesScope(cartridge: unknown, scope: ResolvedScope, viewer: Viewer): boolean {
  if (viewer.role === "organization") return true;
  if (scope.kind === "all") return true;

  const ownerOrgId = firstNonEmpty([
    nestedGet(cartridge, ["_ownerOrganization", "id"]),
    nestedGet(cartridge, ["ownerOrganization", "id"]),
  ]) as string | null;
  const distId = nestedGet(cartridge, ["cartridge_distributor", "id"]) as string | null;

  if (scope.kind === "distributor") {
    if (distId && distId === scope.id) return true;
    return !!ownerOrgId && scope.organizationIds.includes(ownerOrgId);
  }
  return !!ownerOrgId && scope.organizationIds.includes(ownerOrgId);
}

// Normalize a cartridge entity for the frontend. The user-facing "cartridge number" is
// sticker_id. cartridge_distributor is a reference object { id, name }; _ownerOrganization
// may be a real org or the special "<<Global>>" owner for distributor-held stock.
function normalizeCartridge(cartridge: unknown): Record<string, unknown> {
  const c = cartridge as Record<string, unknown>;
  const owner = c._ownerOrganization && typeof c._ownerOrganization === "object"
    ? (c._ownerOrganization as Record<string, unknown>) : {};
  return {
    id: String(firstNonEmpty([c._id, c.id]) ?? "Unknown cartridge"),
    stickerId: c.sticker_id ?? null,
    name: firstNonEmpty([c._name]) as string | null,
    size: firstNonEmpty([c.cartridge_size]) as string | null,
    nfcId: firstNonEmpty([c.cartridge_nfc_id]) as string | null,
    organizationId: firstNonEmpty([owner.id, owner._id]) as string | null,
    organizationName: firstNonEmpty([owner.name, owner.displayName, owner.label]) as string | null,
    distributorId: nestedGet(c, ["cartridge_distributor", "id"]) as string | null,
    distributorName: nestedGet(c, ["cartridge_distributor", "name"]) as string | null,
    amount: typeof c.amount === "number" ? c.amount : null,
    currentAmount: typeof c.current_amount === "number" ? c.current_amount : null,
    isEmpty: typeof c.is_empty === "boolean" ? c.is_empty : null,
  };
}

function normalizeDevice(device: unknown): NormalizedDevice {
  const d = device as Record<string, unknown>;
  const conn = normalizeConnectionStatus(nestedGet(d, ["_status", "_connection", "_connected"]));
  const san = normalizeSanitizerStatus(nestedGet(d, ["_status", "septol_availability1"]));
  const owner = d._ownerOrganization && typeof d._ownerOrganization === "object"
    ? (d._ownerOrganization as Record<string, unknown>) : {};

  // Extract full _status object for the detail panel
  const rawStatus: Record<string, unknown> = (d._status && typeof d._status === "object")
    ? { ...(d._status as Record<string, unknown>) }
    : {};

  // delivery_available1 drives the Operational widget and Delivery row in Status tab.
  // Confirmed field name from live API 2026-04-28. Has the `1` suffix like septol_availability1.
  const deliveryAvailable = nestedGet(d, ["_status", "delivery_available1"]) as boolean | null;

  // Extract device-level custom fields: any non-underscore-prefixed root field.
  // In BIOT, system fields start with _ (e.g., _id, _status, _ownerOrganization).
  // The main non-system field confirmed in device root: current_settings2 (reference to settings entity).
  // Actual settings values live in the separate entity — fetch via GET /generic-entity/v1/generic-entities/{id}.
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(d)) {
    if (!key.startsWith("_")) {
      customFields[key] = value;
    }
  }

  // device_distributor is a reference object on the device root: { id, name, templateName: "distributor" }.
  // Confirmed live 2026-05-19. May be absent / null for unassigned devices.
  const distributorId = nestedGet(d, ["device_distributor", "id"]) as string | null;
  const distributorName = nestedGet(d, ["device_distributor", "name"]) as string | null;

  return {
    id: String(firstNonEmpty([d._id, d.id]) ?? "Unknown device"),
    organizationId: firstNonEmpty([owner.id, owner._id]) as string | null,
    organizationName: firstNonEmpty([owner.name, owner.displayName, owner.label]) as string | null,
    distributorId: distributorId ?? null,
    distributorName: distributorName ?? null,
    connected: nestedGet(d, ["_status", "_connection", "_connected"]) as boolean | null,
    connectionStatus: conn.label,
    connectionStatusKey: conn.key,
    lastConnectedAt: nestedGet(d, ["_status", "_connection", "_lastConnectedTime"]) as string | null,
    sanitizerStatus: san.label,
    sanitizerStatusKey: san.key,
    sanitizerValue: nestedGet(d, ["_status", "septol_availability1"]),
    deliveryAvailable,
    rawStatus,
    customFields,
  };
}

function normalizeConnectionStatus(v: unknown): { key: string; label: string } {
  if (v === true) return { key: "connected", label: "Connected" };
  if (v === false) return { key: "disconnected", label: "Disconnected" };
  return { key: "unknown", label: "Unknown" };
}

function normalizeSanitizerStatus(v: unknown): { key: string; label: string } {
  if (v === true) return { key: "available", label: "Available" };
  if (v === false) return { key: "unavailable", label: "Unavailable" };
  return { key: "unknown", label: "Unknown" };
}

function normalizeGloveSize(v: unknown): { key: string; label: string } {
  if (typeof v !== "string" || !v.trim()) return { key: "unknown", label: "Unknown" };
  const n = v.trim().toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ");
  if (n === "s" || n === "small") return { key: "small", label: "Small" };
  if (n === "m" || n === "medium" || n === "med") return { key: "medium", label: "Medium" };
  if (n === "l" || n === "large") return { key: "large", label: "Large" };
  if (n === "xl" || n === "xlarge" || n === "x large" || n === "extra large") return { key: "extraLarge", label: "Extra Large" };
  return { key: "unknown", label: "Unknown" };
}

// ---------------------------------------------------------------------------
// Viewer / organization / scope
// ---------------------------------------------------------------------------

function buildViewerIdentity(loginPayload: Record<string, unknown>, selfPayload: Record<string, unknown>): Viewer {
  const groups = extractGroups(selfPayload).sort();
  const role = inferRole(groups);
  const ownerOrganizationId = firstNonEmpty([
    loginPayload.ownerOrganizationId,
    nestedGet(selfPayload, ["_ownerOrganization", "id"]),
    nestedGet(selfPayload, ["ownerOrganization", "id"]),
    selfPayload.ownerOrganizationId,
  ]) as string | null;
  const displayName = firstNonEmpty([
    selfPayload.fullName, selfPayload.displayName, selfPayload.name,
    buildFullName(selfPayload.firstName, selfPayload.lastName),
    selfPayload.email, selfPayload.username, loginPayload.userId,
  ]) as string | null;
  return {
    userId: firstNonEmpty([loginPayload.userId, selfPayload._id, selfPayload.id]) as string | null,
    displayName: displayName ?? "BIOT User",
    email: firstNonEmpty([selfPayload.email, selfPayload.username]) as string | null,
    role,
    groups,
    ownerOrganizationId,
  };
}

function buildFullName(first: unknown, last: unknown): string | null {
  const parts: string[] = [];
  if (typeof first === "string" && first.trim()) parts.push(first.trim());
  if (typeof last === "string" && last.trim()) parts.push(last.trim());
  return parts.length ? parts.join(" ") : null;
}

function inferRole(groups: string[]): "manufacturer" | "organization" {
  for (const g of groups) if (g.toLowerCase().includes("manufacturer")) return "manufacturer";
  return "organization";
}

function extractGroups(payload: unknown): string[] {
  const groups: string[] = [];
  const seen = new Set<string>();
  function collect(v: unknown): void {
    if (typeof v === "string" && v.trim() && !seen.has(v.trim())) { seen.add(v.trim()); groups.push(v.trim()); return; }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const f of ["name", "label", "title", "value"]) {
        const fv = (v as Record<string, unknown>)[f];
        if (typeof fv === "string" && fv.trim() && !seen.has(fv.trim())) { seen.add(fv.trim()); groups.push(fv.trim()); }
      }
    }
  }
  function walk(node: unknown): void {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase().includes("group") || key.toLowerCase().includes("role")) {
        Array.isArray(val) ? val.forEach(collect) : collect(val);
      }
      walk(val);
    }
  }
  walk(payload);
  return groups;
}

function deriveOrganizations(viewer: Viewer, selfPayload: unknown, devices: unknown[]): Organization[] {
  const orgs: Record<string, Organization> = {};
  function add(id: unknown, name: unknown): void {
    if (typeof id !== "string" || !id.trim()) return;
    const nid = id.trim();
    if (!orgs[nid]) orgs[nid] = { id: nid, name: nid };
    if (typeof name === "string" && name.trim()) orgs[nid].name = name.trim();
  }
  function walk(node: unknown, path: string): void {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, path)); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (path.toLowerCase().includes("organization")) {
      add(firstNonEmpty([obj.id, obj._id, obj.organizationId, obj.ownerOrganizationId]), firstNonEmpty([obj.name, obj.displayName, obj.label]));
    } else if (Object.keys(obj).some((k) => k.toLowerCase().includes("organization"))) {
      add(firstNonEmpty([obj.organizationId, obj.ownerOrganizationId]), firstNonEmpty([obj.organizationName, obj.ownerOrganizationName]));
    }
    for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
  }
  walk(selfPayload, "");
  for (const device of devices) {
    const d = device as Record<string, unknown>;
    const owner = d._ownerOrganization && typeof d._ownerOrganization === "object" ? (d._ownerOrganization as Record<string, unknown>) : null;
    if (owner) add(firstNonEmpty([owner.id, owner._id]), firstNonEmpty([owner.name, owner.displayName, owner.label]));
  }
  add(viewer.ownerOrganizationId, viewer.ownerOrganizationId);
  const items = Object.values(orgs);
  items.sort((a, b) => {
    const an = (a.name || a.id).toLowerCase(), bn = (b.name || b.id).toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id.toLowerCase() < b.id.toLowerCase() ? -1 : 1;
  });
  if (viewer.role === "organization" && viewer.ownerOrganizationId) {
    const filtered = items.filter((o) => o.id === viewer.ownerOrganizationId);
    return filtered.length ? filtered : [{ id: viewer.ownerOrganizationId, name: viewer.ownerOrganizationId }];
  }
  return items;
}

// Resolved scope passed through the rest of the pipeline. `kind` drives the
// device-match rule; `id` is the selected scope target (or null for "all"); and
// `organizationIds` is the org-id set used for event queries.
interface ResolvedScope {
  kind: "all" | "organization" | "distributor";
  id: string | null;
  // For "all": every known org id (event query fanout).
  // For "organization": [<orgId>].
  // For "distributor": the list of child org ids linked to that distributor (via
  //   organization_to_distributor bridge entities). Used for both event queries
  //   and the secondary "owner-org membership" leg of the device match.
  organizationIds: string[];
  label: string;
  // Echo of the encoded selection ("all" | "org:<id>" | "dist:<id>"). The frontend
  // resends this on the next request to keep the dropdown selection sticky.
  selectedToken: string;
}

function parseScopeToken(raw: string | undefined, knownOrgIds: Set<string>, knownDistIds: Set<string>): { kind: "all" | "organization" | "distributor"; id: string | null } {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t || t === "all") return { kind: "all", id: null };
  if (t.startsWith("dist:")) return { kind: "distributor", id: t.slice("dist:".length) };
  if (t.startsWith("org:")) return { kind: "organization", id: t.slice("org:".length) };
  // Legacy: a bare value (UUID or otherwise). Disambiguate against known sets so
  // a value previously stored in localStorage / linked URL still works.
  if (knownDistIds.has(t)) return { kind: "distributor", id: t };
  if (knownOrgIds.has(t)) return { kind: "organization", id: t };
  // Unknown value — fall back to "all" rather than 400'ing; the dropdown will
  // re-render and the user can choose a valid option.
  return { kind: "all", id: null };
}

function resolveScope(
  viewer: Viewer,
  organizations: Organization[],
  distributors: Distributor[],
  distributorToOrgIds: Record<string, string[]>,
  requestedToken: string | undefined,
): ResolvedScope {
  const availableOrgs = organizations.map((o) => o.id).filter(Boolean);
  const availableDistIds = new Set(distributors.map((d) => d.id));

  // Organization-role users (incl. anyone whose group does not include "manufacturer")
  // are locked to their own organization. No distributor selection available.
  if (viewer.role === "organization") {
    const locked = viewer.ownerOrganizationId ?? availableOrgs[0] ?? null;
    return {
      kind: locked ? "organization" : "all",
      id: locked,
      organizationIds: locked ? [locked] : [],
      label: orgLabel(organizations, locked),
      selectedToken: locked ? `org:${locked}` : "all",
    };
  }

  const parsed = parseScopeToken(requestedToken, new Set(availableOrgs), availableDistIds);
  if (parsed.kind === "all") {
    return {
      kind: "all", id: null, organizationIds: availableOrgs,
      label: "All organizations", selectedToken: "all",
    };
  }
  if (parsed.kind === "distributor" && parsed.id && availableDistIds.has(parsed.id)) {
    const childOrgIds = distributorToOrgIds[parsed.id] ?? [];
    return {
      kind: "distributor", id: parsed.id, organizationIds: childOrgIds,
      label: distLabel(distributors, parsed.id), selectedToken: `dist:${parsed.id}`,
    };
  }
  if (parsed.kind === "organization" && parsed.id && availableOrgs.includes(parsed.id)) {
    return {
      kind: "organization", id: parsed.id, organizationIds: [parsed.id],
      label: orgLabel(organizations, parsed.id), selectedToken: `org:${parsed.id}`,
    };
  }
  // Unknown / not-available selection — silently fall back to "all" for manufacturers.
  return {
    kind: "all", id: null, organizationIds: availableOrgs,
    label: "All organizations", selectedToken: "all",
  };
}

function orgLabel(organizations: Organization[], id: string | null): string {
  if (!id) return "No organization";
  return organizations.find((o) => o.id === id)?.name ?? id;
}

function distLabel(distributors: Distributor[], id: string | null): string {
  if (!id) return "No distributor";
  return distributors.find((d) => d.id === id)?.name ?? id;
}

// Build distributor-id → child-org-id[] from organization_to_distributor bridge entities.
// Bridge shape (confirmed live 2026-05-19):
//   _ownerOrganization.id  = child org id
//   organization_distributor.id = distributor id
// One distributor may have many child orgs; one org may belong to many distributors.
function buildDistributorToOrgsMap(bridges: unknown[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const b of bridges) {
    const orgId = nestedGet(b, ["_ownerOrganization", "id"]) as string | null;
    const distId = nestedGet(b, ["organization_distributor", "id"]) as string | null;
    if (!orgId || !distId) continue;
    (out[distId] ??= new Set()).add(orgId);
  }
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) result[k] = Array.from(v);
  return result;
}

function normalizeDistributors(raw: unknown[]): Distributor[] {
  const seen = new Map<string, Distributor>();
  for (const r of raw) {
    const id = nestedGet(r, ["_id"]) as string | null;
    if (!id || seen.has(id)) continue;
    const name = (nestedGet(r, ["_name"]) as string | null) ?? id;
    seen.set(id, { id, name });
  }
  return Array.from(seen.values()).sort((a, b) => {
    const an = (a.name || a.id).toLowerCase();
    const bn = (b.name || b.id).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

function resolveDateRange(params: Record<string, string>): DateRange {
  const now = new Date();
  const defaultTo = dateOnly(now);
  const defaultFrom = dateOnly(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
  const from = params.from || defaultFrom;
  const to = params.to || defaultTo;
  if (from > to) throw new Error("The start date must be on or before the end date.");
  return {
    from, to,
    // Use provided ISO strings from frontend (which convert local time → UTC).
    // Fallback: midnight UTC if not provided (no time filtering).
    fromIso: params.fromIso || `${from}T00:00:00.000Z`,
    toIso: params.toIso || `${to}T23:59:59.999Z`,
    timezone: params.timezone || "UTC",
  };
}

function dateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

// Per-call upstream timeout. BIOT's generic-entity (device_event) endpoint performs an
// ABAC permission expansion whose cost scales with the caller's permitted-entity set. For
// large-distributor tokens that expansion takes ~85-90s and then fails (HTTP 414), which
// previously stalled the whole dashboard right up against the frontend's 90s request
// timeout (intermittent "Unable to load dashboard data right now"). Every legitimate BIOT
// call here returns in ~1-2s, so a 15s ceiling fails the pathological call fast while never
// tripping on a healthy one. (Confirmed live 2026-06-28.)
const BIOT_FETCH_TIMEOUT_MS = 15000;

// Patient budget for the async glove path ONLY (see deno/main.ts for the full rationale): BIOT's
// `device_event` ABAC expansion takes ~90s for large-distributor tokens before BIOT itself responds.
// Gloves are off the dashboard critical path, so we wait it out rather than giving up early — but
// kept under the platform's ~116s single-request limit (total ~88s) so the response stays clean.
const GLOVE_FETCH_TIMEOUT_MS = 85000;

async function fetchBiot(
  config: BiotConfig, method: string, path: string,
  options: { accessToken?: string; body?: unknown; query?: Record<string, string>; expectedStatuses?: number[]; baseUrl?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const base = options.baseUrl ?? config.baseUrl;
  const url = buildUrl(`${base}${path}`, options.query ?? {});
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const timeoutMs = options.timeoutMs ?? BIOT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`BIOT request timed out after ${timeoutMs / 1000}s (${path}).`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("BIOT returned a non-JSON response."); }
  if (res.status === 401) throw new BiotAuthError(extractErrorMessage(payload) || "BIOT authentication failed. Your session may have expired.");
  const expected = options.expectedStatuses ?? [200];
  if (!expected.includes(res.status)) throw new Error(extractErrorMessage(payload) || `BIOT request failed with status ${res.status}.`);
  return payload as Record<string, unknown>;
}

function buildUrl(base: string, query: Record<string, string>): string {
  const keys = Object.keys(query).filter((k) => query[k] != null && query[k] !== "");
  if (!keys.length) return base;
  const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function extractItems(payload: unknown, preferredKeys: string[] = []): unknown[] {
  if (Array.isArray(payload)) return payload.filter((i) => i && typeof i === "object" && !Array.isArray(i));
  if (!payload || typeof payload !== "object") return [];
  const keys = [...preferredKeys, "items", "data", "results", "content", "rows", "entities", "genericEntities"];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue; seen.add(key);
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.filter((i) => i && typeof i === "object" && !Array.isArray(i));
  }
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (Array.isArray(v)) return v.filter((i) => i && typeof i === "object" && !Array.isArray(i));
  }
  return [];
}

function extractTotalPages(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.totalPages === "number") return p.totalPages;
  if (typeof p._totalPages === "number") return p._totalPages;
  if (typeof p.pages === "number") return p.pages;
  if (p.page && typeof p.page === "object") {
    const pg = p.page as Record<string, unknown>;
    if (typeof pg.totalPages === "number") return pg.totalPages;
    if (typeof pg.pages === "number") return pg.pages;
  }
  if (p.meta && typeof p.meta === "object") {
    const m = p.meta as Record<string, unknown>;
    if (typeof m.totalPages === "number") return m.totalPages;
    if (typeof m.pages === "number") return m.pages;
  }
  return null;
}

function extractErrorMessage(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (Array.isArray(payload)) { for (const i of payload) { const m = extractErrorMessage(i); if (m) return m; } return ""; }
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const f of ["message", "error", "detail", "title", "description"]) {
      if (typeof p[f] === "string" && (p[f] as string).trim()) return (p[f] as string).trim();
    }
    if (Array.isArray(p.errors)) { for (const e of p.errors) { const m = extractErrorMessage(e); if (m) return m; } }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function buildBreakdown(counts: Record<string, number>, labels: [string, string][]): Record<string, unknown>[] {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  return labels.map(([key, label]) => {
    const value = counts[key] ?? 0;
    return { key, label, value, percentage: total ? Number(((value / total) * 100).toFixed(1)) : 0 };
  });
}

function zeroCounts(pairs: [string, string][]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const [k] of pairs) c[k] = 0;
  return c;
}

function nestedGet(source: unknown, keys: string[]): unknown {
  let cur: unknown = source;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur ?? null;
}

function firstNonEmpty(values: unknown[]): unknown {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) return v;
  }
  return null;
}
