// biot-dashboard — Supabase Edge Function
//
// Pure BIOT proxy. No database. No caching. No sync.
// Frontend → this function → BIOT APIs → Frontend.
//
// Required secrets (supabase secrets set):
//   BIOT_BASE_URL   https://api.dev.igin.biot-med.com
//   BIOT_USERNAME   service-account username
//   BIOT_PASSWORD   service-account password

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CONNECTION_BREAKDOWN: [string, string][] = [
  ["connected", "Connected"],
  ["disconnected", "Disconnected"],
  ["unknown", "Unknown"],
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
  username: string;
  password: string;
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

    const action = params.action ?? "dashboard";

    if (action === "health") {
      return ok({ ok: true, backend: "Supabase Edge Function", timestamp: new Date().toISOString() });
    }

    if (action === "dashboard") {
      const data = await buildDashboard(params);
      return ok({ ok: true, data });
    }

    return err({ ok: false, error: { message: `Unknown action: ${action}` } }, 400);
  } catch (e) {
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

function getConfig(): BiotConfig {
  const baseUrl = Deno.env.get("BIOT_BASE_URL");
  const username = Deno.env.get("BIOT_USERNAME");
  const password = Deno.env.get("BIOT_PASSWORD");
  if (!baseUrl) throw new Error("BIOT_BASE_URL secret is not set.");
  if (!username) throw new Error("BIOT_USERNAME secret is not set.");
  if (!password) throw new Error("BIOT_PASSWORD secret is not set.");
  return { baseUrl, username, password };
}

// ---------------------------------------------------------------------------
// Dashboard builder
// ---------------------------------------------------------------------------

async function buildDashboard(params: Record<string, string>): Promise<Record<string, unknown>> {
  const config = getConfig();
  const dateRange = resolveDateRange(params);

  const loginPayload = await loginToBiot(config);
  const accessToken = nestedGet(loginPayload, ["accessJwt", "token"]) as string | null;
  if (!accessToken) throw new Error("BIOT login succeeded but did not return accessJwt.token.");

  const selfPayload = await getCurrentUser(config, accessToken);
  const viewer = buildViewerIdentity(loginPayload, selfPayload);
  const rawDevices = await getDevices(config, accessToken);
  const organizations = deriveOrganizations(viewer, selfPayload, rawDevices);
  const scope = resolveScope(viewer, organizations, params.organizationId);

  const scopedDevices: NormalizedDevice[] = rawDevices
    .filter((d) => deviceMatchesScope(d, scope.organizationIds, viewer))
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
    offlineDevices: getOfflineDevices(scopedDevices),
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

async function loginToBiot(config: BiotConfig): Promise<Record<string, unknown>> {
  return fetchBiot(config, "POST", "/ums/v2/users/login", {
    body: { username: config.username, password: config.password },
    expectedStatuses: [200, 201],
  });
}

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

function getOfflineDevices(devices: NormalizedDevice[]): Record<string, unknown> {
  const items = devices
    .filter((d) => d.connectionStatusKey === "disconnected")
    .map((d) => ({ id: d.id, lastConnectedAt: d.lastConnectedAt, connected: d.connected, connectionStatus: d.connectionStatus }));
  items.sort((a, b) => (a.lastConnectedAt ?? "") < (b.lastConnectedAt ?? "") ? -1 : 1);
  return { total: items.length, items };
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
    displayName: displayName ?? "BIOT Service Account",
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
  if (selected !== "all" && !available.includes(selected)) throw new Error("The requested organization is not available for this manufacturer account.");
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
