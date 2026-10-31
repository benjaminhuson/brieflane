'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('end-to-end: demo inbox → dashboard → draft → approve → send (with every safety gate)', async (t) => {
  const s = await startApp(); t.after(s.close);
  const c = s.client();

  assert.equal((await c.req('GET', '/api/me')).status, 401, 'API requires a session');
  await c.login();
  assert.equal((await c.req('POST', '/api/gmail/connect-demo', null, { noCsrf: true })).status, 403, 'CSRF token required');
  assert.equal((await c.req('POST', '/api/gmail/connect-demo')).status, 200);
  const sync = await c.steps('/api/gmail/sync');
  assert.equal(sync.data.collabsCreated, 4);
  assert.equal(sync.data.ignored, 3);
  assert.equal((await c.req('POST', '/api/gmail/sync')).data.collabMessages, 0, 'second sync is idempotent');

  const today = (await c.req('GET', '/api/today')).data;
  assert.ok(today.attention.length >= 4);
  assert.ok(today.briefing.lines.length);
  assert.equal(today.hasDemoData, true);

  const deals = (await c.req('GET', '/api/collaborations')).data;
  const lumora = deals.find((d) => d.brand === 'Lumora Smart Home');
  assert.equal(lumora.stage, 'negotiating');
  assert.equal(lumora.hasAgreement, false);
  assert.equal(lumora.fee.value, '£600');
  assert.ok(deals.find((d) => d.brand === 'VoltNest').hasAgreement);

  // Draft
  const draft = (await c.req('POST', `/api/collaborations/${lumora.id}/drafts`)).data;
  assert.equal(draft.status, 'draft');
  assert.match(draft.body, /\[CHECK/);
  const blocked = await c.req('POST', `/api/drafts/${draft.id}/approve`);
  assert.equal(blocked.status, 422, 'unresolved [CHECK] placeholders block approval');
  assert.equal((await c.req('POST', `/api/drafts/${draft.id}/send`, { confirm: true })).status, 409, 'cannot send an unapproved draft');

  const body = 'Hi Marcus,\n\n£600 for the integration and a Short works for me. Draft by 12 Nov is fine.\n\nBen';
  await c.req('PUT', `/api/drafts/${draft.id}`, { body });
  assert.equal((await c.req('POST', `/api/drafts/${draft.id}/approve`)).data.status, 'approved');

  // Editing after approval voids it
  await c.req('PUT', `/api/drafts/${draft.id}`, { body: `${body}\nThanks!` });
  assert.equal((await c.req('POST', `/api/drafts/${draft.id}/send`, { confirm: true })).status, 409, 'edit after approval requires re-approval');
  await c.req('POST', `/api/drafts/${draft.id}/approve`);

  assert.equal((await c.req('POST', `/api/drafts/${draft.id}/send`, {})).status, 400, 'explicit confirm flag required');
  const noScope = await c.req('POST', `/api/drafts/${draft.id}/send`, { confirm: true });
  assert.equal(noScope.status, 403);
  assert.equal(noScope.data.needsSendPermission, true, 'send permission is separate from read');

  await c.req('POST', '/api/gmail/enable-send');
  const sent = await c.req('POST', `/api/drafts/${draft.id}/send`, { confirm: true });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.status, 'sent');
  assert.equal(sent.data.simulated, true);
  assert.equal(s.app.svc.demo.sent.length, 1);

  const detail = (await c.req('GET', `/api/collaborations/${lumora.id}`)).data;
  assert.equal(detail.messages.at(-1).direction, 'out');
  assert.equal(detail.messages.at(-1).imported_via, 'sent-by-app');
  const after = (await c.req('GET', '/api/today')).data;
  assert.equal(after.attention.some((a) => a.id === `reply:${lumora.id}`), false, 'reply action clears once you reply');
  // The fee is still not agreed: sending a reply does not create agreement evidence on its own.
  assert.equal((await c.req('GET', '/api/collaborations')).data.find((d) => d.id === lumora.id).hasAgreement, false);
});

