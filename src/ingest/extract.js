'use strict';
const { stripQuoted, sentenceContaining, norm, domainOf, brandFromDomain, findDate } = require('./text');

/**
 * Evidence model
 * --------------
 * basis = 'email'    → the value is stated in the email; `quote` is an exact substring of that email.
 * basis = 'inferred' → our interpretation (brand guessed from a domain, a stage, a "likely" product).
 * A fact may only be 'email' if its quote is verifiably present in the message text (see verifyQuote).
 * Agreement is never inferred: it requires explicit agreement language, quoted.
 */

const AGREEMENT_RE = /\b(we(?:'re| are) (?:happy|pleased|delighted) to (?:proceed|confirm|go ahead|move forward)|(?:contract|agreement) (?:is |has been )?signed|(?:i|we) (?:accept|agree to) (?:the|your) (?:terms|rate|fee|proposal)|(?:deal|terms) (?:is |are )?confirmed|let'?s go ahead|happy to go ahead|approved the (?:brief|proposal|budget))\b/i;
const MONEY_RE = /(?:£|\$|€|GBP\s?|USD\s?|EUR\s?)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\s?(k\b)?/gi;
const TRACKING_RE = /\btracking (?:number|no\.?|code|id)\s*(?:is|:)?\s*([A-Z0-9]{8,30})\b/i;
const CARRIER_RE = /\b(DHL|UPS|FedEx|DPD|Royal Mail|Evri|Hermes|Parcelforce|Yodel|USPS)\b/i;
const SHIPPED_RE = /\b(has been (?:shipped|dispatched|sent)|(?:shipped|dispatched) (?:today|yesterday|this morning)|is on (?:its|the) way|out for delivery)\b/i;
const DELIVERED_RE = /\b(it(?:'s| has) (?:arrived|been delivered)|(?:arrived|received it|got the (?:unit|package|parcel))|delivery confirmed)\b/i;
const DELIVERABLES = [
  [/\bdedicated (?:youtube )?video\b/i, 'Dedicated YouTube video'],
  [/\b(?:\d{2,3}[- ]?(?:second|sec|s)\b[- ]?)?(?:sponsored )?integration\b/i, 'Integration / sponsored segment'],
  [/\b(?:youtube )?shorts?\b/i, 'YouTube Short'],
  [/\b(?:instagram|ig) (?:reel|story|post)s?\b/i, 'Instagram content'],
  [/\btiktok\b/i, 'TikTok video'],
  [/\bunboxing\b/i, 'Unboxing'],
  [/\breview video\b|\bhonest review\b|\bfull review\b/i, 'Review video'],
  [/\baffiliate (?:link|code)\b|\bdiscount code\b/i, 'Affiliate link / discount code'],
];
const DEADLINE_CONTEXT = /\b(by|before|deadline|due|go(?:es)? live|publish(?:ed)?|launch(?:es)?|live on|post(?:ed)? (?:on|by)|draft (?:by|due)|embargo)\b/i;

function verifyQuote(quote, text) {
  if (!quote) return false;
  const squash = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  return squash(text).includes(squash(quote).replace(/…$/, ''));
}

function guessBrand(msg, text) {
  // Agency outreach: "on behalf of VoltNest" → brand VoltNest, agency from the sender domain.
  const ob = text.match(/\bon behalf of\s+(?:our client\s+)?([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,2})/);
  const domainBrand = brandFromDomain(domainOf(msg.fromAddr));
  if (ob) return { brand: ob[1].replace(/[.,]$/, ''), agency: domainBrand || msg.fromName || null, basis: 'email', quote: sentenceContaining(text, ob[0]) };
  const intro = text.match(/\b(?:I'?m|I am|[Tt]his is)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:from|at|with)\s+([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,2})/);
  if (intro) return { brand: intro[1].replace(/[.,]$/, ''), agency: null, basis: 'email', quote: sentenceContaining(text, intro[0]) };
  if (domainBrand) return { brand: domainBrand, agency: null, basis: 'inferred', quote: null };
  return { brand: msg.fromName || domainOf(msg.fromAddr) || 'Unknown brand', agency: null, basis: 'inferred', quote: null };
}

function guessProduct(text) {
  const m = text.match(/\b(?:our|the) (?:new |latest |upcoming )?((?:[A-Z][A-Za-z0-9]+[- ]?){1,3}(?:\d+\w*)?)(?=\s+[a-z]|[,.;!?)]|\s+—)/);
  if (!m) return null;
  const v = m[1].trim();
  if (/^(I|We|Our|The|YouTube|Huson|DIY|Hi|Hello|Thanks)$/i.test(v) || v.length < 3) return null;
  return { value: v, quote: sentenceContaining(text, m[0]) };
}

/**
 * Heuristic extraction from one message. Deterministic and offline; the LLM
 * extractor (llmExtract) refines it when an API key is configured.
 */
function extract(msg) {
  const text = stripQuoted(msg.body || '');
  const all = `${msg.subject || ''}. ${text}`;
  const facts = [];
  const push = (f) => facts.push({ confidence: 0.7, ...f });

  const b = guessBrand(msg, text);
  const product = guessProduct(text);

  // Contact (from headers: email-supported by definition)
  if (msg.direction === 'in' && msg.fromAddr) {
    push({ kind: 'contact', label: 'Contact', value: msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr,
      slot: `contact:${msg.fromAddr.toLowerCase()}`, basis: 'email', quote: `From: ${msg.fromName || ''} <${msg.fromAddr}>`.trim(), confidence: 0.95, headerEvidence: true });
  }
  if (product) push({ kind: 'product', label: 'Product', value: product.value, slot: 'product', basis: 'email', quote: product.quote, confidence: 0.6 });

  for (const [re, label] of DELIVERABLES) {
    const m = text.match(re);
    if (m) push({ kind: 'deliverable', label: 'Deliverable', value: label, slot: `deliverable:${label}`, basis: 'email', quote: sentenceContaining(text, m[0]) });
  }

  // Deadlines: a date phrase in a sentence with deadline context.
  // A sentence can hold several dates ("draft by 12 Nov and live by 19 Nov"), so look clause by clause.
  for (const s of require('./text').sentences(text)) {
    if (!DEADLINE_CONTEXT.test(s)) continue;
    for (const clause of s.split(/,|;|\band\b|\bthen\b/i)) {
      const d = findDate(clause, msg.sentAt);
      if (!d) continue;
      const what = /draft|script|first cut|preview/i.test(clause) ? 'Draft due' : /ship|send|dispatch|arriv/i.test(clause) ? 'Shipping date'
        : /live|publish|post|launch|embargo/i.test(clause) ? 'Go-live date' : 'Deadline';
      push({ kind: 'deadline', label: what, value: `${what}: ${d.phrase}`, dueAt: d.iso, slot: `deadline:${what}`, basis: 'email', quote: s.length > 240 ? `${s.slice(0, 237)}…` : s, confidence: 0.75 });
    }
  }

  // Money: proposed unless explicit agreement language accompanies it.
  const agreementMatch = text.match(AGREEMENT_RE);
  MONEY_RE.lastIndex = 0;
  let mm;
  const seenMoney = new Set();
  while ((mm = MONEY_RE.exec(text))) {
    const sentence = sentenceContaining(text, mm[0]) || mm[0];
    // Product prices (RRP, "worth £X") are not fees.
    if (/\b(rrp|retail|worth|valued? at|priced at|sells? for)\b/i.test(sentence) && !/\b(fee|budget|pay|rate)\b/i.test(sentence)) continue;
    const amount = mm[0].replace(/\s+/g, '');
    if (seenMoney.has(amount)) continue; seenMoney.add(amount);
    const invoiced = /\binvoice|paid|payment (sent|made|processed)/i.test(sentence);
    const label = invoiced ? 'Payment / invoice' : (agreementMatch ? 'Fee (agreement language present)' : 'Fee mentioned (not agreed)');
    push({ kind: 'payment', label, value: `${amount}${msg.direction === 'out' ? ' (your message)' : ''}`, slot: invoiced ? `payment:invoice:${amount}` : 'payment:fee', basis: 'email', quote: sentence, confidence: 0.7 });
  }

  // Shipping
  const tr = text.match(TRACKING_RE);
  const carrier = text.match(CARRIER_RE);
  if (tr) push({ kind: 'shipping', label: 'Tracking', value: `${carrier ? `${carrier[1]} ` : ''}${tr[1]}`, slot: `shipping:tracking:${tr[1]}`, basis: 'email', quote: sentenceContaining(text, tr[0]), confidence: 0.9 });
  const shipped = text.match(SHIPPED_RE);
  if (shipped) push({ kind: 'shipping', label: 'Shipment status', value: 'Shipped', slot: 'shipping:status', basis: 'email', quote: sentenceContaining(text, shipped[0]), confidence: 0.8 });
  const delivered = text.match(DELIVERED_RE);
  if (delivered) push({ kind: 'shipping', label: 'Shipment status', value: 'Delivered', slot: 'shipping:status', basis: 'email', quote: sentenceContaining(text, delivered[0]), confidence: 0.75 });
  const addressAsk = /\b(?:shipping|delivery|postal) address\b/i.exec(text);
  if (addressAsk && msg.direction === 'in') push({ kind: 'shipping', label: 'Address requested', value: 'Brand asked for a shipping address', slot: 'shipping:address-request', basis: 'email', quote: sentenceContaining(text, addressAsk[0]), confidence: 0.8 });

  if (agreementMatch) {
    const who = msg.direction === 'out' ? 'You' : (msg.fromName || 'Brand');
    push({ kind: 'agreement', label: `Agreement language from ${who}`, value: agreementMatch[0], slot: `agreement:${msg.direction}`, basis: 'email', quote: sentenceContaining(text, agreementMatch[0]), confidence: 0.85 });
  }

  // Final guard: any 'email' fact whose quote isn't in the message gets downgraded.
  for (const f of facts) {
    if (f.basis === 'email' && !f.headerEvidence && !verifyQuote(f.quote, all)) { f.basis = 'inferred'; f.confidence = Math.min(f.confidence, 0.4); }
    f.valueKey = `${f.kind}:${norm(f.value)}`;
  }

  return { brand: b.brand, agency: b.agency, brandBasis: b.basis, brandQuote: b.quote, product: product && product.value, facts, text };
}

/**
 * Stage inference. Returns the furthest stage the evidence supports in the
 * automatic range (new → negotiating → awaiting delivery → ready to film).
 * Later stages are creator-driven. Always basis 'inferred' with a reason.
 */
function inferStage({ messages, facts }) {
  const active = facts.filter((f) => f.status !== 'rejected' && f.status !== 'superseded');
  const has = (pred) => active.find(pred);
  const outbound = messages.filter((m) => m.direction === 'out');
  const delivered = has((f) => f.kind === 'shipping' && f.value === 'Delivered');
  const shipped = has((f) => f.kind === 'shipping' && (f.label === 'Tracking' || f.value === 'Shipped'));
  const agreement = has((f) => f.kind === 'agreement');
  if (delivered) return { stage: 'ready_to_film', reason: 'An email says the product arrived — so it is probably ready to film.', evidenceMsg: delivered.evidence_msg || delivered.evidenceMsg };
  if (shipped) return { stage: 'awaiting_delivery', reason: 'An email mentions shipping/tracking for the product.', evidenceMsg: shipped.evidence_msg || shipped.evidenceMsg };
  if (agreement) return { stage: 'awaiting_delivery', reason: 'An email contains explicit agreement language; next step is usually receiving the product.', evidenceMsg: agreement.evidence_msg || agreement.evidenceMsg };
  if (outbound.length) return { stage: 'negotiating', reason: 'You have replied in this thread and terms are not confirmed in writing.', evidenceMsg: outbound[outbound.length - 1].id };
  return { stage: 'new', reason: 'Inbound request with no reply from you yet.', evidenceMsg: messages[0] && messages[0].id };
}

module.exports = { extract, inferStage, verifyQuote, AGREEMENT_RE };
