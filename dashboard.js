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

const GENERIC_REQUEST_ERROR = "Unable to load dashboard data right now. Please try again.";
const REQUEST_TIMEOUT_MS = 90000;

const state = {
  charts: {},
  requestId: 0,
  summary: null,
};

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

document.addEventListener("DOMContentLoaded", () => {
  setDefaultDates();
  wireUi();
  refreshDashboard();
});

function wireUi() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshDashboard());
  document.getElementById("organizationSelect").addEventListener("change", () => refreshDashboard());
}

async function refreshDashboard() {
  const appsScriptUrl = getAppsScriptUrl();
  if (!appsScriptUrl) {
    destroyCharts();
    showDashboardError("Dashboard service is not configured.");
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
    if (requestId !== state.requestId) {
      return;
    }

    state.summary = summary;
    renderOrganizationSelector(summary);
    renderSummary(summary);
  } catch (error) {
    if (requestId !== state.requestId) {
      return;
    }

    destroyCharts();
    showDashboardError(error && error.message ? error.message : GENERIC_REQUEST_ERROR);
  } finally {
    if (requestId === state.requestId) {
      setDashboardLoading(false);
    }
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
  renderMetrics("connectionMetrics", [
    { label: "Total Devices", value: summary.connection.total },
    { label: "Connected", value: summary.connection.counts.connected },
    { label: "Disconnected", value: summary.connection.counts.disconnected },
    { label: "Unknown", value: summary.connection.counts.unknown },
  ]);

  renderMetrics("gloveMetrics", [
    { label: "Total Events", value: summary.gloves.total },
    { label: "Small", value: summary.gloves.counts.small },
    { label: "Medium", value: summary.gloves.counts.medium },
    { label: "Large", value: summary.gloves.counts.large },
    { label: "Extra Large", value: summary.gloves.counts.extraLarge },
    { label: "Unknown", value: summary.gloves.counts.unknown },
  ]);

  renderMetrics("sanitizerMetrics", [
    { label: "Devices", value: summary.sanitizer.total },
    { label: "Available", value: summary.sanitizer.counts.available },
    { label: "Unavailable", value: summary.sanitizer.counts.unavailable },
    { label: "Unknown", value: summary.sanitizer.counts.unknown },
  ]);

  renderLegend("connectionLegend", summary.connection.breakdown, CHART_COLORS.connection);
  renderLegend("gloveLegend", summary.gloves.breakdown, CHART_COLORS.gloves);
  renderLegend("sanitizerLegend", summary.sanitizer.breakdown, CHART_COLORS.sanitizer);

  upsertChart("connectionChart", "connection", summary.connection.breakdown, summary.connection.total, "Devices");
  upsertChart("gloveChart", "gloves", summary.gloves.breakdown, summary.gloves.total, "Events");
  upsertChart("sanitizerChart", "sanitizer", summary.sanitizer.breakdown, summary.sanitizer.total, "Devices");

  renderOfflineTable(summary.offlineDevices);
  renderSanitizerTable(summary.sanitizer);
}

function normalizeDashboardSummary(summary) {
  const source = summary && typeof summary === "object" ? summary : {};
  return {
    viewer: source.viewer && typeof source.viewer === "object" ? source.viewer : {},
    scope: source.scope && typeof source.scope === "object"
      ? source.scope
      : { organizationId: "all", organizationIds: [], organizationLabel: "All organizations" },
    organizations: Array.isArray(source.organizations)
      ? source.organizations.filter((organization) => organization && typeof organization === "object")
      : [],
    connection: normalizeChartSection(source.connection, CONNECTION_BREAKDOWN),
    offlineDevices: normalizeOfflineDevices(source.offlineDevices),
    gloves: normalizeChartSection(source.gloves, GLOVE_BREAKDOWN),
    sanitizer: normalizeSanitizerSection(source.sanitizer),
    meta: source.meta && typeof source.meta === "object" ? source.meta : {},
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

  return {
    total,
    counts,
    breakdown,
  };
}

function normalizeBreakdownItem(items, key, label, fallbackValue, total) {
  const match = Array.isArray(items)
    ? items.find((item) => item && item.key === key) || {}
    : {};
  const value = Number.isFinite(Number(match.value)) ? Number(match.value) : fallbackValue;
  const percentage = Number.isFinite(Number(match.percentage))
    ? Number(match.percentage)
    : total ? Number(((value / total) * 100).toFixed(1)) : 0;

  return {
    key,
    label,
    value,
    percentage,
  };
}

function buildBreakdownFromCounts(counts, labels, totalValue) {
  const total = Number.isFinite(Number(totalValue))
    ? Number(totalValue)
    : labels.reduce((sum, [key]) => sum + toSafeNumber(counts[key]), 0);

  return labels.map(([key, label]) => {
    const value = toSafeNumber(counts[key]);
    return {
      key,
      label,
      value,
      percentage: total ? Number(((value / total) * 100).toFixed(1)) : 0,
    };
  });
}

function normalizeOfflineDevices(section) {
  const source = section && typeof section === "object" ? section : {};
  const items = Array.isArray(source.items)
    ? source.items.map((device) => ({
        id: device && device.id ? String(device.id) : "Unknown device",
        lastConnectedAt: device && device.lastConnectedAt ? device.lastConnectedAt : null,
        connected: device ? device.connected : null,
        connectionStatus: device && device.connectionStatus ? String(device.connectionStatus) : "Unknown",
      }))
    : [];

  return {
    total: Number.isFinite(Number(source.total)) ? Number(source.total) : items.length,
    items,
  };
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

function renderLegend(containerId, breakdown, palette) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  breakdown.forEach((item) => {
    const row = document.createElement("div");
    row.className = "legend-row";

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

function upsertChart(canvasId, paletteKey, breakdown, total, label) {
  if (!window.Chart) {
    return;
  }

  const canvas = document.getElementById(canvasId);
  const palette = CHART_COLORS[paletteKey];
  const labels = breakdown.map((item) => item.label);
  const values = breakdown.map((item) => item.value);
  const colors = breakdown.map((item) => palette[item.key] || "#94a3b8");

  if (!state.charts[canvasId]) {
    state.charts[canvasId] = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors,
            borderColor: "#ffffff",
            borderWidth: 4,
            hoverOffset: 6,
          },
        ],
      },
      options: {
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
          centerText: {
            value: formatNumber(total),
            label,
          },
        },
      },
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

function renderOfflineTable(offlineDevices) {
  const body = document.getElementById("offlineTableBody");
  const empty = document.getElementById("offlineEmpty");
  body.innerHTML = "";

  document.getElementById("offlineCount").textContent = formatNumber(offlineDevices.total);

  if (!offlineDevices.items || offlineDevices.items.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  offlineDevices.items.forEach((device) => {
    const row = document.createElement("tr");
    row.appendChild(buildTextCell(device.id, "device-id"));
    row.appendChild(buildTextCell(formatNullableDateTime(device.lastConnectedAt)));
    row.appendChild(buildStatusCell(device.connectionStatus));
    body.appendChild(row);
  });
}

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

function buildTextCell(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) {
    cell.classList.add(className);
  }
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
  const normalized = String(label || "").toLowerCase();
  if (normalized === "connected") {
    return "status-connected";
  }
  if (normalized === "disconnected") {
    return "status-disconnected";
  }
  if (normalized === "available") {
    return "status-available";
  }
  if (normalized === "unavailable") {
    return "status-unavailable";
  }
  return "status-unknown";
}

function destroyCharts() {
  Object.values(state.charts).forEach((chart) => chart.destroy());
  state.charts = {};
}

async function appsScriptRequest(params) {
  return appsScriptJsonpRequest(params);
}

function appsScriptJsonpRequest(params) {
  const appsScriptUrl = getAppsScriptUrl();
  if (!appsScriptUrl) {
    return Promise.reject(new Error("Dashboard service is not configured."));
  }

  const callbackName = `__biotDashboardCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      finishWithError(buildTransportError(GENERIC_REQUEST_ERROR, "jsonp"));
    }, REQUEST_TIMEOUT_MS);

    const query = new URLSearchParams({ callback: callbackName, _: String(Date.now()) });
    appendQueryParams(query, params);

    window[callbackName] = (payload) => {
      if (!payload || payload.ok === false) {
        finishWithError(buildResponseError(resolveErrorMessage(payload), "jsonp"));
        return;
      }
      finishWithSuccess(payload.data);
    };

    script.async = true;
    script.onload = () => {
      window.setTimeout(() => {
        if (!settled) {
          finishWithError(buildTransportError(GENERIC_REQUEST_ERROR, "jsonp"));
        }
      }, 1000);
    };
    script.onerror = () => {
      finishWithError(buildTransportError(GENERIC_REQUEST_ERROR, "jsonp"));
    };
    script.src = `${appsScriptUrl}${appsScriptUrl.includes("?") ? "&" : "?"}${query.toString()}`;
    document.body.appendChild(script);

    function finishWithSuccess(data) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(data);
    }

    function finishWithError(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }
  });
}

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
  if (!payload) {
    return "Unable to load dashboard data right now.";
  }
  if (payload.error && typeof payload.error === "string") {
    return payload.error;
  }
  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return "Unable to load dashboard data right now.";
}

function setDefaultDates() {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 13);

  document.getElementById("fromDate").value = formatDateInput(fromDate);
  document.getElementById("toDate").value = formatDateInput(toDate);
}

function buildDateRangePayload() {
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;

  if (!from || !to) {
    return { ok: false, error: "Select both a start date and an end date." };
  }
  if (from > to) {
    return { ok: false, error: "The start date must be on or before the end date." };
  }

  const fromIso = new Date(`${from}T00:00:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59.999`).toISOString();

  return {
    ok: true,
    from,
    to,
    fromIso,
    toIso,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function getAppsScriptUrl() {
  const value = window.DASHBOARD_CONFIG && typeof window.DASHBOARD_CONFIG.appsScriptUrl === "string"
    ? window.DASHBOARD_CONFIG.appsScriptUrl.trim()
    : "";
  return value;
}

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

function formatDateInput(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

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
  if (value === null || value === undefined || value === "") {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}
