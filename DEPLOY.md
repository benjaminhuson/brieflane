# Deploying Brieflane: Netlify + Supabase + Google

Architecture: Netlify serves the PWA from its CDN and runs the API as Netlify Functions; Supabase provides Postgres; Google provides sign-in and Gmail access. A scheduled function checks Gmail every 15 minutes.

```
Phone / laptop (PWA) ──► Netlify CDN (public/)
                     └─► Netlify Functions  /api/*  /auth/*  ──► Supabase Postgres (transaction pooler, port 6543)
                         Scheduled function every 15 min  ──► Gmail API (read-only; send only if you grant it)
```

## 1. Supabase
1. New project → name `brieflane` → region **London (eu-west-2)** → generate and save the database password.
2. **Connect** → **Transaction pooler** → copy the URI (port **6543**) and put your password in place of `[YOUR-PASSWORD]`.
   - Use the pooler, not the "Direct connection" (that's IPv6-only and won't work from Netlify).
3. Nothing else: tables are created automatically on first request, with Row Level Security on and Supabase's public API roles revoked, so the anon key can't read anything.

## 2. GitHub → Netlify
1. Code lives in a private GitHub repo (`brieflane`).
2. Netlify → **Add new project → Import an existing project → GitHub** → pick the repo. Build settings are read from `netlify.toml` (publish `public`, no build command). Deploy.
3. Note the site URL (e.g. `https://brieflane-ben.netlify.app`). Optionally rename it under *Site configuration → Change site name* **before** setting up Google, since the URL goes into Google's settings.
4. **Site configuration → Environment variables** → add:

| Variable | Value | When |
|---|---|---|
| `DATABASE_URL` | Supabase transaction pooler URI | now |
| `TOKEN_ENC_KEY` | output of `openssl rand -base64 32` | now (never change it, or Gmail must be reconnected) |
| `BASE_URL` | your site URL, e.g. `https://brieflane-ben.netlify.app` | now |
| `DEMO_LOGIN` | `1` | optional, to test the deploy with the demo workspace; remove later |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 3 | after Google setup |
| `ALLOWED_EMAILS` | `benhuson1@gmail.com` (comma-separate more) | with Google — keeps the app private |
| `ANTHROPIC_API_KEY` | optional | any time |

5. **Deploys → Trigger deploy** after changing variables (they only apply to new deploys).
6. Check `https://<your-site>/api/health` → `{"ok":true,"db":"postgres"}`.

## 3. Google Cloud (Gmail)
1. https://console.cloud.google.com → project picker → **New project** → `Brieflane`.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **Google Auth Platform** (formerly "OAuth consent screen") → **Get started**:
   - App name `Brieflane`, support email = yours, audience **External**, contact email = yours → create.
   - **Branding**: under *Authorised domains* add your full site domain, e.g. `brieflane-ben.netlify.app`.
   - **Data access → Add or remove scopes**: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/gmail.readonly`, `.../auth/gmail.send`.
   - **Audience → Test users**: add `benhuson1@gmail.com`.
4. **Clients → Create client** → type **Web application** → name `Brieflane web`:
   - Authorised JavaScript origins: `https://<your-site>`
   - Authorised redirect URIs: `https://<your-site>/auth/google/callback` (add `http://localhost:8787/auth/google/callback` too if you want local testing)
   - Create → copy the Client ID and Client secret into Netlify env vars → redeploy.
5. **Avoid weekly reconnects:** while the app is in *Testing*, Google expires Gmail permission after 7 days. For personal use, **Audience → Publish app** (push to production without verification). Google shows a one-time "Google hasn't verified this app" screen → *Advanced → Go to Brieflane*. Unverified apps are capped at 100 users. Full verification + security assessment is only needed before inviting other creators.

## 4. First run
1. Open the site → **Continue with Google** → sign in.
2. **Settings → Connect Gmail (read-only)** → approve.
3. **Check email now**, then **Import last 12 months** → review older deals in **Review**.
4. Optional: **Grant send permission** (separate Google prompt) to send approved replies.
5. Install on each device: Safari → Share → *Add to Home Screen*; Chrome/Edge → *Install app*.

## Operations
- Logs: Netlify → Logs → Functions (`api`, `sync-scheduled`).
- Backups: Supabase free tier keeps daily backups for a limited window; export from **Settings → Export all my data** any time.
- Free-tier notes: Netlify functions time out at 10s — sync/import run in short steps automatically. Supabase pauses free projects after a period of inactivity; the 15-minute scheduled sync should keep it active while Gmail is connected — if it ever pauses, restore it from the Supabase dashboard.
