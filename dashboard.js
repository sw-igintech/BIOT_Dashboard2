const CHART_COLORS = {
  connection: {
    connected: "#2563eb",
    disconnected: "#f97316",
    unknown: "#94a3b8",
  },
  gloves: {
    small: "#93c5fd",
    medium: "#2563eb",
    large: "#f59e0b",
    extraLarge: "#f97316",
    unknown: "#cbd5e1",
  },
  sanitizer: {
    available: "#0891b2",
    unavailable: "#f97316",
    unknown: "#94a3b8",
  },
  operational: {
    operational: "#22c55e",
    non_operational: "#f97316",
  },
};

const CONNECTION_BREAKDOWN = [
  ["connected", "Connected"],
  ["disconnected", "Disconnected"],
  ["unknown", "Unknown"],
];

const GLOVE_BREAKDOWN = [
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
  ["extraLarge", "Extra Large"],
  ["unknown", "Unknown"],
];

const SANITIZER_BREAKDOWN = [
  ["available", "Available"],
  ["unavailable", "Unavailable"],
  ["unknown", "Unknown"],
];

const OPERATIONAL_BREAKDOWN = [
  ["operational", "Operational"],
  ["non_operational", "Non-Operational"],
];

const GENERIC_REQUEST_ERROR = "Unable to load dashboard data right now. Please try again.";
const REQUEST_TIMEOUT_MS = 90000;

// ---------------------------------------------------------------------------
// Session timeout policy
// ---------------------------------------------------------------------------
// 12-hour absolute session. The clock starts at login and is not reset by
// token refreshes. After 12 hours the user must log in again regardless of
// activity. This matches common internal-dashboard practice (one workday).
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

const state = {
  charts: {},
  requestId: 0,
  summary: null,
  // connectionFilter: controls which devices appear in the machines table.
  // "disconnected" is the default (same as prior "Offline Devices" behavior).
  // Set to "connected" when the user clicks the Connected legend or chip.
  connectionFilter: "disconnected",
  // selectedDeviceId: tracks the currently opened device detail panel.
  selectedDeviceId: null,
};

// ---------------------------------------------------------------------------
// Auth module
// ---------------------------------------------------------------------------

const AUTH_KEYS = {
  token: "auth_token",
  refreshToken: "auth_refresh_token",
  user: "auth_user",
  sessionStart: "auth_session_start",
};

const auth = {
  getToken() {
    return localStorage.getItem(AUTH_KEYS.token);
  },
  getRefreshToken() {
    return localStorage.getItem(AUTH_KEYS.refreshToken);
  },
  getUser() {
    try {
      const raw = localStorage.getItem(AUTH_KEYS.user);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  setTokens(accessToken, refreshToken, user) {
    if (accessToken) localStorage.setItem(AUTH_KEYS.token, accessToken);
    if (refreshToken) localStorage.setItem(AUTH_KEYS.refreshToken, refreshToken);
    // user is only provided on initial login — set the session clock then
    if (user) {
      localStorage.setItem(AUTH_KEYS.user, JSON.stringify(user));
      localStorage.setItem(AUTH_KEYS.sessionStart, String(Date.now()));
    }
  },
  clearTokens() {
    localStorage.removeItem(AUTH_KEYS.token);
    localStorage.removeItem(AUTH_KEYS.refreshToken);
    localStorage.removeItem(AUTH_KEYS.user);
    localStorage.removeItem(AUTH_KEYS.sessionStart);
  },
  isSessionExpired() {
    const start = parseInt(localStorage.getItem(AUTH_KEYS.sessionStart) || "0", 10);
    if (!start) return true;
    return Date.now() - start > SESSION_MAX_MS;
  },
  isAuthenticated() {
    return !!this.getToken() && !this.isSessionExpired();
  },
};

// ---------------------------------------------------------------------------
// Chart plugin
// ---------------------------------------------------------------------------

const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart, args, pluginOptions) {
    if (!pluginOptions || !chart.chartArea) {
      return;
    }

    const { ctx, chartArea } = chart;
    const centerX = (chartArea.left + chartArea.right) / 2;
    const centerY = (chartArea.top + chartArea.bottom) / 2;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f172a";
    ctx.font = "700 28px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(String(pluginOptions.value ?? ""), centerX, centerY - 6);

    ctx.fillStyle = "#64748b";
    ctx.font = "600 12px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(String(pluginOptions.label ?? ""), centerX, centerY + 18);
    ctx.restore();
  },
};

if (window.Chart) {
  window.Chart.register(centerTextPlugin);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setDefaultDates();
  wireUi();

  if (auth.isAuthenticated()) {
    showDashboardView();
    refreshDashboard();
  } else {
    if (auth.getToken()) auth.clearTokens();
    showLoginView();
  }
});

