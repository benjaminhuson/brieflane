'use strict';
const { stripQuoted } = require('./text');

// Weighted signals. Kept transparent so the "why was this flagged?" reason is explainable to the creator.
const POSITIVE = [
  [/\bsponsor(ship|ed|ing)?\b/i, 3, 'mentions sponsorship'],
  [/\bpaid (promotion|partnership|integration)\b/i, 3, 'paid promotion'],
  [/\b(brand )?(collab|collaboration|partnership)\b/i, 2, 'collaboration language'],
  [/\b(product )?review\b.*\b(video|channel|unit|sample)\b|\breview (unit|sample)\b/i, 3, 'product review request'],
  [/\b(gift(ed|ing)?|free (unit|sample)|send you (a|our|one)|ship (you|a unit))\b/i, 2, 'product gifting'],
  [/\b(rate card|media kit|your rates?|budget|fee)\b/i, 2, 'rates/budget discussed'],
  [/\b(dedicated video|integration|shorts?|unboxing|affiliate( link| code)?|discount code)\b/i, 2, 'deliverable language'],
  [/\b(influencer|creator) (marketing|campaign|program)\b/i, 2, 'influencer campaign'],
  [/\bon behalf of\b/i, 1, 'agency outreach'],
  [/\b(your channel|your videos?|your content|huson diy)\b/i, 1, 'addresses the channel'],
  [/\btracking (number|no\.?|code)\b/i, 1, 'shipping update'],
];
const NEGATIVE = [
  [/\b(order (confirmation|#)|your order has|receipt for|invoice #|payment received for your order)\b/i, -4, 'looks like a receipt'],
  [/\bunsubscribe\b/i, -1, 'bulk mail'],
  [/\b(password reset|verify your email|security alert|sign-in attempt)\b/i, -5, 'account notification'],
  [/^(no-?reply|notifications?|mailer-daemon)@/i, -3, 'automated sender'],
];

/**
 * Classify a normalized message. `threadKnown` = this thread is already linked to a
 * collaboration, in which case follow-ups are always kept (that's how deals progress).
 */
function classify(msg, { threadKnown = false } = {}) {
  if (threadKnown) return { isCollab: true, score: 99, kind: null, reasons: ['reply in a tracked collaboration thread'] };
  const text = `${msg.subject || ''}\n${stripQuoted(msg.body || '')}`;
  let score = 0; const reasons = [];
  for (const [re, w, why] of POSITIVE) if (re.test(text)) { score += w; reasons.push(why); }
  for (const [re, w, why] of NEGATIVE) if (re.test(re.source.startsWith('^(no') ? (msg.fromAddr || '') : text)) { score += w; reasons.push(why); }
  if (msg.direction === 'out') score -= 2; // creator's own outbound mail only counts inside known threads
  let kind = 'unknown';
  if (/\bsponsor|paid (promotion|partnership|integration)|\bfee\b|budget/i.test(text)) kind = 'sponsorship';
  else if (/\breview\b|gift|sample|send you/i.test(text)) kind = 'product_review';
  else if (/affiliate/i.test(text)) kind = 'affiliate';
  return { isCollab: score >= 4, score, kind, reasons };
}

module.exports = { classify };
