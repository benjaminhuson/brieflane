'use strict';
/* Brieflane PWA — vanilla JS, no build step. CSP-safe: no inline handlers; all events delegated. */

const $app = document.getElementById('app');
const state = { me: null, config: null, cache: {}, chat: [], dealFilter: 'all' };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso, opts = { day: 'numeric', month: 'short' }) => iso ? new Date(iso).toLocaleDateString('en-GB', opts) : '';
const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); const diff = (Date.now() - d) / 36e5;
  if (diff < 1) return 'just now'; if (diff < 24) return `${Math.round(diff)}h ago`; if (diff < 24 * 7) return `${Math.round(diff / 24)}d ago`;
  return fmtDate(iso, { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
};
const daysUntil = (iso) => Math.ceil((new Date(iso) - Date.now()) / 864e5);
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }

async function api(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET' && state.me) headers['x-csrf-token'] = state.me.csrf;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal: ctrl.signal });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Brieflane is taking too long to respond. Check your connection and try again.' : "Couldn't reach Brieflane. Check your connection and try again."), { status: 0, network: true });
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || (res.status === 502 || res.status === 504 ? 'The server timed out. Please try again.' : `Something went wrong (error ${res.status}).`);
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

// ---------- icons (stroke, 24px grid) ----------
const P = {
  today: '<path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/><circle cx="12" cy="12" r="4"/>',
  deals: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  review: '<path d="M9 11l2 2 4-4"/><path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z"/>',
  ask: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 10h6M9 14h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-4.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16.5a1.6 1.6 0 0 1 2.4-2L8 17"/>',
  chev: '<path d="m9 6 6 6-6 6"/>', back: '<path d="m15 6-6 6 6 6"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
  plan: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h6M8 16.5h9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
const BASIS = {
  email: ['b-email', 'mail', 'From email'],
  inferred: ['b-inferred', 'spark', 'AI-inferred'],
  user: ['b-user', 'hand', 'Set by you'],
  historical_note: ['b-warn', 'info', 'Unverified note'],
};
const badge = (basis, text) => { const [cls, ic, label] = BASIS[basis] || BASIS.inferred; return `<span class="badge ${cls}" title="${esc(label)}">${icon(ic)}${esc(text || label)}</span>`; };
const demoBadge = '<span class="badge b-demo">Demo data</span>';

// ---------- layout ----------
const NAV = [['today', 'Today', 'today'], ['planner', 'Planner', 'plan'], ['deals', 'Deals', 'deals'], ['calendar', 'Calendar', 'cal'], ['review', 'Review', 'review'], ['assistant', 'Ask', 'ask'], ['settings', 'Settings', 'settings']];
const TABS = ['today', 'planner', 'deals', 'review', 'assistant', 'settings'];
function navLinks(route) {
  const rc = state.reviewCount || 0;
  const nav = NAV.map(([r, label, ic]) => `<a href="#/${r}" data-route="${r}" ${route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${r === 'review' && rc ? `<span class="count">${rc}</span>` : ''}</a>`).join('');
  const tabs = NAV.filter(([r]) => TABS.includes(r)).map(([r, label, ic]) => `<a href="#/${r}" data-route="${r}" ${route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${r === 'review' && rc ? '<i class="dot"></i>' : ''}</a>`).join('');
  return { nav, tabs };
}
function shell(route, inner) {
  const { nav, tabs } = navLinks(route);
  return `<div class="shell">
    <div class="progress" aria-hidden="true"></div>
    <aside class="side"><a class="brand" href="#/today"><img src="/icon.svg" width="28" height="28" alt="">Brieflane</a><nav class="nav">${nav}</nav>
      <div class="side-foot"><b>${esc(state.me.tenant.name)}</b><br>${esc(state.me.user.email)}<br><button class="link" data-act="logout">Sign out</button></div></aside>
    <main id="main">${inner}</main>
    <nav class="tabbar">${tabs}</nav></div>`;
}
/** Update the menus in place (instant feedback on tap) without re-rendering the page. */
function updateNav(route) {
  const { nav, tabs } = navLinks(route);
  const n = document.querySelector('.nav'); if (n) n.innerHTML = nav;
  const t = document.querySelector('.tabbar'); if (t) t.innerHTML = tabs;
}
function demoBanner() {
  const g = state.me.gmail;
  if (g && g.mode === 'demo') return `<div class="banner">${icon('flask')}<div><b>Demo inbox.</b> These brands, people and emails are fictional sample data so you can try the full workflow. Connect real Gmail in Settings once Google OAuth is configured.</div></div>`;
  return '';
}

// ---------- views ----------
async function viewLogin() {
  const c = state.config || (state.config = await api('/auth/config'));
  const err = new URLSearchParams((location.hash.split('?')[1]) || '').get('oauth_error');
  $app.innerHTML = `<div class="login"><div class="card login-card">
    <div class="eyebrow">For independent creators</div>
    <h1>Brieflane</h1>
    <p class="muted">Every brand deal in one lane: what's agreed, what's only proposed, and what needs you today.</p>
    <div class="lanes" aria-hidden="true"><span></span><span></span><span></span></div>
    ${err ? `<div class="banner">${icon('info')}<div>${esc(err)}</div></div>` : ''}
    <div class="stack">
      ${c.googleConfigured ? '<a class="btn btn-primary" style="width:100%" href="/auth/google/start?purpose=signin">Continue with Google</a>' : ''}
      ${c.devLogin ? `<button class="btn ${c.googleConfigured ? '' : 'btn-primary'}" style="width:100%" data-act="dev-login">Open the Huson DIY demo workspace</button>` : ''}
      ${!c.googleConfigured && !c.devLogin ? '<p class="banner info">Sign-in isn\'t configured on this server yet.</p>' : ''}
    </div>
    <p class="small muted" style="margin-top:18px">Brieflane reads only collaboration-related email, never sends anything without your explicit approval, and lets you export or delete everything. <a class="link" href="/privacy.html">Privacy policy</a></p>
  </div></div>`;
}

async function viewToday() {
  const d = await api('/api/today');
  if (typeof d.reviewCount === 'number') state.reviewCount = d.reviewCount;
  const g = state.me.gmail;
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const attention = d.attention.length ? `<ul class="actions">${d.attention.map((a) => `
      <li class="action" ${a.collabId ? `data-go="#/deals/${a.collabId}"` : a.type === 'review' ? 'data-go="#/review"' : ''}>
        <span class="sev sev-${a.severity}" aria-label="${a.severity === 3 ? 'urgent' : a.severity === 2 ? 'soon' : 'when you can'}"></span>
        <div><div class="t">${esc(a.title)}</div><div class="d">${esc(a.detail)}</div>
        ${a.quote ? `<div class="q">“${esc(a.quote)}”</div>` : ''}
        <div style="margin-top:6px">${badge(a.basis)}</div></div>
        <span class="chev">${icon('chev')}</span></li>`).join('')}</ul>`
    : `<div class="empty">${g ? 'Nothing needs you right now. Nice.' : 'Connect your inbox to start.'}</div>`;
  const maxPipe = Math.max(1, ...Object.values(d.pipeline));
  const pipe = state.me.stages.map((s) => `<a class="pipe-row" href="#/deals?stage=${s.id}"><span>${s.label}</span><span class="pipe-bar"><span style="width:${(d.pipeline[s.id] / maxPipe) * 100}%"></span></span><span class="n">${d.pipeline[s.id]}</span></a>`).join('');
  const agenda = d.upcoming.length ? `<ul class="agenda">${d.upcoming.slice(0, 7).map((u) => `<li ${u.collabId ? `data-go="#/deals/${u.collabId}"` : ''}>
      <div class="datebox"><div class="m">${fmtDate(u.date, { month: 'short' })}</div><div class="dd">${new Date(u.date).getDate()}</div></div>
      <div><div style="font-weight:600">${esc(u.title)}</div><div class="small muted">${u.kind === 'task' ? 'Your task' : u.proposed ? 'Proposed in email — not agreed' : 'Stated in email'} · ${daysUntil(u.date) <= 0 ? 'today' : `in ${daysUntil(u.date)}d`}</div></div></li>`).join('')}</ul>`
    : '<div class="empty">No dates in the next few weeks.</div>';
  return `${demoBanner()}
    <div class="page-head"><div><div class="eyebrow">${esc(today)}</div><h1>What needs you today</h1></div>
      ${g ? `<button class="btn" data-act="sync">${icon('sync')}Check email</button>` : '<a class="btn btn-accent" href="#/settings">Connect Gmail</a>'}</div>
    <div class="today-grid">
      <div class="stack">
        <section class="card brief"><h2>${esc(d.briefing.headline)}</h2>${d.briefing.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
          <div class="meta">${icon('spark')}Daily briefing · ${esc(d.briefing.generator === 'rules' ? 'built by rules (no AI key)' : d.briefing.generator)}</div></section>
        <section class="card"><div class="card-head"><h2>Urgent actions</h2><span class="spacer"></span><span class="small muted">${d.attention.length} item${d.attention.length === 1 ? '' : 's'}</span></div>${attention}</section>
      </div>
      <div class="stack">
        <section class="card"><div class="card-head"><h2>Coming up</h2><span class="spacer"></span><a class="link" href="#/calendar">Calendar</a></div>${agenda}</section>
        <section class="card"><div class="card-head"><h2>Pipeline</h2><span class="spacer"></span><a class="link" href="#/deals">All deals</a></div><div class="pipeline">${pipe}</div></section>
      </div>
    </div>`;
}

function dealCard(c) {
  const chips = [];
  if (c.fee) chips.push(`<span class="chip ${c.hasAgreement ? 'ok' : ''}">${esc(c.fee.value.replace(' (your message)', ''))} · ${c.hasAgreement ? 'agreement in email' : 'not agreed'}</span>`);
  if (c.deadline) { const n = daysUntil(c.deadline.due_at); chips.push(`<span class="chip ${n <= 7 ? 'warn' : ''}">${esc(c.deadline.label)} ${fmtDate(c.deadline.due_at)}</span>`); }
  if (c.is_demo) chips.push(demoBadge);
  return `<a class="ccard" href="#/deals/${c.id}"><div class="row" style="gap:6px"><span class="b">${esc(c.brand)}</span>${c.agency ? `<span class="small muted">via ${esc(c.agency)}</span>` : ''}</div>
    ${c.product ? `<div class="p">${esc(c.product)}</div>` : ''}${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
    ${c.next_action ? `<div class="na">→ ${esc(c.next_action)}</div>` : ''}</a>`;
}
async function viewDeals(params) {
  const list = await api('/api/collaborations');
  const stage = params.get('stage');
  if (stage) state.dealFilter = stage;
  const cols = state.me.stages.map((s) => {
    const items = list.filter((c) => c.stage === s.id);
    return `<div class="col"><div class="col-head"><h3>${s.label}</h3><span class="n">${items.length}</span></div>${items.map(dealCard).join('') || '<div class="small muted" style="padding:6px">—</div>'}</div>`;
  }).join('');
  const f = state.dealFilter;
  const filtered = f === 'all' ? list : list.filter((c) => c.stage === f);
  const filters = [['all', 'All'], ...state.me.stages.map((s) => [s.id, s.label])].map(([id, l]) => `<button data-act="filter" data-v="${id}" aria-pressed="${f === id}">${l} <span class="muted">${id === 'all' ? list.length : list.filter((c) => c.stage === id).length}</span></button>`).join('');
  return `${demoBanner()}<div class="page-head"><div><div class="eyebrow">Collaboration tracker</div><h1>Deals</h1></div><a class="btn" href="#/review">Review queue</a></div>
    ${list.length ? `<div class="board">${cols}</div><div class="board-mobile"><div class="filters">${filters}</div>${filtered.map(dealCard).join('') || '<div class="empty">None at this stage.</div>'}</div>`
    : '<div class="card empty">No collaborations yet. Connect Gmail and check email, or import the last year from Settings.</div>'}`;
}

const FACT_GROUPS = [['payment', 'Money'], ['deliverable', 'Deliverables'], ['deadline', 'Dates'], ['shipping', 'Shipping'], ['product', 'Product'], ['brand', 'Brand'], ['contact', 'Contacts'], ['note', 'Notes']];
function factRow(f) {
  const cls = f.status === 'superseded' ? 'superseded' : f.status === 'pending_review' ? 'pending' : '';
  return `<div class="fact ${cls}"><div><div class="v">${esc(f.value)}${f.due_at && f.kind === 'deadline' ? ` <span class="muted small">(${fmtDate(f.due_at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })})</span>` : ''}</div><div class="l">${esc(f.label)}${f.status === 'superseded' ? ' · replaced by a newer email' : ''}</div></div>
    <div>${badge(f.basis)}</div>
    ${f.evidence_quote && f.basis === 'email' ? `<details><summary>Show evidence</summary><blockquote>${esc(f.evidence_quote)}</blockquote></details>` : ''}</div>`;
}
async function viewDeal(id) {
  const d = await api(`/api/collaborations/${id}`);
  const c = d.collab; const stages = state.me.stages;
  const idx = stages.findIndex((s) => s.id === c.stage);
  const active = d.facts.filter((f) => f.status !== 'superseded');
  const superseded = d.facts.filter((f) => f.status === 'superseded');
  const agreements = active.filter((f) => f.kind === 'agreement');
  const fromBrand = agreements.find((a) => !/from You/.test(a.label)); const fromYou = agreements.find((a) => /from You/.test(a.label));
  const agreeBox = fromBrand && fromYou
    ? `<div class="agree yes"><b>Both sides used agreement wording in email.</b> Check the quotes below before treating terms as final.</div>`
    : agreements.length ? `<div class="agree no"><b>Only one side used agreement wording</b> — not a confirmed deal yet.</div>`
      : `<div class="agree no"><b>No written agreement found.</b> Fees and dates here are proposals until confirmed by email.</div>`;
  const groups = FACT_GROUPS.map(([k, label]) => {
    const fs = active.filter((f) => f.kind === k);
    return fs.length ? `<div class="fgroup"><h3>${label}</h3>${fs.map(factRow).join('')}</div>` : '';
  }).join('');
  const agreementGroup = agreements.length ? `<div class="fgroup"><h3>Agreement evidence</h3>${agreements.map(factRow).join('')}</div>` : '';
  const thread = d.messages.length ? `<ul class="thread">${[...d.messages].reverse().map((m, i) => `<li class="msg ${m.direction}">
      <div class="h"><b>${esc(m.direction === 'out' ? 'You' : (m.from_name || m.from_addr))}</b><span class="muted">${esc(m.direction === 'out' ? `to ${m.to_addr}` : m.from_addr)}</span><span class="spacer"></span><span class="mono muted">${fmtWhen(m.sent_at)}</span></div>
      <div class="s">${esc(m.subject)}</div>
      ${m.body ? (i === 0 ? `<pre>${esc(m.body)}</pre>` : `<details><summary>${esc((m.snippet || '').slice(0, 110))}…</summary><pre>${esc(m.body)}</pre></details>`) : `<div class="small muted">${esc(m.snippet || '')} <i>(body removed by your retention setting)</i></div>`}
      ${m.imported_via === 'sent-by-app' ? '<span class="badge b-user">Sent from Brieflane</span>' : ''}</li>`).join('')}</ul>`
    : '<div class="empty">No linked emails.</div>';
  const canSend = state.me.gmail && state.me.gmail.canSend;
  const drafts = d.drafts.filter((x) => x.status !== 'discarded');
  const draftHtml = drafts.map((x) => {
    const hasCheck = /\[CHECK[^\]]*\]/.test(x.body || '');
    const steps = `<div class="steps"><span class="${x.status === 'draft' ? 'on' : ''}">Draft</span><span class="${x.status === 'approved' ? 'on' : ''}">Approved</span><span class="${x.status === 'sent' ? 'on' : ''}">Sent</span></div>`;
    if (x.status === 'sent') return `<div class="draft"><div class="draft-status">${steps}<span class="spacer"></span><span class="mono muted">${fmtWhen(x.sent_at)}</span></div><pre style="white-space:pre-wrap;margin:0;font:14px/1.55 var(--sans);color:var(--ink-2)">${esc(x.body)}</pre></div>`;
    return `<div class="draft" data-draft="${x.id}">
      <div class="draft-status">${steps}<span class="spacer"></span><span class="badge b-inferred">${icon('spark')}${esc(x.generator === 'template' ? 'Template draft' : 'AI draft')}</span></div>
      <label class="field">To<input type="text" name="to_addr" value="${esc(x.to_addr)}" ${x.status === 'approved' ? 'readonly' : ''}></label>
      <label class="field" style="margin-top:8px">Subject<input type="text" name="subject" value="${esc(x.subject)}" ${x.status === 'approved' ? 'readonly' : ''}></label>
      <label class="field" style="margin-top:8px">Message<textarea name="body" ${x.status === 'approved' ? 'readonly' : ''}>${esc(x.body)}</textarea></label>
      ${hasCheck ? '<div class="warnline">Replace every [CHECK: …] with your decision before approving. Nothing is sent or agreed until you do.</div>' : ''}
      <div class="row" style="margin-top:12px">
        ${x.status === 'draft' ? `<button class="btn" data-act="draft-save">Save</button><button class="btn btn-primary" data-act="draft-approve">Approve</button>` : '<button class="btn" data-act="draft-unapprove">Edit again</button>'}
        ${x.status === 'approved' ? (canSend ? `<button class="btn btn-accent" data-act="draft-send">${icon('send')}Send${state.me.gmail.mode === 'demo' ? ' (simulated)' : ''}</button>` : '<button class="btn btn-accent" data-act="enable-send">Grant send permission…</button>') : ''}
        <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="draft-discard">Discard</button>
      </div></div>`;
  }).join('');
  return `<div class="row" style="margin-bottom:10px"><a class="link" href="#/deals">${'← All deals'}</a></div>
    <div class="page-head" style="margin-bottom:4px"><div><div class="eyebrow">${esc(c.kind === 'product_review' ? 'Product review' : c.kind === 'sponsorship' ? 'Sponsorship' : c.kind === 'affiliate' ? 'Affiliate' : 'Collaboration')}${c.agency ? ` · via ${esc(c.agency)}` : ''}</div>
      <h1>${esc(c.brand)}</h1>${c.product ? `<div class="muted" style="margin-top:4px">${esc(c.product)}</div>` : ''}</div>
      <div class="row">${c.is_demo ? demoBadge : ''}</div></div>
    <div class="stagebar" role="group" aria-label="Stage">${stages.map((s, i) => `<button data-act="stage" data-v="${s.id}" class="${i < idx ? 'done' : i === idx ? 'current' : ''}" aria-pressed="${i === idx}">${s.label}</button>`).join('')}</div>
    <div class="row small">${badge(c.stage_basis === 'user' ? 'user' : c.stage_basis === 'historical_note' ? 'historical_note' : 'inferred', c.stage_basis === 'user' ? 'Stage set by you' : 'Stage AI-inferred')}<span class="muted">${esc(c.stage_reason || '')}</span>
      ${c.stage_basis === 'user' ? '<button class="link" data-act="stage-reset">Let Brieflane infer it again</button>' : ''}</div>
    ${c.next_action ? `<div class="nextbox"><div><div class="eyebrow">Suggested next action</div><div class="t">${esc(c.next_action)}${c.next_action_due ? ` <span class="muted small">· by ${fmtDate(c.next_action_due, { weekday: 'short', day: 'numeric', month: 'short' })}</span>` : ''}</div></div></div>` : ''}
    <div class="detail-grid">
      <div class="stack">
        <section class="card"><div class="card-head"><h2>What we know</h2></div><div class="facts">${agreeBox}${groups || '<div class="empty">No details extracted yet.</div>'}${agreementGroup}
          ${superseded.length ? `<details class="fgroup"><summary class="small muted" style="cursor:pointer">History (${superseded.length} replaced value${superseded.length > 1 ? 's' : ''})</summary>${superseded.map(factRow).join('')}</details>` : ''}
          <details class="fgroup"><summary class="small" style="cursor:pointer;font-weight:600">+ Add a detail yourself</summary>
            <form data-form="add-fact" class="stack" style="margin-top:10px">
              <div class="row" style="flex-wrap:nowrap"><select name="kind" style="max-width:150px"><option value="deadline">Date</option><option value="payment">Money</option><option value="deliverable">Deliverable</option><option value="shipping">Shipping</option><option value="note">Note</option></select>
              <input type="text" name="value" placeholder="e.g. Agreed by phone: £600" required></div>
              <div class="row" style="flex-wrap:nowrap"><input type="date" name="dueAt" style="max-width:180px"><button class="btn btn-sm" type="submit">Add</button></div>
            </form></details>
        </div></section>
        <section class="card"><div class="card-head"><h2>Tasks</h2></div><div class="card-pad stack">
          ${d.tasks.map((t) => `<label class="row" style="flex-wrap:nowrap"><input type="checkbox" data-act="task-toggle" data-id="${t.id}" ${t.done ? 'checked' : ''}><span style="${t.done ? 'text-decoration:line-through;color:var(--ink-3)' : ''}">${esc(t.title)}</span><span class="spacer"></span><span class="mono muted">${t.due_at ? fmtDate(t.due_at) : ''}</span></label>`).join('') || '<div class="small muted">No tasks yet.</div>'}
          <form data-form="add-task" class="row" style="flex-wrap:nowrap"><input type="text" name="title" placeholder="Add a task…" required><input type="date" name="dueAt" style="max-width:160px"><button class="btn btn-sm" type="submit">Add</button></form>
        </div></section>
      </div>
      <div class="stack">
        <section class="card"><div class="card-head"><h2>Reply</h2><span class="spacer"></span>${!drafts.some((x) => x.status !== 'sent') && d.messages.some((m) => m.direction === 'in') ? `<button class="btn btn-primary btn-sm" data-act="draft-new">${icon('spark')}Suggest a reply</button>` : ''}</div>
          ${draftHtml || '<div class="empty">Brieflane drafts replies for you to edit. Nothing is ever sent without your approval.</div>'}</section>
        <section class="card"><div class="card-head"><h2>Email history</h2><span class="spacer"></span><span class="small muted">${d.messages.length} message${d.messages.length === 1 ? '' : 's'}</span></div>${thread}</section>
      </div>
    </div>`;
}

