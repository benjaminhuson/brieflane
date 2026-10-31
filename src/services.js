'use strict';
const { forTenant } = require('./repo');
const { id, token, sha256, makeCipher, pkcePair } = require('./crypto');
const { SCOPES, COLLAB_QUERY, authUrl, makeGoogle, makeGmailClient } = require('./gmail/google');
const { makeDemoProvider } = require('./gmail/demo');
const { ingestOne, newStats, finishStats, refreshDerived } = require('./ingest/pipeline');
const { CHECK } = require('./ai/drafts');

const nowIso = () => new Date().toISOString();
const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const DEMO_EMAIL = 'huson-diy@demo.brieflane.local';
const isDemoUser = (email) => String(email || '').endsWith('@demo.brieflane.local');

function makeServices({ cfg, db, llm, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
  const cipher = makeCipher(cfg.tokenKey);
  const google = makeGoogle(cfg, fetchImpl);
  const demo = makeDemoProvider(clock);

  // ---------------- Accounts & sessions ----------------
  async function createTenantWithUser({ email, name, googleSub, tenantName }) {
    return db.tx(async (t) => {
      const tid = id('ten'); const uid = id('usr');
      await t.run('INSERT INTO tenants (id, name, retention_days, created_at) VALUES (?,?,?,?)', [tid, tenantName || name || email, cfg.defaultRetentionDays, nowIso()]);
      await t.run('INSERT INTO users (id, tenant_id, email, name, google_sub, created_at) VALUES (?,?,?,?,?,?)', [uid, tid, email.toLowerCase(), name || null, googleSub || null, nowIso()]);
      return (await t.query('SELECT * FROM users WHERE id=?', [uid]))[0];
    });
  }
  async function createSession(user) {
    const raw = token(32); const csrf = token(24);
    const exp = new Date(Date.now() + cfg.sessionTtlDays * 864e5).toISOString();
    await db.run('INSERT INTO sessions (id_hash, user_id, tenant_id, csrf, expires_at, created_at) VALUES (?,?,?,?,?,?)', [sha256(raw), user.id, user.tenant_id, csrf, exp, nowIso()]);
    return { raw, csrf, expires: exp };
  }
  async function sessionFromToken(raw) {
    if (!raw) return null;
    const s = (await db.query('SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?', [sha256(raw)]))[0];
    if (!s || s.expires_at < nowIso()) return null;
    return s;
  }
  const destroySession = async (raw) => { if (raw) await db.run('DELETE FROM sessions WHERE id_hash=?', [sha256(raw)]); };

  /** Demo workspace: sample inbox only. It can never be connected to a real Gmail account. */
  async function devLogin() {
    if (!cfg.allowDevLogin) throw httpErr(403, 'Demo login is disabled');
    let user = (await db.query('SELECT * FROM users WHERE email=?', [DEMO_EMAIL]))[0];
    if (!user) {
      user = await createTenantWithUser({ email: DEMO_EMAIL, name: 'Ben', tenantName: 'Huson DIY (demo workspace)' });
      await seedHistoricalNotes(forTenant(db, user.tenant_id));
    }
    return user;
  }

  /** Context from earlier planning conversations — NOT from email, NOT current commitments. Goes to Review. */
  async function seedHistoricalNotes(repo) {
    for (const [brand, agency, product] of [['Botslab', null, 'smart-home security (enquiry)'], ['WOTOKOL', 'WOTOKOL (agency)', 'IFA Berlin 2026 collaboration (proposal)'], ['Outsunny', null, 'product gifting (your outreach)']]) {
      await repo.createCollab({ brand, brandKey: brand.toLowerCase(), agency, product, kind: 'unknown', stage: 'new', stageBasis: 'historical_note',
        stageReason: 'Mentioned in an earlier planning conversation, not found in email. Status unknown — not a current commitment.', needsReview: true });
    }
  }

  // ---------------- OAuth ----------------
  async function startOAuth({ purpose, session }) {
    if (!cfg.googleConfigured) throw httpErr(400, 'Google OAuth is not configured on this server yet (see README → Setup).');
    if (purpose !== 'signin' && session && isDemoUser(session.email)) throw httpErr(403, "The demo workspace can't connect a real inbox. Sign out and continue with Google.");
    const scopes = purpose === 'signin' ? SCOPES.signIn
      : purpose === 'gmail_read' ? [...SCOPES.signIn, SCOPES.read]
        : purpose === 'gmail_send' ? [...SCOPES.signIn, SCOPES.send] : null;
    if (!scopes) throw httpErr(400, 'bad purpose');
    const { verifier, challenge } = pkcePair();
    const state = token(24);
    await db.run('INSERT INTO oauth_states (state, verifier, purpose, user_id, created_at) VALUES (?,?,?,?,?)', [state, verifier, purpose, session ? session.user_id : null, nowIso()]);
    return authUrl(cfg, { scopes, state, challenge, loginHint: session && !isDemoUser(session.email) ? session.email : undefined, offline: purpose !== 'signin' });
  }

  async function finishOAuth({ code, state, currentSession }) {
    const st = (await db.query('SELECT * FROM oauth_states WHERE state=?', [state || '']))[0];
    if (!st) throw httpErr(400, 'Invalid or expired sign-in attempt — please try again');
    await db.run('DELETE FROM oauth_states WHERE state=?', [state]);
    if (Date.now() - Date.parse(st.created_at) > 15 * 60e3) throw httpErr(400, 'Sign-in attempt expired — please try again');
    const tok = await google.exchangeCode(code, st.verifier);
    const info = await google.userinfo(tok.access_token);
    if (!info.email_verified) throw httpErr(403, 'Google account email is not verified');
    const email = info.email.toLowerCase();

    if (st.purpose === 'signin') {
      if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) throw httpErr(403, `Brieflane is in private beta and ${email} isn't on the list yet.`);
      let user = (await db.query('SELECT * FROM users WHERE google_sub=?', [info.sub]))[0] || (await db.query('SELECT * FROM users WHERE email=?', [email]))[0];
      if (!user) user = await createTenantWithUser({ email, name: info.name, googleSub: info.sub });
      else if (!user.google_sub) await db.run('UPDATE users SET google_sub=? WHERE id=?', [info.sub, user.id]);
      return { user, purpose: 'signin' };
    }
    // Gmail connect/upgrade must be finished by the same signed-in user that started it.
    if (!currentSession || currentSession.user_id !== st.user_id) throw httpErr(403, 'Session mismatch for Gmail connection — please try again');
    const repo = forTenant(db, currentSession.tenant_id);
    const granted = String(tok.scope || '').split(' ');
    const prev = await repo.connection();
    if (!granted.includes(SCOPES.read) && !(prev && prev.scopes.includes(SCOPES.read))) throw httpErr(403, 'Gmail read access was not granted (tick the Gmail box on the Google screen)');
    const scopes = [...new Set([...(prev ? prev.scopes.split(' ') : []), ...granted])].filter(Boolean).join(' ');
    await repo.saveConnection({
      userId: currentSession.user_id, email, mode: 'google', scopes,
      encRefresh: tok.refresh_token ? cipher.encrypt(tok.refresh_token, repo.tenantId) : null,
      encAccess: cipher.encrypt(tok.access_token, repo.tenantId),
      accessExpiresAt: new Date(Date.now() + (tok.expires_in || 3000) * 1000).toISOString(),
    });
    await repo.audit(currentSession.user_id, st.purpose === 'gmail_send' ? 'gmail.send_granted' : 'gmail.connected', { email });
    return { purpose: st.purpose };
  }

  // ---------------- Gmail provider per tenant ----------------
  // Interface: candidates(kind) → ordered Gmail ids · get(id) → normalized message · send(msg)
  async function provider(repo) {
    const conn = await repo.connection();
    if (!conn) throw httpErr(409, 'Gmail is not connected');
    if (conn.mode === 'demo') {
      return {
        isDemo: true, conn,
        async candidates(kind) { return (kind === 'history' ? [...await demo.historical(), ...await demo.recent()] : await demo.recent()).map((m) => m.gmailId); },
        async get(gid) { return [...await demo.recent(), ...await demo.historical()].find((m) => m.gmailId === gid); },
        send: (m) => demo.send(m),
      };
    }
    const getAccessToken = async () => {
      const c = await repo.connection();
      if (c.enc_access && c.access_expires_at > new Date(Date.now() + 60e3).toISOString()) return cipher.decrypt(c.enc_access, repo.tenantId);
      const refresh = cipher.decrypt(c.enc_refresh, repo.tenantId);
      if (!refresh) throw httpErr(401, 'Gmail authorisation expired — reconnect Gmail in Settings');
      let t;
      try { t = await google.refresh(refresh); } catch { throw httpErr(401, 'Gmail authorisation expired or was revoked — reconnect Gmail in Settings'); }
      await repo.updateAccess(cipher.encrypt(t.access_token, repo.tenantId), new Date(Date.now() + (t.expires_in || 3000) * 1000).toISOString());
      return t.access_token;
    };
    const client = makeGmailClient({ getAccessToken, accountEmail: conn.email }, fetchImpl);
    return {
      isDemo: false, conn,
      async candidates(kind) {
        if (kind === 'history') return (await client.listIds(`newer_than:${cfg.historicalImportDays}d ${COLLAB_QUERY}`, 500)).reverse(); // oldest first
        const since = conn.last_sync_at ? Math.floor(Date.parse(conn.last_sync_at) / 1000) - 3600 : null;
        const ids = (await client.listIds(`${since ? `after:${since}` : 'newer_than:30d'} ${COLLAB_QUERY}`, 200)).reverse();
        // Replies in tracked threads often lack keywords, so check those threads directly.
        for (const tid of await repo.trackedThreads(40)) for (const mid of await client.threadMessageIds(tid)) if (!ids.includes(mid)) ids.push(mid);
        return ids;
      },
      get: (gid) => client.getMessage(gid),
      send: (m) => client.send(m),
    };
  }

  async function connectDemo(repo, session) {
    if (!cfg.demoMode && !isDemoUser(session.email)) throw httpErr(400, 'The demo inbox is only for the demo workspace');
    await repo.saveConnection({ userId: session.user_id, email: demo.accountEmail, mode: 'demo', scopes: 'demo.read' });
    await repo.audit(session.user_id, 'gmail.connected', { mode: 'demo' });
  }
  async function enableDemoSend(repo, userId) {
    const c = await repo.connection();
    if (!c || c.mode !== 'demo') throw httpErr(400, 'Not a demo connection');
    await repo.saveConnection({ userId, email: c.email, mode: 'demo', scopes: [...new Set([...c.scopes.split(' '), 'demo.send'])].join(' ') });
    await repo.audit(userId, 'gmail.send_granted', { mode: 'demo' });
  }
  const canSend = (conn) => Boolean(conn && (conn.scopes.split(' ').includes(SCOPES.send) || conn.scopes.split(' ').includes('demo.send')));

  /**
   * One budgeted step of a sync ('recent') or 12-month import ('history').
   * Serverless functions have short time limits, so each call does as much as fits in
   * cfg.stepBudgetMs and reports `more: true` if the caller should call again.
   * Progress needs no job state: already-stored message ids are skipped on the next step.
   */
  async function syncStep(repo, userId, kind = 'recent', { budgetMs = cfg.stepBudgetMs } = {}) {
    const started = Date.now();
    const p = await provider(repo);
    const ids = await p.candidates(kind);
    const existing = await repo.existingGmailIds(ids);
    const todo = ids.filter((x) => !existing.has(x));
    const stats = newStats();
    const ctx = { db, repo, llm, now: clock() };
    let done = 0;
    while (done < todo.length && (done === 0 || Date.now() - started < budgetMs)) { // always make progress
      const batch = todo.slice(done, done + 5);
      const msgs = await Promise.all(batch.map((gid) => p.get(gid)));
      for (const m of msgs) if (m) await ingestOne(ctx, m, kind === 'history' ? 'history' : 'sync', stats);
      done += batch.length;
    }
    const more = done < todo.length;
    if (!more) await repo.markSynced(kind === 'history' ? 'history_imported_at' : 'last_sync_at');
    if (stats.collabMessages || !more) await repo.audit(userId, kind === 'history' ? 'gmail.history_import' : 'gmail.sync', { processed: done, remaining: todo.length - done });
    return { ...finishStats(stats), processed: done, remaining: todo.length - done, more };
  }

  /** Netlify scheduled function: keep every connected inbox fresh without anyone pressing a button. */
  async function scheduledSync({ budgetMs = 20000 } = {}) {
    const started = Date.now();
    const rows = await db.query("SELECT tenant_id FROM gmail_connections WHERE mode='google' ORDER BY COALESCE(last_sync_at,'') ASC");
    const results = [];
    for (const { tenant_id: tid } of rows) {
      const left = budgetMs - (Date.now() - started);
      if (left < 3000) break;
      try { results.push({ tid, ...(await syncStep(forTenant(db, tid), null, 'recent', { budgetMs: Math.min(left - 2000, 8000) })) }); }
      catch (e) { results.push({ tid, error: e.message }); }
    }
    await runRetention();
    return results;
  }

  // ---------------- Drafts: human-in-the-loop sending ----------------
  async function editDraft(repo, did, patch, userId) {
    const d = await repo.draft(did);
    if (!d || d.status === 'sent' || d.status === 'discarded') throw httpErr(404, 'Draft not editable');
    const p = {};
    for (const k of ['subject', 'body', 'to_addr']) if (typeof patch[k] === 'string') p[k] = patch[k].slice(0, 20000);
    if (d.status === 'approved') Object.assign(p, { status: 'draft', approved_at: null, approved_by: null }); // any edit voids approval
    await repo.updateDraft(did, p);
    await repo.audit(userId, 'draft.edit', { did });
    return repo.draft(did);
  }
  async function approveDraft(repo, did, userId) {
    const d = await repo.draft(did);
    if (!d || d.status !== 'draft') throw httpErr(409, 'Only an unsent draft can be approved');
    if (!d.body || !d.body.trim()) throw httpErr(422, 'Draft is empty');
    if (CHECK.test(d.body)) throw httpErr(422, 'Resolve every [CHECK: …] placeholder before approving');
    await repo.updateDraft(did, { status: 'approved', approved_at: nowIso(), approved_by: userId });
    await repo.audit(userId, 'draft.approve', { did });
    return repo.draft(did);
  }
  async function sendDraft(repo, did, userId) {
    const d = await repo.draft(did);
    if (!d) throw httpErr(404, 'not found');
    if (d.status !== 'approved') throw httpErr(409, 'Draft must be explicitly approved before sending');
    const p = await provider(repo);
    if (!canSend(p.conn)) throw httpErr(403, 'Send permission not granted', { needsSendPermission: true });
    const original = d.reply_to_msg ? await repo.message(d.reply_to_msg) : null;
    const res = await p.send({ to: d.to_addr, subject: d.subject, body: d.body, threadId: d.thread_id, inReplyTo: original && original.message_id_header });
    const sentAt = nowIso();
    await db.tx(async (t) => {
      const r = repo.withDb(t);
      await r.updateDraft(did, { status: 'sent', sent_at: sentAt, sent_gmail_id: res.id });
      if (!(await r.hasMessage(res.id))) {
        await r.insertMessage({ gmailId: res.id, threadId: d.thread_id || res.threadId, isCollab: true, collabId: d.collab_id, fromAddr: p.conn.email,
          fromName: 'You', toAddr: d.to_addr, subject: d.subject, sentAt, snippet: d.body.slice(0, 160), body: d.body, direction: 'out', importedVia: 'sent-by-app', isDemo: p.isDemo });
      }
      await r.updateCollab(d.collab_id, { last_outbound_at: sentAt });
      await refreshDerived(r, d.collab_id, { now: clock() });
      await r.audit(userId, 'draft.send', { did, demo: p.isDemo });
    });
    return { ...(await repo.draft(did)), simulated: p.isDemo };
  }

  // ---------------- Review ----------------
  async function reviewCollab(repo, cid, action, userId) {
    const c = await repo.collab(cid);
    if (!c || !c.needs_review) throw httpErr(404, 'not found');
    if (!['confirm', 'dismiss'].includes(action)) throw httpErr(400, 'bad action');
    await db.tx(async (t) => {
      const r = repo.withDb(t);
      if (action === 'confirm') {
        const patch = { needs_review: 0 };
        if (c.stage_basis === 'historical_note') Object.assign(patch, { stage_basis: 'user', stage_reason: 'Confirmed by you from a historical note' });
        await r.updateCollab(cid, patch);
        for (const f of await r.facts(cid)) if (f.status === 'pending_review') await r.setFactStatus(f.id, 'active');
        await refreshDerived(r, cid, { now: clock() });
      } else await r.updateCollab(cid, { archived: 1, needs_review: 0 });
      await r.audit(userId, `review.collab.${action}`, { cid });
    });
  }
  async function reviewFact(repo, fid, action, userId) {
    const f = await repo.fact(fid);
    if (!f || f.status !== 'pending_review') throw httpErr(404, 'not found');
    if (!['confirm', 'reject'].includes(action)) throw httpErr(400, 'bad action');
    await repo.setFactStatus(fid, action === 'confirm' ? 'active' : 'rejected');
    await refreshDerived(repo, f.collab_id, { now: clock() });
    await repo.audit(userId, `review.fact.${action}`, { fid });
  }

  // ---------------- Privacy: export, retention, disconnect, delete ----------------
  async function exportData(repo) {
    const T = repo.tenantId;
    const q = (sql) => db.query(sql, [T]);
    const conn = await repo.connection();
    return {
      format: 'brieflane-export/v1', exportedAt: nowIso(),
      tenant: await repo.tenant(),
      users: await q('SELECT id, email, name, role, created_at FROM users WHERE tenant_id=?'),
      gmailConnection: conn ? { email: conn.email, mode: conn.mode, scopes: conn.scopes, last_sync_at: conn.last_sync_at } : null, // tokens never exported
      collaborations: await q('SELECT * FROM collaborations WHERE tenant_id=?'),
      facts: await q('SELECT * FROM facts WHERE tenant_id=?'),
      messages: await q('SELECT * FROM messages WHERE tenant_id=? AND is_collab=1'),
      drafts: await q('SELECT * FROM drafts WHERE tenant_id=?'),
      tasks: await q('SELECT * FROM tasks WHERE tenant_id=?'),
      audit: await q('SELECT action, detail, at FROM audit WHERE tenant_id=? ORDER BY id'),
    };
  }
  async function disconnectGmail(repo, userId, { purge = false } = {}) {
    const c = await repo.connection();
    if (c && c.mode === 'google') await google.revoke(cipher.decrypt(c.enc_refresh, repo.tenantId) || cipher.decrypt(c.enc_access, repo.tenantId));
    await db.tx(async (t) => {
      const r = repo.withDb(t);
      await r.deleteConnection();
      if (purge) await t.run('UPDATE messages SET body=NULL, snippet=NULL WHERE tenant_id=?', [repo.tenantId]);
      await r.audit(userId, 'gmail.disconnected', { purge });
    });
  }
  async function deleteAccount(repo) {
    const c = await repo.connection();
    if (c && c.mode === 'google') await google.revoke(cipher.decrypt(c.enc_refresh, repo.tenantId));
    await db.run('DELETE FROM tenants WHERE id=?', [repo.tenantId]); // cascades to every tenant table
  }
  async function runRetention() {
    const now = Date.now();
    let purged = 0;
    for (const t of await db.query('SELECT id, retention_days FROM tenants')) {
      const cutoff = new Date(now - t.retention_days * 864e5).toISOString();
      purged += (await db.run('UPDATE messages SET body=NULL WHERE tenant_id=? AND body IS NOT NULL AND sent_at < ?', [t.id, cutoff])).count;
      await db.run('DELETE FROM messages WHERE tenant_id=? AND is_collab=0 AND created_at < ?', [t.id, cutoff]);
    }
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
    await db.run('DELETE FROM oauth_states WHERE created_at < ?', [new Date(now - 15 * 60e3).toISOString()]);
    return { purged };
  }

  return {
    cipher, google, demo, isDemoUser, createTenantWithUser, createSession, sessionFromToken, destroySession, devLogin, seedHistoricalNotes,
    startOAuth, finishOAuth, provider, connectDemo, enableDemoSend, canSend, syncStep, scheduledSync,
    editDraft, approveDraft, sendDraft, reviewCollab, reviewFact, exportData, disconnectGmail, deleteAccount, runRetention,
  };
}

module.exports = { makeServices, httpErr, isDemoUser };