test('review queue: historical import and past-chat notes only count after confirmation', async (t) => {
  const s = await startApp(); t.after(s.close);
  const c = s.client(); await c.login();
  await c.req('POST', '/api/gmail/connect-demo');
  const imp = await c.steps('/api/gmail/import-history');
  assert.equal(imp.data.more, false);
  assert.ok((await c.req('GET', '/api/me')).data.gmail.historyImportedAt);
  const review = (await c.req('GET', '/api/review')).data;
  const notes = review.collabs.filter((x) => x.stage_basis === 'historical_note');
  assert.deepEqual(notes.map((n) => n.brand).sort(), ['Botslab', 'Outsunny', 'WOTOKOL']);
  const before = (await c.req('GET', '/api/collaborations')).data.map((d) => d.brand);
  assert.ok(!before.includes('PrintForge') && !before.includes('Botslab'));

  const pf = review.collabs.find((x) => x.brand === 'PrintForge');
  await c.req('POST', `/api/review/collab/${pf.id}`, { action: 'confirm' });
  await c.req('POST', `/api/review/collab/${notes[0].id}`, { action: 'dismiss' });
  const now = (await c.req('GET', '/api/collaborations')).data;
  assert.ok(now.find((d) => d.brand === 'PrintForge'));
  assert.equal(now.find((d) => d.brand === notes[0].brand), undefined);
});

test('tenant isolation over HTTP: another creator gets 404s, never data', async (t) => {
  const s = await startApp(); t.after(s.close);
  const a = s.client(); await a.login();
  await a.req('POST', '/api/gmail/connect-demo'); await a.steps('/api/gmail/sync');
  const deal = (await a.req('GET', '/api/collaborations')).data[0];
  const draft = (await a.req('POST', `/api/collaborations/${deal.id}/drafts`)).data;

  const user = await s.app.svc.createTenantWithUser({ email: 'other@creator.example', name: 'Other' });
  const sess = await s.app.svc.createSession(user);
  const b = s.client(); b.setSession(sess.raw, sess.csrf);
  assert.equal((await b.req('GET', '/api/collaborations')).data.length, 0);
  assert.equal((await b.req('GET', `/api/collaborations/${deal.id}`)).status, 404);
  assert.equal((await b.req('PATCH', `/api/collaborations/${deal.id}`, { stage: 'published' })).status, 404);
  assert.equal((await b.req('PUT', `/api/drafts/${draft.id}`, { body: 'x' })).status, 404);
  assert.equal((await b.req('POST', `/api/drafts/${draft.id}/send`, { confirm: true })).status, 404);
  assert.equal((await b.req('POST', `/api/collaborations/${deal.id}/drafts`)).status, 404);
  // B's CSRF token doesn't work with A's session either.
  assert.equal((await a.req('POST', '/api/gmail/sync', null, { noCsrf: true })).status, 403);
});