async function viewCalendar() {
  const events = await api('/api/calendar');
  const now = new Date();
  const month = (y, m) => {
    const first = new Date(y, m, 1); const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i >= 35 && day.getMonth() !== m) break;
      const key = day.toDateString();
      const evs = events.filter((e) => new Date(e.date).toDateString() === key);
      cells.push(`<div class="${day.getMonth() !== m ? 'out' : ''} ${key === now.toDateString() ? 'today' : ''}"><span class="dn">${day.getDate()}</span>${evs.map((e) => `<a class="ev ${e.kind === 'task' ? 'task' : e.proposed ? 'proposed' : ''}" ${e.collabId ? `href="#/deals/${e.collabId}"` : ''} title="${esc(e.title)}">${esc(e.title)}</a>`).join('')}</div>`);
    }
    return `<section class="card" style="overflow:hidden"><div class="card-head"><h2>${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2></div>
      <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></section>`;
  };
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `<div class="page-head"><div><div class="eyebrow">Deadlines & tasks</div><h1>Calendar</h1></div>
    <div class="row small"><span class="chip" style="background:var(--ink);color:var(--paper)">Stated in email</span><span class="chip" style="border:1px dashed var(--ink-3);background:none">Proposed, not agreed</span><span class="chip" style="background:var(--accent);color:var(--accent-ink)">Your task</span></div></div>
    <div class="stack">${month(now.getFullYear(), now.getMonth())}${month(next.getFullYear(), next.getMonth())}</div>`;
}