function wireUi() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshDashboard());
  document.getElementById("organizationSelect").addEventListener("change", () => refreshDashboard());
  document.getElementById("loginForm").addEventListener("submit", handleLoginFormSubmit);
  document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  document.getElementById("closeDetailBtn").addEventListener("click", closeDeviceDetail);

  // Show/Hide password toggle
  document.getElementById("togglePassword").addEventListener("click", () => {
    const input = document.getElementById("loginPassword");
    const btn = document.getElementById("togglePassword");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
  });

  // Auto-format date inputs as user types (dd/mm/yy)
  ["fromDate", "toDate"].forEach((id) => {
    document.getElementById(id).addEventListener("input", (e) => {
      let digits = e.target.value.replace(/\D/g, "");
      if (digits.length > 6) digits = digits.slice(0, 6);
      let formatted = digits;
      if (digits.length > 4) {
        formatted = digits.slice(0, 2) + "/" + digits.slice(2, 4) + "/" + digits.slice(4);
      } else if (digits.length > 2) {
        formatted = digits.slice(0, 2) + "/" + digits.slice(2);
      }
      e.target.value = formatted;
    });
  });

  // Connection filter chips (Disconnected / Connected buttons in table header)
  document.querySelectorAll(".filter-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      setConnectionFilter(btn.dataset.filter);
    });
  });

  // Detail panel tab switching
  document.querySelectorAll(".detail-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      switchDetailTab(tab.dataset.tab);
    });
  });
}

// ---------------------------------------------------------------------------
// Auth view helpers
// ---------------------------------------------------------------------------

function showLoginView() {
  document.getElementById("loginView").classList.remove("hidden");
  document.getElementById("dashboardView").classList.add("hidden");
}

function showDashboardView() {
  document.getElementById("loginView").classList.add("hidden");
  document.getElementById("dashboardView").classList.remove("hidden");
  updateUserDisplay();
}

function updateUserDisplay() {
  const user = auth.getUser();
  const el = document.getElementById("userInfo");
  if (el && user && user.email) {
    el.textContent = user.email;
  }
}

function handleAuthFailure() {
  auth.clearTokens();
  destroyCharts();
  state.summary = null;
  showLoginView();
}

// ---------------------------------------------------------------------------
// Login form
// ---------------------------------------------------------------------------

