# How to start the dev environment

Run the dashboard locally on Windows / PowerShell. Two processes: the **backend** (Deno, on `:8000`)
and the **frontend preview** (Node, on `:8789`).

---

## TL;DR — what to run

**First time only (one-time setup):**
1. Install Deno (Step 1 below), then close & reopen the terminal.

**Every time you start dev (including the first time, after Deno is installed):**
1. **Terminal 1 — backend:**
   ```powershell
   cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2\deno
   $env:BIOT_BASE_URL = "https://api.dev.igin.biot-med.com"
   deno task start
   ```
2. **Terminal 2 — frontend:**
   ```powershell
   cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2
   $env:PREVIEW_BACKEND_URL = "http://localhost:8000"
   node deno/preview/serve-preview.mjs
   ```
3. Open **http://localhost:8789** and log in with a real BIOT account.

> The `$env:...` lines set environment variables **per terminal session** — they are not saved. That's
> why you re-run them (or the whole Terminal 1 / Terminal 2 blocks) every time you open fresh terminals.

---

## Full steps (Option A — local backend + local frontend)

### Step 1 — Install Deno (one time only)

In a PowerShell terminal:

```powershell
irm https://deno.land/install.ps1 | iex
```

Then **close and reopen your terminal** so `deno` is on PATH. Verify:

```powershell
deno --version
```

> Using **Git Bash** instead of PowerShell? Use `curl -fsSL https://deno.land/install.sh | sh` and the
> bash-style `VAR=value cmd` form for the env vars below.

### Step 2 — Start the backend (Terminal 1)

```powershell
cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2\deno
$env:BIOT_BASE_URL = "https://api.dev.igin.biot-med.com"
deno task start
```

Leave this running. It serves on **http://localhost:8000**.

To confirm it's healthy, open a *separate* terminal and run:

```powershell
node c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2\scripts\smoke-health.mjs http://localhost:8000
```

### Step 3 — Start the frontend (Terminal 2)

Open a second PowerShell terminal:

```powershell
cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2
$env:PREVIEW_BACKEND_URL = "http://localhost:8000"
node deno/preview/serve-preview.mjs
```

This serves the real frontend on **http://localhost:8789**, wired to your local backend. It rewrites
the backend URL **in memory** only — the production `index.html` on disk is never touched, and you'll
see a "PREVIEW" banner.

### Step 4 — Use it

Open **http://localhost:8789** in your browser and log in with a real BIOT account (your own BIOT
username/password — there's no shared login).

That's it. Terminal 1 = backend, Terminal 2 = frontend, browser at :8789.

---

## First run vs. next times — at a glance

| | First run | Every run after |
|---|---|---|
| Install Deno (Step 1) | ✅ once | ❌ skip |
| Terminal 1: `cd deno`, set `$env:BIOT_BASE_URL`, `deno task start` | ✅ | ✅ |
| Terminal 2: `cd` repo, set `$env:PREVIEW_BACKEND_URL`, `serve-preview.mjs` | ✅ | ✅ |
| Open http://localhost:8789 and log in | ✅ | ✅ |

To stop either server: `Ctrl+C` in its terminal.

---

## Quicker alternatives

- **Frontend only, against the live staging backend** (no Deno, no Terminal 1 — fastest sanity check):
  ```powershell
  cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2
  node deno/preview/serve-preview.mjs
  ```
  With no `PREVIEW_BACKEND_URL`, it defaults to the live backend
  (`https://biot-dashboard-staging.sw-igin.deno.net`). Open http://localhost:8789.

- **Persist `BIOT_BASE_URL`** so you don't retype it: set it once for your user account with
  `setx BIOT_BASE_URL "https://api.dev.igin.biot-med.com"` (takes effect in *new* terminals), then you
  can skip that line in Terminal 1.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `deno: command not found` after install | Close and reopen the terminal (PATH refresh). |
| `irm`/`iex` not found | You're in Git Bash, not PowerShell — use the `curl … | sh` installer. |
| Backend errors `BIOT_BASE_URL secret is not set` | You didn't set `$env:BIOT_BASE_URL` in that terminal before `deno task start`. |
| Port 8000 or 8789 already in use | Another instance is running, or set `PREVIEW_PORT=9000` for the frontend. |
| Login fails | Confirm the backend is up (Step 2 health check) and you're using real BIOT dev credentials. |

For the deeper "why", see [explain/05-local-dev-and-deploy.md](explain/05-local-dev-and-deploy.md).
</content>
