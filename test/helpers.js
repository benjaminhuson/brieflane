'use strict';
const http = require('node:http');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { nodeHandler } = require('../src/server');

/** Spin up an isolated app (in-memory PGlite Postgres) on an ephemeral port. */
async function startApp(env = {}, { fetchImpl } = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const isProd = env.NODE_ENV === 'production';
  const base = isProd ? 'https://brieflane.test' : `http://127.0.0.1:${port}`;
  const cfg = loadConfig({ DB_PATH: ':memory:', DATABASE_URL: '', PORT: String(port), BASE_URL: base, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ANTHROPIC_API_KEY: '', ALLOWED_EMAILS: '', DEMO_LOGIN: '', ...env });
  const db = await openDb(cfg);
  const app = createApp({ cfg, db, fetchImpl });
  server.on('request', nodeHandler(app));
  const url = `http://127.0.0.1:${port}`;
  const q = async (sql, params = []) => db.query(sql, params);
  const count = async (sql, params = []) => (await db.query(sql, params))[0].n;

  function client() {
    let cookie = ''; let csrf = '';
    async function req(method, path, body, { noCsrf = false, raw = false } = {}) {
      const headers = { 'content-type': 'application/json', origin: url };
      if (cookie) headers.cookie = cookie;
      if (csrf && !noCsrf && method !== 'GET') headers['x-csrf-token'] = csrf;
      const res = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      if (raw) return res;
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data, headers: res.headers };
    }
    return {
      req,
      async login() { await req('POST', '/auth/dev-login'); const me = await req('GET', '/api/me'); csrf = me.data.csrf; return me.data; },
      setSession(rawToken, token) { cookie = `${cfg.isProd ? '__Host-bl_sid' : 'bl_sid'}=${rawToken}`; csrf = token; },
      get cookie() { return cookie; },
      /** Call a stepped endpoint until it reports no more work. */
      async steps(path) { let r; for (let i = 0; i < 50; i++) { r = await req('POST', path); if (!r.data.more) break; } return r; },
    };
  }
  return { cfg, db, app, base: url, q, count, client, close: async () => { await new Promise((r) => server.close(r)); await db.close(); } };
}

module.exports = { startApp };
