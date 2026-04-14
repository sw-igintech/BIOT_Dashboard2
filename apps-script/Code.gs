// =============================================================================
// ARCHIVED — no longer the active backend path.
// The dashboard now uses Supabase Edge Functions (supabase/functions/biot-dashboard).
// This file is kept for reference only.
// =============================================================================

const DEFAULT_CONFIG = {
  BIOT_BASE_URL: 'https://api.dev.igin.biot-med.com',
};

const CONNECTION_BREAKDOWN = [
  ['connected', 'Connected'],
  ['disconnected', 'Disconnected'],
  ['unknown', 'Unknown'],
];

const SANITIZER_BREAKDOWN = [
  ['available', 'Available'],
  ['unavailable', 'Unavailable'],
  ['unknown', 'Unknown'],
];

const GLOVE_BREAKDOWN = [
  ['small', 'Small'],
  ['medium', 'Medium'],
  ['large', 'Large'],
  ['extraLarge', 'Extra Large'],
  ['unknown', 'Unknown'],
];

function doGet(e) {
  return handleWebRequest_(e, false);
}

function doPost(e) {
  return handleWebRequest_(e, true);
}

function handleWebRequest_(e, isPost) {
  var params = collectParams_(e, isPost);
  var callback = params.callback;
  var transport = params.transport;

  try {
    var action = params.action || 'dashboard';
    var data;

    if (action === 'dashboard') {
      data = buildDashboardResponse_(params);
    } else if (action === 'health') {
      data = buildHealthResponse_();
    } else {
      throw new Error('Unknown action: ' + action);
    }

    return createWebResponse_({ ok: true, data: data }, callback, transport, params);
  } catch (error) {
    return createWebResponse_(
      {
        ok: false,
        error: {
          message: error && error.message ? error.message : 'Unexpected Apps Script error.',
        },
      },
      callback,
      transport,
      params
    );
  }
}

function collectParams_(e, isPost) {
  var params = {};

  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (key) {
      params[key] = e.parameter[key];
    });
  }

  if (isPost && e && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      if (body && typeof body === 'object') {
        Object.keys(body).forEach(function (key) {
          params[key] = body[key];
        });
      }
    } catch (error) {
      throw new Error('Invalid JSON body.');
    }
  }

  return params;
}

