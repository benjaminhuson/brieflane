# Brieflane — MVP

The brand-deal inbox and daily briefing for independent creators. First user: **Huson DIY**.
See [PRODUCT.md](PRODUCT.md) for the name, summary and phased roadmap.

## Run it (2 minutes, no accounts needed)

Requires **Node.js 22.13+**.

```bash
cd brieflane
npm install
npm start            # → http://localhost:8787 (local Postgres via PGlite in ./data/pg — no setup)
npm test             # 25 tests: unit, pipeline, full API workflow
```

**Hosting:** Netlify (PWA + Functions) and Supabase (Postgres). Step-by-step in [DEPLOY.md](DEPLOY.md).

Open http://localhost:8787 → **Open the Huson DIY demo workspace** → **Use the demo inbox**.
Without Google credentials the app runs against a clearly labelled **demo inbox** (fictional brands on `.example` domains). Everything else is real: the Postgres database, extraction, tracker, drafts, approval gates, review queue and privacy controls.

### Try the end-to-end workflow
1. **Today** — briefing, urgent actions ranked by why, upcoming dates, pipeline.
2. **Deals → Lumora Smart Home** — £600 is shown as *fee mentioned (not agreed)*; both proposed dates are marked as proposals; each fact has a *Show evidence* quote.
3. **Suggest a reply** → the draft contains `[CHECK: …]` placeholders → **Approve** is refused until you replace them.
4. Approve → **Send** asks for the *separate* send permission → grant it → confirm → sent (simulated in demo). The reply appears in email history and the "Reply to…" action clears.
5. **Settings → Import last 12 months** → older deals land in **Review**, not your tracker, until you confirm them. The three entries from earlier planning chats (Botslab, WOTOKOL/IFA 2026, Outsunny) sit there too, flagged *from a past chat, not email*.
6. **Ask** — "What should I do first today?", "What money is on the table?".

## What's implemented vs not

### ✅ Implemented and tested
| Area | Detail |
|---|---|
| Dashboard | Daily briefing (rules; AI-written when a key is set), urgent actions with severity + reason + evidence basis, 5-week agenda, pipeline counts |
| Tracker | 7 stages (new → negotiating → awaiting delivery → ready to film → editing → scheduled → published); kanban on desktop, filtered list on mobile |
| Deal detail | Facts grouped by money / deliverables / dates / shipping / product / contacts, each badged **From email** (with verbatim quote), **AI-inferred**, or **Set by you**; agreement panel (needs agreement wording from *both* sides to say so); superseded-value history; linked email thread; tasks; add-your-own facts |
| Extraction | Classifier (explainable weighted signals), brand/agency/product/contact/deliverable/deadline/fee/shipping/agreement extraction, UK date parsing, quote verification, stage inference that only moves forward and never overrides a stage you set |
| Dedupe & updates | One row per Gmail message per tenant; thread → same deal; same brand → same open deal; newer value in the same slot supersedes the old (e.g. a moved deadline or counter-offer) |
| Historical import | 12-month import as a background job; anything >30 days old goes to Review; confirm/dismiss per deal or per fact |
| Drafts | Stage-aware templates (or AI) that never commit; `[CHECK]` placeholders block approval; any edit voids approval; send requires approval + separate send scope + explicit confirm |
| Assistant | Rule-based answers for priorities, deadlines, money, shipping, per-brand status; AI path uses the same tenant-scoped context and evidence rules |
| Gmail OAuth | Google sign-in (identity scopes only), Gmail connect with `gmail.readonly`, `gmail.send` requested separately via incremental auth, PKCE + one-time state, token refresh, revoke on disconnect/delete. Tested with a mocked Google; **not yet run against a real Google project** |
| Security | Tenant-scoped repository (every query filtered by session tenant), AES-256-GCM token encryption with tenant-bound AAD, hashed session ids, HttpOnly/SameSite cookies (`__Host-`/Secure in prod), CSRF tokens, strict CSP, rate limits, dev login disabled in production, email treated as untrusted data in AI prompts |
| Privacy | Non-collab mail stored as id only; configurable body retention (evidence quotes kept); JSON export (no tokens); Gmail disconnect with optional purge; full account deletion (cascade); audit log |
| PWA | Installable manifest, service worker caching the app shell only (never API data), responsive layout with mobile tab bar, light/dark |

### 🟡 Placeholders / simplified in the MVP
- **Demo inbox** stands in for Gmail until OAuth credentials are configured (always labelled).
- **Sync** is a 15-minute scheduled check plus the manual "Check email" button; Gmail push (Pub/Sub) would make it near-instant. Sync and the 12-month import run in short resumable steps to fit Netlify's 10-second function limit.
- **Rate limits** are per function instance (best effort), not global.
- **AI** is off without `ANTHROPIC_API_KEY`; the rule-based paths are deliberately conservative and will miss some phrasing.
- **Tenant isolation** is enforced in the app's data layer; Postgres RLS currently locks out Supabase's public API entirely, and per-tenant RLS policies are planned as a second layer.
- Calendar shows deadlines/tasks only; no Google Calendar sync.

### 🔵 Planned (see PRODUCT.md)
Content studio, YouTube integration, push sync, Postgres + RLS, KMS, team roles, billing, Outlook.

## Setup still required
See **[DEPLOY.md](DEPLOY.md)**: Supabase project → Netlify site + environment variables → Google Cloud project (Gmail API, consent screen, OAuth client, test user, publish to avoid 7-day expiry). Before other creators can use it: Google verification + annual CASA security assessment for the restricted Gmail scopes.

## Architecture

```
public/            PWA (vanilla JS, CSP-safe, no build) — served by Netlify's CDN
netlify/functions/ api.mjs (all /api, /auth routes) · sync-scheduled.mjs (every 15 min)
src/server.js      local Node server (same app, plus static files)
src/app.js         framework-agnostic routes, sessions, CSRF, security headers, rate limits
src/services.js    OAuth, Gmail provider, sync/import jobs, draft approval/send, review, privacy
src/repo.js        the only data-access layer; bound to one tenant
src/db.js          Postgres schema + one async interface over postgres.js (Supabase) and PGlite (local/tests)
src/crypto.js      AES-256-GCM token encryption, PKCE, ids
src/gmail/         Google OAuth + Gmail REST client + MIME parsing; demo provider
src/ingest/        classify → extract (with quotes) → pipeline (dedupe, supersede, stage, next action)
src/ai/            optional LLM client (quote-verified), attention ranking & briefing, assistant, drafts
test/              node:test suites
```

**Evidence model.** A fact is `email` only when its quote is verifiably a substring of the stored email (header facts excepted); otherwise it's downgraded to `inferred`. Stages are always `inferred` (with a reason and source message) or `user`. "Agreement" requires explicit agreement wording, quoted; the UI only says both sides agreed when both directions have it.

**Historical context.** No discussion transcript was attached to this build, so Huson DIY's earlier enquiries (Botslab, WOTOKOL re IFA Berlin 2026, Outsunny) are seeded only as unverified Review items in the demo workspace — never as current commitments.
