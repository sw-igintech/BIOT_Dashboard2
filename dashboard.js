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
  // selectedDeviceId: tracks the currently opened device detail modal.
  selectedDeviceId: null,
  // machineSearch: live partial-match search term for machine IDs.
  machineSearch: "",
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
  // Use afterTooltipDraw (not afterDraw) so the center text is painted AFTER
  // the tooltip box. In Chart.js 4 the tooltip renders after afterDraw, which
  // means an afterDraw-based plugin gets covered by the tooltip when they
  // overlap. afterTooltipDraw fires after the tooltip is painted, keeping the
  // center value visible even when a wide tooltip box extends inward.
  afterTooltipDraw(chart, args, pluginOptions) {
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

  // Machine search — live filter as user types
  document.getElementById("machineSearch").addEventListener("input", (e) => {
    state.machineSearch = e.target.value.trim().toLowerCase();
    if (state.summary) renderMachinesTable(state.summary);
  });

  // Modal: close on backdrop click (click outside the panel card)
  document.getElementById("deviceDetailModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("deviceDetailModal")) closeDeviceDetail();
  });

  // Modal: close on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("deviceDetailModal").classList.contains("hidden")) {
      closeDeviceDetail();
    }
  });

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
    { label: "Medium", value: summary.gloves.counts.medium, cls: "metric-tile--sm" },
    { label: "Large", value: summary.gloves.counts.large, cls: "metric-tile--sm" },
    { label: "Extra Large", value: summary.gloves.counts.extraLarge, cls: "metric-tile--sm" },
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
  renderGloveHighlight(summary.gloves.counts);
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
}

// ---------------------------------------------------------------------------
// Glove highlight — HIGH DEMAND badge + PRO TIP
// ---------------------------------------------------------------------------

// Ordered list of glove size keys. Used to determine display order and
// tie-breaking: when two sizes share the same count, the one that appears
// first in this list (i.e. the smaller size) is chosen.
const GLOVE_SIZE_KEYS = ["small", "medium", "large", "extraLarge"];
const GLOVE_SIZE_LABELS = { small: "Small", medium: "Medium", large: "Large", extraLarge: "Extra Large" };

function renderGloveHighlight(counts) {
  // Find top glove size by highest count; tie → first in GLOVE_SIZE_KEYS order
  let topKey = null;
  let topValue = -1;
  GLOVE_SIZE_KEYS.forEach((key) => {
    const val = typeof counts[key] === "number" ? counts[key] : 0;
    if (val > topValue) {
      topValue = val;
      topKey = key;
    }
  });

  // Apply HIGH DEMAND badge to the matching legend row
  const legend = document.getElementById("gloveLegend");
  if (legend) {
    legend.querySelectorAll("[data-legend-key]").forEach((row) => {
      row.querySelectorAll(".high-demand-badge").forEach((b) => b.remove());
      if (topKey !== null && topValue > 0 && row.dataset.legendKey === topKey) {
        const badge = document.createElement("span");
        badge.className = "high-demand-badge";
        badge.textContent = "HIGH DEMAND";
        row.appendChild(badge);
      }
    });
  }

  // Update PRO TIP row
  const tipEl = document.getElementById("gloveTip");
  if (tipEl) {
    if (topKey !== null && topValue > 0) {
      const label = GLOVE_SIZE_LABELS[topKey] || topKey;
      tipEl.textContent =
        `Pro tip: Based on consumption trends, we recommend increasing stock of ${label} gloves.`;
      tipEl.classList.remove("hidden");
    } else {
      tipEl.classList.add("hidden");
    }
  }
}

// ---------------------------------------------------------------------------
// Connection filter (machines table)
// ---------------------------------------------------------------------------

