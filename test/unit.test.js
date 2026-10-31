'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCipher } = require('../src/crypto');
const { classify } = require('../src/ingest/classify');
const { extract, inferStage, verifyQuote } = require('../src/ingest/extract');
const { findDate, brandFromDomain } = require('../src/ingest/text');
const { makeLlm, llmExtract } = require('../src/ai/llm');
const { templateDraft, CHECK } = require('../src/ai/drafts');

const key = require('node:crypto').randomBytes(32).toString('base64');
const msg = (body, extra = {}) => ({ gmailId: 'g1', threadId: 't1', fromAddr: 'anna@acme-tools.example', fromName: 'Anna Ross', subject: 'Collab', sentAt: '2026-10-30T10:00:00.000Z', direction: 'in', body, ...extra });

test('token encryption round-trips and is bound to the tenant', () => {
  const c = makeCipher(key);
  const blob = c.encrypt('refresh-token-123', 'ten_A');
  assert.notEqual(blob, 'refresh-token-123');
  assert.equal(c.decrypt(blob, 'ten_A'), 'refresh-token-123');
  assert.throws(() => c.decrypt(blob, 'ten_B'), 'decrypting under another tenant must fail');
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => c.decrypt(tampered, 'ten_A'));
});

test('classifier keeps collaboration mail and skips receipts / notifications', () => {
  assert.equal(classify(msg('Hi! We would love to sponsor a dedicated video on your channel. Our budget is £500.')).isCollab, true);
  assert.equal(classify(msg('Order confirmation #123. Your order has been received.')).isCollab, false);
  assert.equal(classify(msg('Password reset requested', { fromAddr: 'noreply@site.example' })).isCollab, false);
  assert.equal(classify(msg('ok thanks'), { threadKnown: true }).isCollab, true, 'follow-ups in tracked threads are kept');
});

test('fees are "not agreed" unless explicit agreement wording is present', () => {
  const a = extract(msg("I'm Anna Ross from Acme Tools. Our budget is £450 for a 60-second integration."));
  const fee = a.facts.find((f) => f.kind === 'payment');
  assert.equal(fee.value, '£450');
  assert.match(fee.label, /not agreed/);
  assert.equal(a.facts.some((f) => f.kind === 'agreement'), false);
  assert.equal(a.brand, 'Acme Tools');

  const b = extract(msg("We're happy to proceed at £600. The contract has been signed."));
  assert.ok(b.facts.find((f) => f.kind === 'agreement'));
  assert.match(b.facts.find((f) => f.kind === 'payment').label, /agreement language present/);
});

test('every email-backed fact quotes text that actually exists in the email', () => {
  const m = msg('The unit has been shipped today with DPD, tracking number DP4471982265GB. We need the draft by 12 November and the video live by 19 November.');
  const r = extract(m);
  for (const f of r.facts.filter((x) => x.basis === 'email' && x.kind !== 'contact')) assert.ok(verifyQuote(f.quote, m.body), `${f.kind} quote missing`);
  const dates = r.facts.filter((f) => f.kind === 'deadline').map((f) => f.dueAt.slice(0, 10)).sort();
  assert.deepEqual(dates, ['2026-11-12', '2026-11-19']);
  assert.ok(r.facts.find((f) => f.label === 'Tracking' && f.value.includes('DP4471982265GB')));
});

test('date parsing resolves relative to the message date', () => {
  assert.equal(findDate('live by 3 January', '2026-12-20T00:00:00Z').iso.slice(0, 10), '2027-01-03');
  assert.equal(findDate('due 14/11/2026', '2026-10-01T00:00:00Z').iso.slice(0, 10), '2026-11-14');
  assert.equal(findDate('by Friday', '2026-10-28T09:00:00Z').iso.slice(0, 10), '2026-10-30');
  assert.equal(findDate('no dates here', '2026-10-28T09:00:00Z'), null);
});

test('brand from domain is inferred, agency outreach captures the client brand', () => {
  assert.equal(brandFromDomain('mail.kestrel-tools.co.uk'), 'Kestrel Tools');
  assert.equal(brandFromDomain('gmail.com'), null);
  const r = extract(msg("I'm Priya from Northbeam, reaching out on behalf of VoltNest. We'd love a dedicated video.", { fromAddr: 'priya@northbeam.example' }));
  assert.equal(r.brand, 'VoltNest');
  assert.equal(r.agency, 'Northbeam');
});

test('stage inference: shipping → awaiting delivery, delivered → ready to film, never "agreed" from a reply alone', () => {
  const out = [{ id: 'm2', direction: 'out' }];
  assert.equal(inferStage({ messages: [{ id: 'm1', direction: 'in' }], facts: [] }).stage, 'new');
  assert.equal(inferStage({ messages: out, facts: [] }).stage, 'negotiating');
  assert.equal(inferStage({ messages: out, facts: [{ kind: 'shipping', label: 'Tracking', value: 'X', status: 'active' }] }).stage, 'awaiting_delivery');
  assert.equal(inferStage({ messages: out, facts: [{ kind: 'shipping', label: 'Shipment status', value: 'Delivered', status: 'active' }] }).stage, 'ready_to_film');
});

test('LLM output is quote-verified: hallucinated quotes are downgraded and fake agreements dropped', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    brand: 'Acme', facts: [
      { kind: 'payment', label: 'Agreed fee', value: '£900', quote: 'We agree to pay £900' },          // not in email
      { kind: 'agreement', label: 'Agreed', value: 'deal agreed', quote: 'Our budget is £450' },       // quote exists, but no agreement wording
      { kind: 'deliverable', label: 'Deliverable', value: 'Integration', quote: '60-second integration' },
    ] }) }] }) });
  const llm = makeLlm({ anthropic: { apiKey: 'test', model: 'm' } }, fakeFetch);
  const m = msg('Our budget is £450 for a 60-second integration.');
  const r = await llmExtract(llm, m, extract(m));
  const fee = r.facts.find((f) => f.value === '£900');
  assert.equal(fee.basis, 'inferred', 'unverifiable quote must not count as email evidence');
  assert.equal(r.facts.some((f) => f.kind === 'agreement'), false, 'agreement requires explicit wording');
  assert.equal(r.facts.find((f) => f.value === 'Integration').basis, 'email');
});

test('template drafts never commit: open decisions are [CHECK] placeholders', () => {
  const body = templateDraft({ stage: 'negotiating', brand: 'Lumora' }, { fee: { value: '£600' }, deadlines: [{ label: 'Go-live date', date: '2026-11-19' }], deliverables: [], shipping: [] }, { from_name: 'Marcus Lee' });
  assert.match(body, CHECK);
  assert.doesNotMatch(body, /\b(I agree|I accept|confirmed|deal)\b/i);
});
