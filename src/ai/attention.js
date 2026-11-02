'use strict';
const { STAGES, STAGE_LABEL } = require('../repo');

const DAY = 864e5;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Everything in this module works on a *snapshot* (see repo.snapshot()): one parallel
 * batch of queries per request, then pure in-memory computation. The database can be far
 * from the functions (Netlify free plan = US East, Supabase = London), so round trips matter.
 */

/** "What needs my attention today?" — deterministic, explainable ranking. */
function computeAttention(snap, now = new Date()) {
  const items = [];
  const { collabs, facts, drafts, tasks, reviewCount } = snap;
  const byId = Object.fromEntries(collabs.map((c) => [c.id, c]));

  for (const f of facts) {
    if (f.kind !== 'deadline' || !f.due_at) continue;
    const c = byId[f.collab_id];
    if (!c || c.stage === 'published') continue;
    const days = Math.ceil((new Date(f.due_at) - now) / DAY);
    if (days > 10 || days < -14) continue;
    items.push({
      id: `deadline:${f.id}`, type: 'deadline', collabId: c.id, brand: c.brand, due: f.due_at,
      severity: days <= 3 ? 3 : days <= 7 ? 2 : 1,
      title: days < 0 ? `${c.brand}: ${f.label.toLowerCase()} was ${fmtDate(f.due_at)} (overdue)` : `${c.brand}: ${f.label.toLowerCase()} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
      detail: `${fmtDate(f.due_at)} — stated in email${c.stage === 'negotiating' || c.stage === 'new' ? ' as part of a proposal (not agreed)' : ''}.`,
      basis: 'email', quote: f.evidence_quote,
    });
  }

  for (const c of collabs) {
    if (c.stage === 'published') continue;
    const lastIn = c.last_inbound_at && new Date(c.last_inbound_at);
    const lastOut = c.last_outbound_at && new Date(c.last_outbound_at);
    if (lastIn && (!lastOut || lastIn > lastOut)) {
      const hrs = (now - lastIn) / 36e5;
      items.push({
        id: `reply:${c.id}`, type: 'reply', collabId: c.id, brand: c.brand, severity: hrs > 48 ? 3 : 2,
        title: `Reply to ${c.brand}`,
        detail: `Their last email (${hrs < 24 ? `${Math.max(1, Math.round(hrs))}h ago` : `${Math.round(hrs / 24)} days ago`}) has no reply from you yet.`,
        basis: 'email',
      });
    } else if (c.stage === 'negotiating' && lastOut && (now - lastOut) / DAY > 5) {
      items.push({ id: `nudge:${c.id}`, type: 'nudge', collabId: c.id, brand: c.brand, severity: 1,
        title: `Nudge ${c.brand}?`, detail: `No reply for ${Math.round((now - lastOut) / DAY)} days since your last email.`, basis: 'inferred' });
    }
    if (c.stage === 'awaiting_delivery') {
      items.push({ id: `delivery:${c.id}`, type: 'delivery', collabId: c.id, brand: c.brand, severity: 1,
        title: `Watch for ${c.product || c.brand} delivery`, detail: 'Move to "Ready to film" once it arrives.', basis: c.stage_basis === 'user' ? 'user' : 'inferred' });
    }
  }

  for (const d of drafts) {
    items.push({ id: `draft:${d.id}`, type: 'draft', collabId: d.collab_id, brand: d.brand, severity: d.status === 'approved' ? 2 : 1,
      title: d.status === 'approved' ? `Approved reply to ${d.brand} not sent yet` : `Review draft reply to ${d.brand}`,
      detail: 'Drafts never send without your explicit approval.', basis: 'user' });
  }

  if (reviewCount) items.push({ id: 'review', type: 'review', severity: 1, title: `${reviewCount} item${reviewCount > 1 ? 's' : ''} to review`, detail: 'Historical or ambiguous details waiting for you to confirm before they count.', basis: 'inferred' });

  for (const t of tasks) {
    if (!t.due_at) continue;
    const days = Math.ceil((new Date(t.due_at) - now) / DAY);
    if (days <= 3) items.push({ id: `task:${t.id}`, type: 'task', taskId: t.id, collabId: t.collab_id, due: t.due_at, severity: days < 0 ? 3 : 2, title: t.title, detail: days < 0 ? 'Overdue' : `Due ${fmtDate(t.due_at)}`, basis: 'user' });
  }

  items.sort((a, b) => b.severity - a.severity || String(a.due || '9').localeCompare(String(b.due || '9')));
  return items;
}

function pipelineCounts(snap) {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const c of snap.collabs) counts[c.stage]++;
  return counts;
}

function upcoming(snap, now = new Date(), days = 45) {
  const collabs = Object.fromEntries(snap.collabs.map((c) => [c.id, c]));
  const out = [];
  for (const f of snap.facts) {
    if (f.kind !== 'deadline' || !f.due_at || !collabs[f.collab_id]) continue;
    const dt = new Date(f.due_at);
    if (dt < new Date(now - 31 * DAY) || dt > new Date(now.getTime() + days * DAY)) continue;
    const c = collabs[f.collab_id];
    out.push({ date: f.due_at, title: `${c.brand} — ${f.label}`, label: f.label, collabId: c.id, kind: 'deadline', basis: f.basis, proposed: ['new', 'negotiating'].includes(c.stage), quote: f.evidence_quote });
  }
  for (const t of snap.tasks) if (t.due_at) out.push({ date: t.due_at, title: t.title, label: t.title, collabId: t.collab_id, kind: 'task', basis: 'user', taskId: t.id });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Planner: one row per active project with its dated milestones (from email or set by you),
 * open tasks, stage and next action. The client lays these out on a week grid.
 */
function planner(snap, now = new Date()) {
  const factsBy = groupBy(snap.facts, 'collab_id');
  const tasksBy = groupBy(snap.tasks, 'collab_id');
  const rows = snap.collabs.filter((c) => !c.archived).map((c) => {
    const facts = factsBy[c.id] || [];
    const events = facts.filter((f) => f.kind === 'deadline' && f.due_at)
      .map((f) => ({ date: f.due_at, label: f.label, kind: 'deadline', basis: f.basis, proposed: ['new', 'negotiating'].includes(c.stage), quote: f.evidence_quote }));
    const openTasks = (tasksBy[c.id] || []);
    for (const t of openTasks) if (t.due_at) events.push({ date: t.due_at, label: t.title, kind: 'task', basis: 'user', taskId: t.id });
    if (c.next_action_due) events.push({ date: c.next_action_due, label: c.next_action, kind: 'next', basis: 'inferred' });
    events.sort((a, b) => a.date.localeCompare(b.date));
    const upcomingEvent = events.find((e) => new Date(e.date) >= new Date(now - DAY));
    const fee = facts.filter((f) => f.kind === 'payment').slice(-1)[0];
    return {
      id: c.id, brand: c.brand, product: c.product, agency: c.agency, stage: c.stage, stageBasis: c.stage_basis,
      nextAction: c.next_action, nextActionDue: c.next_action_due, isDemo: Boolean(c.is_demo),
      fee: fee ? fee.value.replace(' (your message)', '') : null, hasAgreement: facts.some((f) => f.kind === 'agreement'),
      events, tasks: openTasks.map((t) => ({ id: t.id, title: t.title, due_at: t.due_at })),
      sortKey: upcomingEvent ? upcomingEvent.date : `9999-${STAGES.indexOf(c.stage)}`,
    };
  });
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const looseTasks = (tasksBy.null || []).map((t) => ({ id: t.id, title: t.title, due_at: t.due_at }));
  return { rows, looseTasks };
}

function groupBy(list, key) {
  const out = {};
  for (const x of list) (out[x[key] == null ? 'null' : x[key]] ||= []).push(x);
  return out;
}

/** Daily briefing: rule-built summary, optionally rewritten by the LLM under strict evidence rules. */
async function briefing(snap, llm, { now = new Date(), name = 'there', items = computeAttention(snap, now) } = {}) {
  const counts = pipelineCounts(snap);
  const active = Object.entries(counts).filter(([s, n]) => n && s !== 'published').map(([s, n]) => `${n} ${STAGE_LABEL[s].toLowerCase()}`);
  const urgent = items.filter((i) => i.severity >= 3);
  const hour = now.getUTCHours();
  const greet = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const lines = [];
  if (!items.length) lines.push(snap.collabs.length ? 'Nothing urgent. Good day to get ahead on filming or editing.' : 'No brand deals tracked yet. Connect Gmail in Settings, then check email or import the last 12 months.');
  else {
    lines.push(`${urgent.length ? `${urgent.length} thing${urgent.length > 1 ? 's' : ''} can't wait` : 'Nothing is on fire'}; ${items.length} item${items.length > 1 ? 's' : ''} on your list in total.`);
    for (const i of items.slice(0, 3)) lines.push(`• ${i.title} — ${i.detail}`);
  }
  if (active.length) lines.push(`Pipeline: ${active.join(', ')}.`);
  const rules = { headline: `${greet}, ${name}.`, lines, generator: 'rules' };
  if (!llm.enabled) return rules;
  try {
    const prose = await llm.complete({
      system: 'You write a short daily briefing for a YouTube creator about brand deals. Use ONLY the JSON provided. Never say a deal or fee is agreed unless an item explicitly says agreement evidence exists. Fees in proposals are "proposed". Max 90 words, plain text, warm and direct, UK English. Start with the single most important action.',
      prompt: JSON.stringify({ greeting: rules.headline, attention: items.slice(0, 8).map(({ title, detail, basis, severity }) => ({ title, detail, basis, severity })), pipeline: counts }),
      maxTokens: 300,
    });
    return { headline: rules.headline, lines: [prose.trim()], generator: llm.label, fallback: rules.lines };
  } catch { return rules; }
}

module.exports = { computeAttention, pipelineCounts, upcoming, planner, briefing, fmtDate, groupBy };
