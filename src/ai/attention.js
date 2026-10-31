'use strict';
const { STAGES, STAGE_LABEL } = require('../repo');

const DAY = 864e5;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * "What needs my attention today?" — deterministic, explainable ranking.
 * Each item says *why* it's here and whether that rests on email evidence or inference.
 */
async function computeAttention(repo, now = new Date()) {
  const items = [];
  const collabs = await repo.collabs();
  const byId = Object.fromEntries(collabs.map((c) => [c.id, c]));

  for (const f of await repo.allActiveFacts()) {
    if (f.kind !== 'deadline' || !f.due_at) continue;
    const c = byId[f.collab_id];
    if (!c || c.stage === 'published') continue;
    const days = Math.ceil((new Date(f.due_at) - now) / DAY);
    if (days > 10 || days < -14) continue;
    items.push({
      id: `deadline:${f.id}`, type: 'deadline', collabId: c.id, brand: c.brand, due: f.due_at,
      severity: days < 0 ? 3 : days <= 3 ? 3 : days <= 7 ? 2 : 1,
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
        id: `reply:${c.id}`, type: 'reply', collabId: c.id, brand: c.brand,
        severity: hrs > 48 ? 3 : hrs > 12 ? 2 : 2,
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

  for (const d of await repo.pendingDrafts()) {
    items.push({ id: `draft:${d.id}`, type: 'draft', collabId: d.collab_id, brand: d.brand, severity: d.status === 'approved' ? 2 : 1,
      title: d.status === 'approved' ? `Approved reply to ${d.brand} not sent yet` : `Review draft reply to ${d.brand}`,
      detail: 'Drafts never send without your explicit approval.', basis: 'user' });
  }

  const reviewCount = (await repo.reviewCollabs()).length + (await repo.pendingFacts()).length;
  if (reviewCount) items.push({ id: 'review', type: 'review', severity: 1, title: `${reviewCount} item${reviewCount > 1 ? 's' : ''} to review`, detail: 'Historical or ambiguous details waiting for you to confirm before they count.', basis: 'inferred' });

  for (const t of await repo.tasks()) {
    if (!t.due_at) continue;
    const days = Math.ceil((new Date(t.due_at) - now) / DAY);
    if (days <= 3) items.push({ id: `task:${t.id}`, type: 'task', taskId: t.id, collabId: t.collab_id, due: t.due_at, severity: days < 0 ? 3 : 2, title: t.title, detail: days < 0 ? 'Overdue' : `Due ${fmtDate(t.due_at)}`, basis: 'user' });
  }

  // Merge reply + deadline for the same collab into one row ordering by severity then due date.
  items.sort((a, b) => b.severity - a.severity || String(a.due || '9').localeCompare(String(b.due || '9')));
  return items;
}

async function pipelineCounts(repo) {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const c of await repo.collabs()) counts[c.stage]++;
  return counts;
}

async function upcoming(repo, now = new Date(), days = 45) {
  const collabs = Object.fromEntries((await repo.collabs()).map((c) => [c.id, c]));
  const out = [];
  for (const f of await repo.allActiveFacts()) {
    if (f.kind !== 'deadline' || !f.due_at || !collabs[f.collab_id]) continue;
    const dt = new Date(f.due_at);
    if (dt < new Date(now - 31 * DAY) || dt > new Date(now.getTime() + days * DAY)) continue;
    const c = collabs[f.collab_id];
    out.push({ date: f.due_at, title: `${c.brand} — ${f.label}`, collabId: c.id, kind: 'deadline', basis: f.basis, proposed: ['new', 'negotiating'].includes(c.stage), quote: f.evidence_quote });
  }
  for (const t of await repo.tasks()) if (t.due_at) out.push({ date: t.due_at, title: t.title, collabId: t.collab_id, kind: 'task', basis: 'user', taskId: t.id });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Daily briefing: rule-built summary, optionally rewritten by the LLM under strict evidence rules. */
async function briefing(repo, llm, { now = new Date(), name = 'there' } = {}) {
  const items = await computeAttention(repo, now);
  const counts = await pipelineCounts(repo);
  const active = Object.entries(counts).filter(([s, n]) => n && s !== 'published').map(([s, n]) => `${n} ${STAGE_LABEL[s].toLowerCase()}`);
  const urgent = items.filter((i) => i.severity >= 3);
  const hour = now.getUTCHours();
  const greet = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  const lines = [];
  if (!items.length) lines.push('Nothing urgent. Good day to get ahead on filming or editing.');
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

module.exports = { computeAttention, pipelineCounts, upcoming, briefing, fmtDate };