async function handleLoginFormSubmit(event) {
  event.preventDefault();

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!email || !password) {
    showLoginError("Please enter your email and password.");
    return;
  }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "Signing in...";
  hideLoginError();

  try {
    const data = await loginRequest(email, password);
    auth.setTokens(data.accessToken, data.refreshToken, { email, userId: data.userId });
    showDashboardView();
    refreshDashboard();
  } catch (error) {
    showLoginError(error && error.message ? error.message : "Login failed. Please check your credentials.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
}

function handleLogout() {
  auth.clearTokens();
  destroyCharts();
  state.summary = null;
  hideDashboardError();
  setDashboardLoading(false);
  closeDeviceDetail();
  showLoginView();
}

function showLoginError(message) {
  const el = document.getElementById("loginError");
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideLoginError() {
  const el = document.getElementById("loginError");
  el.textContent = "";
  el.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Dashboard refresh
// ---------------------------------------------------------------------------

async function refreshDashboard() {
  const edgeUrl = getEdgeUrl();
  if (!edgeUrl) {
    destroyCharts();
    showDashboardError("Dashboard service is not configured.");
    return;
  }

  if (!auth.isAuthenticated()) {
    if (auth.getToken()) auth.clearTokens();
    showLoginView();
    return;
  }

  const range = buildDateRangePayload();
  if (!range.ok) {
    showDashboardError(range.error);
    return;
  }

  const requestId = ++state.requestId;
  setDashboardLoading(true);
  hideDashboardError();

  const organizationSelect = document.getElementById("organizationSelect");
  const organizationField = document.getElementById("organizationField");
  const params = {
    action: "dashboard",
    from: range.from,
    to: range.to,
    fromIso: range.fromIso,
    toIso: range.toIso,
    timezone: range.timezone,
  };

  if (!organizationField.classList.contains("hidden") && organizationSelect.value) {
    params.organizationId = organizationSelect.value;
  }

  try {
    const summary = normalizeDashboardSummary(await appsScriptRequest(params));
    if (requestId !== state.requestId) return;

    state.summary = summary;
    // Close any open detail panel when data is refreshed
    closeDeviceDetail();
    renderOrganizationSelector(summary);
    renderSummary(summary);
  } catch (error) {
    if (requestId !== state.requestId) return;
    destroyCharts();
    showDashboardError(error && error.message ? error.message : GENERIC_REQUEST_ERROR);
  } finally {
    if (requestId === state.requestId) setDashboardLoading(false);
  }
}

function renderOrganizationSelector(summary) {
  const field = document.getElementById("organizationField");
  const select = document.getElementById("organizationSelect");
  const organizations = Array.isArray(summary.organizations) ? summary.organizations : [];

  if (!summary.viewer || summary.viewer.role !== "manufacturer") {
    field.classList.add("hidden");
    select.innerHTML = "";
    return;
  }

  const selectedValue = summary.scope.organizationId || "all";
  field.classList.remove("hidden");
  select.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All organizations";
  select.appendChild(allOption);

  organizations.forEach((organization) => {
    const option = document.createElement("option");
    option.value = organization.id;
    option.textContent = organization.name || organization.id;
    select.appendChild(option);
  });

  select.value = selectedValue;
}

function renderSummary(summary) {
  // Connection: hide Unknown in metrics and chart/legend
  const connDisplayBreakdown = summary.connection.breakdown.filter((b) => b.key !== "unknown");
  renderMetrics("connectionMetrics", [
    { label: "Total Devices", value: summary.connection.total },
    { label: "Connected", value: summary.connection.counts.connected },
    { label: "Disconnected", value: summary.connection.counts.disconnected },
  ]);

  // Gloves: hide Unknown in metrics and chart/legend
  const gloveDisplayBreakdown = summary.gloves.breakdown.filter((b) => b.key !== "unknown");
  renderMetrics("gloveMetrics", [
    { label: "Total Events", value: summary.gloves.total },
    { label: "Small", value: summary.gloves.counts.small },
    { label: "Medium", value: summary.gloves.counts.medium },
    { label: "Large", value: summary.gloves.counts.large },
    { label: "Extra Large", value: summary.gloves.counts.extraLarge },
  ]);

  // Sanitizer: keep Unknown fully visible
  renderMetrics("sanitizerMetrics", [
    { label: "Devices", value: summary.sanitizer.total },
    { label: "Available", value: summary.sanitizer.counts.available },
    { label: "Unavailable", value: summary.sanitizer.counts.unavailable },
    { label: "Unknown", value: summary.sanitizer.counts.unknown },
  ]);

  // Operational
  renderMetrics("operationalMetrics", [
    { label: "Total Devices", value: summary.operational.total },
    { label: "Operational", value: summary.operational.counts.operational },
    { label: "Non-Operational", value: summary.operational.counts.non_operational },
  ]);

  // Legends — connection legend is clickable (sets machines table filter)
  renderLegend("connectionLegend", connDisplayBreakdown, CHART_COLORS.connection, (key) => {
    setConnectionFilter(key);
  });
  renderLegend("gloveLegend", gloveDisplayBreakdown, CHART_COLORS.gloves);
  renderLegend("sanitizerLegend", summary.sanitizer.breakdown, CHART_COLORS.sanitizer);
  renderLegend("operationalLegend", summary.operational.breakdown, CHART_COLORS.operational);

  // Charts — connection chart segments are also clickable
  upsertChart("connectionChart", "connection", connDisplayBreakdown, summary.connection.total, "Devices", (key) => {
    setConnectionFilter(key);
  });
  upsertChart("gloveChart", "gloves", gloveDisplayBreakdown, summary.gloves.total, "Events");
  upsertChart("sanitizerChart", "sanitizer", summary.sanitizer.breakdown, summary.sanitizer.total, "Devices");
  upsertChart("operationalChart", "operational", summary.operational.breakdown, summary.operational.total, "Devices");

  renderMachinesTable(summary);
  renderSanitizerTable(summary.sanitizer);
}

// ---------------------------------------------------------------------------
// Connection filter (machines table)
// ---------------------------------------------------------------------------

function setConnectionFilter(key) {
  if (!["connected", "disconnected"].includes(key)) return;
  state.connectionFilter = key;

  // Update filter chip active state
  document.querySelectorAll(".filter-chip").forEach((btn) => {
    btn.classList.toggle("filter-chip--active", btn.dataset.filter === key);
  });

  // Update connection legend active state (re-render to reflect current active)
  if (state.summary) {
    const connDisplayBreakdown = state.summary.connection.breakdown.filter((b) => b.key !== "unknown");
    renderLegend("connectionLegend", connDisplayBreakdown, CHART_COLORS.connection, (k) => {
      setConnectionFilter(k);
    });
    renderMachinesTable(state.summary);
  }
}

function normalizeDashboardSummary(summary) {
  const source = summary && typeof summary === "object" ? summary : {};
  return {
    viewer: source.viewer && typeof source.viewer === "object" ? source.viewer : {},
    scope: source.scope && typeof source.scope === "object"
      ? source.scope
      : { organizationId: "all", organizationIds: [], organizationLabel: "All organizations" },
    organizations: Array.isArray(source.organizations)
      ? source.organizations.filter((o) => o && typeof o === "object")
      : [],
    connection: normalizeChartSection(source.connection, CONNECTION_BREAKDOWN),
    // All devices — replaces the old offlineDevices (disconnected-only) structure
    devices: normalizeDevices(source.devices),
    operational: normalizeChartSection(source.operational, OPERATIONAL_BREAKDOWN),
    gloves: normalizeChartSection(source.gloves, GLOVE_BREAKDOWN),
    sanitizer: normalizeSanitizerSection(source.sanitizer),
    meta: source.meta && typeof source.meta === "object" ? source.meta : {},
  };
}

function normalizeDevices(section) {
  const source = section && typeof section === "object" ? section : {};
  const items = Array.isArray(source.items) ? source.items.map(normalizeDeviceItem) : [];
  return { total: items.length, items };
}

function normalizeDeviceItem(device) {
  if (!device) {
    return {
      id: "Unknown", organizationId: null, organizationName: null,
      connected: null, connectionStatus: "Unknown", connectionStatusKey: "unknown",
      lastConnectedAt: null, sanitizerStatus: "Unknown", sanitizerStatusKey: "unknown",
      rawStatus: {}, customFields: {},
    };
  }
  return {
    id: device.id ? String(device.id) : "Unknown",
    organizationId: device.organizationId || null,
    organizationName: device.organizationName || null,
    connected: device.connected !== undefined ? device.connected : null,
    connectionStatus: device.connectionStatus ? String(device.connectionStatus) : "Unknown",
    connectionStatusKey: device.connectionStatusKey ? String(device.connectionStatusKey) : "unknown",
    lastConnectedAt: device.lastConnectedAt || null,
    sanitizerStatus: device.sanitizerStatus ? String(device.sanitizerStatus) : "Unknown",
    sanitizerStatusKey: device.sanitizerStatusKey ? String(device.sanitizerStatusKey) : "unknown",
    rawStatus: device.rawStatus && typeof device.rawStatus === "object" ? device.rawStatus : {},
    customFields: device.customFields && typeof device.customFields === "object" ? device.customFields : {},
  };
}

function normalizeChartSection(section, labels) {
  const source = section && typeof section === "object" ? section : {};
  const counts = {};

  labels.forEach(([key]) => {
    counts[key] = toSafeNumber(source.counts && source.counts[key]);
  });

  const derivedTotal = labels.reduce((sum, [key]) => sum + counts[key], 0);
  const total = Number.isFinite(Number(source.total)) ? Number(source.total) : derivedTotal;
  const breakdown = Array.isArray(source.breakdown) && source.breakdown.length
    ? labels.map(([key, label]) => normalizeBreakdownItem(source.breakdown, key, label, counts[key], total))
    : buildBreakdownFromCounts(counts, labels, total);

  return { total, counts, breakdown };
}

function normalizeBreakdownItem(items, key, label, fallbackValue, total) {
  const match = Array.isArray(items) ? items.find((item) => item && item.key === key) || {} : {};
  const value = Number.isFinite(Number(match.value)) ? Number(match.value) : fallbackValue;
  const percentage = Number.isFinite(Number(match.percentage))
    ? Number(match.percentage)
    : total ? Number(((value / total) * 100).toFixed(1)) : 0;
  return { key, label, value, percentage };
}

function buildBreakdownFromCounts(counts, labels, totalValue) {
  const total = Number.isFinite(Number(totalValue))
    ? Number(totalValue)
    : labels.reduce((sum, [key]) => sum + toSafeNumber(counts[key]), 0);
  return labels.map(([key, label]) => {
    const value = toSafeNumber(counts[key]);
    return { key, label, value, percentage: total ? Number(((value / total) * 100).toFixed(1)) : 0 };
  });
}

function normalizeSanitizerSection(section) {
  const normalized = normalizeChartSection(section, SANITIZER_BREAKDOWN);
  const source = section && typeof section === "object" ? section : {};
  normalized.devices = Array.isArray(source.devices)
    ? source.devices.map((device) => ({
        id: device && device.id ? String(device.id) : "Unknown device",
        status: device && device.status ? String(device.status) : "Unknown",
        statusKey: device && device.statusKey ? String(device.statusKey) : "unknown",
        value: device ? device.value : null,
      }))
    : [];
  return normalized;
}

function toSafeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

// ---------------------------------------------------------------------------
// Machines table (filterable by connection status)
// ---------------------------------------------------------------------------

function renderMachinesTable(summary) {
  const filter = state.connectionFilter;
  const allItems = summary.devices ? summary.devices.items : [];
  const filteredItems = allItems.filter((d) => d.connectionStatusKey === filter);

  // Update title and count badge
  const titleMap = { connected: "Connected Machines", disconnected: "Disconnected Machines" };
  document.getElementById("machinesTableTitle").textContent = titleMap[filter] || "Machines";
  document.getElementById("machinesCount").textContent = formatNumber(filteredItems.length);

  const body = document.getElementById("machinesTableBody");
  const empty = document.getElementById("machinesEmpty");
  body.innerHTML = "";

  if (!filteredItems.length) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  filteredItems.forEach((device) => {
    const row = document.createElement("tr");
    row.className = "clickable-row";
    if (device.id === state.selectedDeviceId) {
      row.classList.add("clickable-row--selected");
    }

    row.addEventListener("click", () => {
      if (state.selectedDeviceId === device.id) {
        closeDeviceDetail();
      } else {
        openDeviceDetail(device, summary.viewer);
      }
    });

    row.appendChild(buildTextCell(device.id, "device-id"));
    row.appendChild(buildTextCell(formatNullableDateTime(device.lastConnectedAt)));
    row.appendChild(buildStatusCell(device.connectionStatus));
    body.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Sanitizer table
// ---------------------------------------------------------------------------

function renderSanitizerTable(sanitizer) {
  const body = document.getElementById("sanitizerTableBody");
  const empty = document.getElementById("sanitizerEmpty");
  body.innerHTML = "";

  document.getElementById("sanitizerCount").textContent = formatNumber(sanitizer.total);

  if (!sanitizer.devices || sanitizer.devices.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  sanitizer.devices.forEach((device) => {
    const row = document.createElement("tr");
    const idCell = buildTextCell(device.id, "device-id");
    const statusCell = document.createElement("td");
    const statusBadge = buildStatusBadge(device.status);
    const rawValue = document.createElement("div");
    rawValue.className = "muted-copy";
    rawValue.textContent = `Value: ${formatRawValue(device.value)}`;
    statusCell.appendChild(statusBadge);
    statusCell.appendChild(rawValue);
    row.appendChild(idCell);
    row.appendChild(statusCell);
    body.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Device detail panel
// ---------------------------------------------------------------------------

function openDeviceDetail(device, viewer) {
  state.selectedDeviceId = device.id;

  // Update selected row highlight
  document.querySelectorAll(".clickable-row").forEach((row) => {
    const idCell = row.querySelector(".device-id");
    if (idCell) {
      row.classList.toggle("clickable-row--selected", idCell.textContent === device.id);
    }
  });

  // Populate header
  document.getElementById("detailDeviceId").textContent = device.id;

  // Populate Status tab
  populateStatusTab(device, viewer);

  // Populate Settings tab
  populateSettingsTab(device);

  // Show panel
  const panel = document.getElementById("deviceDetailPanel");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeDeviceDetail() {
  state.selectedDeviceId = null;
  document.getElementById("deviceDetailPanel").classList.add("hidden");
  document.querySelectorAll(".clickable-row--selected").forEach((row) => {
    row.classList.remove("clickable-row--selected");
  });
}

function switchDetailTab(tab) {
  document.querySelectorAll(".detail-tab").forEach((btn) => {
    btn.classList.toggle("detail-tab--active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".detail-content").forEach((content) => {
    content.classList.add("hidden");
  });
  const target = document.getElementById(tab === "status" ? "detailTabStatus" : "detailTabSettings");
  if (target) target.classList.remove("hidden");
}

function populateStatusTab(device, viewer) {
  const rs = device.rawStatus || {};

  // ── Connectivity ────────────────────────────────────────────────────────
  // CONFIRMED: _status._connection._connected
  const connEl = document.getElementById("detailConnStatus");
  connEl.innerHTML = "";
  connEl.appendChild(buildStatusBadge(device.connectionStatus));

  // ATTEMPTED: _status._connection.interface or _status._connection._interface
  // These field names have NOT been verified from a live BIOT REST API response.
  // The socket simulator does not expose this field. May be null for all devices.
  const connObj = (rs._connection && typeof rs._connection === "object") ? rs._connection : {};
  const iface = firstStrVal([connObj.interface, connObj["_interface"], connObj.type, connObj._type]);
  document.getElementById("detailConnInterface").textContent = iface || "—";

  // CONFIRMED: _status._connection._lastConnectedTime
  document.getElementById("detailLastConnected").textContent = formatNullableDateTime(device.lastConnectedAt);

  // ── Levels ──────────────────────────────────────────────────────────────
  // ATTEMPTED: _status.septol (0=empty, 1=partial, 2=full from socket simulator)
  // Field name not confirmed via REST API — based on socket simulator StatusEvent.
  const septol = rs.septol;
  document.getElementById("detailSanitizerLevel").textContent = formatSeptolLevel(septol);

  // ATTEMPTED: _status.trash (0–1 fraction from socket simulator)
  // Field name not confirmed via REST API.
  const trash = rs.trash;
  document.getElementById("detailBinLevel").textContent = formatBinLevel(trash);

  // ATTEMPTED: _status.cartridge (0–6 from socket simulator, total cartridge slots)
  // Field name not confirmed via REST API.
  const cartridge = rs.cartridge;
  document.getElementById("detailCartridgeLevel").textContent = formatCartridgeLevel(cartridge);

  // ATTEMPTED: _status.delivery_available — field name unconfirmed.
  // Fallback: derive from cartridge > 0 + connected.
  const deliveryRaw = rs.delivery_available;
  document.getElementById("detailDelivery").textContent = formatDelivery(deliveryRaw, device.connected, cartridge);

  // ── Organization ────────────────────────────────────────────────────────
  const isManufacturer = viewer && viewer.role === "manufacturer";

  // End User: _ownerOrganization.name — CONFIRMED
  const endUserRow = document.getElementById("detailEndUserRow");
  if (isManufacturer) {
    endUserRow.classList.remove("hidden");
    document.getElementById("detailEndUser").textContent = device.organizationName || device.organizationId || "—";
  } else {
    endUserRow.classList.add("hidden");
  }

  // Distributor: No confirmed BIOT field name for this in the current device data.
  // The reference project shows distributors as a separate generic entity type ("distributor")
  // not embedded in the device object. Showing organization name as a placeholder.
  // This field requires either a parent organization relationship (not confirmed in device data)
  // or an additional BIOT entity query, which is outside the scope of the current implementation.
  const distributorRow = document.getElementById("detailDistributorRow");
  if (isManufacturer) {
    distributorRow.classList.remove("hidden");
    // ATTEMPTED: try common field name patterns in customFields
    const cf = device.customFields || {};
    const dist = firstStrVal([
      cf.distributor,
      cf.distributor_name,
      cf.distributorOrganization,
      cf.distributor_organization,
    ]);
    document.getElementById("detailDistributor").textContent = dist || "—";
  } else {
    distributorRow.classList.add("hidden");
  }
}

function populateSettingsTab(device) {
  const cf = device.customFields || {};
  const rs = device.rawStatus || {};

  // All settings fields below are UNCONFIRMED — they depend on the device template
  // defined in the BIOT system. The field names are attempted based on the socket
  // simulator (SettingsEvent) and common BIOT naming patterns. If the template uses
  // different names, these will show "—".

  // SW Version — ATTEMPTED: common field names for firmware/software version
  const swVersion = firstStrVal([
    cf.sw_version, cf.swVersion, cf.firmware_version, cf.firmwareVersion,
    cf.fw_version, cf.fwVersion, rs.sw_version, rs.fw_version,
  ]);
  document.getElementById("detailSwVersion").textContent = swVersion || "—";

  // Glove default size — ATTEMPTED: socket simulator uses "defaultGloveSize"
  const defaultSize = firstStrVal([
    cf.default_glove_size, cf.defaultGloveSize, cf.glove_default_size, cf.gloveSizeDefault,
  ]);
  document.getElementById("detailDefaultGloveSize").textContent = defaultSize ? defaultSize.toUpperCase() : "—";

  // NFC card required — ATTEMPTED: common BIOT naming patterns
  const nfcRaw = firstDefinedVal([
    cf.nfc_required, cf.nfcRequired, cf.user_identification_required,
    cf.userIdentificationRequired, cf.nfc_mandatory,
  ]);
  document.getElementById("detailNfcRequired").textContent = formatBoolField(nfcRaw);

  // 2nd glove prompt — ATTEMPTED
  const secondGloveRaw = firstDefinedVal([
    cf.prompt_second_glove, cf.promptSecondGlove, cf.prompt_for_second_glove,
    cf.second_glove_prompt, cf.secondGlovePrompt,
  ]);
  document.getElementById("detailSecondGlovePrompt").textContent = formatBoolField(secondGloveRaw);

  // Sanitizer serving volume — ATTEMPTED
  const volume = firstDefinedVal([
    cf.sanitizer_volume, cf.sanitizerVolume, cf.serving_volume, cf.servingVolume,
    cf.septol_volume, cf.septolVolume,
  ]);
  document.getElementById("detailSanitizerVolume").textContent =
    volume !== null && volume !== undefined ? String(volume) : "—";

  // Sanitizer side — ATTEMPTED
  const side = firstStrVal([
    cf.sanitizer_side, cf.sanitizerSide, cf.septol_side, cf.septolSide,
  ]);
  document.getElementById("detailSanitizerSide").textContent = side || "—";

  // Sanitizer mandatory — ATTEMPTED
  const mandatoryRaw = firstDefinedVal([
    cf.sanitizer_mandatory, cf.sanitizerMandatory, cf.septol_mandatory, cf.septolMandatory,
  ]);
  document.getElementById("detailSanitizerMandatory").textContent = formatBoolField(mandatoryRaw);
}

// ---------------------------------------------------------------------------
// Device field formatting helpers
// ---------------------------------------------------------------------------

// septol: 0 = empty, 1 = partial, 2 = full (from socket simulator)
function formatSeptolLevel(value) {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "Empty";
  if (value === 1) return "Partial";
  if (value === 2) return "Full";
  return String(value);
}

// trash: 0–1 fraction (0 = empty, 1 = full) from socket simulator
function formatBinLevel(value) {
  if (value === null || value === undefined) return "—";
  const pct = Math.round(Number(value) * 100);
  if (Number.isNaN(pct)) return String(value);
  return `${pct}%`;
}

// cartridge: 0–6 total loaded cartridge slots (socket simulator)
function formatCartridgeLevel(value) {
  if (value === null || value === undefined) return "—";
  return `${value}/6`;
}

// delivery_available may be boolean OR derived from state
function formatDelivery(rawValue, connected, cartridge) {
  if (rawValue !== null && rawValue !== undefined) {
    if (typeof rawValue === "boolean") return rawValue ? "Available" : "Not Available";
    return String(rawValue);
  }
  // Derivation: available if connected AND has at least one cartridge
  if (connected === true && cartridge !== null && cartridge !== undefined && Number(cartridge) > 0) {
    return "Available";
  }
  if (connected === false) return "Not Available";
  return "—";
}

function formatBoolField(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === 1 || value === "true" || value === "1" || value === "yes") return "Yes";
  if (value === 0 || value === "false" || value === "0" || value === "no") return "No";
  return String(value);
}

// Return first non-null/non-empty string value from an array of candidates
function firstStrVal(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Return first defined (non-undefined, non-null) value from an array
function firstDefinedVal(values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderMetrics(containerId, items) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  items.forEach((item) => {
    const tile = document.createElement("div");
    tile.className = "metric-tile";

    const label = document.createElement("div");
    label.className = "metric-label";
    label.textContent = item.label;

    const value = document.createElement("div");
    value.className = "metric-value";
    value.textContent = formatNumber(item.value);

    tile.appendChild(label);
    tile.appendChild(value);
    container.appendChild(tile);
  });
}

// onItemClick: optional callback(key) — makes the legend rows clickable
function renderLegend(containerId, breakdown, palette, onItemClick = null) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  breakdown.forEach((item) => {
    const row = document.createElement("div");
    row.className = "legend-row";

    if (onItemClick) {
      row.classList.add("legend-row--clickable");
      if (item.key === state.connectionFilter) {
        row.classList.add("legend-row--active");
      }
      row.title = `Click to filter machines by ${item.label}`;
      row.addEventListener("click", () => onItemClick(item.key));
    }

    const left = document.createElement("div");
    left.className = "legend-left";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = palette[item.key] || "#94a3b8";

    const textWrap = document.createElement("div");

    const name = document.createElement("div");
    name.className = "legend-name";
    name.textContent = item.label;

    const meta = document.createElement("div");
    meta.className = "legend-meta";
    meta.textContent = `${formatNumber(item.value)} • ${item.percentage}%`;

    textWrap.appendChild(name);
    textWrap.appendChild(meta);
    left.appendChild(swatch);
    left.appendChild(textWrap);

    const value = document.createElement("div");
    value.className = "legend-name";
    value.textContent = formatNumber(item.value);

    row.appendChild(left);
    row.appendChild(value);
    container.appendChild(row);
  });
}

// onSegmentClick: optional callback(key) — called when a doughnut segment is clicked
function upsertChart(canvasId, paletteKey, breakdown, total, label, onSegmentClick = null) {
  if (!window.Chart) return;

  const canvas = document.getElementById(canvasId);
  const palette = CHART_COLORS[paletteKey];
  const labels = breakdown.map((item) => item.label);
  const values = breakdown.map((item) => item.value);
  const colors = breakdown.map((item) => palette[item.key] || "#94a3b8");

  if (!state.charts[canvasId]) {
    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.parsed || 0;
              const totalValue = context.dataset.data.reduce((sum, item) => sum + item, 0);
              const percentage = totalValue ? ((value / totalValue) * 100).toFixed(1) : "0.0";
              return `${context.label}: ${formatNumber(value)} (${percentage}%)`;
            },
          },
        },
        centerText: { value: formatNumber(total), label },
      },
    };

    if (onSegmentClick) {
      chartOptions.onClick = (_event, activeElements) => {
        if (activeElements && activeElements.length > 0) {
          const idx = activeElements[0].index;
          const item = breakdown[idx];
          if (item) onSegmentClick(item.key);
        }
      };
    }

    state.charts[canvasId] = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: "#ffffff",
          borderWidth: 4,
          hoverOffset: 6,
        }],
      },
      options: chartOptions,
    });
    return;
  }

  const chart = state.charts[canvasId];
  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  chart.data.datasets[0].backgroundColor = colors;
  chart.options.plugins.centerText.value = formatNumber(total);
  chart.options.plugins.centerText.label = label;
  chart.update();
}

function buildTextCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.classList.add(className);
  return cell;
}

