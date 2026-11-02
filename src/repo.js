'use strict';
const { id } = require('./crypto');

const now = () => new Date().toISOString();

const STAGES = ['new', 'negotiating', 'awaiting_delivery', 'ready_to_film', 'editing', 'scheduled', 'published'];
const STAGE_LABEL = {
  new: 'New', negotiating: 'Negotiating', awaiting_delivery: 'Awaiting delivery',
  ready_to_film: 'Ready to film', editing: 'Editing', scheduled: 'Scheduled', published: 'Published',
};

/**
 * Tenant-scoped data access. The ONLY module that touches tenant tables, and
 * every statement filters by the tenant id captured here. Route handlers get a
 * repo bound to the session's tenant, so a request can never reach another tenant's rows.
 * Pass a transaction handle as `db` to run these inside a transaction.
 */
function forTenant(db, tenantId) {
  if (!tenantId || typeof tenantId !== 'string') throw new Error('tenantId required');
  const T = tenantId;
  const one = async (sql, ...p) => (await db.query(sql, [T, ...p]))[0] || null;
  const all = (sql, ...p) => db.query(sql, [T, ...p]);
  const run = (sql, ...p) => db.run(sql, [T, ...p]);

  const repo = {
    tenantId: T,
    db,
    withDb: (other) => forTenant(other, T),

    tenant: () => one('SELECT * FROM tenants WHERE id = ?'),
    setRetention: (days) => db.run('UPDATE tenants SET retention_days = ? WHERE id = ?', [days, T]),

    // ---------- Gmail connection ----------
    connection: () => one('SELECT * FROM gmail_connections WHERE tenant_id = ?'),
    saveConnection: (c) => run(`INSERT INTO gmail_connections (tenant_id, user_id, email, mode, scopes, enc_refresh, enc_access, access_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (tenant_id) DO UPDATE SET user_id=excluded.user_id, email=excluded.email, mode=excluded.mode,
        scopes=excluded.scopes, enc_refresh=COALESCE(excluded.enc_refresh, gmail_connections.enc_refresh),
        enc_access=excluded.enc_access, access_expires_at=excluded.access_expires_at`,
    c.userId, c.email, c.mode, c.scopes || '', c.encRefresh, c.encAccess, c.accessExpiresAt, now()),
    updateAccess: (encAccess, expiresAt) => db.run('UPDATE gmail_connections SET enc_access=?, access_expires_at=? WHERE tenant_id=?', [encAccess, expiresAt, T]),
    markSynced(field = 'last_sync_at') {
      if (!['last_sync_at', 'history_imported_at'].includes(field)) throw new Error('bad field');
      return db.run(`UPDATE gmail_connections SET ${field}=? WHERE tenant_id=?`, [now(), T]);
    },
    deleteConnection: () => run('DELETE FROM gmail_connections WHERE tenant_id = ?'),

    // ---------- Messages ----------
    hasMessage: async (gmailId) => Boolean(await one('SELECT 1 AS x FROM messages WHERE tenant_id=? AND gmail_id=?', gmailId)),
    /** Which of these Gmail ids are already stored? (one query per 200 ids) */
    async existingGmailIds(ids) {
      const found = new Set();
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        if (!chunk.length) continue;
        const rows = await all(`SELECT gmail_id FROM messages WHERE tenant_id=? AND gmail_id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
        for (const r of rows) found.add(r.gmail_id);
      }
      return found;
    },
    insertMessage(m) { return repo.insertMessageWithId(id('msg'), m); },
    async insertMessageWithId(mid, m) {
      await run(`INSERT INTO messages (tenant_id, id, gmail_id, thread_id, is_collab, collab_id, from_addr, from_name, to_addr, subject,
           sent_at, snippet, body, direction, classify_reason, message_id_header, imported_via, is_demo, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id, gmail_id) DO NOTHING`,
      mid, m.gmailId, m.threadId, m.isCollab ? 1 : 0, m.collabId, m.fromAddr, m.fromName, m.toAddr, m.subject,
      m.sentAt, m.snippet, m.body, m.direction, m.classifyReason, m.messageIdHeader, m.importedVia, m.isDemo ? 1 : 0, now());
      return mid;
    },
    message: (mid) => one('SELECT * FROM messages WHERE tenant_id=? AND id=?', mid),
    messagesForCollab: (cid) => all('SELECT * FROM messages WHERE tenant_id=? AND collab_id=? ORDER BY sent_at ASC', cid),

    // ---------- Collaborations ----------
    collabs: ({ includeReview = false, includeArchived = false } = {}) => all(`SELECT * FROM collaborations WHERE tenant_id=?
        ${includeReview ? '' : 'AND needs_review=0'} ${includeArchived ? '' : 'AND archived=0'} ORDER BY updated_at DESC`),
    reviewCollabs: () => all('SELECT * FROM collaborations WHERE tenant_id=? AND needs_review=1 AND archived=0 ORDER BY created_at DESC'),
    collab: (cid) => one('SELECT * FROM collaborations WHERE tenant_id=? AND id=?', cid),
    collabByThread: (threadId) => one(`SELECT c.* FROM collab_threads t JOIN collaborations c ON c.id=t.collab_id AND c.tenant_id=t.tenant_id
        WHERE t.tenant_id=? AND t.thread_id=?`, threadId),
    openCollabByBrand: (brandKey) => one(`SELECT * FROM collaborations WHERE tenant_id=? AND brand_key=? AND archived=0 AND stage != 'published'
        ORDER BY updated_at DESC LIMIT 1`, brandKey),
    async createCollab(c) {
      const cid = id('col'); const t = now();
      await run(`INSERT INTO collaborations (tenant_id, id, brand, brand_key, agency, product, kind, stage, stage_basis, stage_reason,
           stage_evidence_msg, needs_review, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      cid, c.brand, c.brandKey, c.agency, c.product, c.kind || 'unknown', c.stage || 'new', c.stageBasis || 'inferred',
      c.stageReason, c.stageEvidenceMsg, c.needsReview ? 1 : 0, c.isDemo ? 1 : 0, c.createdAt || t, t);
      return cid;
    },
    async updateCollab(cid, patch) {
      const allowed = ['brand', 'agency', 'product', 'kind', 'stage', 'stage_basis', 'stage_reason', 'stage_evidence_msg',
        'next_action', 'next_action_due', 'needs_review', 'last_inbound_at', 'last_outbound_at', 'archived'];
      const keys = Object.keys(patch).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      if (patch.stage && !STAGES.includes(patch.stage)) throw new Error('invalid stage');
      await db.run(`UPDATE collaborations SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE tenant_id=? AND id=?`,
        [...keys.map((k) => patch[k]), now(), T, cid]);
    },
    linkThread: (threadId, cid) => run('INSERT INTO collab_threads (tenant_id, thread_id, collab_id) VALUES (?,?,?) ON CONFLICT DO NOTHING', threadId, cid),
    threadsForCollab: async (cid) => (await all('SELECT thread_id FROM collab_threads WHERE tenant_id=? AND collab_id=?', cid)).map((r) => r.thread_id),
    trackedThreads: async (limit = 50) => (await all(`SELECT t.thread_id FROM collab_threads t JOIN collaborations c ON c.id=t.collab_id
        WHERE t.tenant_id=? AND c.archived=0 AND c.stage != 'published' ORDER BY c.updated_at DESC LIMIT ?`, limit)).map((r) => r.thread_id),

    // ---------- Facts ----------
    facts(cid, { statuses = ['active', 'pending_review'] } = {}) {
      return all(`SELECT * FROM facts WHERE tenant_id=? AND collab_id=? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC, id ASC`, cid, ...statuses);
    },
    allActiveFacts: () => all("SELECT * FROM facts WHERE tenant_id=? AND status='active'"),
    pendingFacts: () => all(`SELECT f.*, c.brand FROM facts f JOIN collaborations c ON c.id=f.collab_id
        WHERE f.tenant_id=? AND f.status='pending_review' AND c.needs_review=0 AND c.archived=0 ORDER BY f.created_at DESC`),
    fact: (fid) => one('SELECT * FROM facts WHERE tenant_id=? AND id=?', fid),
    findFact: (cid, valueKey) => one("SELECT * FROM facts WHERE tenant_id=? AND collab_id=? AND value_key=? AND status IN ('active','pending_review') LIMIT 1", cid, valueKey),
    factsInSlot: (cid, slot) => all("SELECT * FROM facts WHERE tenant_id=? AND collab_id=? AND slot=? AND status IN ('active','pending_review')", cid, slot),
    async addFact(f) {
      const fid = id('fct');
      await run(`INSERT INTO facts (tenant_id, id, collab_id, kind, label, value, value_key, slot, due_at, basis, evidence_msg, evidence_quote,
           evidence_at, confidence, status, superseded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      fid, f.collabId, f.kind, f.label, f.value, f.valueKey, f.slot, f.dueAt, f.basis, f.evidenceMsg, f.evidenceQuote,
      f.evidenceAt, f.confidence, f.status || 'active', f.supersededBy, now());
      return fid;
    },
    /** Insert many facts in one statement. Returns the ids (also set on each input object). */
    async addFacts(list) {
      if (!list.length) return [];
      const cols = ['tenant_id', 'id', 'collab_id', 'kind', 'label', 'value', 'value_key', 'slot', 'due_at', 'basis', 'evidence_msg', 'evidence_quote', 'evidence_at', 'confidence', 'status', 'superseded_by', 'created_at'];
      const base = Date.now(); const params = []; const rows = [];
      list.forEach((f, i) => {
        f.id = f.id || id('fct');
        params.push(T, f.id, f.collabId, f.kind, f.label, f.value, f.valueKey, f.slot, f.dueAt, f.basis, f.evidenceMsg, f.evidenceQuote,
          f.evidenceAt, f.confidence, f.status || 'active', f.supersededBy, new Date(base + i).toISOString()); // +i ms keeps insertion order stable
        rows.push(`(${cols.map(() => '?').join(',')})`);
      });
      await db.run(`INSERT INTO facts (${cols.join(',')}) VALUES ${rows.join(',')}`, params);
      return list.map((f) => f.id);
    },
    /** Mark many facts superseded by their replacements in one statement. pairs: [{ id, by }] */
    async supersedeFacts(pairs) {
      if (!pairs.length) return;
      await db.run(`UPDATE facts SET status='superseded', superseded_by=v.by FROM (VALUES ${pairs.map(() => '(?::text, ?::text)').join(',')}) AS v(id, by)
        WHERE facts.tenant_id=? AND facts.id=v.id`, [...pairs.flatMap((p) => [p.id, p.by]), T]);
    },
    setFactStatus(fid, status, supersededBy) {
      if (!['active', 'pending_review', 'superseded', 'rejected'].includes(status)) throw new Error('bad status');
      return db.run('UPDATE facts SET status=?, superseded_by=? WHERE tenant_id=? AND id=?', [status, supersededBy, T, fid]);
    },

    // ---------- Tasks ----------
    tasks: ({ includeDone = false } = {}) => all(`SELECT * FROM tasks WHERE tenant_id=? ${includeDone ? '' : 'AND done=0'} ORDER BY COALESCE(due_at,'9999') ASC`),
    async addTask(t) {
      const tid = id('tsk');
      await run('INSERT INTO tasks (tenant_id, id, collab_id, title, due_at, created_at) VALUES (?,?,?,?,?,?)', tid, t.collabId, t.title, t.dueAt, now());
      return tid;
    },
    setTaskDone: (tid, done) => db.run('UPDATE tasks SET done=? WHERE tenant_id=? AND id=?', [done ? 1 : 0, T, tid]),
    task: (tid) => one('SELECT * FROM tasks WHERE tenant_id=? AND id=?', tid),

    // ---------- Drafts ----------
    drafts: (cid) => all("SELECT * FROM drafts WHERE tenant_id=? AND collab_id=? AND status != 'discarded' ORDER BY created_at DESC", cid),
    pendingDrafts: () => all(`SELECT d.*, c.brand FROM drafts d JOIN collaborations c ON c.id=d.collab_id
        WHERE d.tenant_id=? AND d.status IN ('draft','approved') ORDER BY d.updated_at DESC`),
    draft: (did) => one('SELECT * FROM drafts WHERE tenant_id=? AND id=?', did),
    async addDraft(d) {
      const did = id('drf'); const t = now();
      await run(`INSERT INTO drafts (tenant_id, id, collab_id, thread_id, reply_to_msg, to_addr, subject, body, status, generator, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?)`, did, d.collabId, d.threadId, d.replyToMsg, d.toAddr, d.subject, d.body, d.generator, t, t);
      return did;
    },
    async updateDraft(did, patch) {
      const allowed = ['to_addr', 'subject', 'body', 'status', 'approved_at', 'approved_by', 'sent_at', 'sent_gmail_id'];
      const keys = Object.keys(patch).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      await db.run(`UPDATE drafts SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE tenant_id=? AND id=?`,
        [...keys.map((k) => patch[k]), now(), T, did]);
    },

    /**
     * Everything the dashboard, planner, calendar and assistant need, in ONE parallel batch.
     * Postgres.js pipelines these over the connection, so the cost is ~1 round trip, not 6.
     */
    async snapshot() {
      const [collabs, facts, drafts, tasks, counts] = await Promise.all([
        repo.collabs(),
        all(`SELECT f.* FROM facts f JOIN collaborations c ON c.id=f.collab_id AND c.tenant_id=f.tenant_id
             WHERE f.tenant_id=? AND f.status='active' AND c.needs_review=0 AND c.archived=0 ORDER BY f.created_at ASC, f.id ASC`),
        repo.pendingDrafts(),
        repo.tasks(),
        repo.reviewCounts(),
      ]);
      return { collabs, facts, drafts, tasks, reviewCount: counts.total, reviewCounts: counts };
    },
    async reviewCounts() {
      const r = await one(`SELECT
          (SELECT COUNT(*) FROM collaborations WHERE tenant_id=?1 AND needs_review=1 AND archived=0)::int AS collabs,
          (SELECT COUNT(*) FROM facts f JOIN collaborations c ON c.id=f.collab_id
             WHERE f.tenant_id=?1 AND f.status='pending_review' AND c.needs_review=0 AND c.archived=0)::int AS facts`.replace(/\?1/g, '$1'));
      return { collabs: r.collabs, facts: r.facts, total: r.collabs + r.facts };
    },
    /** Review queue with facts and message summaries in 3 queries total. */
    async reviewQueue() {
      const [collabs, facts, msgs, pending] = await Promise.all([
        repo.reviewCollabs(),
        all(`SELECT f.* FROM facts f JOIN collaborations c ON c.id=f.collab_id WHERE f.tenant_id=? AND c.needs_review=1 AND c.archived=0
             AND f.status IN ('active','pending_review') ORDER BY f.created_at ASC`),
        all(`SELECT m.id, m.collab_id, m.subject, m.from_name, m.from_addr, m.sent_at, m.snippet, m.direction FROM messages m
             JOIN collaborations c ON c.id=m.collab_id WHERE m.tenant_id=? AND c.needs_review=1 AND c.archived=0 ORDER BY m.sent_at ASC`),
        repo.pendingFacts(),
      ]);
      const fBy = {}; for (const f of facts) (fBy[f.collab_id] ||= []).push(f);
      const mBy = {}; for (const m of msgs) (mBy[m.collab_id] ||= []).push(m);
      return { collabs: collabs.map((c) => ({ ...c, facts: fBy[c.id] || [], messages: mBy[c.id] || [] })), facts: pending };
    },

    // ---------- Audit ----------
    audit: (userId, action, detail) => db.run('INSERT INTO audit (tenant_id, user_id, action, detail, at) VALUES (?,?,?,?,?)',
      [T, userId, action, detail ? JSON.stringify(detail) : null, now()]),
    auditLog: (limit = 50) => all('SELECT action, detail, at FROM audit WHERE tenant_id=? ORDER BY id DESC LIMIT ?', limit),
  };
  return repo;
}

module.exports = { forTenant, STAGES, STAGE_LABEL };
