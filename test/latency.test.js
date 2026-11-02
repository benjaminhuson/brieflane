'use strict';
/**
 * Regression guard for the Netlify (US East) ↔ Supabase (London) setup: every database
 * round trip costs ~80–90ms, so we count round trips per request and keep them small.
 * Parallel queries inside one Promise.all count as one "wave".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const RTT = 85;
function addLatency(db) {
  const stats = { queries: 0 };
  const wrap = (q) => {
    for (const m of ['query', 'run']) {
      const orig = q[m].bind(q);
      q[m] = async (...a) => { stats.queries++; await new Promise((r) => setTimeout(r, RTT)); return orig(...a); };
    }
    const tx = q.tx.bind(q);
    q.tx = (fn) => tx((t) => fn(wrap(t)));
    return q;
  };
  wrap(db);
  return stats;
}

test('pages stay fast when every database query costs a transatlantic round trip', async (t) => {
  const s = await startApp(); t.after(s.close);
  const c = s.client(); await c.login();
  await c.req('POST', '/api/gmail/connect-demo');
  await c.steps('/api/gmail/sync');
  await c.steps('/api/gmail/import-history');
  const stats = addLatency(s.db);

  const budgets = { '/api/today': 900, '/api/planner': 900, '/api/collaborations': 900, '/api/calendar': 900, '/api/review': 900, '/api/badge': 500, '/api/me': 900 };
  const deal = (await c.req('GET', '/api/collaborations')).data[0];
  budgets[`/api/collaborations/${deal.id}`] = 900;
  for (const [path, maxMs] of Object.entries(budgets)) {
    const q0 = stats.queries; const t0 = Date.now();
    const r = await c.req('GET', path);
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, path);
    if (process.env.SHOW_TIMINGS) console.log(`TIMING ${path.replace(/col_[^/]+/, ':id')} ${ms}ms ${stats.queries - q0} queries`);
    assert.ok(ms < maxMs, `${path} took ${ms}ms with ${stats.queries - q0} queries (budget ${maxMs}ms)`);
  }

  // Ingesting one collaboration email should cost a handful of round trips, not dozens.
  const { forTenant } = require('../src/repo');
  const { ingestMessages } = require('../src/ingest/pipeline');
  const tid = (await s.q("SELECT tenant_id FROM users WHERE email LIKE '%demo.brieflane.local'"))[0].tenant_id;
  const repo = forTenant(s.db, tid);
  const t0 = Date.now();
  await ingestMessages({ db: s.db, repo, llm: s.app.llm }, [{
    gmailId: 'lat-1', threadId: 'lat-t1', sentAt: new Date().toISOString(), direction: 'in', fromAddr: 'amy@newbrand.example', fromName: 'Amy',
    subject: 'Sponsored video', body: "I'm Amy from NewBrand. We'd love to sponsor a dedicated video. Our budget is £400 and it should go live by 30 November.",
  }]);
  const ms = Date.now() - t0;
  if (process.env.SHOW_TIMINGS) console.log(`TIMING ingest-one-email ${ms}ms`);
  assert.ok(ms < 2000, `ingesting one email took ${ms}ms`);
});