function buildStatusCell(label) {
  const cell = document.createElement("td");
  cell.appendChild(buildStatusBadge(label));
  return cell;
}

function buildStatusBadge(label) {
  const badge = document.createElement("span");
  badge.className = `status-badge ${statusClassName(label)}`;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  const text = document.createElement("span");
  text.textContent = label;
  badge.appendChild(dot);
  badge.appendChild(text);
  return badge;
}

function statusClassName(label) {
  const normalized = String(label || "").toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "connected") return "status-connected";
  if (normalized === "disconnected") return "status-disconnected";
  if (normalized === "available") return "status-available";
  if (normalized === "unavailable") return "status-unavailable";
  if (normalized === "operational") return "status-operational";
  return "status-unknown";
}

function destroyCharts() {
  Object.values(state.charts).forEach((chart) => chart.destroy());
  state.charts = {};
}

// ---------------------------------------------------------------------------
// HTTP: dashboard request (GET with x-biot-token + 401 refresh retry)
// ---------------------------------------------------------------------------

async function appsScriptRequest(params) {
  if (!auth.isAuthenticated()) {
    handleAuthFailure();
    throw new Error("Not authenticated. Please log in.");
  }

  const edgeUrl = getEdgeUrl();
  if (!edgeUrl) throw new Error("Dashboard service is not configured.");

  let accessToken = auth.getToken();

  for (let attempt = 0; attempt < 2; attempt++) {
    const query = new URLSearchParams({ _: String(Date.now()) });
    appendQueryParams(query, params);

    const headers = {
      "Content-Type": "application/json",
      "x-biot-token": accessToken,
    };
    const anonKey = getAnonKey();
    if (anonKey) {
      headers["apikey"] = anonKey;
      headers["Authorization"] = `Bearer ${anonKey}`;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${edgeUrl}?${query.toString()}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      window.clearTimeout(timeoutId);
      if (error.name === "AbortError") throw buildTransportError(GENERIC_REQUEST_ERROR, "fetch");
      throw error;
    }
    window.clearTimeout(timeoutId);

    // On first 401, attempt a token refresh and retry
    if (response.status === 401 && attempt === 0) {
      const newToken = await performTokenRefresh();
      if (!newToken) {
        handleAuthFailure();
        throw new Error("Your session has expired. Please log in again.");
      }
      accessToken = newToken;
      continue;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw buildResponseError("Received an invalid response from the server.", "fetch");
    }

    if (response.status === 401) {
      handleAuthFailure();
      throw new Error("Your session has expired. Please log in again.");
    }

    if (!payload || payload.ok === false) {
      throw buildResponseError(resolveErrorMessage(payload), "fetch");
    }

    return payload.data;
  }

  throw new Error(GENERIC_REQUEST_ERROR);
}