function createWebResponse_(payload, callback, transport, params) {
  if (transport === 'postmessage') {
    return createPostMessageResponse_(payload, params || {});
  }

  var text;

  if (callback) {
    if (!/^[A-Za-z_$][0-9A-Za-z_$]{0,127}$/.test(callback)) {
      throw new Error('Invalid JSONP callback name.');
    }
    text = callback + '(' + JSON.stringify(payload) + ');';
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  text = JSON.stringify(payload);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function createPostMessageResponse_(payload, params) {
  var requestId = typeof params.requestId === 'string' ? params.requestId : '';
  var targetOrigin = sanitizeTargetOrigin_(params.origin);
  var envelope = {
    source: 'biot-dashboard-apps-script',
    requestId: requestId,
    payload: payload,
  };
  var serializedEnvelope = serializeForHtmlScript_(envelope);
  var serializedTargetOrigin = JSON.stringify(targetOrigin);
  var html =
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' +
    '(function(){' +
    'var message=' + serializedEnvelope + ';' +
    'var targetOrigin=' + serializedTargetOrigin + ';' +
    'if(window.parent&&window.parent!==window){window.parent.postMessage(message,targetOrigin);}' +
    'window.close&&window.close();' +
    '})();' +
    '</script></body></html>';

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function sanitizeTargetOrigin_(value) {
  if (typeof value !== 'string') {
    return '*';
  }

  var trimmed = value.trim();
  if (!trimmed) {
    return '*';
  }

  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(trimmed) || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(trimmed) || /^http:\/\/localhost(?::\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  return '*';
}

function serializeForHtmlScript_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildHealthResponse_() {
  var config = getConfig_();
  return {
    ok: true,
    backend: 'Google Apps Script',
    biotBaseUrl: config.BIOT_BASE_URL,
    genericEntityBaseUrl: config.GENERIC_ENTITY_BASE_URL,
  };
}

function buildDashboardResponse_(params) {
  var config = getConfig_();
  var loginPayload = loginToBiot_(config);
  var accessToken = nestedGet_(loginPayload, ['accessJwt', 'token']);
  if (!accessToken) {
    throw new Error('BIOT login succeeded but did not return accessJwt.token.');
  }

  var selfPayload = getCurrentUser_(config, accessToken);
  var viewer = buildViewerIdentity_(loginPayload, selfPayload);
  var dateRange = resolveDateRange_(params);
  var rawDevices = getDevices_(config, accessToken);
  var organizations = viewer.role === 'manufacturer'
    ? getOrganizationsForManufacturer_(viewer, selfPayload, rawDevices)
    : deriveOrganizations_(viewer, selfPayload, rawDevices);
  var scope = resolveScope_(viewer, organizations, params.organizationId);
  var scopedDevices = rawDevices
    .filter(function (device) {
      return deviceMatchesScope_(device, scope.organizationIds, viewer);
    })
    .map(normalizeDevice_);
  var widgetErrors = {};
  var gloves = safeWidget_(
    function () {
      return getGloveSummary_(config, accessToken, scope.organizationIds, dateRange);
    },
    emptyGloveSummary_(),
    function (message) {
      widgetErrors.gloves = message;
    }
  );

  return {
    viewer: viewer,
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
    organizations: organizations,
    connection: getConnectionSummary_(scopedDevices),
    offlineDevices: getOfflineDevices_(scopedDevices),
    gloves: gloves,
    sanitizer: getSanitizerSummary_(scopedDevices),
    meta: {
      generatedAt: new Date().toISOString(),
      backend: 'Google Apps Script',
      biotBaseUrl: config.BIOT_BASE_URL,
      genericEntityBaseUrl: config.GENERIC_ENTITY_BASE_URL,
      partialFailures: widgetErrors,
    },
  };
}

function getConfig_() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  var config = {
    BIOT_BASE_URL: properties.BIOT_BASE_URL || DEFAULT_CONFIG.BIOT_BASE_URL,
    GENERIC_ENTITY_BASE_URL: properties.GENERIC_ENTITY_BASE_URL || properties.BIOT_GENERIC_ENTITY_BASE_URL || properties.BIOT_BASE_URL || DEFAULT_CONFIG.BIOT_BASE_URL,
    BIOT_USERNAME: properties.BIOT_USERNAME || '',
    BIOT_PASSWORD: properties.BIOT_PASSWORD || '',
  };

  if (!config.BIOT_BASE_URL) {
    throw new Error('BIOT_BASE_URL is missing in Script Properties.');
  }
  if (!config.BIOT_USERNAME) {
    throw new Error('BIOT_USERNAME is missing in Script Properties.');
  }
  if (!config.BIOT_PASSWORD) {
    throw new Error('BIOT_PASSWORD is missing in Script Properties.');
  }

  return config;
}

function loginToBiot_(config) {
  return fetchBiot_(
    config,
    'POST',
    '/ums/v2/users/login',
    {
      body: {
        username: config.BIOT_USERNAME,
        password: config.BIOT_PASSWORD,
      },
      expectedStatuses: [200, 201],
    }
  );
}

function getCurrentUser_(config, accessToken) {
  return fetchBiot_(config, 'GET', '/ums/v2/users/self', {
    accessToken: accessToken,
  });
}

function getDevices_(config, accessToken) {
  var payload = fetchBiot_(config, 'GET', '/device/v2/devices', {
    accessToken: accessToken,
  });
  return extractItems_(payload, ['devices', 'items', 'data', 'results']);
}

function getOfflineDevices_(devices) {
  var items = devices
    .filter(function (device) {
      return device.connectionStatusKey === 'disconnected';
    })
    .map(function (device) {
      return {
        id: device.id,
        lastConnectedAt: device.lastConnectedAt,
        connected: device.connected,
        connectionStatus: device.connectionStatus,
      };
    });

  items.sort(function (left, right) {
    return normalizeTimestampSortValue_(left.lastConnectedAt) < normalizeTimestampSortValue_(right.lastConnectedAt) ? -1 : 1;
  });

  return {
    total: items.length,
    items: items,
  };
}

function getSanitizerSummary_(devices) {
  var counts = zeroCounts_(SANITIZER_BREAKDOWN);
  var items = [];

  devices.forEach(function (device) {
    counts[device.sanitizerStatusKey] += 1;
    items.push({
      id: device.id,
      status: device.sanitizerStatus,
      statusKey: device.sanitizerStatusKey,
      value: device.sanitizerValue,
    });
  });

  var statusOrder = {
    unavailable: 0,
    unknown: 1,
    available: 2,
  };

  items.sort(function (left, right) {
    var leftOrder = statusOrder[left.statusKey] !== undefined ? statusOrder[left.statusKey] : 9;
    var rightOrder = statusOrder[right.statusKey] !== undefined ? statusOrder[right.statusKey] : 9;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return String(left.id).localeCompare(String(right.id));
  });

  return {
    total: items.length,
    counts: counts,
    breakdown: buildBreakdown_(counts, SANITIZER_BREAKDOWN),
    devices: items,
  };
}

function getConnectionSummary_(devices) {
  var counts = zeroCounts_(CONNECTION_BREAKDOWN);

  devices.forEach(function (device) {
    counts[device.connectionStatusKey] += 1;
  });

  return {
    total: devices.length,
    counts: counts,
    breakdown: buildBreakdown_(counts, CONNECTION_BREAKDOWN),
  };
}

function getGloveSummary_(config, accessToken, organizationIds, dateRange) {
  var counts = zeroCounts_(GLOVE_BREAKDOWN);
  var total = 0;

  organizationIds.forEach(function (organizationId) {
    if (!organizationId) {
      return;
    }

    var page = 0;
    while (true) {
      var searchRequest = {
        filter: {
          event_code: { eq: 'GLOVE_TAKEN' },
          '_ownerOrganization.id': { eq: organizationId },
          _creationTime: {
            from: dateRange.fromIso,
            to: dateRange.toIso,
          },
        },
        limit: 100,
        page: page,
      };

      var payload = fetchBiot_(
        config,
        'GET',
        '/generic-entity/v3/generic-entities/device_event',
        {
          accessToken: accessToken,
          baseUrl: config.GENERIC_ENTITY_BASE_URL,
          query: {
            searchRequest: JSON.stringify(searchRequest),
          },
        }
      );

      var items = extractItems_(payload, ['items', 'data', 'results', 'rows', 'entities', 'genericEntities']);
      if (!items.length) {
        break;
      }

      items.forEach(function (item) {
        var normalized = normalizeGloveSize_(item.event_cartridge_size);
        counts[normalized.key] += 1;
        total += 1;
      });

      var totalPages = extractTotalPages_(payload);
      if (totalPages !== null && page + 1 >= totalPages) {
        break;
      }
      if (items.length < 100) {
        break;
      }

      page += 1;
    }
  });

  return {
    total: total,
    counts: counts,
    breakdown: buildBreakdown_(counts, GLOVE_BREAKDOWN),
  };
}

function emptyGloveSummary_() {
  var counts = zeroCounts_(GLOVE_BREAKDOWN);
  return {
    total: 0,
    counts: counts,
    breakdown: buildBreakdown_(counts, GLOVE_BREAKDOWN),
  };
}

function safeWidget_(buildFn, fallbackValue, onError) {
  try {
    return buildFn();
  } catch (error) {
    if (typeof onError === 'function') {
      onError(error && error.message ? error.message : 'Widget request failed.');
    }
    return fallbackValue;
  }
}

function getOrganizationsForManufacturer_(viewer, selfPayload, devices) {
  return deriveOrganizations_(viewer, selfPayload, devices);
}

function buildViewerIdentity_(loginPayload, selfPayload) {
  var groups = extractGroups_(selfPayload).sort();
  var role = inferRole_(groups);
  var ownerOrganizationId = firstNonEmpty_([
    loginPayload.ownerOrganizationId,
    nestedGet_(selfPayload, ['_ownerOrganization', 'id']),
    nestedGet_(selfPayload, ['ownerOrganization', 'id']),
    selfPayload.ownerOrganizationId,
  ]);

  var displayName = firstNonEmpty_([
    selfPayload.fullName,
    selfPayload.displayName,
    selfPayload.name,
    buildFullName_(selfPayload.firstName, selfPayload.lastName),
    selfPayload.email,
    selfPayload.username,
    loginPayload.userId,
  ]);

  return {
    userId: firstNonEmpty_([loginPayload.userId, selfPayload._id, selfPayload.id]),
    displayName: displayName || 'BIOT Service Account',
    email: firstNonEmpty_([selfPayload.email, selfPayload.username]),
    role: role,
    groups: groups,
    ownerOrganizationId: ownerOrganizationId,
  };
}

function buildFullName_(firstName, lastName) {
  var parts = [];
  if (typeof firstName === 'string' && firstName.trim()) {
    parts.push(firstName.trim());
  }
  if (typeof lastName === 'string' && lastName.trim()) {
    parts.push(lastName.trim());
  }
  return parts.join(' ');
}

function inferRole_(groups) {
  for (var i = 0; i < groups.length; i += 1) {
    if (String(groups[i]).toLowerCase().indexOf('manufacturer') !== -1) {
      return 'manufacturer';
    }
  }
  return 'organization';
}

function extractGroups_(payload) {
  var groups = [];
  var seen = {};

  function collect(value) {
    if (typeof value === 'string' && value.trim()) {
      var key = value.trim();
      if (!seen[key]) {
        seen[key] = true;
        groups.push(key);
      }
      return;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      ['name', 'label', 'title', 'value'].forEach(function (field) {
        if (typeof value[field] === 'string' && value[field].trim() && !seen[value[field].trim()]) {
          seen[value[field].trim()] = true;
          groups.push(value[field].trim());
        }
      });
    }
  }

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    Object.keys(node).forEach(function (key) {
      var value = node[key];
      if (key.toLowerCase().indexOf('group') !== -1 || key.toLowerCase().indexOf('role') !== -1) {
        if (Array.isArray(value)) {
          value.forEach(collect);
        } else {
          collect(value);
        }
      }
      walk(value);
    });
  }

  walk(payload);
  return groups;
}

function deriveOrganizations_(viewer, selfPayload, devices) {
  var organizations = {};

  function addOrganization(orgId, name) {
    if (typeof orgId !== 'string' || !orgId.trim()) {
      return;
    }

    var normalizedId = orgId.trim();
    if (!organizations[normalizedId]) {
      organizations[normalizedId] = { id: normalizedId, name: normalizedId };
    }
    if (typeof name === 'string' && name.trim()) {
      organizations[normalizedId].name = name.trim();
    }
  }

  function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach(function (item) {
        walk(item, path);
      });
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }

    var lowerPath = String(path || '').toLowerCase();
    if (lowerPath.indexOf('organization') !== -1) {
      addOrganization(
        firstNonEmpty_([node.id, node._id, node.organizationId, node.ownerOrganizationId]),
        firstNonEmpty_([node.name, node.displayName, node.label])
      );
    } else if (Object.keys(node).some(function (key) {
      return key.toLowerCase().indexOf('organization') !== -1;
    })) {
      addOrganization(
        firstNonEmpty_([node.organizationId, node.ownerOrganizationId]),
        firstNonEmpty_([node.organizationName, node.ownerOrganizationName])
      );
    }

    Object.keys(node).forEach(function (key) {
      var nextPath = path ? path + '.' + key : key;
      walk(node[key], nextPath);
    });
  }

  walk(selfPayload, '');

  devices.forEach(function (device) {
    var owner = device && device._ownerOrganization && typeof device._ownerOrganization === 'object'
      ? device._ownerOrganization
      : null;
    if (!owner) {
      return;
    }
    addOrganization(firstNonEmpty_([owner.id, owner._id]), firstNonEmpty_([owner.name, owner.displayName, owner.label]));
  });

  addOrganization(viewer.ownerOrganizationId, viewer.ownerOrganizationId);

  var items = Object.keys(organizations).map(function (key) {
    return organizations[key];
  });

  items.sort(function (left, right) {
    var leftName = (left.name || left.id).toLowerCase();
    var rightName = (right.name || right.id).toLowerCase();
    if (leftName !== rightName) {
      return leftName < rightName ? -1 : 1;
    }
    return left.id.toLowerCase() < right.id.toLowerCase() ? -1 : 1;
  });

  if (viewer.role === 'organization' && viewer.ownerOrganizationId) {
    var filtered = items.filter(function (item) {
      return item.id === viewer.ownerOrganizationId;
    });
    if (filtered.length) {
      return filtered;
    }
    return [{ id: viewer.ownerOrganizationId, name: viewer.ownerOrganizationId }];
  }

  return items;
}

