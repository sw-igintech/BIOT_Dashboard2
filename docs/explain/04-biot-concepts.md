# 4 — BIOT concepts & field reference

You can't maintain this dashboard without a working model of **BIOT**, the upstream platform. This
chapter is the domain glossary + the confirmed field names the code depends on.

## What BIOT is

BIOT (biot-med.com) is a cloud platform for managing connected medical/IoT devices. It provides:

- **Users & auth** (`/ums/…`) — login, token refresh, "who am I".
- **Devices** (`/device/…`) — the registered machines and their live `_status`.
- **Generic entities** (`/generic-entity/…`) — a flexible, template-based entity store. Everything that
  isn't a device or user lives here: distributors, cartridges, org↔distributor bridges, and device
  *events*. Each entity type is identified by a `templateName`.

This project uses **the dev environment**: `https://api.dev.igin.biot-med.com`.

## Conventions that bite you

- **Underscore-prefixed = system fields.** BIOT prefixes its own managed fields with `_`
  (`_id`, `_name`, `_status`, `_ownerOrganization`, `_creationTime`, `_connection`). Customer-defined
  fields have no underscore (`current_settings2`, `device_distributor`, `bin_level1`). The backend uses
  this rule in `normalizeDevice`: everything not starting with `_` becomes a `customField`.
- **Reference objects.** A link to another entity is an object like
  `{ id, name, templateName }`, not a bare id. E.g. `device.device_distributor.id`,
  `device.current_settings2.id`.
- **Inconsistent list envelopes.** List endpoints wrap results under different keys
  (`data`, `items`, `results`, `devices`, …). The `extractItems` helper tries them all.
- **Pagination.** `searchRequest = { limit, page }` passed as a JSON-stringified query param; responses
  may or may not include `totalPages`.

## The permission model (ABAC) — why different users see different things

BIOT uses **Attribute-Based Access Control**. Your token carries your identity + group memberships, and
BIOT decides which entities you may see. **This dashboard delegates all data-scoping to BIOT** — it
forwards your token and shows what comes back. Consequences:

- A **manufacturer** user sees the whole fleet; the dashboard adds an optional dropdown to *narrow*
  the view client-side.
- An **organization** user sees only their org's devices — BIOT returns exactly that set, so the
  dashboard does **no** client-side filtering for them.
- A **distributor** user's token may legitimately return devices across several owner-orgs (their own +
  child orgs). This is why the backend trusts BIOT's list rather than filtering by a single owner-org
  (an earlier version broke distributor users by over-filtering — see the comment above
  `deviceMatchesScope`).

### The known upstream defect (memorize this)

BIOT's `device_event` endpoint runs an ABAC expansion whose cost scales with the caller's permitted
entity set. For **large-distributor tokens permitted into the manufacturer root org**, the glove-events
query takes **~90 seconds and then returns HTTP 414** — deterministically. This is a **BIOT-side bug**,
not something fixable in this repo. The entire "gloves are a separate async action with an 85s patient
budget and graceful-degradation UI" design exists to cope with it. See [02-backend.md](02-backend.md)
§6 and [03-frontend.md](03-frontend.md) glove state machine.

## Roles

The `Viewer.role` is inferred in `inferRole()`: if any of the user's group names contains the word
"manufacturer" → `"manufacturer"`, otherwise `"organization"`. Only that distinction matters to the UI
(manufacturer = gets the scope dropdown + sees org/distributor detail rows).

## Organizations vs Distributors

- **Organization** = an end-user account that owns machines (a clinic, a hospital). A device's owner is
  `device._ownerOrganization`.
- **Distributor** = a reseller/service company that manages machines across multiple organizations.
  Modeled as a generic entity (`templateName: "distributor"`).
- A device can link to a distributor **two ways**:
  1. **Directly** — `device.device_distributor` reference object.
  2. **Indirectly** — via an `organization_to_distributor` **bridge entity** that links a child org to a
     distributor (`_ownerOrganization.id` = child org, `organization_distributor.id` = distributor).
- The backend builds `distributorId → [childOrgIds]` from those bridges
  (`buildDistributorToOrgsMap`) and uses the OR of both links for distributor-scope filtering.

## Endpoints this project calls

