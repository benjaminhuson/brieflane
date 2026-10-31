'use strict';
/** One app (and one DB connection) per warm function instance. */
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

let appPromise = null;
function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const cfg = loadConfig();
      if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set (Netlify → Site configuration → Environment variables).');
      const db = await openDb(cfg);
      return createApp({ cfg, db });
    })().catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

module.exports = { getApp };
