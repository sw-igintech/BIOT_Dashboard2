# Machines Dashboard

This project is a static GitHub Pages dashboard backed by a single Google Apps Script web app.

Configured frontend endpoint:

`https://script.google.com/macros/s/AKfycbwtCs6khyngFpoq7UwuSZpVcz6Y600uZIHjnUzXVF7uzdE6z1wok9fsvquzDm_U5Wen/exec`

## Final Deployment Files

GitHub Pages:
- `index.html`
- `dashboard.css`
- `dashboard.js`

Google Apps Script:
- `apps-script/Code.gs`

## Required Apps Script Configuration

Set these Script Properties in the Apps Script project:
- `BIOT_BASE_URL=https://api.dev.igin.biot-med.com`
- `BIOT_USERNAME=your BIOT username`
- `BIOT_PASSWORD=your BIOT password`

Optional if Generic Entity V3 needs a different host in your BIOT environment:
- `GENERIC_ENTITY_BASE_URL=https://apidev.biot-med.com`

If `GENERIC_ENTITY_BASE_URL` is not set, the app uses `BIOT_BASE_URL` for glove queries too.

## Apps Script Setup

1. Open the Apps Script project.
2. Copy `apps-script/Code.gs` into the project.
3. Set the Script Properties above.
4. Deploy a new Web App version after updating the script.
5. Use access settings that allow the GitHub Pages site to call the deployed `/exec` URL.

## Frontend Setup

Publish these files to GitHub Pages:
- `index.html`
- `dashboard.css`
- `dashboard.js`

The Apps Script URL is already set in `index.html`.

## Runtime Notes

- BIOT credentials stay only in Apps Script.
- The browser never calls BIOT directly.
- Organization users are locked to their own organization.
- Manufacturer users get an organization selector and can view all accessible organizations.
- Glove data is fetched from Generic Entity V3 `device_event` with pagination.
- The frontend now defaults to the last 14 days for a faster first load.
- Wider date ranges are still supported.
- The Apps Script backend isolates glove failures so device and sanitizer widgets can still render.
- After changing `apps-script/Code.gs`, you must redeploy the Apps Script Web App.

## Old Backend Files No Longer Used

These files are no longer part of the final deployment path:
- `app.py`
- `biot_client.py`
- `dashboard_service.py`
- `requirements.txt`
- `.env.example`