| Purpose | Method + path | Notes |
|---------|---------------|-------|
| Login | `POST /ums/v2/users/login` | returns `accessJwt.token`, `refreshJwt.token`, `userId` |
| Refresh | `POST /ums/v2/users/token/refresh` | |
| Current user | `GET /ums/v2/users/self` | role, groups, owner org |
| Devices | `GET /device/v2/devices` | `searchRequest={limit,page}`; the fleet + `_status` |
| Distributors | `GET /generic-entity/v3/generic-entities/distributor` | |
| Org↔dist bridges | `GET /generic-entity/v3/generic-entities/organization_to_distributor` | |
| Cartridges | `GET /generic-entity/v3/generic-entities/cartridge` | do **not** add a `_templateName` filter (400) |
| Glove events | `GET /generic-entity/v3/generic-entities/device_event` | filter `event_code=GLOVE_TAKEN`; the slow one |
| Device settings | `GET /generic-entity/v1/generic-entities/{id}` | the `entity` action; id from `current_settings2.id` |

## ⭐ Confirmed field reference

These are the exact field names the code reads. They were verified against the live dev API (dates in
the source comments). **If a widget shows blanks, a renamed field upstream is the first thing to check.**

### Device `_status` (drives connection / sanitizer / operational + the detail Status tab)

| Field | Type | Used for |
|-------|------|----------|
| `_status._connection._connected` | boolean | Connection status |
| `_status._connection._lastConnectedTime` | ISO string | "Last Connected At" |
| `_status._connection._ipAddress` | string | (available, not shown) |
| `_status.connectivity_interface` | string (`"wifi"`) | Detail: Interface |
| `_status.septol_availability1` | boolean | Sanitizer widget + detail (septol = the sanitizer) |
| `_status.delivery_available1` | boolean | **Operational** widget + detail: Delivery Available |
| `_status.bin_level1` | integer | Detail: Bin Level (a count, not a 0–1 fraction) |
| `_status.total_small_gloves` | integer | Detail: Gloves In Stock — Small |
| `_status.total_medium_gloves` | integer | …Medium |
| `_status.total_large_gloves` | integer | …Large |
| `_status.total_extra_large_gloves` | integer | …Extra Large |

Fields that look plausible but **do NOT exist** on real devices (socket-simulator only): `septol`
(numeric level), `trash` (fraction), `cartridge` (slot count). Don't build on them.

### Device root (non-`_` custom fields)

| Field | Shape | Used for |
|-------|-------|----------|
| `device_distributor` | `{ id, name, templateName:"distributor" }` | distributor link + detail row |
| `current_settings2` | `{ id, templateName:"device_current_settings" }` | **reference** to the settings entity |
| `_ownerOrganization` | `{ id, name }` | owner org (this one *is* `_`-prefixed) |

### Settings entity (fetched via the `entity` action — all lowercase)

| Field | Type | Detail row |
|-------|------|-----------|
| `software_version.name` | nested string | SW Version |
| `glovedefaultsize` | string (`small`/`medium`/`large`/`extra_large`) | Default Size |
| `useridentificationrequired` | boolean | NFC Card Required |
| `promptforactivationtosecondglove` | boolean | 2nd Glove Prompt |
| `septolservingvolume` | number | Serving Volume |
| `septolcurrentside` | string (`left`/`right`) | Side |
| `septolmandatoryuse` | boolean | Mandatory |

### Glove event (`device_event`, `event_code = "GLOVE_TAKEN"`)

| Field | Used for |
|-------|----------|
| `event_cartridge_size` | glove size bucket (normalized to small/medium/large/extraLarge/unknown) |
| `_ownerOrganization.id` | the org filter for the query |
| `_creationTime` | the date-range filter (UTC) |
| `device_event` (reference) | `.id` = source device id, used for scope post-filtering |

### Cartridge entity

| Field | Used for |
|-------|----------|
| `sticker_id` | user-facing cartridge number |
| `cartridge_size` | size |
| `cartridge_distributor` `{ id, name }` | distributor link |
| `_ownerOrganization` | owner (may be the special `<<Global>>` for distributor stock) |
| `amount` / `current_amount` / `is_empty` | inventory level |

More live-verified detail lives in [../DENO_MIGRATION.md](../DENO_MIGRATION.md) and the gitignored
`claude/BIOT_API_REFERENCE.md`. Next: [05-local-dev-and-deploy.md](05-local-dev-and-deploy.md).
</content>
