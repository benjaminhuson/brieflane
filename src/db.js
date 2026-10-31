'use strict';
/**
 * Database layer: one small async interface over two Postgres engines.
 *   - Production (Netlify): Supabase Postgres via postgres.js, through the transaction pooler.
 *   - Local dev & tests:    PGlite, an in-process Postgres (WASM). Zero setup, same SQL.
 *
 * Interface: db.query(sql, params) → rows · db.run(sql, params) → { count } · db.exec(sqlText)
 *            db.tx(async (t) => …)   (t has the same interface)
 * SQL uses `?` placeholders, converted to $1..$n here so statements stay readable.
 */

const SCHEMA = `
SELECT pg_advisory_xact_lock(727274);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 400,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gmail_connections (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT,
  mode TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  enc_refresh TEXT,
  enc_access TEXT,
  access_expires_at TEXT,
  last_sync_at TEXT,
  history_imported_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  is_collab INTEGER NOT NULL DEFAULT 0,
  collab_id TEXT,
  from_addr TEXT, from_name TEXT, to_addr TEXT,
  subject TEXT, sent_at TEXT, snippet TEXT,
  body TEXT,
  direction TEXT,
  classify_reason TEXT,
  message_id_header TEXT,
  imported_via TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(tenant_id, thread_id);
CREATE INDEX IF NOT EXISTS messages_collab ON messages(tenant_id, collab_id);
CREATE TABLE IF NOT EXISTS collaborations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  brand_key TEXT NOT NULL,
  agency TEXT,
  product TEXT,
  kind TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  stage_basis TEXT NOT NULL DEFAULT 'inferred',
  stage_reason TEXT,
  stage_evidence_msg TEXT,
  next_action TEXT,
  next_action_due TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collabs_brand ON collaborations(tenant_id, brand_key);
CREATE TABLE IF NOT EXISTS collab_threads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, thread_id)
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collab_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  value_key TEXT NOT NULL,
  slot TEXT,
  due_at TEXT,
  basis TEXT NOT NULL,
  evidence_msg TEXT,
  evidence_quote TEXT,
  evidence_at TEXT,
  confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_collab ON facts(tenant_id, collab_id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collab_id TEXT REFERENCES collaborations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collab_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
  thread_id TEXT, reply_to_msg TEXT,
  to_addr TEXT, subject TEXT, body TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  generator TEXT,
  approved_at TEXT, approved_by TEXT,
  sent_at TEXT, sent_gmail_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

-- Supabase exposes the public schema through its REST API. Brieflane never uses that API:
-- RLS with no policies + revoked grants means the anon/authenticated keys can read nothing.
-- The server connects as the table owner (bypasses RLS); tenant isolation is enforced in src/repo.js.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','sessions','oauth_states','gmail_connections','messages','collaborations','collab_threads','facts','tasks','drafts','audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
`;

const toDollar = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const clean = (params) => params.map((p) => (p === undefined ? null : p));

function wrapPostgres(sql) {
  const make = (q) => ({
    kind: 'postgres',
    async query(text, params = []) { return Array.from(await q.unsafe(toDollar(text), clean(params))); },
    async run(text, params = []) { const r = await q.unsafe(toDollar(text), clean(params)); return { count: r.count }; },
    async exec(text) { await q.unsafe(text); },
    async tx(fn) { return q.begin ? q.begin((t) => fn(make(t))) : fn(make(q)); },
  });
  const db = make(sql);
  db.close = () => sql.end({ timeout: 5 });
  return db;
}

function wrapPglite(pg) {
  const make = (q, inTx) => ({
    kind: 'pglite',
    async query(text, params = []) { return (await q.query(toDollar(text), clean(params))).rows; },
    async run(text, params = []) { const r = await q.query(toDollar(text), clean(params)); return { count: r.affectedRows || 0 }; },
    async exec(text) { await q.exec(text); },
    async tx(fn) { return inTx ? fn(make(q, true)) : pg.transaction((t) => fn(make(t, true))); },
  });
  const db = make(pg, false);
  db.close = () => pg.close();
  return db;
}

/**
 * Open a database. DATABASE_URL → Supabase/Postgres; otherwise PGlite
 * (persisted to dataDir/pg, or in memory when dbPath is ':memory:').
 */
async function openDb(cfg) {
  let db;
  if (cfg.databaseUrl) {
    const postgres = require('postgres');
    // prepare:false — required by Supabase's transaction pooler; max:1 — one connection per function instance.
    db = wrapPostgres(postgres(cfg.databaseUrl, { prepare: false, max: cfg.isServerless ? 1 : 5, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} }));
  } else {
    const PGLITE = '@electric-sql/pglite'; // dynamic import keeps it out of the Netlify bundle
    const { PGlite } = await import(PGLITE);
    db = wrapPglite(cfg.dbPath === ':memory:' ? new PGlite() : new PGlite(cfg.dbPath));
  }
  await db.exec(`BEGIN; ${SCHEMA} COMMIT;`);
  return db;
}

module.exports = { openDb };
