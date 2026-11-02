'use strict';
const { classify } = require('./classify');
const { extract, inferStage } = require('./extract');
const { brandKey } = require('./text');
const { llmExtract } = require('../ai/llm');
const { STAGES } = require('../repo');

const AUTO_STAGES = ['new', 'negotiating', 'awaiting_delivery', 'ready_to_film'];
const HISTORICAL_AGE_DAYS = 30;

function newStats() {
  return { seen: 0, skippedDuplicate: 0, ignored: 0, collabMessages: 0, collabsCreated: 0, collabsUpdated: new Set(), factsAdded: 0, superseded: 0, toReview: 0 };
}
function finishStats(s) { return { ...s, collabsUpdated: s.collabsUpdated.size }; }

/**
 * Ingest normalized messages (Gmail or demo) for one tenant.
 *
 * Dedupe and update rules:
 *  - A Gmail message id is ingested once per tenant (UNIQUE + check).
 *  - Non-collaboration mail is recorded by id only (no subject/body kept) so it's never re-fetched.
 *  - Thread already linked → same collaboration; else an open collaboration with the same brand key → same.
 *  - Facts dedupe on value_key. In a slot (e.g. the fee, the go-live date) the value from the NEWEST
 *    email is active and older ones are superseded — regardless of the order messages arrive in.
 *  - Historical imports (older than 30 days) land in Review: collaboration needs_review, facts pending_review.
 *  - Stage auto-advances only forward, only within new→ready to film, never over a creator-set stage.
 */
async function ingestMessages({ db, repo, llm, now = new Date() }, messages, { via = 'sync', stats = newStats() } = {}) {
  for (const msg of messages) await ingestOne({ db, repo, llm, now }, msg, via, stats);
  return finishStats(stats);
}

async function ingestOne({ repo, llm, now }, msg, via, stats) {
  stats.seen++;
  const [known, linked] = await Promise.all([repo.hasMessage(msg.gmailId), repo.collabByThread(msg.threadId)]);
  if (known) { stats.skippedDuplicate++; return; }

  const cls = classify(msg, { threadKnown: Boolean(linked) });
  const skip = (r = repo) => r.insertMessage({ gmailId: msg.gmailId, threadId: msg.threadId, isCollab: false, importedVia: via, isDemo: msg.isDemo });
  if (!cls.isCollab) { await skip(); stats.ignored++; return; }

  const ex = await llmExtract(llm, msg, extract(msg)); // async LLM work happens outside the transaction
  const historical = via === 'history' && (now - new Date(msg.sentAt)) / 864e5 > HISTORICAL_AGE_DAYS;

  await repo.db.tx(async (t) => {
    const r = repo.withDb(t);
    let collab = linked;
    if (!collab && msg.direction === 'in') collab = await r.openCollabByBrand(brandKey(ex.brand));
    if (!collab && msg.direction === 'out') { await skip(r); stats.ignored++; return; } // outbound mail outside tracked threads: id only

    let cid;
    if (!collab) {
      cid = await r.createCollab({ brand: ex.brand, brandKey: brandKey(ex.brand), agency: ex.agency, product: ex.product, kind: cls.kind,
        needsReview: historical, isDemo: msg.isDemo, createdAt: msg.sentAt });
      stats.collabsCreated++;
    } else cid = collab.id;

    const mid = require('../crypto').id('msg');
    const [current, fresh] = await Promise.all([
      r.facts(cid),
      collab ? Promise.resolve(collab) : r.collab(cid),
      r.linkThread(msg.threadId, cid),
      r.insertMessageWithId(mid, {
        gmailId: msg.gmailId, threadId: msg.threadId, isCollab: true, collabId: cid, fromAddr: msg.fromAddr, fromName: msg.fromName,
        toAddr: msg.toAddr, subject: msg.subject, sentAt: msg.sentAt, snippet: msg.snippet || (msg.body || '').slice(0, 160),
        body: msg.body, direction: msg.direction, messageIdHeader: msg.messageIdHeader, classifyReason: cls.reasons.join('; '), importedVia: via, isDemo: msg.isDemo,
      }),
    ]);
    collab = fresh;
    stats.collabMessages++; stats.collabsUpdated.add(cid);

    const review = historical || Boolean(collab.needs_review);
    const candidates = [];
    if (ex.brandBasis === 'email' && ex.brandQuote) candidates.push([{ kind: 'brand', label: 'Brand', value: ex.brand, slot: 'brand', basis: 'email', quote: ex.brandQuote, confidence: 0.8, valueKey: `brand:${brandKey(ex.brand)}` }, review]);
    for (const f of ex.facts) candidates.push([f, review && f.kind !== 'contact']);
    const { inserts, supersede } = planFacts(current, candidates, { cid, mid, sentAt: msg.sentAt, stats });
    await r.addFacts(inserts);
    await r.supersedeFacts(supersede);

    const patch = {};
    if (!collab.product && ex.product) patch.product = ex.product;
    if (msg.direction === 'in' && (!collab.last_inbound_at || msg.sentAt > collab.last_inbound_at)) patch.last_inbound_at = msg.sentAt;
    if (msg.direction === 'out' && (!collab.last_outbound_at || msg.sentAt > collab.last_outbound_at)) patch.last_outbound_at = msg.sentAt;
    await refreshDerived(r, cid, { now, collab: { ...collab, ...patch }, extra: patch });
  });
}

