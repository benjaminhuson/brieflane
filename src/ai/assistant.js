'use strict';
const { computeAttention, upcoming, fmtDate } = require('./attention');
const { STAGE_LABEL } = require('../repo');

async function collabSummary(repo, c) {
  const facts = await repo.facts(c.id, { statuses: ['active'] });
  const pick = (k) => facts.filter((f) => f.kind === k);
  const fee = pick('payment').slice(-1)[0];
  const agreement = pick('agreement');
  return {
    brand: c.brand, agency: c.agency, product: c.product, stage: STAGE_LABEL[c.stage],
    stageBasis: c.stage_basis, stageReason: c.stage_reason, nextAction: c.next_action,
    fee: fee ? { value: fee.value, label: fee.label } : null,
    agreementEvidence: agreement.map((a) => ({ who: a.label, quote: a.evidence_quote })),
    deadlines: pick('deadline').map((d) => ({ label: d.label, date: d.due_at && d.due_at.slice(0, 10) })),
    deliverables: pick('deliverable').map((d) => d.value),
    shipping: pick('shipping').map((s) => `${s.label}: ${s.value}`),
  };
}

async function describe(repo, c) {
  const s = await collabSummary(repo, c);
  const parts = [`**${s.brand}**${s.product ? ` (${s.product})` : ''} is at **${s.stage}** — ${s.stageBasis === 'user' ? 'set by you' : `AI-inferred: ${s.stageReason}`}`];
  if (s.fee) parts.push(`Money: ${s.fee.value} — ${s.fee.label.toLowerCase()} (from email).`);
  if (s.agreementEvidence.length) parts.push(`Agreement wording in email: ${s.agreementEvidence.map((a) => `${a.who.replace('Agreement language from ', '')}: “${a.quote}”`).join(' / ')}`);
  else parts.push('No written agreement found in email, so treat terms as not agreed.');
  if (s.deadlines.length) parts.push(`Dates mentioned: ${s.deadlines.map((d) => `${d.label} ${d.date ? fmtDate(d.date) : ''}`).join(', ')}.`);
  if (s.deliverables.length) parts.push(`Deliverables mentioned: ${[...new Set(s.deliverables)].join(', ')}.`);
  if (s.nextAction) parts.push(`Suggested next step: ${s.nextAction}.`);
  return parts.join('\n');
}

/** Rule-based assistant (works offline); the LLM path uses the same tenant-scoped context. */
async function ask(repo, llm, question, now = new Date()) {
  const q = String(question || '').slice(0, 1000);
  const collabs = await repo.collabs();
  const ql = q.toLowerCase();
  const named = collabs.find((c) => ql.includes(c.brand.toLowerCase()) || (c.product && ql.includes(c.product.toLowerCase())) || (c.agency && ql.includes(c.agency.toLowerCase())));

  if (llm.enabled) {
    try {
      const context = {
        today: now.toISOString().slice(0, 10),
        attention: (await computeAttention(repo, now)).slice(0, 10).map(({ title, detail, basis }) => ({ title, detail, basis })),
        collaborations: await Promise.all(collabs.map((c) => collabSummary(repo, c))),
        upcoming: (await upcoming(repo, now)).slice(0, 15),
      };
      const answer = await llm.complete({
        system: 'You are Brieflane, an assistant for a YouTube creator managing brand collaborations. Answer ONLY from the JSON context. Distinguish clearly between facts stated in email, AI-inferred status, and things the creator set. Never describe a deal, fee or commitment as agreed unless agreementEvidence is present — say "proposed" or "not confirmed in writing" instead. If the context does not contain the answer, say so. Be concise; UK English.',
        prompt: `<context>${JSON.stringify(context)}</context>\n\nQuestion: ${q}`,
        maxTokens: 600,
      });
      return { answer: answer.trim(), generator: llm.label };
    } catch { /* fall through to rules */ }
  }

  let answer;
  if (named) answer = await describe(repo, named);
  else if (/priorit|first|focus|today|what should|attention|urgent/.test(ql)) {
    const items = (await computeAttention(repo, now)).slice(0, 5);
    answer = items.length ? `In order, I'd tackle:\n${items.map((i, n) => `${n + 1}. ${i.title} — ${i.detail}`).join('\n')}\n\nRanked by: overdue/near deadlines, unanswered brand emails, then approvals and reviews.` : 'Nothing needs you right now.';
  } else if (/due|deadline|week|calendar|when/.test(ql)) {
    const up = (await upcoming(repo, now)).filter((u) => new Date(u.date) >= new Date(now - 864e5)).slice(0, 8);
    answer = up.length ? `Coming up:\n${up.map((u) => `• ${fmtDate(u.date)} — ${u.title}${u.proposed ? ' (proposed, not agreed)' : ''}`).join('\n')}` : 'No dates on the calendar.';
  } else if (/money|pay|fee|owe|invoice|earn|£|\$/.test(ql)) {
    const rows = (await Promise.all(collabs.map(async (c) => ({ c, s: await collabSummary(repo, c) })))).filter((r) => r.s.fee);
    answer = rows.length ? rows.map((r) => `• ${r.c.brand}: ${r.s.fee.value} — ${r.s.fee.label.toLowerCase()}${r.s.agreementEvidence.length ? '' : ' (no written agreement found)'}`).join('\n') : 'No fees mentioned in tracked emails.';
  } else if (/ship|deliver|arriv|tracking/.test(ql)) {
    const rows = (await Promise.all(collabs.map(async (c) => ({ c, s: await collabSummary(repo, c) })))).filter((r) => r.s.shipping.length);
    answer = rows.length ? rows.map((r) => `• ${r.c.brand}: ${r.s.shipping.join('; ')}`).join('\n') : 'No shipping details found in tracked emails.';
  } else {
    answer = `I can answer questions like “what should I do first?”, “what's due this week?”, “what money is on the table?”, or “where are we with ${collabs[0] ? collabs[0].brand : 'a brand'}?”.`;
  }
  return { answer, generator: 'rules' };
}

module.exports = { ask, collabSummary };