async function viewReview() {
  const r = await api('/api/review');
  const collabs = r.collabs.map((c) => `<section class="card" data-review="${c.id}"><div class="card-head"><div><h2>${esc(c.brand)}</h2><div class="small muted">${esc(c.product || '')}</div></div><span class="spacer"></span>
      ${c.stage_basis === 'historical_note' ? badge('historical_note', 'From a past chat, not email') : `<span class="badge b-plain">Historical import</span>`}${c.is_demo ? demoBadge : ''}</div>
    <div class="card-pad stack">
      <p class="small" style="margin:0">${esc(c.stage_basis === 'historical_note' ? c.stage_reason : `Found in email from ${fmtDate(c.created_at, { month: 'short', year: 'numeric' })}. It's older or ambiguous, so it won't appear in your tracker or briefing until you confirm it.`)}</p>
      ${c.messages.length ? `<div class="small">${c.messages.map((m) => `<div style="padding:4px 0;border-top:1px solid var(--line)"><span class="mono muted">${fmtDate(m.sent_at, { day: 'numeric', month: 'short', year: 'numeric' })}</span> · <b>${esc(m.direction === 'out' ? 'You' : m.from_name || m.from_addr)}</b> — ${esc(m.snippet || m.subject)}</div>`).join('')}</div>` : ''}
      ${c.facts.length ? `<div>${c.facts.map(factRow).join('')}</div>` : ''}
      <div class="row"><button class="btn btn-primary" data-act="review-collab" data-v="confirm">${c.stage_basis === 'historical_note' ? 'Track this' : 'Confirm & add to tracker'}</button><button class="btn" data-act="review-collab" data-v="dismiss">Dismiss</button></div>
    </div></section>`).join('');
  const facts = r.facts.length ? `<section class="card"><div class="card-head"><h2>Details to confirm</h2></div><div class="card-pad">${r.facts.map((f) => `<div class="row" data-fact="${f.id}" style="padding:8px 0;border-top:1px solid var(--line);flex-wrap:nowrap"><div style="flex:1">${factRow(f)}<div class="small muted">${esc(f.brand)}</div></div>
      <button class="btn btn-sm" data-act="review-fact" data-v="confirm">Confirm</button><button class="btn btn-sm btn-ghost" data-act="review-fact" data-v="reject">Reject</button></div>`).join('')}</div></section>` : '';
  return `<div class="page-head"><div><div class="eyebrow">Human check</div><h1>Review</h1></div></div>
    <p class="muted" style="margin-top:-8px;max-width:70ch">Older emails and unverified notes are held here. Nothing below counts towards your briefing, deadlines or tracker until you confirm it.</p>
    <div class="stack">${collabs}${facts}${!collabs && !facts ? '<div class="card empty">All clear — nothing to review.</div>' : ''}</div>`;
}

