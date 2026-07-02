# BIOT Dashboard — Explained

A guided tour of this project, written for someone who just cloned the repo and needs to
**understand and maintain it**. Read the files in order; each one builds on the previous.

| # | File | What it covers |
|---|------|----------------|
| 0 | [00-overview.md](00-overview.md) | What this product is, the tech stack, and the mental model to hold in your head. |
| 1 | [01-architecture.md](01-architecture.md) | The three layers (browser → Deno → BIOT), how a request flows end-to-end, why there is no database. |
| 2 | [02-backend.md](02-backend.md) | `deno/main.ts` line-by-line by section: actions, BIOT calls, the scope model, the glove async trick, timeouts. |
| 3 | [03-frontend.md](03-frontend.md) | `index.html` + `dashboard.js`: views, auth/session, state, rendering, charts, the 4 glove states, tables, the device modal. |
| 4 | [04-biot-concepts.md](04-biot-concepts.md) | BIOT domain model: entities, the confirmed field names, ABAC permissions, distributors/organizations. |
| 5 | [05-local-dev-and-deploy.md](05-local-dev-and-deploy.md) | Run it locally, the deploy pipeline, rollback, CI, the validation scripts. |
| 6 | [06-maintenance-playbook.md](06-maintenance-playbook.md) | Recipes for the changes you'll actually make: add a widget, change a field, debug the glove timeout, swap the logo. |

## The 30-second version

Operations staff open a web page, log in with **their own BIOT credentials**, and see live
device status (connection, gloves, sanitizer, operational), a machine table, a cartridge table,
and per-device details. That's it.

- **Frontend** = static files (`index.html`, `dashboard.js`, `dashboard.css`) served by GitHub Pages.
- **Backend** = one Deno file (`deno/main.ts`) on Deno Deploy that is a **pure proxy** to the BIOT
  REST API. No database. No cache. It just forwards the user's token and reshapes BIOT's responses.
- **BIOT** = the third-party medical IoT platform that is the single source of truth for all data.

Everything else in the repo is deployment plumbing, the (now-fallback) old Supabase backend, and docs.

> These docs describe the code as of the **v2.0** release (Supabase → Deno cutover). The authoritative
> current-state handoff is [../PROJECT_STATE.md](../PROJECT_STATE.md); the migration record is
> [../DENO_MIGRATION.md](../DENO_MIGRATION.md). This `explain/` folder is the *how it works* companion
> to those *what/where* docs.
</content>
</invoke>