function resolveScope_(viewer, organizations, requestedOrganizationId) {
  var availableIds = organizations
    .map(function (organization) {
      return organization.id;
    })
    .filter(function (organizationId) {
      return !!organizationId;
    });

  if (viewer.role === 'organization') {
    var lockedOrganizationId = viewer.ownerOrganizationId || (availableIds.length ? availableIds[0] : null);
    return {
      selectedOrganizationId: lockedOrganizationId,
      organizationIds: lockedOrganizationId ? [lockedOrganizationId] : [],
      label: organizationLabel_(organizations, lockedOrganizationId),
    };
  }

  var selected = typeof requestedOrganizationId === 'string' && requestedOrganizationId.trim()
    ? requestedOrganizationId.trim()
    : 'all';

  if (selected !== 'all' && availableIds.indexOf(selected) === -1) {
    throw new Error('The requested organization is not available for this manufacturer account.');
  }

  if (selected === 'all') {
    return {
      selectedOrganizationId: 'all',
      organizationIds: availableIds,
      label: 'All organizations',
    };
  }

  return {
    selectedOrganizationId: selected,
    organizationIds: [selected],
    label: organizationLabel_(organizations, selected),
  };
}

function organizationLabel_(organizations, organizationId) {
  if (!organizationId) {
    return 'No organization';
  }

  for (var i = 0; i < organizations.length; i += 1) {
    if (organizations[i].id === organizationId) {
      return organizations[i].name || organizationId;
    }
  }

  return organizationId;
}