// ---------------------------------------------------------------------------
// HTTP: login and token refresh (POST)
// ---------------------------------------------------------------------------

async function loginRequest(username, password) {
  const edgeUrl = getEdgeUrl();
  if (!edgeUrl) throw new Error("Dashboard service is not configured.");

  const headers = { "Content-Type": "application/json" };
  const anonKey = getAnonKey();
  if (anonKey) {
    headers["apikey"] = anonKey;
    headers["Authorization"] = `Bearer ${anonKey}`;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(edgeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "login", username, password }),
      signal: controller.signal,
    });

    const payload = await response.json();

    if (!payload || payload.ok === false) {
      throw new Error(resolveErrorMessage(payload) || "Login failed. Please check your credentials.");
    }

    return payload.data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Login request timed out. Please try again.");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function refreshTokenRequest(refreshToken) {
  const edgeUrl = getEdgeUrl();
  if (!edgeUrl) throw new Error("Dashboard service is not configured.");

  const headers = { "Content-Type": "application/json" };
  const anonKey = getAnonKey();
  if (anonKey) {
    headers["apikey"] = anonKey;
    headers["Authorization"] = `Bearer ${anonKey}`;
  }

  const response = await fetch(edgeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "refresh", refreshToken }),
  });

  const payload = await response.json();

  if (!payload || payload.ok === false) {
    throw new Error(resolveErrorMessage(payload) || "Token refresh failed.");
  }

  return payload.data;
}