function setConnectionFilter(key) {
  if (!["all", "connected", "disconnected"].includes(key)) return;
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

    // Scroll down to the machines table so the user sees the filtered results
    const tableSection = document.getElementById("machinesTableSection");
    if (tableSection) tableSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
    deliveryAvailable: typeof device.deliveryAvailable === "boolean" ? device.deliveryAvailable : null,
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
  const searchTerm = state.machineSearch;
  const allItems = summary.devices ? summary.devices.items : [];
  const filteredItems = allItems.filter((d) => {
    if (filter !== "all" && d.connectionStatusKey !== filter) return false;
    if (searchTerm && !d.id.toLowerCase().includes(searchTerm)) return false;
    return true;
  });

  // Update title and count badge
  const titleMap = { all: "All Machines", connected: "Connected Machines", disconnected: "Disconnected Machines" };
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

  // Populate Status tab (synchronous — data already in rawStatus)
  populateStatusTab(device, viewer);

  // Populate Settings tab (async — fetches separate settings entity from Edge Function)
  populateSettingsTab(device).catch(() => { /* error shown inside populateSettingsTab */ });

  // Show modal
  document.getElementById("deviceDetailModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeDeviceDetail() {
  state.selectedDeviceId = null;
  document.getElementById("deviceDetailModal").classList.add("hidden");
  document.body.classList.remove("modal-open");
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

  // CONFIRMED: _status.connectivity_interface (at _status root, NOT nested in _connection)
  // Live value example: "wifi"
  const iface = rs.connectivity_interface;
  document.getElementById("detailConnInterface").textContent =
    typeof iface === "string" && iface ? iface : "—";

  // CONFIRMED: _status._connection._lastConnectedTime
  document.getElementById("detailLastConnected").textContent = formatNullableDateTime(device.lastConnectedAt);

  // ── Device Status ────────────────────────────────────────────────────────
  // CONFIRMED: _status.delivery_available1 (boolean) — drives the Operational widget
  document.getElementById("detailDelivery").textContent =
    device.deliveryAvailable === true ? "Yes" :
    device.deliveryAvailable === false ? "No" : "—";

  // CONFIRMED: _status.septol_availability1 (boolean) — sanitizer (septol) available
  const septolAvail = rs.septol_availability1;
  document.getElementById("detailSanitizerAvail").textContent =
    septolAvail === true ? "Available" : septolAvail === false ? "Not Available" : "—";

  // CONFIRMED: _status.bin_level1 (integer — current bin fill count, not a 0-1 fraction)
  const binLevel = rs.bin_level1;
  document.getElementById("detailBinLevel").textContent =
    (binLevel !== null && binLevel !== undefined) ? String(binLevel) : "—";

  // ── Gloves In Stock ──────────────────────────────────────────────────────
  // CONFIRMED: _status.total_small_gloves, total_medium_gloves, total_large_gloves,
  //            total_extra_large_gloves (integers — current stock counts)
  const gloveFields = {
    detailGlovesSmall: rs.total_small_gloves,
    detailGlovesMedium: rs.total_medium_gloves,
    detailGlovesLarge: rs.total_large_gloves,
    detailGlovesXL: rs.total_extra_large_gloves,
  };
  for (const [elId, val] of Object.entries(gloveFields)) {
    document.getElementById(elId).textContent =
      (val !== null && val !== undefined) ? String(val) : "—";
  }

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

  // Distributor: not embedded in device data — separate generic entity type in BIOT.
  // Showing hidden for now; would require an additional entity query not yet implemented.
  const distributorRow = document.getElementById("detailDistributorRow");
  distributorRow.classList.add("hidden");
}

async function populateSettingsTab(device) {
  const loadingEl = document.getElementById("settingsLoadingMsg");
  const errorEl = document.getElementById("settingsErrorMsg");

  // Reset display state
  if (loadingEl) loadingEl.classList.remove("hidden");
  if (errorEl) errorEl.classList.add("hidden");
  _clearSettingsFields();

  // Settings live in a separate BIOT generic entity, not in the device object.
  // The device exposes current_settings2.id as the entity reference.
  const settingsRef = device.customFields && device.customFields.current_settings2;
  const settingsId = settingsRef && typeof settingsRef === "object" ? settingsRef.id : null;

  if (!settingsId) {
    if (loadingEl) loadingEl.classList.add("hidden");
    return;
  }

  let settings;
  try {
    settings = await appsScriptRequest({ action: "entity", id: settingsId });
  } catch {
    if (loadingEl) loadingEl.classList.add("hidden");
    if (errorEl) errorEl.classList.remove("hidden");
    return;
  }

  // Guard: user may have closed the panel or opened a different device while we were fetching
  if (state.selectedDeviceId !== device.id) return;

  if (loadingEl) loadingEl.classList.add("hidden");

  if (!settings) return;

  // Apply confirmed BIOT settings entity field names (all lowercase, confirmed 2026-04-28)

  // software_version is a nested object; the version string is at software_version.name
  const swVersionObj = settings.software_version;
  document.getElementById("detailSwVersion").textContent =
    (swVersionObj && typeof swVersionObj === "object" && swVersionObj.name)
      ? String(swVersionObj.name) : "—";

  // glovedefaultsize: string ("small", "medium", "large", "extra_large")
  document.getElementById("detailDefaultGloveSize").textContent =
    firstStrVal([settings.glovedefaultsize]) || "—";

  // useridentificationrequired: boolean
  document.getElementById("detailNfcRequired").textContent =
    formatBoolField(settings.useridentificationrequired !== undefined ? settings.useridentificationrequired : null);

  // promptforactivationtosecondglove: boolean
  document.getElementById("detailSecondGlovePrompt").textContent =
    formatBoolField(settings.promptforactivationtosecondglove !== undefined ? settings.promptforactivationtosecondglove : null);

  // septolservingvolume: number
  const volume = settings.septolservingvolume;
  document.getElementById("detailSanitizerVolume").textContent =
    (volume !== null && volume !== undefined) ? String(volume) : "—";

  // septolcurrentside: string ("left" / "right")
  document.getElementById("detailSanitizerSide").textContent =
    firstStrVal([settings.septolcurrentside]) || "—";

  // septolmandatoryuse: boolean
  document.getElementById("detailSanitizerMandatory").textContent =
    formatBoolField(settings.septolmandatoryuse !== undefined ? settings.septolmandatoryuse : null);
}

function _clearSettingsFields() {
  const ids = [
    "detailSwVersion", "detailDefaultGloveSize", "detailNfcRequired",
    "detailSecondGlovePrompt", "detailSanitizerVolume", "detailSanitizerSide",
    "detailSanitizerMandatory",
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "—";
  });
}

// ---------------------------------------------------------------------------
// Device field formatting helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderMetrics(containerId, items) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  items.forEach((item) => {
    const tile = document.createElement("div");
    tile.className = item.cls ? `metric-tile ${item.cls}` : "metric-tile";

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
    row.dataset.legendKey = item.key;

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
