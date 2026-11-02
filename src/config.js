'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Central configuration from environment variables (Netlify UI → Site configuration → Environment variables).
 * `overrides` is for tests.
 */
function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const port = Number(env.PORT) || 8787;
  // Netlify Functions run on AWS Lambda.
  const isServerless = Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY_FUNCTIONS) && env.FORCE_LOCAL !== '1';
  const isProd = env.NODE_ENV === 'production' || isServerless;
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');

  const google = { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' };
  const googleConfigured = Boolean(google.clientId && google.clientSecret);

  let tokenKey = env.TOKEN_ENC_KEY || '';
  if (!tokenKey) {
    if (isProd) throw new Error('TOKEN_ENC_KEY is required in production (openssl rand -base64 32).');
    if (env.DB_PATH === ':memory:') tokenKey = crypto.randomBytes(32).toString('base64');
    else {
      fs.mkdirSync(dataDir, { recursive: true });
      const keyFile = path.join(dataDir, '.dev-token-key');
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
      tokenKey = fs.readFileSync(keyFile, 'utf8').trim();
    }
  }

  const baseUrl = (env.BASE_URL || (isServerless && env.URL) || `http://localhost:${port}`).replace(/\/$/, '');
  if (isProd && !baseUrl.startsWith('https://')) throw new Error('BASE_URL must be https:// in production.');

  return {
    port, isProd, isServerless, baseUrl,
    databaseUrl: env.DATABASE_URL || '',
    dbPath: env.DB_PATH || path.join(dataDir, 'pg'),
    tokenKey, google, googleConfigured,
    demoMode: env.DEMO_MODE === '1' || !googleConfigured,
    // Demo workspace login: always on locally; in production only if DEMO_LOGIN=1.
    allowDevLogin: !isProd || env.DEMO_LOGIN === '1' || env.ALLOW_DEV_LOGIN === '1',
    // Private beta: only these Google accounts may sign in (comma-separated). Empty = anyone.
    allowedEmails: (env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    anthropic: { apiKey: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' },
    sessionTtlDays: Number(env.SESSION_TTL_DAYS) || 30,
    defaultRetentionDays: Number(env.DEFAULT_RETENTION_DAYS) || 400,
    historicalImportDays: 365,
    // Netlify synchronous functions stop at 60s (scheduled: 30s); each sync/import step stops well before that.
    stepBudgetMs: Number(env.STEP_BUDGET_MS) || (isServerless ? 25000 : 60000),
  };
}

module.exports = { loadConfig };
