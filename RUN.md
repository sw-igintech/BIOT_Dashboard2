# Run the frontend

> ## ⚠️ IMPORTANT: Use PowerShell, NOT Git Bash
>
> All commands below use PowerShell syntax (`$env:VAR = "..."`). Running them in
> **Git Bash (MINGW64)** will fail with errors like `bash: :BIOT_BASE_URL: command not found`,
> and the env var will silently **not** be set.
>
> Open a **PowerShell** terminal before running any of the commands below.

## Quickest — frontend only (live staging backend)

No Deno needed, just Node:

```powershell
cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2
node deno/preview/serve-preview.mjs
```

Open **http://localhost:8789** and log in with your BIOT account.

## Full local dev — frontend + local backend

**Terminal 1 — backend (Deno on :8000):**

```powershell
cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2\deno
$env:BIOT_BASE_URL = "https://api.dev.igin.biot-med.com"
deno task start
```

**Terminal 2 — frontend (:8789):**

```powershell
cd c:\Users\EranYahav\work\projects\igin\BIOT_Dashboard2
$env:PREVIEW_BACKEND_URL = "http://localhost:8000"
node deno/preview/serve-preview.mjs
```

Open **http://localhost:8789**.

## Notes

- Preview server rewrites the backend URL in memory only — `index.html` on disk is never touched.
- Port 8789 taken? Set `$env:PREVIEW_PORT = "9000"`.
- `Ctrl+C` stops either server.
