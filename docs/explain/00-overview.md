# 0 — Overview

## What is this?

The **BIOT Devices Dashboard** is an internal operations tool for **IGIN SMART**, whose product is a
smart wall-mounted machine that dispenses **gloves** and **sanitizer** (think of a connected PPE
station in a clinic/hospital). Each physical machine is an IoT device registered in **BIOT** — a
third-party cloud platform for medical/IoT device management (biot-med.com).

This dashboard lets IGIN staff and their distributors log in and monitor the fleet:

- **Device Connection Status** — how many machines are online vs offline.
- **Glove Consumption** — how many gloves were dispensed (by size) in a date range.
- **Sanitizer Status** — which machines have sanitizer available.
- **Operational Status** — which machines can currently dispense ("delivery available").
- **Machines table** — searchable/filterable list, click a row for full device detail + settings.
- **Cartridges table** — glove cartridge inventory (when a specific org/distributor is selected).

The data is **live from BIOT on every load** — the dashboard stores nothing itself.

## Tech stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Plain HTML + vanilla JavaScript + CSS | **No framework, no build step.** Three files served as-is. |
| Charts | [Chart.js 4](https://www.chartjs.org/) (via CDN) | Doughnut charts. |
| Date picker | [flatpickr](https://flatpickr.js.org/) (via CDN) | The From/To date inputs. |
| Backend | [Deno](https://deno.com/) (`Deno.serve`) | One TypeScript file. Runs on **Deno Deploy** (serverless edge). |
| Upstream API | BIOT REST API | The real source of truth. |
| Frontend hosting | GitHub Pages | Auto-deploys on push to `main`. |
| Backend hosting | Deno Deploy | Auto-deploys via GitHub Actions on push to `main` touching `deno/**`. |

There is **no npm install** for the app itself. The only Node usage is a couple of standalone
validation scripts (`scripts/*.mjs`) and the optional Playwright preview harness — none of which the
running app depends on.

## The mental model (hold this in your head)

```
   You are the user.                    "Middle-man" you own.          The real system.
┌──────────────────────┐   your BIOT   ┌──────────────────────┐  your  ┌──────────────┐
│  Browser              │   token in    │  Deno backend        │  token │  BIOT API    │
│  index.html           │──── header ──▶│  deno/main.ts        │───────▶│  (dev cloud) │
│  dashboard.js/.css    │◀── reshaped ──│  pure proxy,         │◀───────│              │
│  (charts, tables)     │     JSON      │  no DB, no cache     │  raw   │              │
└──────────────────────┘               └──────────────────────┘  JSON  └──────────────┘
```

Three ideas that explain 90% of the design:

1. **The backend is a pure proxy.** It has no database, no cache, no user store, no scheduled jobs.
   Every request triggers fresh calls to BIOT. If you're looking for "where is the data stored" — it
   isn't. It's in BIOT.

2. **Auth is the user's own BIOT token.** There is no shared service account for reading data. When you
   log in, the backend asks BIOT for *your* token, hands it back to the browser, and the browser sends
   it up on every subsequent request. **What data you see is entirely determined by what BIOT lets
   your token see** (this is BIOT's ABAC permission system — see [04-biot-concepts.md](04-biot-concepts.md)).

3. **The backend's job is shaping, not deciding.** It fans out to several BIOT endpoints, normalizes
   their messy/inconsistent field names into clean objects, aggregates counts for the charts, and
   applies an optional *scope filter* (for manufacturer users who pick a specific org/distributor from
   a dropdown). That's the whole backend.

## Why is the config field called `supabaseEdgeUrl`?

Historical baggage, and it matters when you read the code. The backend used to run on **Supabase Edge
Functions**. In June 2026 it was migrated to Deno Deploy (the "v2.0" cutover). To keep the change to a
single line, the config key name was left as `supabaseEdgeUrl` — but it now holds the **Deno** URL.
You'll see the same legacy naming in `getEdgeUrl()`, `appsScriptRequest()` (an even older name from a
Google Apps Script era), and `supabaseAnonKey` (still sent by the browser, ignored by Deno).

Don't be confused: **the live backend is Deno.** Supabase is kept deployed only as an instant-rollback
fallback. See [../PROJECT_STATE.md](../PROJECT_STATE.md).

## Repository map

```
BIOT_Dashboard2/
├── index.html            ← frontend shell + the one config line (backend URL)
├── dashboard.js          ← ALL frontend logic (auth, fetch, render, charts)  ⭐ main frontend file
├── dashboard.css         ← styles
├── logo.svg              ← brand logo (swappable)
├── deno/
│   ├── main.ts           ← THE BACKEND — pure BIOT proxy                       ⭐ main backend file
│   ├── deno.json         ← Deno tasks (start / check)
│   ├── deploy.sh         ← manual deploy helper
│   └── preview/          ← local preview server + Playwright E2E (non-prod tooling)
├── supabase/             ← OLD backend, fallback only (mirror of main.ts)
├── scripts/              ← standalone validation scripts (health, parity)
├── .github/workflows/    ← CI + auto-deploy pipelines
└── docs/                 ← PROJECT_STATE.md, DENO_MIGRATION.md, and this explain/ folder
```

The two files you'll spend all your time in are **`deno/main.ts`** (backend) and **`dashboard.js`**
(frontend). Continue to [01-architecture.md](01-architecture.md).
</content>
