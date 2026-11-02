'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

async function demoWorkspace(env, opts) {
  const s = await startApp(env, opts);
  const c = s.client(); await c.login();
  await c.req('POST', '/api/gmail/connect-demo');
  await c.steps('/api/gmail/sync');
  return { s, c };
}
const runAll = (c) => c.steps('/api/agents/run');
const byBrand = async (c, brand) => (await c.req('GET', '/api/collaborations')).data.find((d) => d.brand === brand);
const detail = async (c, id) => (await c.req('GET', `/api/collaborations/${id}`)).data;

test('stage agents prepare work for each deal and never send anything', async (t) => {
  const { s, c } = await demoWorkspace(); t.after(s.close);
  const r = await runAll(c);
  assert.equal(r.status, 200);
  assert.equal(r.data.more, false);

  // Negotiator: offer vs the rate card, and a counter-offer draft with a [CHECK] decision.
  const lumora = await detail(c, (await byBrand(c, 'Lumora Smart Home')).id);
  const offer = lumora.docs.find((d) => d.kind === 'offer');
  assert.ok(offer, 'offer analysis written');
  assert.match(offer.body, /Offered: £600 \(from email, not agreed\)/);
  assert.match(offer.body, /Rate card total: £1000/);
  assert.match(offer.body, /£400 \(40%\) below your rates/);
  const counter = lumora.drafts.find((d) => d.source === 'agent:negotiating');
  assert.ok(counter && counter.status === 'draft');
  assert.match(counter.body, /\[CHECK/);
  assert.match(counter.generator, /^Negotiator/);
  // Its earlier "new" run was skipped because the deal had already moved on.
  assert.ok(lumora.agentRuns.some((x) => x.agent === 'new' && x.status === 'skipped'));

  // Producer: shot list, outline, and filming tasks scheduled before the go-live date.
  const volt = await detail(c, (await byBrand(c, 'VoltNest')).id);
  assert.ok(volt.docs.find((d) => d.kind === 'shot_list'));
  assert.ok(volt.docs.find((d) => d.kind === 'script_outline'));
  const film = volt.tasks.find((x) => x.title === 'Film VoltNest P3');
  const goLive = volt.facts.find((f) => f.label === 'Go-live date' && f.status === 'active');
  assert.ok(film && new Date(film.due_at) < new Date(goLive.due_at), 'filming is planned before go-live');
  assert.equal(film.source, 'agent:ready_to_film');

  // Logistics and Scout.
  const kestrel = await detail(c, (await byBrand(c, 'Kestrel Tools')).id);
  assert.ok(kestrel.tasks.some((x) => /^Check the Kestrel RT-20 has arrived/.test(x.title)));
  const fil = await detail(c, (await byBrand(c, 'Filamentry')).id);
  assert.ok(fil.docs.find((d) => d.kind === 'fit_check'));
  assert.ok(fil.drafts.find((d) => d.source === 'agent:new'));

  // Agents' work shows on Today and the Planner; nothing was sent.
  const today = (await c.req('GET', '/api/today')).data;
  assert.ok(today.agentActivity.length >= 3);
  const plan = (await c.req('GET', '/api/planner')).data;
  assert.ok(plan.rows.find((x) => x.brand === 'VoltNest').events.some((e) => e.kind === 'task' && e.label === 'Film VoltNest P3'));
  assert.equal(s.app.svc.demo.sent.length, 0, 'agents never send email');
  const drafts = await s.q("SELECT status FROM drafts WHERE source LIKE 'agent:%'");
  assert.ok(drafts.length >= 2 && drafts.every((d) => d.status === 'draft'), 'agent drafts wait for approval');

  // Running again does nothing new (each stage runs once per deal).
  const again = await runAll(c);
  assert.equal(again.data.ran.length, 0);
});

test('moving a deal yourself triggers that stage; switched-off agents stay quiet', async (t) => {
  const { s, c } = await demoWorkspace(); t.after(s.close);
  await runAll(c);
  const volt = await byBrand(c, 'VoltNest');
  const moved = await c.req('PATCH', `/api/collaborations/${volt.id}`, { stage: 'editing' });
  assert.equal(moved.data.agentQueued, true);
  await runAll(c);
  const d = await detail(c, volt.id);
  assert.ok(d.docs.find((x) => x.kind === 'requirements'));
  assert.ok(d.tasks.some((x) => /disclosure/.test(x.title)));
  assert.ok(d.drafts.some((x) => x.source === 'agent:editing'));

  await c.req('POST', '/api/agents/settings', { enabled: { published: false } });
  await c.req('PATCH', `/api/collaborations/${volt.id}`, { stage: 'published' });
  await runAll(c);
  const after = await detail(c, volt.id);
  const run = after.agentRuns.find((x) => x.agent === 'published');
  assert.equal(run.status, 'skipped');
  assert.match(run.summary, /Closer is switched off/);
  assert.ok(!after.tasks.some((x) => /7-day stats/.test(x.title)));

  // Manual "run now" works even when the agent is switched off (you asked for it).
  await c.req('POST', `/api/collaborations/${volt.id}/agent`);
  const manual = await detail(c, volt.id);
  assert.ok(manual.tasks.some((x) => /7-day stats/.test(x.title)));
  assert.ok(manual.tasks.some((x) => /Send invoice to VoltNest \(£1,200\)/.test(x.title)));
});

test('time trigger: a 5-day silence in negotiation produces a nudge draft', async (t) => {
  const { s, c } = await demoWorkspace(); t.after(s.close);
  await runAll(c);
  const lumora = await byBrand(c, 'Lumora Smart Home');
  await s.q("UPDATE drafts SET status='discarded' WHERE collab_id=?", [lumora.id]);
  const old = new Date(Date.now() - 6 * 864e5).toISOString();
  await s.q('UPDATE collaborations SET last_outbound_at=?, last_inbound_at=? WHERE id=?', [old, new Date(Date.now() - 8 * 864e5).toISOString(), lumora.id]);
  await runAll(c);
  const d = await detail(c, lumora.id);
  const nudge = d.drafts.find((x) => x.source === 'agent:negotiating' && x.status === 'draft');
  assert.ok(nudge, 'nudge drafted');
  assert.match(nudge.body, /following up/i);
});

test('old imported deals never trigger agents; tenants are isolated', async (t) => {
  const { s, c } = await demoWorkspace(); t.after(s.close);
  await c.steps('/api/gmail/import-history');
  const review = (await c.req('GET', '/api/review')).data;
  const pf = review.collabs.find((x) => x.brand === 'PrintForge');
  await c.req('POST', `/api/review/collab/${pf.id}`, { action: 'confirm' });
  await runAll(c);
  assert.equal((await s.q('SELECT COUNT(*)::int n FROM agent_runs WHERE collab_id=?', [pf.id]))[0].n, 0);

  const doc = (await s.q('SELECT id FROM deal_docs LIMIT 1'))[0];
  const other = await s.app.svc.createTenantWithUser({ email: 'other@creator.example', name: 'Other' });
  const sess = await s.app.svc.createSession(other);
  const b = s.client(); b.setSession(sess.raw, sess.csrf);
  assert.equal((await b.req('PUT', `/api/docs/${doc.id}`, { body: 'x' })).status, 404);
  assert.equal((await b.req('POST', `/api/docs/${doc.id}/dismiss`)).status, 404);
  assert.equal((await b.req('GET', '/api/agents')).data.runs.length, 0);
  assert.equal((await b.req('POST', '/api/agents/run')).data.ran.length, 0);
});

test('with an AI key, agents use the AI and its output is labelled', async (t) => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const sys = body.system || '';
    let text = 'ok';
    if (/video producer/.test(sys)) text = JSON.stringify({ shot_list: ['AI shot one', 'AI shot two'], outline: ['AI beat'], must_mention: ['USB-C charging'] });
    else if (/Draft an email/.test(sys)) text = 'Hi Priya,\n\nAI draft. [CHECK: confirm date]\n\nBen';
    else if (/\{"brand"/.test(sys) || /extract brand-collaboration/.test(sys)) text = '{"facts":[]}';
    else if (/assess whether/.test(sys)) text = JSON.stringify({ fit: 'strong', reasons: ['Matches 3D printing'], questions: ['Spool count?'] });
    else if (/requirements/.test(sys)) text = JSON.stringify({ requirements: ['Show the app'] });
    else text = '{"description":"Sponsored. [LINK]"}';
    return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
  const { s, c } = await demoWorkspace({ ANTHROPIC_API_KEY: 'test' }, { fetchImpl }); t.after(s.close);
  await runAll(c);
  const volt = await detail(c, (await byBrand(c, 'VoltNest')).id);
  const shots = volt.docs.find((d) => d.kind === 'shot_list');
  assert.match(shots.body, /AI shot one/);
  assert.equal(shots.generator, 'Producer · AI');
  assert.match(volt.docs.find((d) => d.kind === 'script_outline').body, /USB-C charging/);
  const fil = await detail(c, (await byBrand(c, 'Filamentry')).id);
  assert.match(fil.docs.find((d) => d.kind === 'fit_check').body, /STRONG/);
  assert.equal(fil.drafts.find((d) => d.source === 'agent:new').generator, 'Scout · AI');
});
