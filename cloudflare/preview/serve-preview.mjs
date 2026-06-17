#!/usr/bin/env node
// Non-production frontend preview server (migration validation only).
//
// Serves the REAL production frontend (index.html + dashboard.js + dashboard.css + logo.svg)
// but rewrites ONLY the window.DASHBOARD_CONFIG block in-memory so the dashboard talks to the
// Cloudflare STAGING Worker instead of Supabase. It NEVER modifies any file on disk — the
// production index.html stays the single source of truth, so the preview can't drift.
//
// A bright banner makes clear this is the staging/preview build, not production.
//
// Usage:
//   node cloudflare/preview/serve-preview.mjs           # serves on http://localhost:8788
//   PREVIEW_PORT=9000 PREVIEW_BACKEND_URL=<url> node cloudflare/preview/serve-preview.mjs
//
// Default backend = the Stage-3 Cloudflare staging Worker.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", ".."); // repo root
const PORT = Number(process.env.PREVIEW_PORT || 8788);
const BACKEND = process.env.PREVIEW_BACKEND_URL || "https://biot-dashboard-staging.sw-590.workers.dev";

// Replace ONLY the DASHBOARD_CONFIG object literal. supabaseAnonKey is set to "" because the
// Cloudflare Worker ignores the Supabase anon key (CORS still allows the header); not sending
// it keeps the preview clean.
function rewriteConfig(html) {
  const replacement =
    `window.DASHBOARD_CONFIG = {\n` +
    `      supabaseEdgeUrl: ${JSON.stringify(BACKEND)},\n` +
    `      supabaseAnonKey: ""\n` +
    `    };`;
  const re = /window\.DASHBOARD_CONFIG\s*=\s*\{[\s\S]*?\};/;
  if (!re.test(html)) throw new Error("Could not find DASHBOARD_CONFIG block in index.html");
  return html.replace(re, replacement);
}

function injectBanner(html) {
  const banner =
    `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;` +
    `font:600 12px/1.4 system-ui,sans-serif;text-align:center;padding:4px 8px;letter-spacing:.02em">` +
    `PREVIEW — Cloudflare staging backend (${BACKEND}) — NOT production</div>`;
  return html.replace(/<body([^>]*)>/, `<body$1>${banner}`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json" };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let path = url.pathname;
    if (path === "/" || path === "/index.html" || path === "/preview.html") {
      const raw = await readFile(join(ROOT, "index.html"), "utf8");
      const html = injectBanner(rewriteConfig(raw));
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      res.end(html);
      return;
    }
    // Static assets from repo root (strip query string like ?v=...).
    const safe = path.replace(/\.\.+/g, "").replace(/^\/+/, "");
    const ext = safe.slice(safe.lastIndexOf("."));
    const body = await readFile(join(ROOT, safe));
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${req.url} (${e instanceof Error ? e.message : e})`);
  }
});

server.listen(PORT, () => {
  console.log(`Preview server: http://localhost:${PORT}`);
  console.log(`Backend (Cloudflare staging): ${BACKEND}`);
  console.log(`Production index.html is unmodified; config rewritten in-memory only.`);
});
