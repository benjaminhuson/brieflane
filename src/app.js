'use strict';
const { forTenant, STAGES, STAGE_LABEL } = require('./repo');
const { makeServices, httpErr } = require('./services');
const { makeLlm } = require('./ai/llm');
const { computeAttention, pipelineCounts, upcoming, planner, briefing, groupBy } = require('./ai/attention');
const { ask } = require('./ai/assistant');
const { generateDraft } = require('./ai/drafts');
const { setStageByUser, refreshDerived } = require('./ingest/pipeline');
const { safeEqual } = require('./crypto');
const { AGENTS, ORDER, isEnabled } = require('./agents');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * Framework-agnostic app. handleRequest({ method, url, headers, body, ip }) → { status, headers, cookies, body }.
 * src/server.js adapts it to Node's http server; netlify/functions/api.mjs adapts it to Netlify Functions.
 */
function createApp({ cfg, db, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
  const llm = makeLlm(cfg, fetchImpl);
  const svc = makeServices({ cfg, db, llm, fetchImpl, clock });
  const routes = [];
  const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), opts, handler });

  // Fixed-window rate limiter. Per function instance on Netlify (best effort); move to Postgres/Redis for strictness.
  const buckets = new Map();
  function limit(key, max, windowMs = 60e3) {
    const now = Date.now(); const b = buckets.get(key) || { n: 0, reset: now + windowMs };
    if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
    b.n++; buckets.set(key, b);
    if (b.n > max) throw httpErr(429, 'Too many requests — slow down a little');
  }

  const cookieName = cfg.isProd ? '__Host-bl_sid' : 'bl_sid';
  const sessionCookie = (value, maxAgeSec) => [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(cfg.isProd ? ['Secure'] : [])].join('; ');
  const readCookie = (headers) => {
    const m = (headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`));
    return m ? decodeURIComponent(m.slice(cookieName.length + 1)) : null;
  };
  const login = async (ctx, user, method) => {
    const s = await svc.createSession(user);
    ctx.cookies.push(sessionCookie(s.raw, cfg.sessionTtlDays * 86400));
    await forTenant(db, user.tenant_id).audit(user.id, 'auth.login', { method });
  };

  // ================= Auth =================
  route('GET', '/auth/config', { public: true }, () => ({ googleConfigured: cfg.googleConfigured, devLogin: cfg.allowDevLogin, demoMode: cfg.demoMode, ai: llm.label }));
  route('POST', '/auth/dev-login', { public: true, sameOrigin: true }, async (ctx) => {
    limit(`auth:${ctx.ip}`, 20);
    await login(ctx, await svc.devLogin(), 'demo');
    return { ok: true };
  });
  route('GET', '/auth/google/start', { public: true }, async (ctx) => {
    limit(`auth:${ctx.ip}`, 20);
    const purpose = ctx.query.get('purpose') || 'signin';
    if (purpose !== 'signin' && !ctx.session) throw httpErr(401, 'Sign in first');
    return { redirect: await svc.startOAuth({ purpose, session: ctx.session }) };
  });
  route('GET', '/auth/google/callback', { public: true }, async (ctx) => {
    const err = ctx.query.get('error');
    if (err) return { redirect: `/#/${ctx.session ? 'settings' : 'login'}?oauth_error=${encodeURIComponent(err === 'access_denied' ? 'You cancelled the Google screen' : err)}` };
    const r = await svc.finishOAuth({ code: ctx.query.get('code'), state: ctx.query.get('state'), currentSession: ctx.session });
    if (r.purpose === 'signin') { await login(ctx, r.user, 'google'); return { redirect: '/#/today' }; }
    return { redirect: `/#/settings?connected=${r.purpose}` };
  });
  route('POST', '/auth/logout', {}, async (ctx) => { await svc.destroySession(ctx.rawSession); ctx.cookies.push(sessionCookie('', 0)); return { ok: true }; });

  // ================= App API =================
  route('GET', '/api/me', {}, async (ctx) => {
    const conn = await ctx.repo.connection();
    const tenant = await ctx.repo.tenant();
    return {
      user: { email: ctx.session.email, name: ctx.session.name, isDemo: svc.isDemoUser(ctx.session.email) },
      tenant: { name: tenant.name, retentionDays: tenant.retention_days },
      csrf: ctx.session.csrf, ai: llm.label, demoMode: cfg.demoMode, googleConfigured: cfg.googleConfigured,
      gmail: conn ? { mode: conn.mode, email: conn.email, canRead: true, canSend: svc.canSend(conn), lastSyncAt: conn.last_sync_at, historyImportedAt: conn.history_imported_at } : null,
      stages: STAGES.map((s) => ({ id: s, label: STAGE_LABEL[s] })),
    };
  });

  route('GET', '/api/today', {}, async (ctx) => {
    const now = clock();
    const [snap, activity, cached] = await Promise.all([ctx.repo.snapshot(), ctx.repo.recentAgentActivity(new Date(now - 3 * 864e5).toISOString()), ctx.repo.cachedBriefing()]);
    const attention = computeAttention(snap, now);
    // Rules briefing is instant; the AI version (if enabled) loads separately from /api/briefing.
    const rules = await briefing(snap, { enabled: false }, { now, name: (ctx.session.name || 'there').split(' ')[0], items: attention });
    return {
      briefing: rules,
      aiBriefing: llm.enabled,
      cachedAiBriefing: cached && now - new Date(cached.created_at) < 6 * 3600e3 ? JSON.parse(cached.body) : null,
      agentActivity: activity.map((r) => ({ ...r, outputs: r.outputs ? JSON.parse(r.outputs) : [], name: AGENTS[r.agent].name })),
      attention,
      pipeline: pipelineCounts(snap),
      upcoming: upcoming(snap, now, 35).filter((u) => new Date(u.date) >= new Date(now - 864e5)),
      hasDemoData: snap.collabs.some((c) => c.is_demo),
      reviewCount: snap.reviewCount,
    };
  });

  route('GET', '/api/briefing', {}, async (ctx) => { limit(`ai:${ctx.session.tenant_id}`, 60); return svc.aiBriefing(ctx.repo, (ctx.session.name || 'there').split(' ')[0]); });

  // ---------- Agents ----------
  route('GET', '/api/agents', {}, async (ctx) => {
    const [settings, runs, all] = await Promise.all([ctx.repo.agentSettings(), ctx.repo.agentRuns(40), ctx.repo.agentRunCounts()]);
    const counts = Object.fromEntries(all.map((r) => [r.agent, r.n]));
    return {
      ai: llm.enabled, aiLabel: llm.label,
      agents: ORDER.map((stage) => ({ stage, name: AGENTS[stage].name, does: AGENTS[stage].does, enabled: isEnabled(settings, stage), runs: counts[stage] || 0 })),
      settings: { profile: settings.profile, rates: settings.rates, signoff: settings.signoff },
      runs: runs.map((r) => ({ ...r, outputs: r.outputs ? JSON.parse(r.outputs) : [], name: AGENTS[r.agent].name })),
    };
  });
  route('POST', '/api/agents/settings', {}, async (ctx) => {
    const b = ctx.body || {};
    const enabled = {};
    if (b.enabled && typeof b.enabled === 'object') for (const k of ORDER) if (typeof b.enabled[k] === 'boolean') enabled[k] = b.enabled[k];
    let rates;
    if (b.rates && typeof b.rates === 'object') {
      rates = {};
      for (const k of ['dedicated', 'integration', 'short', 'review']) { const v = Number(b.rates[k]); if (Number.isFinite(v) && v >= 0 && v < 1e6) rates[k] = Math.round(v); }
    }
    const saved = await ctx.repo.saveAgentSettings({ enabled, rates,
      profile: typeof b.profile === 'string' ? b.profile.slice(0, 1500) : undefined, signoff: typeof b.signoff === 'string' ? b.signoff.slice(0, 60) : undefined });
    await ctx.repo.audit(ctx.session.user_id, 'agents.settings');
    return saved;
  });
  route('POST', '/api/ai/test', {}, async (ctx) => {
    limit(`ai:${ctx.session.tenant_id}`, 10);
    if (!llm.enabled) return { ok: false, message: 'No AI key is set. Add ANTHROPIC_API_KEY in Netlify, then redeploy.' };
    const t0 = Date.now();
    try {
      const out = await llm.complete({ system: 'Reply with the single word OK.', prompt: 'Test', maxTokens: 5, timeoutMs: 20000 });
      return { ok: true, message: `AI is working (${llm.label}, replied in ${((Date.now() - t0) / 1000).toFixed(1)}s): ${out.trim().slice(0, 20)}` };
    } catch (e) {
      const hint = /workspace/i.test(e.message) ? ' Fix: create the key inside a workspace, or add ANTHROPIC_WORKSPACE_ID in Netlify.'
        : e.status === 401 ? ' The key looks wrong or revoked; paste it again in Netlify.' : /credit|billing|balance/i.test(e.message) ? ' Add credit in the Claude Console billing page.' : '';
      return { ok: false, message: `${e.message}.${hint}` };
    }
  });
  route('POST', '/api/agents/run', {}, async (ctx) => { limit(`agents:${ctx.session.tenant_id}`, 60); return svc.runAgentsStep(ctx.repo); });
  route('POST', '/api/collaborations/:id/agent', {}, async (ctx) => {
    limit(`agents:${ctx.session.tenant_id}`, 60);
    const c = await ctx.repo.collab(ctx.params.id);
    if (!c) throw httpErr(404, 'not found');
    await ctx.repo.enqueueAgent({ collabId: c.id, agent: c.stage, stage: c.stage, runKey: `manual:${Date.now()}`, trigger: 'manual' });
    await ctx.repo.audit(ctx.session.user_id, 'agent.manual', { cid: c.id, agent: c.stage });
    return svc.runAgentsStep(ctx.repo);
  });
  route('PUT', '/api/docs/:id', {}, async (ctx) => {
    if (!(await ctx.repo.doc(ctx.params.id))) throw httpErr(404, 'not found');
    await ctx.repo.updateDoc(ctx.params.id, { body: typeof (ctx.body || {}).body === 'string' ? ctx.body.body.slice(0, 20000) : null });
    return ctx.repo.doc(ctx.params.id);
  });
  route('POST', '/api/docs/:id/dismiss', {}, async (ctx) => {
    if (!(await ctx.repo.doc(ctx.params.id))) throw httpErr(404, 'not found');
    await ctx.repo.updateDoc(ctx.params.id, { dismissed: 1 }); return { ok: true };
  });

  route('GET', '/api/planner', {}, async (ctx) => ({ ...planner(await ctx.repo.snapshot(), clock()), today: clock().toISOString() }));
  route('GET', '/api/badge', {}, async (ctx) => ({ review: (await ctx.repo.reviewCounts()).total }));

  route('GET', '/api/collaborations', {}, async (ctx) => {
    const snap = await ctx.repo.snapshot();
    const factsBy = groupBy(snap.facts, 'collab_id');
    return snap.collabs.map((c) => {
      const facts = factsBy[c.id] || [];
      return {
        ...c,
        deadline: facts.filter((f) => f.kind === 'deadline' && f.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at))[0] || null,
        fee: facts.filter((f) => f.kind === 'payment').slice(-1)[0] || null,
        hasAgreement: facts.some((f) => f.kind === 'agreement'),
      };
    });
  });

  route('GET', '/api/collaborations/:id', {}, async (ctx) => {
    const [c, facts, messages, drafts, tasks, docs, runs, settings] = await Promise.all([
      ctx.repo.collab(ctx.params.id),
      ctx.repo.facts(ctx.params.id, { statuses: ['active', 'pending_review', 'superseded'] }),
      ctx.repo.messagesForCollab(ctx.params.id),
      ctx.repo.drafts(ctx.params.id),
      ctx.repo.tasks({ includeDone: true }),
      ctx.repo.docs(ctx.params.id),
      ctx.repo.agentRunsFor(ctx.params.id),
      ctx.repo.agentSettings(),
    ]);
    if (!c) throw httpErr(404, 'not found');
    return {
      collab: c, facts, drafts, docs,
      agent: { stage: c.stage, name: AGENTS[c.stage].name, does: AGENTS[c.stage].does, enabled: isEnabled(settings, c.stage) },
      agentRuns: runs.map((r) => ({ ...r, outputs: r.outputs ? JSON.parse(r.outputs) : [], name: AGENTS[r.agent].name })),
      messages: messages.map((m) => ({ ...m, message_id_header: undefined })),
      tasks: tasks.filter((t) => t.collab_id === c.id),
    };
  });
  route('PATCH', '/api/collaborations/:id', {}, async (ctx) => {
    const c = await ctx.repo.collab(ctx.params.id);
    if (!c) throw httpErr(404, 'not found');
    const b = ctx.body || {};
    let agentQueued = false;
    if (b.stage) agentQueued = await setStageByUser(ctx.repo, c.id, b.stage, ctx.session.user_id);
    if (b.resetStage) { await ctx.repo.updateCollab(c.id, { stage_basis: 'inferred', stage_reason: null }); await refreshDerived(ctx.repo, c.id, { now: clock() }); }
    const patch = {};
    for (const k of ['brand', 'product', 'agency']) if (typeof b[k] === 'string') patch[k] = b[k].slice(0, 120);
    if (typeof b.archived === 'boolean') patch.archived = b.archived ? 1 : 0;
    if (Object.keys(patch).length) { await ctx.repo.updateCollab(c.id, patch); await ctx.repo.audit(ctx.session.user_id, 'collab.edit', { cid: c.id, fields: Object.keys(patch) }); }
    return { ...(await ctx.repo.collab(c.id)), agentQueued: Boolean(agentQueued) };
  });
  route('POST', '/api/collaborations/:id/facts', {}, async (ctx) => {
    const c = await ctx.repo.collab(ctx.params.id);
    if (!c) throw httpErr(404, 'not found');
    const { kind, label, value, dueAt } = ctx.body || {};
    if (!['deliverable', 'deadline', 'payment', 'shipping', 'product', 'contact', 'note'].includes(kind) || !value) throw httpErr(400, 'kind and value required');
    const fid = await ctx.repo.addFact({ collabId: c.id, kind, label: String(label || kind).slice(0, 80), value: String(value).slice(0, 300), valueKey: `${kind}:user:${Date.now()}`,
      slot: null, dueAt: dueAt ? new Date(dueAt).toISOString() : null, basis: 'user', status: 'active', confidence: 1 });
    await refreshDerived(ctx.repo, c.id, { now: clock() });
    return ctx.repo.fact(fid);
  });

  // Drafts
  route('POST', '/api/collaborations/:id/drafts', {}, async (ctx) => {
    limit(`ai:${ctx.session.tenant_id}`, 30);
    const d = await generateDraft(ctx.repo, llm, ctx.params.id);
    await ctx.repo.audit(ctx.session.user_id, 'draft.generate', { did: d.id });
    return d;
  });
  route('PUT', '/api/drafts/:id', {}, (ctx) => svc.editDraft(ctx.repo, ctx.params.id, ctx.body || {}, ctx.session.user_id));
  route('POST', '/api/drafts/:id/approve', {}, (ctx) => svc.approveDraft(ctx.repo, ctx.params.id, ctx.session.user_id));
  route('POST', '/api/drafts/:id/send', {}, (ctx) => {
    if (!(ctx.body && ctx.body.confirm === true)) throw httpErr(400, 'Explicit confirmation required');
    return svc.sendDraft(ctx.repo, ctx.params.id, ctx.session.user_id);
  });
  route('POST', '/api/drafts/:id/discard', {}, async (ctx) => {
    const d = await ctx.repo.draft(ctx.params.id);
    if (!d || d.status === 'sent') throw httpErr(404, 'not found');
    await ctx.repo.updateDraft(d.id, { status: 'discarded' }); return { ok: true };
  });

  // Tasks
  route('POST', '/api/tasks', {}, async (ctx) => {
    const { title, dueAt, collabId } = ctx.body || {};
    if (!title) throw httpErr(400, 'title required');
    if (collabId && !(await ctx.repo.collab(collabId))) throw httpErr(404, 'collaboration not found');
    return ctx.repo.task(await ctx.repo.addTask({ title: String(title).slice(0, 200), dueAt: dueAt ? new Date(dueAt).toISOString() : null, collabId: collabId || null }));
  });
  route('PATCH', '/api/tasks/:id', {}, async (ctx) => {
    if (!(await ctx.repo.task(ctx.params.id))) throw httpErr(404, 'not found');
    await ctx.repo.setTaskDone(ctx.params.id, Boolean(ctx.body && ctx.body.done)); return ctx.repo.task(ctx.params.id);
  });
  route('GET', '/api/calendar', {}, async (ctx) => upcoming(await ctx.repo.snapshot(), clock(), 120));

  // Review
  route('GET', '/api/review', {}, (ctx) => ctx.repo.reviewQueue());
  route('POST', '/api/review/collab/:id', {}, async (ctx) => { await svc.reviewCollab(ctx.repo, ctx.params.id, ctx.body && ctx.body.action, ctx.session.user_id); return { ok: true }; });
  route('POST', '/api/review/fact/:id', {}, async (ctx) => { await svc.reviewFact(ctx.repo, ctx.params.id, ctx.body && ctx.body.action, ctx.session.user_id); return { ok: true }; });

  // Assistant
  route('POST', '/api/assistant', {}, async (ctx) => { limit(`ai:${ctx.session.tenant_id}`, 30); return ask(await ctx.repo.snapshot(), llm, ctx.body && ctx.body.question, clock()); });

  // Gmail
  route('POST', '/api/gmail/connect-demo', {}, async (ctx) => { await svc.connectDemo(ctx.repo, ctx.session); return { ok: true }; });
  route('POST', '/api/gmail/enable-send', {}, async (ctx) => {
    const c = await ctx.repo.connection();
    if (!c) throw httpErr(409, 'Connect Gmail first');
    if (c.mode === 'demo') { await svc.enableDemoSend(ctx.repo, ctx.session.user_id); return { ok: true }; }
    return { redirect: '/auth/google/start?purpose=gmail_send' };
  });
  // Both return { more: true } when there's more to do; the client calls again.
  route('POST', '/api/gmail/sync', {}, (ctx) => { limit(`sync:${ctx.session.tenant_id}`, 60); return svc.syncStep(ctx.repo, ctx.session.user_id, 'recent'); });
  route('POST', '/api/gmail/import-history', {}, (ctx) => { limit(`sync:${ctx.session.tenant_id}`, 120); return svc.syncStep(ctx.repo, ctx.session.user_id, 'history'); });
  route('POST', '/api/gmail/disconnect', {}, async (ctx) => { await svc.disconnectGmail(ctx.repo, ctx.session.user_id, { purge: Boolean(ctx.body && ctx.body.purge) }); return { ok: true }; });

  // Privacy
  route('GET', '/api/privacy/export', {}, async (ctx) => {
    await ctx.repo.audit(ctx.session.user_id, 'privacy.export');
    ctx.headers['Content-Disposition'] = `attachment; filename="brieflane-export-${new Date().toISOString().slice(0, 10)}.json"`;
    return svc.exportData(ctx.repo);
  });
  route('POST', '/api/privacy/retention', {}, async (ctx) => {
    const days = Number(ctx.body && ctx.body.days);
    if (!Number.isInteger(days) || days < 30 || days > 3650) throw httpErr(400, 'Retention must be 30–3650 days');
    await ctx.repo.setRetention(days); await ctx.repo.audit(ctx.session.user_id, 'privacy.retention', { days });
    await svc.runRetention();
    return { ok: true, days };
  });
  route('POST', '/api/privacy/delete-account', {}, async (ctx) => {
    if (!(ctx.body && ctx.body.confirm === 'DELETE')) throw httpErr(400, 'Type DELETE to confirm');
    await svc.deleteAccount(ctx.repo);
    ctx.cookies.push(sessionCookie('', 0));
    return { ok: true };
  });
  route('GET', '/api/audit', {}, (ctx) => ctx.repo.auditLog(100));
  route('GET', '/api/health', { public: true }, async () => {
    const t0 = Date.now(); await db.query('SELECT 1 AS ok'); const first = Date.now() - t0;
    const t1 = Date.now(); for (let i = 0; i < 3; i++) await db.query('SELECT 1 AS ok');
    return { ok: true, db: db.kind, firstQueryMs: first, roundTripMs: Math.round((Date.now() - t1) / 3), region: process.env.AWS_REGION || 'local' };
  });

  // ================= Core handler =================
  async function handleRequest({ method, url, headers = {}, body = null, ip = '' }) {
    const u = new URL(url, cfg.baseUrl);
    const out = { status: 200, headers: { ...SECURITY_HEADERS, ...(cfg.isProd ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}) }, cookies: [], body: null };
    const ctx = { query: u.searchParams, headers: out.headers, cookies: out.cookies, ip, params: {} };
    try {
      const r = routes.find((x) => x.method === method && x.re.test(u.pathname));
      if (!r) throw Object.assign(httpErr(404, 'not found'), { noRoute: true });
      ctx.params = r.re.exec(u.pathname).groups || {};
      ctx.rawSession = readCookie(headers);
      ctx.session = await svc.sessionFromToken(ctx.rawSession);
      if (!r.opts.public && !ctx.session) throw httpErr(401, 'Not signed in');
      if (method !== 'GET') {
        // CSRF: authenticated mutations need the per-session token; pre-auth POSTs need a same-origin Origin.
        if (ctx.session && !r.opts.public && !safeEqual(headers['x-csrf-token'], ctx.session.csrf)) throw httpErr(403, 'Bad CSRF token');
        if (r.opts.sameOrigin && headers.origin && ![cfg.baseUrl, `http://${headers.host}`, `https://${headers.host}`].includes(headers.origin)) throw httpErr(403, 'Cross-origin request refused');
        if (body && body.length > 1e6) throw httpErr(413, 'Body too large');
        try { ctx.body = body ? JSON.parse(body) : {}; } catch { throw httpErr(400, 'Invalid JSON'); }
      }
      if (ctx.session) ctx.repo = forTenant(db, ctx.session.tenant_id);
      const started = Date.now();
      const result = await r.handler(ctx);
      out.headers['Server-Timing'] = `app;dur=${Date.now() - started}`;
      if (result && result.redirect && method === 'GET') { out.status = 302; out.headers.Location = result.redirect; return out; }
      return json(out, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (method === 'GET' && u.pathname === '/auth/google/callback') { out.status = 302; out.headers.Location = `/#/${ctx.session ? 'settings' : 'login'}?oauth_error=${encodeURIComponent(e.message)}`; return out; }
      return Object.assign(json(out, status, { error: status === 500 ? 'Something went wrong' : e.message, ...(e.needsSendPermission ? { needsSendPermission: true } : {}) }), { noRoute: e.noRoute });
    }
  }

  return { handleRequest, svc, llm, cfg, db };
}

function json(out, status, obj) {
  out.status = status;
  out.headers['Content-Type'] = 'application/json; charset=utf-8';
  out.headers['Cache-Control'] = 'no-store';
  out.body = JSON.stringify(obj);
  return out;
}

module.exports = { createApp, SECURITY_HEADERS };