function resolveDateRange_(params) {
  var now = new Date();
  var defaultTo = formatDateOnly_(now);
  var defaultFrom = formatDateOnly_(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));

  var from = typeof params.from === 'string' && params.from ? params.from : defaultFrom;
  var to = typeof params.to === 'string' && params.to ? params.to : defaultTo;
  if (from > to) {
    throw new Error('The start date must be on or before the end date.');
  }

  return {
    from: from,
    to: to,
    fromIso: typeof params.fromIso === 'string' && params.fromIso ? params.fromIso : from + 'T00:00:00.000Z',
    toIso: typeof params.toIso === 'string' && params.toIso ? params.toIso : to + 'T23:59:59.999Z',
    timezone: typeof params.timezone === 'string' && params.timezone ? params.timezone : 'UTC',
  };
}

function formatDateOnly_(date) {
  var year = date.getUTCFullYear();
  var month = String(date.getUTCMonth() + 1).padStart(2, '0');
  var day = String(date.getUTCDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function deviceMatchesScope_(device, organizationIds, viewer) {
  var ownerOrganizationId = firstNonEmpty_([
    nestedGet_(device, ['_ownerOrganization', 'id']),
    nestedGet_(device, ['ownerOrganization', 'id']),
  ]);

  if (!organizationIds.length) {
    if (viewer.role === 'organization' && viewer.ownerOrganizationId) {
      return ownerOrganizationId === viewer.ownerOrganizationId;
    }
    return true;
  }

  return organizationIds.indexOf(ownerOrganizationId) !== -1;
}

function normalizeDevice_(device) {
  var connection = normalizeConnectionStatus_(nestedGet_(device, ['_status', '_connection', '_connected']));
  var sanitizer = normalizeSanitizerStatus_(nestedGet_(device, ['_status', 'septol_availability1']));
  var owner = device && device._ownerOrganization && typeof device._ownerOrganization === 'object'
    ? device._ownerOrganization
    : {};

  return {
    id: String(firstNonEmpty_([device._id, device.id, 'Unknown device'])),
    organizationId: firstNonEmpty_([owner.id, owner._id]),
    organizationName: firstNonEmpty_([owner.name, owner.displayName, owner.label]),
    connected: nestedGet_(device, ['_status', '_connection', '_connected']),
    connectionStatus: connection.label,
    connectionStatusKey: connection.key,
    lastConnectedAt: nestedGet_(device, ['_status', '_connection', '_lastConnectedTime']),
    sanitizerStatus: sanitizer.label,
    sanitizerStatusKey: sanitizer.key,
    sanitizerValue: nestedGet_(device, ['_status', 'septol_availability1']),
  };
}

function normalizeConnectionStatus_(value) {
  if (value === true) {
    return { key: 'connected', label: 'Connected' };
  }
  if (value === false) {
    return { key: 'disconnected', label: 'Disconnected' };
  }
  return { key: 'unknown', label: 'Unknown' };
}

function normalizeSanitizerStatus_(value) {
  if (value === true) {
    return { key: 'available', label: 'Available' };
  }
  if (value === false) {
    return { key: 'unavailable', label: 'Unavailable' };
  }
  return { key: 'unknown', label: 'Unknown' };
}

function normalizeGloveSize_(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { key: 'unknown', label: 'Unknown' };
  }

  var normalized = value.trim().toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  if (normalized === 's' || normalized === 'small') {
    return { key: 'small', label: 'Small' };
  }
  if (normalized === 'm' || normalized === 'medium' || normalized === 'med') {
    return { key: 'medium', label: 'Medium' };
  }
  if (normalized === 'l' || normalized === 'large') {
    return { key: 'large', label: 'Large' };
  }
  if (normalized === 'xl' || normalized === 'xlarge' || normalized === 'x large' || normalized === 'extra large') {
    return { key: 'extraLarge', label: 'Extra Large' };
  }
  return { key: 'unknown', label: 'Unknown' };
}

function buildBreakdown_(counts, labels) {
  var total = Object.keys(counts).reduce(function (sum, key) {
    return sum + Number(counts[key] || 0);
  }, 0);

  return labels.map(function (pair) {
    var key = pair[0];
    var label = pair[1];
    var value = Number(counts[key] || 0);
    return {
      key: key,
      label: label,
      value: value,
      percentage: total ? Number(((value / total) * 100).toFixed(1)) : 0,
    };
  });
}

function zeroCounts_(pairs) {
  var counts = {};
  pairs.forEach(function (pair) {
    counts[pair[0]] = 0;
  });
  return counts;
}

function normalizeTimestampSortValue_(value) {
  return typeof value === 'string' && value ? value : '';
}

function fetchBiot_(config, method, path, options) {
  options = options || {};
  var baseUrl = options.baseUrl || config.BIOT_BASE_URL;
  var url = buildUrl_(baseUrl + path, options.query || {});
  var requestOptions = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Accept: 'application/json',
    },
  };

  if (options.accessToken) {
    requestOptions.headers.Authorization = 'Bearer ' + options.accessToken;
  }
  if (options.body !== undefined) {
    requestOptions.contentType = 'application/json';
    requestOptions.payload = JSON.stringify(options.body);
  }

  var response = UrlFetchApp.fetch(url, requestOptions);
  var statusCode = response.getResponseCode();
  var text = response.getContentText();
  var payload = parseJsonSafe_(text);
  var expectedStatuses = options.expectedStatuses || [200];

  if (expectedStatuses.indexOf(statusCode) === -1) {
    throw new Error(extractErrorMessage_(payload) || ('BIOT request failed with status ' + statusCode + '.'));
  }

  return payload;
}

