'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { forTenant } = require('../src/repo');
const { ingestMessages, setStageByUser } = require('../src/ingest/pipeline');
const { makeLlm } = require('../src/ai/llm');
const { makeDemoProvider } = require('../src/gmail/demo');

const llm = makeLlm({ anthropic: { apiKey: '' } });
async function setup(t) {
  const db = await openDb({ dbPath: ':memory:' });
  t.after(() => db.close());
  await db.exec("INSERT INTO tenants (id, name, created_at) VALUES ('ten_1','T1','2026-01-01'), ('ten_2','T2','2026-01-01')");
  return { db, repo: forTenant(db, 'ten_1') };
}
const NOW = new Date('2026-10-31T12:00:00Z');
const m = (id, thread, daysAgo, dir, body, from = { addr: 'sam@brightcam.example', name: 'Sam Lee' }) => ({
  gmailId: id, threadId: thread, sentAt: new Date(NOW - daysAgo * 864e5).toISOString(), direction: dir,
  fromAddr: dir === 'out' ? 'me@x.example' : from.addr, fromName: dir === 'out' ? 'Me' : from.name, subject: 'Sponsored video', body,
});
const ingest = (ctx, msgs, opts) => ingestMessages({ ...ctx, llm, now: NOW }, msgs, opts);

test('same message ingested twice is stored once', async (t) => {
  const ctx = await setup(t);
  const msg = m('a1', 't1', 2, 'in', "I'm Sam Lee from BrightCam. We'd like to sponsor a dedicated video. Budget £500.");
  await ingest(ctx, [msg]);
  const r = await ingest(ctx, [msg]);
  assert.equal(r.skippedDuplicate, 1);
  assert.equal((await ctx.repo.collabs()).length, 1);
  assert.equal((await ctx.db.query('SELECT COUNT(*)::int n FROM messages'))[0].n, 1);
});

test('conversation progress updates the same collaboration and supersedes changed values', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx, [
    m('b1', 't1', 6, 'in', "I'm Sam Lee from BrightCam. We'd like to sponsor a dedicated video. Our budget is £500 and the video should go live by 20 November."),
    m('b2', 't1', 5, 'out', 'Thanks Sam, my rate is £800.'),
  ]);
  // A new thread from the same brand domain also merges into the open collaboration.
  await ingest(ctx, [m('b3', 't2', 1, 'in', 'Hi again, we can do £650 if the video goes live by 27 November instead. The unit has been shipped, tracking number ZX12345678.')]);
  const cs = await ctx.repo.collabs();
  assert.equal(cs.length, 1);
  const c = cs[0];
  const facts = await ctx.repo.facts(c.id, { statuses: ['active', 'superseded'] });
  const activeFee = facts.filter((f) => f.slot === 'payment:fee' && f.status === 'active');
  assert.equal(activeFee.length, 1);
  assert.equal(activeFee[0].value, '£650');
  assert.match(activeFee[0].label, /not agreed/);
  const goLive = facts.filter((f) => f.slot === 'deadline:Go-live date');
  assert.equal(goLive.find((f) => f.status === 'active').due_at.slice(0, 10), '2026-11-27');
  assert.ok(goLive.find((f) => f.status === 'superseded'), 'old deadline kept as history');
  assert.equal(c.stage, 'awaiting_delivery');
  assert.equal(c.stage_basis, 'inferred');
});

test('newest email wins even when messages arrive out of order (Gmail returns newest first)', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx, [m('o3', 't1', 1, 'in', "I'm Sam Lee from BrightCam. We can do £650 for a dedicated video.")]);
  await ingest(ctx, [m('o1', 't1', 6, 'in', "I'm Sam Lee from BrightCam. Our budget is £500 for a dedicated video.")]);
  const c = (await ctx.repo.collabs())[0];
  const fees = (await ctx.repo.facts(c.id, { statuses: ['active', 'superseded'] })).filter((f) => f.slot === 'payment:fee');
  assert.equal(fees.find((f) => f.status === 'active').value, '£650');
  assert.equal(fees.find((f) => f.status === 'superseded').value, '£500');
});

test('a stage set by the creator is never overridden by inference', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx, [m('c1', 't1', 3, 'in', "I'm Sam Lee from BrightCam. We'd like to sponsor a dedicated video.")]);
  const cid = (await ctx.repo.collabs())[0].id;
  await setStageByUser(ctx.repo, cid, 'editing', 'u1');
  await ingest(ctx, [m('c2', 't1', 1, 'in', 'The unit has been shipped, tracking number ZX12345678.')]);
  const c = await ctx.repo.collab(cid);
  assert.equal(c.stage, 'editing');
  assert.equal(c.stage_basis, 'user');
});

test('historical import sends old deals to review instead of the live tracker', async (t) => {
  const ctx = await setup(t);
  const demo = makeDemoProvider(() => NOW);
  const r = await ingest(ctx, await demo.historical(), { via: 'history' });
  assert.ok(r.toReview > 0);
  assert.equal((await ctx.repo.collabs()).length, 0, 'nothing historical is live until confirmed');
  const review = await ctx.repo.reviewCollabs();
  assert.equal(review.length, 2);
  for (const c of review) for (const f of (await ctx.repo.facts(c.id)).filter((x) => x.kind !== 'contact')) assert.equal(f.status, 'pending_review');
});

test('non-collaboration mail is recorded by id only — no subject or body', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx, [m('d1', 't9', 1, 'in', 'Order confirmation #8. Your order has been received.', { addr: 'orders@shop.example', name: 'Shop' })]);
  const row = (await ctx.db.query("SELECT * FROM messages WHERE gmail_id='d1'"))[0];
  assert.equal(row.is_collab, 0);
  assert.equal(row.body, null); assert.equal(row.subject, null); assert.equal(row.from_addr, null);
});

test('repo is tenant-scoped: another tenant cannot see or touch the data', async (t) => {
  const ctx = await setup(t);
  await ingest(ctx, [m('e1', 't1', 1, 'in', "I'm Sam Lee from BrightCam. We'd like to sponsor a dedicated video.")]);
  const cid = (await ctx.repo.collabs())[0].id;
  const other = forTenant(ctx.db, 'ten_2');
  assert.equal(await other.collab(cid), null);
  assert.equal((await other.collabs()).length, 0);
  await other.updateCollab(cid, { brand: 'Hacked' });
  assert.equal((await ctx.repo.collab(cid)).brand, 'BrightCam');
  assert.throws(() => forTenant(ctx.db, ''), /tenantId required/);
});

test('schema locks Supabase public API roles out of every table (RLS on)', async (t) => {
  const ctx = await setup(t);
  const rows = await ctx.db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace");
  assert.ok(rows.length >= 12);
  for (const r of rows) assert.equal(r.relrowsecurity, true, `${r.relname} has RLS`);
});
