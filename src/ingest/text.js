'use strict';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'yahoo.com',
  'yahoo.co.uk', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'qq.com', '163.com', 'foxmail.com', 'freemail.example']);

/** Strip quoted replies and signatures so we only extract from what *this* message says. */
function stripQuoted(body = '') {
  const lines = String(body).replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,120}wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: .+@/.test(line)) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function sentences(text = '') {
  return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9£$€"'(])/).map((s) => s.trim()).filter(Boolean);
}

function sentenceContaining(text, idx) {
  for (const s of sentences(text)) if (s.includes(idx)) return s.length > 240 ? `${s.slice(0, 237)}…` : s;
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9£$€.]+/g, ' ').trim();
const brandKey = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|inc|llc|gmbh|co|official|uk|team|store|shop)\b/g, '').replace(/[^a-z0-9]/g, '');

function domainOf(addr = '') { const m = String(addr).toLowerCase().match(/@([a-z0-9.-]+)/); return m ? m[1] : ''; }
function brandFromDomain(domain) {
  if (!domain || FREEMAIL.has(domain)) return null;
  // mail.kestrel-tools.co.uk -> kestrel-tools -> "Kestrel Tools"
  const SUB = new Set(['mail', 'email', 'm', 'www', 'news', 'hello', 'info', 'pr', 'marketing', 'partners', 'team']);
  const TLD = new Set(['com', 'co', 'uk', 'io', 'net', 'org', 'de', 'cn', 'us', 'eu', 'fr', 'it', 'es', 'agency', 'shop', 'store', 'tech', 'ai', 'app', 'hk', 'au', 'ca', 'example']);
  const labels = domain.split('.').filter((p) => !SUB.has(p) && !TLD.has(p));
  const label = labels[labels.length - 1] || domain.split('.')[0];
  return label.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Find a date phrase in text and resolve it relative to the message date.
 * Supports: "14 November", "November 14th", "14/11/2026" (UK), "by Friday", "end of the month".
 * Returns { iso, phrase } or null.
 */
function findDate(text, refIso) {
  const ref = new Date(refIso || Date.now());
  const t = String(text);
  const mk = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m, d, 17, 0, 0));
    return Number.isNaN(dt.getTime()) || dt.getUTCDate() !== d ? null : dt;
  };
  const nextOccurrence = (m, d, explicitYear) => {
    if (explicitYear) return mk(explicitYear, m, d);
    let dt = mk(ref.getUTCFullYear(), m, d);
    if (dt && dt < new Date(ref.getTime() - 3 * 864e5)) dt = mk(ref.getUTCFullYear() + 1, m, d);
    return dt;
  };
  const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  let m;
  const r1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${mon}\\b(?:,?\\s+(20\\d{2}))?`, 'i');
  const r2 = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d{2}))?`, 'i');
  if ((m = t.match(r1))) {
    const dt = nextOccurrence(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1]), m[3] && Number(m[3]));
    if (dt) return { iso: dt.toISOString(), phrase: m[0] };
  }
  if ((m = t.match(r2))) {
    const dt = nextOccurrence(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), Number(m[2]), m[3] && Number(m[3]));
    if (dt) return { iso: dt.toISOString(), phrase: m[0] };
  }
  if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/))) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    const dt = mk(y, Number(m[2]) - 1, Number(m[1]));
    if (dt) return { iso: dt.toISOString(), phrase: m[0] };
  }
  if ((m = t.match(/\b(?:by|before|on|this|next)\s+(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i))) {
    const target = DAYS.indexOf(m[2].toLowerCase());
    let diff = (target - ref.getUTCDay() + 7) % 7 || 7;
    if (m[1] || /next/i.test(m[0].split(/\s+/)[0])) diff += diff < 7 ? 7 : 0;
    const dt = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + diff, 17));
    return { iso: dt.toISOString(), phrase: m[0] };
  }
  if ((m = t.match(/\bend of (?:the |this )?month\b/i))) {
    const dt = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0, 17));
    return { iso: dt.toISOString(), phrase: m[0] };
  }
  return null;
}

module.exports = { stripQuoted, sentences, sentenceContaining, norm, brandKey, domainOf, brandFromDomain, findDate, FREEMAIL };