function buildUrl_(baseUrl, query) {
  var keys = Object.keys(query || {}).filter(function (key) {
    return query[key] !== undefined && query[key] !== null && query[key] !== '';
  });
  if (!keys.length) {
    return baseUrl;
  }

  var queryString = keys
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key]));
    })
    .join('&');

  return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + queryString;
}

function parseJsonSafe_(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('BIOT returned a non-JSON response.');
  }
}

function extractItems_(payload, preferredKeys) {
  if (Array.isArray(payload)) {
    return payload.filter(function (item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    });
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  var keys = (preferredKeys || []).concat(['items', 'data', 'results', 'content', 'rows', 'entities', 'genericEntities']);
  var seen = {};

  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    if (Array.isArray(payload[key])) {
      return payload[key].filter(function (item) {
        return item && typeof item === 'object' && !Array.isArray(item);
      });
    }
  }

  for (var property in payload) {
    if (Array.isArray(payload[property])) {
      return payload[property].filter(function (item) {
        return item && typeof item === 'object' && !Array.isArray(item);
      });
    }
  }

  return [];
}

function extractTotalPages_(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (typeof payload.totalPages === 'number') {
    return payload.totalPages;
  }
  if (typeof payload._totalPages === 'number') {
    return payload._totalPages;
  }
  if (typeof payload.pages === 'number') {
    return payload.pages;
  }

  if (payload.page && typeof payload.page === 'object') {
    if (typeof payload.page.totalPages === 'number') {
      return payload.page.totalPages;
    }
    if (typeof payload.page.pages === 'number') {
      return payload.page.pages;
    }
  }

  if (payload.meta && typeof payload.meta === 'object') {
    if (typeof payload.meta.totalPages === 'number') {
      return payload.meta.totalPages;
    }
    if (typeof payload.meta.pages === 'number') {
      return payload.meta.pages;
    }
  }

  return null;
}

function extractErrorMessage_(payload) {
  if (!payload) {
    return '';
  }

  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  if (Array.isArray(payload)) {
    for (var i = 0; i < payload.length; i += 1) {
      var messageFromArray = extractErrorMessage_(payload[i]);
      if (messageFromArray) {
        return messageFromArray;
      }
    }
    return '';
  }

  if (typeof payload === 'object') {
    var messageFields = ['message', 'error', 'detail', 'title', 'description'];
    for (var j = 0; j < messageFields.length; j += 1) {
      var field = messageFields[j];
      if (typeof payload[field] === 'string' && payload[field].trim()) {
        return payload[field].trim();
      }
    }

    if (Array.isArray(payload.errors)) {
      for (var k = 0; k < payload.errors.length; k += 1) {
        var nestedMessage = extractErrorMessage_(payload.errors[k]);
        if (nestedMessage) {
          return nestedMessage;
        }
      }
    }
  }

  return '';
}

function firstNonEmpty_(values) {
  for (var i = 0; i < values.length; i += 1) {
    var value = values[i];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) {
      return value;
    }
  }
  return null;
}

function nestedGet_(source, keys) {
  var current = source;
  for (var i = 0; i < keys.length; i += 1) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[keys[i]];
  }
  return current;
}