test('Google OAuth (mocked): least-privilege scopes, PKCE, tokens encrypted at rest, revoked on disconnect', async (t) => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(opts.body);
      assert.ok(p.get('code_verifier'), 'PKCE verifier sent');
      return { ok: true, json: async () => ({ access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', expires_in: 3600, scope: p.get('code') === 'read' ? 'openid email https://www.googleapis.com/auth/gmail.readonly' : 'openid email' }) };
    }
    if (String(url).includes('userinfo')) return { ok: true, json: async () => ({ sub: 'g-123', email: 'ben@example.com', email_verified: true, name: 'Ben' }) };
    if (String(url).includes('/revoke')) return { ok: true, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const s = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' }, { fetchImpl }); t.after(s.close);
  const c = s.client();

  // Sign-in asks only for identity scopes.
  const start = await c.req('GET', '/auth/google/start?purpose=signin', null, { raw: true });
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.searchParams.get('scope'), 'openid email profile');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const cb = await c.req('GET', `/auth/google/callback?code=signin&state=${loc.searchParams.get('state')}`, null, { raw: true });
  assert.equal(cb.headers.get('location'), '/#/today');
  const me = (await c.req('GET', '/api/me')).data;
  assert.equal(me.user.email, 'ben@example.com');
  c.setSession(c.cookie.split('=')[1], me.csrf);

  // Gmail connect asks for gmail.readonly only — not send.
  const g = new URL((await c.req('GET', '/auth/google/start?purpose=gmail_read', null, { raw: true })).headers.get('location'));
  assert.ok(g.searchParams.get('scope').includes('gmail.readonly'));
  assert.ok(!g.searchParams.get('scope').includes('gmail.send'));
  assert.equal(g.searchParams.get('include_granted_scopes'), 'true');
  await c.req('GET', `/auth/google/callback?code=read&state=${g.searchParams.get('state')}`, null, { raw: true });
  const conn = (await s.q('SELECT * FROM gmail_connections'))[0];
  assert.ok(conn.enc_refresh.startsWith('v1:'));
  const dump = JSON.stringify(await s.q('SELECT * FROM gmail_connections'));
  assert.ok(!dump.includes('REFRESH-SECRET') && !dump.includes('ACCESS-SECRET'), 'no plaintext tokens in the database');
  assert.equal((await c.req('GET', '/api/me')).data.gmail.canSend, false);

  // State can't be replayed.
  assert.match((await c.req('GET', `/auth/google/callback?code=read&state=${g.searchParams.get('state')}`, null, { raw: true })).headers.get('location'), /oauth_error/);

  // Export never includes tokens; disconnect revokes.
  const exp = await c.req('GET', '/api/privacy/export');
  assert.ok(!JSON.stringify(exp.data).includes('enc_refresh'));
  await c.req('POST', '/api/gmail/disconnect', { purge: true });
  assert.ok(calls.some((x) => x.url.includes('/revoke?token=REFRESH-SECRET')));
  assert.equal(await s.count('SELECT COUNT(*)::int n FROM gmail_connections'), 0);
});

test('privacy: retention purges old bodies; account deletion removes every tenant row', async (t) => {
  const s = await startApp(); t.after(s.close);
  const c = s.client(); await c.login();
  await c.req('POST', '/api/gmail/connect-demo'); await c.steps('/api/gmail/sync');
  assert.equal((await c.req('POST', '/api/privacy/retention', { days: 5 })).status, 400, 'minimum 30 days');
  await s.q("UPDATE messages SET sent_at='2020-01-01T00:00:00.000Z' WHERE is_collab=1 AND gmail_id LIKE 'demo-kestrel%'");
  await c.req('POST', '/api/privacy/retention', { days: 30 });
  assert.equal(await s.count("SELECT COUNT(*)::int n FROM messages WHERE gmail_id LIKE 'demo-kestrel%' AND body IS NOT NULL"), 0);
  assert.ok(await s.count('SELECT COUNT(*)::int n FROM facts WHERE evidence_quote IS NOT NULL') > 0, 'evidence quotes survive retention');

  assert.equal((await c.req('POST', '/api/privacy/delete-account', { confirm: 'nope' })).status, 400);
  assert.equal((await c.req('POST', '/api/privacy/delete-account', { confirm: 'DELETE' })).status, 200);
  for (const tbl of ['tenants', 'users', 'sessions', 'messages', 'collaborations', 'facts', 'drafts', 'gmail_connections', 'audit']) {
    assert.equal(await s.count(`SELECT COUNT(*)::int n FROM ${tbl}`), 0, `${tbl} emptied`);
  }
  assert.equal((await c.req('GET', '/api/me')).status, 401);
});

test('security headers and dev-login lockdown in production', async (t) => {
  const s = await startApp(); t.after(s.close);
  const res = await fetch(`${s.base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const p = await startApp({ NODE_ENV: 'production', TOKEN_ENC_KEY: require('node:crypto').randomBytes(32).toString('base64') }); t.after(p.close);
  assert.equal((await p.client().req('POST', '/auth/dev-login')).status, 403);
  const cross = await fetch(`${s.base}/auth/dev-login`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403, 'cross-origin login refused');
});

test('private beta allowlist and demo-workspace isolation', async (t) => {
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/token')) return { ok: true, json: async () => ({ access_token: 'A', expires_in: 3600, scope: 'openid email' }) };
    if (String(url).includes('userinfo')) return { ok: true, json: async () => ({ sub: 'g-9', email: 'stranger@example.com', email_verified: true }) };
    throw new Error('unexpected');
  };
  const s = await startApp({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', ALLOWED_EMAILS: 'ben@example.com' }, { fetchImpl }); t.after(s.close);
  const c = s.client();
  const loc = new URL((await c.req('GET', '/auth/google/start?purpose=signin', null, { raw: true })).headers.get('location'));
  const cb = await c.req('GET', `/auth/google/callback?code=x&state=${loc.searchParams.get('state')}`, null, { raw: true });
  assert.match(decodeURIComponent(cb.headers.get('location')), /private beta/);
  assert.equal(await s.count('SELECT COUNT(*)::int n FROM users'), 0, 'no account created for non-allowlisted email');

  // The shared demo workspace can never start a real Gmail connection, but can use the demo inbox.
  await c.login();
  const g = await c.req('GET', '/auth/google/start?purpose=gmail_read', null, { raw: true });
  assert.equal(g.status, 403);
  assert.equal((await c.req('POST', '/api/gmail/connect-demo')).status, 200);
});

test('works with Netlify-style budgeted steps: tiny budget still completes across calls', async (t) => {
  const s = await startApp({ STEP_BUDGET_MS: '1' }); t.after(s.close);
  const c = s.client(); await c.login();
  await c.req('POST', '/api/gmail/connect-demo');
  const first = await c.req('POST', '/api/gmail/sync');
  assert.equal(first.data.more, true, 'first step stops early');
  const done = await c.steps('/api/gmail/sync');
  assert.equal(done.data.more, false);
  assert.equal((await c.req('GET', '/api/collaborations')).data.length, 4);
});
