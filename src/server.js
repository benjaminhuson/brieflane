'use strict';
/** Local server: serves public/ and adapts Node's http to the framework-agnostic app. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };

function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', reject);
  });
}

function serveStatic(pathname, res, headers) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC, 'index.html');
    const ext = path.extname(target);
    res.writeHead(200, { ...headers, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(target).pipe(res);
  });
}

function nodeHandler(app) {
  return async (req, res) => {
    const pathname = req.url.split('?')[0];
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/auth/');
    if (!isApi && req.method === 'GET') return serveStatic(pathname, res, require('./app').SECURITY_HEADERS);
    let body = null;
    try { body = req.method === 'GET' ? null : await readBody(req); } catch { res.writeHead(413); return res.end(); }
    const out = await app.handleRequest({ method: req.method, url: req.url, headers: req.headers, body, ip: req.socket.remoteAddress });
    if (out.cookies.length) out.headers['Set-Cookie'] = out.cookies;
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  };
}

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg);
  const app = createApp({ cfg, db });
  await app.svc.runRetention();
  setInterval(() => app.svc.runRetention().catch(() => {}), 6 * 3600e3).unref();
  http.createServer(nodeHandler(app)).listen(cfg.port, () => {
    console.log(`Brieflane running at ${cfg.baseUrl}`);
    console.log(`  Database: ${cfg.databaseUrl ? 'Postgres (DATABASE_URL)' : `local PGlite at ${cfg.dbPath}`}`);
    console.log(`  Gmail:    ${cfg.googleConfigured ? 'Google OAuth configured' : 'DEMO INBOX (Google OAuth not configured)'}`);
    console.log(`  AI:       ${app.llm.label}`);
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { nodeHandler };