/**
 * Decide, in memory, which extracted facts are new and which existing ones they replace.
 * Rules: dedupe on value_key; within a slot the NEWEST email's value is current and older
 * values are superseded, regardless of the order messages arrive in.
 */
function planFacts(current, candidates, { cid, mid, sentAt, stats }) {
  const { id } = require('../crypto');
  const live = current.map((x) => ({ ...x }));       // active + pending_review facts, mutable working copy
  const inserts = []; const supersede = [];
  for (const [f, toReview] of candidates) {
    if (live.some((x) => x.value_key === f.valueKey)) continue;
    const prior = f.slot ? live.filter((x) => x.slot === f.slot) : [];
    const newer = prior.find((p) => p.evidence_at && p.evidence_at > sentAt);
    const row = { id: id('fct'), collabId: cid, kind: f.kind, label: f.label, value: f.value, valueKey: f.valueKey, slot: f.slot,
      dueAt: f.dueAt, basis: f.basis, evidenceMsg: mid, evidenceQuote: f.quote, evidenceAt: sentAt, confidence: f.confidence };
    stats.factsAdded++;
    if (newer) { inserts.push({ ...row, status: 'superseded', supersededBy: newer.id }); stats.superseded++; continue; }
    row.status = toReview ? 'pending_review' : 'active';
    inserts.push(row);
    if (toReview) stats.toReview++;
    for (const p of prior) {
      const pending = inserts.find((x) => x.id === p.id);
      if (pending) Object.assign(pending, { status: 'superseded', supersededBy: row.id });
      else supersede.push({ id: p.id, by: row.id });
      stats.superseded++;
      live.splice(live.indexOf(p), 1);
    }
    live.push({ id: row.id, value_key: f.valueKey, slot: f.slot, evidence_at: sentAt, status: row.status });
  }
  return { inserts, supersede };
}

/** Recompute inferred stage and the suggested next action for one collaboration. */
async function refreshDerived(repo, cid, { now = new Date(), collab = null, extra = {} } = {}) {
  const [c0, messages, facts] = await Promise.all([collab ? Promise.resolve(collab) : repo.collab(cid), repo.messagesForCollab(cid), repo.facts(cid, { statuses: ['active'] })]);
  const c = { ...c0, ...extra };
  const patch = { ...extra };
  if (c.stage_basis === 'inferred') {
    const s = inferStage({ messages, facts });
    const cur = AUTO_STAGES.indexOf(c.stage);
    const nxt = AUTO_STAGES.indexOf(s.stage);
    if (cur !== -1 && nxt > cur) Object.assign(patch, { stage: s.stage, stage_reason: s.reason, stage_evidence_msg: s.evidenceMsg });
    else if (!c.stage_reason) Object.assign(patch, { stage_reason: s.reason, stage_evidence_msg: s.evidenceMsg });
  }
  const stage = patch.stage || c.stage;
  const na = suggestNextAction({ ...c, ...patch, stage }, messages, facts, now);
  patch.next_action = na.text; patch.next_action_due = na.due;
  await repo.updateCollab(cid, patch);
}

function suggestNextAction(c, messages, facts, now) {
  const last = messages[messages.length - 1];
  const upcoming = facts.filter((f) => f.kind === 'deadline' && f.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at))
    .find((f) => new Date(f.due_at) > new Date(now.getTime() - 14 * 864e5));
  const name = last && last.direction === 'in' ? (last.from_name || 'the brand').split(' ')[0] : null;
  if (last && last.direction === 'in' && c.stage !== 'published') {
    if (facts.find((f) => f.slot === 'shipping:address-request' && f.evidence_msg === last.id)) return { text: `Send ${name} a shipping address (they asked)`, due: null };
    return { text: `Reply to ${name}`, due: new Date(new Date(last.sent_at).getTime() + 2 * 864e5).toISOString() };
  }
  switch (c.stage) {
    case 'new': return { text: 'Decide whether this is a fit, then reply', due: null };
    case 'negotiating': return { text: 'Waiting on the brand — nudge if no reply in a few days', due: null };
    case 'awaiting_delivery': return { text: 'Confirm the product arrives, then move to Ready to film', due: null };
    case 'ready_to_film': return { text: upcoming ? `Film — ${upcoming.label.toLowerCase()} ${upcoming.value.split(': ')[1] || ''}`.trim() : 'Schedule filming', due: upcoming && upcoming.due_at };
    case 'editing': return { text: upcoming ? `Finish edit before ${upcoming.label.toLowerCase()}` : 'Finish the edit', due: upcoming && upcoming.due_at };
    case 'scheduled': return { text: 'Check the brand has approved and the video is scheduled', due: upcoming && upcoming.due_at };
    case 'published': return { text: 'Send the brand the live link and stats', due: null };
    default: return { text: null, due: null };
  }
}

/** Creator sets a stage manually: it sticks, and auto-inference stops for this collaboration. */
async function setStageByUser(repo, cid, stage, userId) {
  if (!STAGES.includes(stage)) throw Object.assign(new Error('invalid stage'), { status: 400 });
  await repo.updateCollab(cid, { stage, stage_basis: 'user', stage_reason: 'Set by you', stage_evidence_msg: null });
  await refreshDerived(repo, cid);
  await repo.audit(userId, 'stage.set', { cid, stage });
}

module.exports = { ingestMessages, ingestOne, newStats, finishStats, refreshDerived, setStageByUser, suggestNextAction };
