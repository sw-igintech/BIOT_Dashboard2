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

interface NormalizedDevice {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
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

async function buildDashboard(params: Record<string, string>, accessToken: string): Promise<Record<string, unknown>> {
  const config: BiotConfig = { baseUrl: getBaseUrl() };
  const dateRange = resolveDateRange(params);

  // User supplies their own accessToken — no server-side login needed
  const selfPayload = await getCurrentUser(config, accessToken);
  const viewer = buildViewerIdentity({}, selfPayload);
  const rawDevices = await getDevices(config, accessToken);
  const organizations = deriveOrganizations(viewer, selfPayload, rawDevices);
  const scope = resolveScope(viewer, organizations, params.organizationId);

  // When a manufacturer views all organizations, trust the API response
  // entirely — the BIOT API already scopes results to the authenticated
  // user's visibility. Client-side filtering in this case can silently drop
  // devices whose ownerOrganization wasn't captured by deriveOrganizations.
  // Only apply client-side scope filtering when a specific org is selected.
  const needsClientFilter = scope.selectedOrganizationId !== "all";
  const scopedDevices: NormalizedDevice[] = rawDevices
    .filter((d) => !needsClientFilter || deviceMatchesScope(d, scope.organizationIds, viewer))
    .map(normalizeDevice);

  const widgetErrors: Record<string, string> = {};
  const gloves = await safeWidget(
    () => getGloveSummary(config, accessToken, scope.organizationIds, dateRange),
    emptyGloveSummary(),
    (msg) => { widgetErrors.gloves = msg; },
  );

  return {
    viewer,
    scope: {
      from: dateRange.from,
      to: dateRange.to,
      fromIso: dateRange.fromIso,
      toIso: dateRange.toIso,
      timezone: dateRange.timezone,
      organizationId: scope.selectedOrganizationId,
      organizationIds: scope.organizationIds,
      organizationLabel: scope.label,
    },
    organizations,
    connection: getConnectionSummary(scopedDevices),
    // All devices (connected + disconnected + unknown) — frontend filters by connectionStatusKey
    devices: getAllDevices(scopedDevices),
    // Operational summary: Operational = delivery_available === true, Non-Operational = otherwise
    operational: getOperationalSummary(scopedDevices),
    gloves,
    sanitizer: getSanitizerSummary(scopedDevices),
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

async function getGloveSummary(
  config: BiotConfig,
  accessToken: string,
  organizationIds: string[],
  dateRange: DateRange,
): Promise<Record<string, unknown>> {
  const counts = zeroCounts(GLOVE_BREAKDOWN);
  let total = 0;

  for (const organizationId of organizationIds) {
    if (!organizationId) continue;
    let page = 0;

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
        limit: 100,
        page,
      };

      const payload = await fetchBiot(
        config, "GET",
        "/generic-entity/v3/generic-entities/device_event",
        { accessToken, query: { searchRequest: JSON.stringify(searchRequest) } },
      );

      const items = extractItems(payload, ["items", "data", "results", "rows", "entities", "genericEntities"]);
      if (!items.length) break;

      for (const item of items) {
        const norm = normalizeGloveSize((item as Record<string, unknown>).event_cartridge_size);
        counts[norm.key] += 1;
        total += 1;
      }

      const totalPages = extractTotalPages(payload);
      if (totalPages !== null && page + 1 >= totalPages) break;
      if (items.length < 100) break;
      page += 1;
    }
  }

  return { total, counts, breakdown: buildBreakdown(counts, GLOVE_BREAKDOWN) };
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

function deviceMatchesScope(device: unknown, organizationIds: string[], viewer: Viewer): boolean {
  const ownerOrgId = firstNonEmpty([
    nestedGet(device, ["_ownerOrganization", "id"]),
    nestedGet(device, ["ownerOrganization", "id"]),
  ]) as string | null;
  if (!organizationIds.length) {
    if (viewer.role === "organization" && viewer.ownerOrganizationId) return ownerOrgId === viewer.ownerOrganizationId;
    return true;
  }
  return organizationIds.includes(ownerOrgId ?? "");
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

  return {
    id: String(firstNonEmpty([d._id, d.id]) ?? "Unknown device"),
    organizationId: firstNonEmpty([owner.id, owner._id]) as string | null,
    organizationName: firstNonEmpty([owner.name, owner.displayName, owner.label]) as string | null,
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

function resolveScope(
  viewer: Viewer, organizations: Organization[], requestedOrgId: string | undefined,
): { selectedOrganizationId: string; organizationIds: string[]; label: string } {
  const available = organizations.map((o) => o.id).filter(Boolean);
  if (viewer.role === "organization") {
    const locked = viewer.ownerOrganizationId ?? available[0] ?? null;
    return { selectedOrganizationId: locked ?? "", organizationIds: locked ? [locked] : [], label: orgLabel(organizations, locked) };
  }
  const selected = typeof requestedOrgId === "string" && requestedOrgId.trim() ? requestedOrgId.trim() : "all";
  if (selected !== "all" && !available.includes(selected)) throw new Error("The requested organization is not available for this account.");
  if (selected === "all") return { selectedOrganizationId: "all", organizationIds: available, label: "All organizations" };
  return { selectedOrganizationId: selected, organizationIds: [selected], label: orgLabel(organizations, selected) };
}

function orgLabel(organizations: Organization[], id: string | null): string {
  if (!id) return "No organization";
  return organizations.find((o) => o.id === id)?.name ?? id;
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

async function fetchBiot(
  config: BiotConfig, method: string, path: string,
  options: { accessToken?: string; body?: unknown; query?: Record<string, string>; expectedStatuses?: number[]; baseUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const base = options.baseUrl ?? config.baseUrl;
  const url = buildUrl(`${base}${path}`, options.query ?? {});
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const res = await fetch(url, init);
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