function viewAssistant() {
  const msgs = state.chat.length ? state.chat.map((m) => `<div class="bubble ${m.who}">${esc(m.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}${m.gen ? `<span class="gen">${esc(m.gen === 'rules' ? 'Answered by rules (no AI key)' : m.gen)}</span>` : ''}</div>`).join('')
    : '<div class="bubble bot">Ask me about your deals: what to do first, what\'s due, what money is on the table, or where things stand with a brand. I only answer from your tracked emails and I\'ll say when something isn\'t confirmed.</div>';
  const sugg = ['What should I do first today?', "What's due in the next two weeks?", 'What money is on the table?', 'Where are we with VoltNest?'];
  return `<div class="page-head"><div><div class="eyebrow">Assistant</div><h1>Ask Brieflane</h1></div></div>
    <section class="card" style="max-width:820px"><div class="chat" id="chat">${msgs}</div>
      <div class="suggest">${sugg.map((s) => `<button data-act="ask-suggest">${esc(s)}</button>`).join('')}</div>
      <form class="composer" data-form="ask"><input type="text" name="q" placeholder="Ask about your tasks or deals…" autocomplete="off" required><button class="btn btn-primary" type="submit">Ask</button></form></section>`;
}

async function viewSettings(params) {
  const me = state.me = await api('/api/me');
  const g = me.gmail;
  const audit = await api('/api/audit');
  const msg = params.get('oauth_error') ? `<div class="banner">${icon('info')}<div>Google sign-in didn't complete: ${esc(params.get('oauth_error'))}</div></div>`
    : params.get('connected') ? `<div class="banner info">${icon('shield')}<div>Google permission granted.</div></div>` : '';
  const connectBtn = me.googleConfigured && !me.user.isDemo ? '<a class="btn btn-primary" href="/auth/google/start?purpose=gmail_read">Connect Gmail (read-only)</a>'
    : '<button class="btn btn-primary" data-act="connect-demo">Use the demo inbox</button>';
  return `${msg}<div class="page-head"><div><div class="eyebrow">${esc(me.tenant.name)}</div><h1>Settings</h1></div></div>
  <div class="settings">
    <section class="card"><div class="card-head">${icon('mail')}<h2>Gmail</h2><span class="spacer"></span>${g ? `<span class="badge ${g.mode === 'demo' ? 'b-demo' : 'b-email'}">${g.mode === 'demo' ? 'Demo inbox' : 'Connected'}</span>` : '<span class="badge b-plain">Not connected</span>'}</div>
      <div class="card-pad">
        ${me.user.isDemo ? '<p class="small muted" style="margin-top:0">This is the shared demo workspace, so it only uses the labelled demo inbox. To connect your real Gmail, sign out and continue with Google.</p>'
          : !me.googleConfigured ? '<p class="small muted" style="margin-top:0">Google OAuth isn\'t configured on this server, so a clearly labelled demo inbox stands in for Gmail. See README → Setup to connect real Gmail.</p>' : ''}
        <div class="scope"><div class="ic">${icon('mail')}</div><div><b>Read collaboration emails</b><div class="small muted">Scope: ${me.googleConfigured ? '<span class="mono">gmail.readonly</span>' : 'demo'}. Brieflane searches for brand/review mail only; other email is skipped and never stored.</div></div>
          <div>${g ? '<span class="chip ok">Granted</span>' : connectBtn}</div></div>
        <div class="scope"><div class="ic">${icon('send')}</div><div><b>Send approved replies</b><div class="small muted">Optional, separate permission (<span class="mono">gmail.send</span>). Even with it, nothing sends until you approve and confirm each email.</div></div>
          <div>${g ? (g.canSend ? '<span class="chip ok">Granted</span>' : '<button class="btn btn-sm" data-act="enable-send">Grant…</button>') : '<span class="small muted">Connect first</span>'}</div></div>
        ${g ? `<dl class="kv" style="margin-top:14px"><dt>Account</dt><dd>${esc(g.email)}</dd><dt>Last checked</dt><dd>${g.lastSyncAt ? fmtWhen(g.lastSyncAt) : 'never'}</dd><dt>History import</dt><dd>${g.historyImportedAt ? `done ${fmtWhen(g.historyImportedAt)}` : 'not run'}</dd></dl>
        <div class="row" style="margin-top:14px"><button class="btn" data-act="sync">${icon('sync')}Check email now</button><button class="btn" data-act="import-history">Import last 12 months</button><span class="spacer"></span><button class="btn btn-danger btn-sm" data-act="disconnect">Disconnect</button></div>
        <p class="small muted">The 12-month import sends anything older than 30 days to <a href="#/review">Review</a> first, so old or ambiguous deals never look current.</p>` : ''}
      </div></section>
    <section class="card"><div class="card-head">${icon('spark')}<h2>AI</h2><span class="spacer"></span><span class="badge ${/^AI/.test(me.ai) ? 'b-inferred' : 'b-plain'}">${esc(me.ai)}</span></div>
      <div class="card-pad small">Without an AI key, Brieflane uses transparent rules for extraction, briefings, drafts and answers. With one, it uses the AI but still verifies every quoted fact against the original email and never treats a deal as agreed without explicit wording.</div></section>
    <section class="card"><div class="card-head">${icon('shield')}<h2>Privacy & data</h2></div><div class="card-pad stack">
      <form data-form="retention" class="row" style="flex-wrap:nowrap"><label class="field" style="flex:1">Keep email bodies for<select name="days">${[90, 180, 365, 400, 730].map((d) => `<option value="${d}" ${me.tenant.retentionDays === d ? 'selected' : ''}>${d} days</option>`).join('')}</select></label><button class="btn" type="submit" style="align-self:flex-end">Save</button></form>
      <p class="small muted" style="margin:0">After this, message bodies are deleted; extracted details and short evidence quotes remain so your deal history still makes sense.</p>
      <div class="row"><a class="btn" href="/api/privacy/export" download>Export all my data (JSON)</a></div>
      <details><summary class="small" style="cursor:pointer;font-weight:600;color:var(--danger)">Delete my account and all data</summary>
        <form data-form="delete-account" class="row" style="margin-top:10px;flex-wrap:nowrap"><input type="text" name="confirm" placeholder="Type DELETE" required><button class="btn btn-danger" type="submit">Delete everything</button></form>
        <p class="small muted">Revokes Google access and permanently deletes your workspace, emails, deals, drafts and audit log.</p></details>
    </div></section>
    <section class="card"><div class="card-head"><h2>Activity log</h2></div><div class="card-pad audit">${audit.map((a) => `${esc(a.at.slice(0, 16).replace('T', ' '))}  ${esc(a.action)}`).join('<br>') || 'No activity yet.'}</div></section>
  </div>`;
}