async function performTokenRefresh() {
  const refreshToken = auth.getRefreshToken();
  if (!refreshToken) return null;

  try {
    const data = await refreshTokenRequest(refreshToken);
    auth.setTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

function appendQueryParams(query, params) {
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  });
}

function buildTransportError(message, transport) {
  const error = new Error(message);
  error.transport = transport;
  error.transportFailure = true;
  return error;
}

function buildResponseError(message, transport) {
  const error = new Error(message || "Unable to load dashboard data right now.");
  error.transport = transport;
  error.transportFailure = false;
  return error;
}

function resolveErrorMessage(payload) {
  if (!payload) return "Unable to load dashboard data right now.";
  if (payload.error && typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return "Unable to load dashboard data right now.";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getEdgeUrl() {
  return window.DASHBOARD_CONFIG && typeof window.DASHBOARD_CONFIG.supabaseEdgeUrl === "string"
    ? window.DASHBOARD_CONFIG.supabaseEdgeUrl.trim() : "";
}

function getAnonKey() {
  return window.DASHBOARD_CONFIG && typeof window.DASHBOARD_CONFIG.supabaseAnonKey === "string"
    ? window.DASHBOARD_CONFIG.supabaseAnonKey.trim() : "";
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

function setDashboardLoading(isLoading) {
  const loading = document.getElementById("dashboardLoading");
  const refreshButton = document.getElementById("refreshBtn");
  loading.classList.toggle("hidden", !isLoading);
  refreshButton.disabled = isLoading;
  refreshButton.textContent = isLoading ? "Refreshing..." : "Refresh";
}

function showDashboardError(message) {
  const element = document.getElementById("dashboardError");
  element.textContent = message;
  element.classList.remove("hidden");
}

function hideDashboardError() {
  const element = document.getElementById("dashboardError");
  element.textContent = "";
  element.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------

function toDisplayDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(2);
  return `${day}/${month}/${year}`;
}

function parseDisplayDate(ddmmyy) {
  const parts = ddmmyy.trim().split("/");
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = 2000 + parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function setDefaultDates() {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 13);

  document.getElementById("fromDate").value = toDisplayDate(fromDate);
  document.getElementById("toDate").value = toDisplayDate(toDate);
}

function buildDateRangePayload() {
  const fromDisplay = document.getElementById("fromDate").value.trim();
  const toDisplay = document.getElementById("toDate").value.trim();
  const fromTime = document.getElementById("fromTime").value || "00:00";
  const toTime = document.getElementById("toTime").value || "23:59";

  if (!fromDisplay || !toDisplay) {
    return { ok: false, error: "Select both a start date and an end date." };
  }

  const from = parseDisplayDate(fromDisplay);
  const to = parseDisplayDate(toDisplay);

  if (!from) {
    return { ok: false, error: `Invalid start date. Use dd/mm/yy format (e.g. ${toDisplayDate(new Date())}).` };
  }
  if (!to) {
    return { ok: false, error: `Invalid end date. Use dd/mm/yy format (e.g. ${toDisplayDate(new Date())}).` };
  }
  if (from > to) {
    return { ok: false, error: "The start date must be on or before the end date." };
  }

  // Time filtering note:
  // new Date("YYYY-MM-DDTHH:MM:ss") interprets as LOCAL time and converts to UTC
  // via .toISOString(). This is the intended behavior — users enter their local
  // clock time, and we convert to UTC for BIOT's _creationTime filter.
  // Time filtering ONLY applies to glove consumption events (device_event endpoint).
  // Device connection status and sanitizer status are current-state, not time-filtered.
  const fromIso = new Date(`${from}T${fromTime}:00`).toISOString();
  const toIso = new Date(`${to}T${toTime}:59.999`).toISOString();

  return {
    ok: true,
    from,
    to,
    fromIso,
    toIso,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function formatDateTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatNullableDateTime(value) {
  return value ? formatDateTime(value) : "Unknown";
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatRawValue(value) {
  if (value === null || value === undefined || value === "") return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