// ---------- planner ----------
const DAYMS = 864e5;
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const STAGE_SHORT = { new: 'New', negotiating: 'Negotiating', awaiting_delivery: 'Awaiting delivery', ready_to_film: 'Ready to film', editing: 'Editing', scheduled: 'Scheduled', published: 'Published' };
function evClass(e) { return e.kind === 'task' ? 'task' : e.kind === 'next' ? 'next' : e.proposed ? 'proposed' : 'email'; }
function evTitle(e) {
  const when = fmtDate(e.date, { weekday: 'short', day: 'numeric', month: 'short' });
  const src = e.kind === 'task' ? 'your task' : e.kind === 'next' ? 'suggested by Brieflane' : e.proposed ? 'proposed in email, not agreed' : 'stated in email';
  return `${e.label} — ${when} (${src})`;
}
async function viewPlanner() {
  const d = await api('/api/planner');
  const weeks = 6;
  const start = new Date(startOfWeek(new Date()).getTime() + (state.plannerOffset || 0) * 7 * DAYMS);
  const end = new Date(start.getTime() + weeks * 7 * DAYMS);
  const pct = (iso) => ((new Date(iso) - start) / (end - start)) * 100;
  const inRange = (e) => { const t = new Date(e.date); return t >= start && t < end; };
  const todayPct = pct(new Date().toISOString());
  const weekHeads = Array.from({ length: weeks }, (_, i) => {
    const w = new Date(start.getTime() + i * 7 * DAYMS);
    const isNow = Date.now() >= w.getTime() && Date.now() < w.getTime() + 7 * DAYMS;
    return `<div class="wk ${isNow ? 'now' : ''}"><span class="mono">${isNow ? 'This week' : `w/c`}</span> ${w.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>`;
  }).join('');
  const track = (events) => {
    const vis = events.filter(inRange);
    const before = events.filter((e) => new Date(e.date) < start).length;
    const after = events.filter((e) => new Date(e.date) >= end).length;
    return `<div class="track">${Array.from({ length: weeks }, () => '<span class="wkcell"></span>').join('')}
      ${todayPct >= 0 && todayPct <= 100 ? `<i class="todayline" style="left:${todayPct}%"></i>` : ''}
      ${vis.map((e, i) => `<span class="ev ${evClass(e)}" style="left:${pct(e.date)}%;top:${8 + (i % 3) * 22}px" title="${esc(evTitle(e))}"><i></i><b>${esc(e.label)}</b></span>`).join('')}
      ${!vis.length ? `<span class="nodates">${before ? `${before} earlier` : ''}${before && after ? ' · ' : ''}${after ? `${after} later` : ''}${!before && !after ? 'No dates yet' : ''}</span>` : ''}
    </div>`;
  };
  const upNext = (events) => events.filter((e) => new Date(e.date) >= new Date(Date.now() - DAYMS)).slice(0, 4);
  const row = (r) => `<div class="prow" data-go="#/deals/${r.id}">
      <div class="pinfo">
        <div class="row" style="gap:6px"><b class="pbrand">${esc(r.brand)}</b>${r.isDemo ? demoBadge : ''}</div>
        <div class="small muted">${esc([r.product, r.fee ? `${r.fee} · ${r.hasAgreement ? 'agreement in email' : 'not agreed'}` : null].filter(Boolean).join(' · ') || '\u00a0')}</div>
        <div class="row" style="gap:6px;margin-top:6px"><span class="stagechip st-${r.stage}">${STAGE_SHORT[r.stage]}</span>${r.stageBasis === 'user' ? '' : '<span class="small muted" title="Stage inferred from email">AI-inferred</span>'}</div>
        ${r.nextAction ? `<div class="pnext">→ ${esc(r.nextAction)}</div>` : ''}
      </div>
      <div class="ptrack">${track(r.events)}</div>
      <ul class="pmobile">${upNext(r.events).map((e) => `<li><span class="datebox sm"><span class="m">${fmtDate(e.date, { month: 'short' })}</span><span class="dd">${new Date(e.date).getDate()}</span></span><span class="evdot ${evClass(e)}"></span><span>${esc(e.label)}<span class="small muted"> · ${e.kind === 'task' ? 'your task' : e.kind === 'next' ? 'suggested' : e.proposed ? 'proposed' : 'from email'}</span></span></li>`).join('') || '<li class="small muted">No upcoming dates</li>'}</ul>
    </div>`;
  const projects = d.rows.filter((r) => state.plannerShowDone || r.stage !== 'published');
  const options = d.rows.filter((r) => r.stage !== 'published').map((r) => `<option value="${r.id}">${esc(r.brand)}${r.product ? ` — ${esc(r.product)}` : ''}</option>`).join('');
  const loose = d.looseTasks.length ? `<div class="prow loose"><div class="pinfo"><b class="pbrand">Other tasks</b><div class="small muted">Not linked to a project</div></div>
      <div class="ptrack">${track(d.looseTasks.filter((t) => t.due_at).map((t) => ({ date: t.due_at, label: t.title, kind: 'task' })))}</div>
      <ul class="pmobile">${d.looseTasks.slice(0, 4).map((t) => `<li><span class="evdot task"></span>${esc(t.title)}${t.due_at ? ` <span class="small muted">· ${fmtDate(t.due_at)}</span>` : ''}</li>`).join('')}</ul></div>` : '';
  const range = `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${new Date(end - DAYMS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  return `${demoBanner()}
    <div class="page-head"><div><div class="eyebrow">${weeks} weeks · ${esc(range)}</div><h1>Planner</h1></div>
      <div class="row"><button class="btn btn-sm" data-act="plan-shift" data-v="-1" aria-label="Previous weeks">‹</button><button class="btn btn-sm" data-act="plan-shift" data-v="0">This week</button><button class="btn btn-sm" data-act="plan-shift" data-v="1" aria-label="Next weeks">›</button></div></div>
    <div class="legend small"><span><span class="evdot email"></span>Date stated in email</span><span><span class="evdot proposed"></span>Proposed, not agreed</span><span><span class="evdot task"></span>Your task</span><span><span class="evdot next"></span>Suggested next step</span></div>
    ${projects.length || loose ? `<section class="card planner">
      <div class="phead"><div class="pinfo muted small">Project</div><div class="ptrack"><div class="weeks">${weekHeads}</div></div></div>
      ${projects.map(row).join('')}${loose}
    </section>` : '<div class="card empty">No projects yet. Connect Gmail in Settings and check email; each brand deal becomes a row here.</div>'}
    <section class="card card-pad" style="margin-top:16px">
      <h2 style="margin-bottom:10px">Add to the plan</h2>
      <form data-form="plan-task" class="planform">
        <select name="collabId" aria-label="Project"><option value="">No project</option>${options}</select>
        <input type="text" name="title" placeholder="e.g. Film B-roll, send draft, post Short" required aria-label="Task">
        <input type="date" name="dueAt" required aria-label="Date">
        <button class="btn btn-primary" type="submit">${icon('plus')}Add</button>
      </form>
      <label class="row small muted" style="margin-top:10px;gap:6px"><input type="checkbox" data-act="plan-done" ${state.plannerShowDone ? 'checked' : ''}> Show published projects</label>
    </section>`;
}

// ---------- router ----------
let renderSeq = 0;
const LOADING = '<div class="card empty loading-card"><span class="spin"></span> Loading…</div>';
async function render() {
  const seq = ++renderSeq;            // newer navigations win; stale responses are dropped
  const [pathPart, qs] = (location.hash.slice(1) || '/today').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = pathPart.split('/').filter(Boolean);
  if (!state.me) {
    try { state.me = await api('/api/me'); } catch (e) { if (seq === renderSeq) { if (e.status === 401 || e.status === 403) return viewLogin(); return showFatal(e); } return; }
    if (seq !== renderSeq) return;
    refreshBadge();
  }
  const route = parts[0] || 'today';
  const views = { today: viewToday, planner: viewPlanner, deals: () => (parts[1] ? viewDeal(parts[1]) : viewDeals(params)), calendar: viewCalendar, review: viewReview, assistant: viewAssistant, settings: () => viewSettings(params) };
  const view = views[route] || viewToday;

  // Instant feedback: highlight the tapped menu item and show progress straight away.
  const main = document.getElementById('main');
  if (!main) $app.innerHTML = shell(route, LOADING);
  else {
    updateNav(route);
    document.body.classList.add('busy');
    if (main.dataset.route !== pathPart) main.innerHTML = LOADING;
  }
  try {
    const html = await view();
    if (seq !== renderSeq) return;
    $app.innerHTML = shell(route, html);
    document.getElementById('main').dataset.route = pathPart;
    if (route === 'assistant') { const ch = document.getElementById('chat'); ch.scrollTop = ch.scrollHeight; }
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) { state.me = null; return viewLogin(); }
    $app.innerHTML = shell(route, `<div class="card card-pad stack" role="alert"><h2>That didn't load</h2><p class="muted" style="margin:0">${esc(e.message)}</p><div><button class="btn btn-primary" data-act="retry">Try again</button></div></div>`);
  } finally {
    if (seq === renderSeq) document.body.classList.remove('busy');
  }
}
function showFatal(e) {
  $app.innerHTML = `<div class="login"><div class="card login-card stack"><h1>Brieflane</h1><p class="muted">${esc(e.message)}</p><button class="btn btn-primary" data-act="retry">Try again</button></div></div>`;
}
/** Review badge loads in the background so it never slows navigation. */
async function refreshBadge() {
  try {
    const b = await api('/api/badge', { timeoutMs: 15000 });
    if (b.review !== state.reviewCount) { state.reviewCount = b.review; updateNav((location.hash.slice(2).split(/[/?]/)[0]) || 'today'); }
  } catch { /* badge is optional */ }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- actions ----------
async function busy(el, fn) {
  const label = el && el.innerHTML;
  if (el) { el.disabled = true; el.innerHTML = '<span class="spin"></span>'; }
  try { await fn(); } catch (e) { toast(e.message); } finally { if (el && document.body.contains(el)) { el.disabled = false; el.innerHTML = label; } }
}
const dealId = () => (location.hash.match(/#\/deals\/([^/?]+)/) || [])[1];
const draftEl = (el) => el.closest('[data-draft]');
const draftFields = (box) => ({ to_addr: box.querySelector('[name=to_addr]').value, subject: box.querySelector('[name=subject]').value, body: box.querySelector('[name=body]').value });

const actions = {
  retry: () => render(),
  'plan-shift': (el) => { const v = Number(el.dataset.v); state.plannerOffset = v === 0 ? 0 : (state.plannerOffset || 0) + v; render(); },
  'plan-done': (el) => { state.plannerShowDone = el.checked; render(); },
  'dev-login': (el) => busy(el, async () => { await api('/auth/dev-login', { method: 'POST' }); state.me = await api('/api/me'); location.hash = state.me.gmail ? '#/today' : '#/settings'; render(); }),
  logout: async () => { await api('/auth/logout', { method: 'POST' }); state.me = null; location.hash = '#/'; render(); },
  'connect-demo': (el) => busy(el, async () => {
    await api('/api/gmail/connect-demo', { method: 'POST' });
    const r = await runSteps('/api/gmail/sync');
    toast(`Demo inbox connected: ${r.collabMessages} collaboration emails, ${r.ignored} other emails skipped`);
    state.me = await api('/api/me'); location.hash = '#/today'; render();
  }),
  sync: (el) => busy(el, async () => {
    const r = await runSteps('/api/gmail/sync', (t) => t.remaining && toast(`Checking email… ${t.remaining} left`));
    toast(r.collabMessages ? `${r.collabMessages} new collaboration email${r.collabMessages > 1 ? 's' : ''} · ${r.collabsCreated} new deal${r.collabsCreated === 1 ? '' : 's'}` : 'No new collaboration emails');
    state.me = await api('/api/me'); refreshBadge(); render();
  }),
  'import-history': (el) => busy(el, async () => {
    const r = await runSteps('/api/gmail/import-history', (t) => toast(`Importing… ${t.processed} checked, ${t.remaining} to go`));
    toast(`Imported ${r.collabMessages} collaboration emails · ${r.toReview} detail${r.toReview === 1 ? '' : 's'} sent to Review`);
    refreshBadge(); location.hash = '#/review'; render();
  }),
  'enable-send': async (el) => {
    if (!confirm('Grant Brieflane permission to send emails you approve?\n\nThis is separate from read access. Every email still needs your explicit approval and a final confirmation.')) return;
    await busy(el, async () => { const r = await api('/api/gmail/enable-send', { method: 'POST' }); if (r.redirect) { location.href = r.redirect; return; } state.me = await api('/api/me'); toast('Send permission granted'); render(); });
  },
  disconnect: async (el) => {
    if (!confirm('Disconnect Gmail and revoke Brieflane\'s access?')) return;
    const purge = confirm('Also delete stored email bodies now? (Deals and extracted details are kept.)');
    await busy(el, async () => { await api('/api/gmail/disconnect', { method: 'POST', body: { purge } }); state.me = await api('/api/me'); toast('Gmail disconnected'); render(); });
  },
  filter: (el) => { state.dealFilter = el.dataset.v; render(); },
  stage: (el) => busy(null, async () => { await api(`/api/collaborations/${dealId()}`, { method: 'PATCH', body: { stage: el.dataset.v } }); toast('Stage updated — set by you'); render(); }),
  'stage-reset': () => busy(null, async () => { await api(`/api/collaborations/${dealId()}`, { method: 'PATCH', body: { resetStage: true } }); render(); }),
  'draft-new': (el) => busy(el, async () => { await api(`/api/collaborations/${dealId()}/drafts`, { method: 'POST' }); render(); }),
  'draft-save': (el) => busy(el, async () => { await api(`/api/drafts/${draftEl(el).dataset.draft}`, { method: 'PUT', body: draftFields(draftEl(el)) }); toast('Draft saved'); render(); }),
  'draft-approve': (el) => busy(el, async () => {
    const box = draftEl(el);
    await api(`/api/drafts/${box.dataset.draft}`, { method: 'PUT', body: draftFields(box) });
    await api(`/api/drafts/${box.dataset.draft}/approve`, { method: 'POST' });
    toast('Approved. Review once more, then send.'); render();
  }),
  'draft-unapprove': (el) => busy(el, async () => { const box = draftEl(el); await api(`/api/drafts/${box.dataset.draft}`, { method: 'PUT', body: draftFields(box) }); render(); }),
  'draft-send': async (el) => {
    const box = draftEl(el); const f = draftFields(box);
    const demo = state.me.gmail.mode === 'demo';
    if (!confirm(`${demo ? '[DEMO — simulated, nothing leaves the server]\n\n' : ''}Send this email now?\n\nTo: ${f.to_addr}\nSubject: ${f.subject}`)) return;
    await busy(el, async () => {
      try { await api(`/api/drafts/${box.dataset.draft}/send`, { method: 'POST', body: { confirm: true } }); }
      catch (e) { if (e.data && e.data.needsSendPermission) return actions['enable-send'](el); throw e; }
      toast(demo ? 'Sent (simulated in demo)' : 'Sent'); render();
    });
  },
  'draft-discard': (el) => busy(el, async () => { await api(`/api/drafts/${draftEl(el).dataset.draft}/discard`, { method: 'POST' }); render(); }),
  'task-toggle': (el) => busy(null, async () => { await api(`/api/tasks/${el.dataset.id}`, { method: 'PATCH', body: { done: el.checked } }); render(); }),
  'review-collab': (el) => busy(el, async () => { await api(`/api/review/collab/${el.closest('[data-review]').dataset.review}`, { method: 'POST', body: { action: el.dataset.v } }); toast(el.dataset.v === 'confirm' ? 'Added to your tracker' : 'Dismissed'); refreshBadge(); render(); }),
  'review-fact': (el) => busy(el, async () => { await api(`/api/review/fact/${el.closest('[data-fact]').dataset.fact}`, { method: 'POST', body: { action: el.dataset.v } }); refreshBadge(); render(); }),
  'ask-suggest': (el) => askQuestion(el.textContent),
};
/** Sync/import run in short server steps (serverless time limits); keep calling until done. */
async function runSteps(path, onProgress) {
  const total = { collabMessages: 0, collabsCreated: 0, toReview: 0, ignored: 0, processed: 0 };
  for (let i = 0; i < 200; i++) {
    const r = await api(path, { method: 'POST' });
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
    if (!r.more) return total;
    if (onProgress) onProgress({ ...total, remaining: r.remaining });
  }
  return total;
}
async function askQuestion(q) {
  state.chat.push({ who: 'me', text: q }); render();
  try { const r = await api('/api/assistant', { method: 'POST', body: { question: q } }); state.chat.push({ who: 'bot', text: r.answer, gen: r.generator }); }
  catch (e) { state.chat.push({ who: 'bot', text: e.message }); }
  render();
}
const forms = {
  ask: (f) => { const q = f.q.value.trim(); if (q) askQuestion(q); },
  'plan-task': (f) => busy(f.querySelector('button'), async () => {
    await api('/api/tasks', { method: 'POST', body: { title: f.title.value, dueAt: f.dueAt.value || null, collabId: f.collabId.value || null } });
    toast('Added to your plan'); render();
  }),
  'add-task': (f) => busy(null, async () => { await api('/api/tasks', { method: 'POST', body: { title: f.title.value, dueAt: f.dueAt.value || null, collabId: dealId() } }); render(); }),
  'add-fact': (f) => busy(null, async () => { await api(`/api/collaborations/${dealId()}/facts`, { method: 'POST', body: { kind: f.kind.value, label: f.kind.options[f.kind.selectedIndex].text, value: f.value.value, dueAt: f.dueAt.value || null } }); toast('Added — marked as set by you'); render(); }),
  retention: (f) => busy(null, async () => { await api('/api/privacy/retention', { method: 'POST', body: { days: Number(f.days.value) } }); toast('Retention saved'); }),
  'delete-account': (f) => busy(null, async () => {
    if (!confirm('This permanently deletes your workspace and all data. Continue?')) return;
    await api('/api/privacy/delete-account', { method: 'POST', body: { confirm: f.confirm.value } });
    state.me = null; location.hash = '#/'; toast('Account deleted'); render();
  }),
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a && actions[a.dataset.act]) { if (a.tagName !== 'INPUT') e.preventDefault(); actions[a.dataset.act](a); return; }
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button')) location.hash = go.dataset.go;
});
document.addEventListener('submit', (e) => { const f = e.target.closest('[data-form]'); if (f && forms[f.dataset.form]) { e.preventDefault(); forms[f.dataset.form](f); } });

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
