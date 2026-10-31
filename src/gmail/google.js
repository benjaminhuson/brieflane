'use strict';

const SCOPES = {
  signIn: ['openid', 'email', 'profile'],
  read: 'https://www.googleapis.com/auth/gmail.readonly', // least privilege that can read message bodies
  send: 'https://www.googleapis.com/auth/gmail.send',     // requested separately, only if the creator opts in
};

// Narrow server-side search so we only pull likely collaboration mail.
const COLLAB_QUERY = '{sponsor sponsorship sponsored collaboration collab partnership "product review" "review unit" gifting gifted sample "media kit" "rate card" affiliate "paid promotion" influencer integration "on behalf of"} -category:promotions -category:social';

function authUrl(cfg, { scopes, state, challenge, loginHint, offline = true }) {
  const p = new URLSearchParams({
    client_id: cfg.google.clientId,
    redirect_uri: `${cfg.baseUrl}/auth/google/callback`,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    include_granted_scopes: 'true', // incremental authorization
  });
  if (offline) { p.set('access_type', 'offline'); p.set('prompt', 'consent'); }
  if (loginHint) p.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

function makeGoogle(cfg, fetchImpl = globalThis.fetch) {
  async function form(url, body) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Google token error: ${data.error || res.status}`), { status: 502 });
    return data;
  }
  return {
    exchangeCode: (code, verifier) => form('https://oauth2.googleapis.com/token', {
      code, code_verifier: verifier, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
      redirect_uri: `${cfg.baseUrl}/auth/google/callback`, grant_type: 'authorization_code',
    }),
    refresh: (refreshToken) => form('https://oauth2.googleapis.com/token', {
      refresh_token: refreshToken, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret, grant_type: 'refresh_token',
    }),
    async revoke(tokenValue) {
      if (!tokenValue) return;
      await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenValue)}`, { method: 'POST' }).catch(() => {});
    },
    async userinfo(accessToken) {
      const res = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw Object.assign(new Error('userinfo failed'), { status: 502 });
      return res.json();
    },
  };
}

// ---------- MIME parsing ----------
const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function htmlToText(html) {
  return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body && part.body.data) return part.body.data;
  for (const p of part.parts || []) { const r = findPart(p, mime); if (r) return r; }
  return null;
}
function parseAddress(v = '') {
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: m[1].trim() || null, addr: m[2].trim().toLowerCase() } : { name: null, addr: String(v).trim().toLowerCase() };
}
function normalizeGmail(raw, accountEmail) {
  const h = Object.fromEntries((raw.payload && raw.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  const from = parseAddress(h.from);
  const plain = findPart(raw.payload, 'text/plain');
  const html = plain ? null : findPart(raw.payload, 'text/html');
  const body = plain ? b64(plain) : html ? htmlToText(b64(html)) : (raw.payload && raw.payload.body && raw.payload.body.data ? b64(raw.payload.body.data) : '');
  const out = (raw.labelIds || []).includes('SENT') || (accountEmail && from.addr === accountEmail.toLowerCase());
  return {
    gmailId: raw.id, threadId: raw.threadId, fromAddr: from.addr, fromName: from.name, toAddr: h.to || '',
    subject: h.subject || '(no subject)', sentAt: new Date(Number(raw.internalDate) || Date.parse(h.date) || Date.now()).toISOString(),
    snippet: raw.snippet || '', body: body.slice(0, 50000), direction: out ? 'out' : 'in', messageIdHeader: h['message-id'] || null, isDemo: false,
  };
}

/** Gmail REST client for one connection. getAccessToken() handles refresh. */
function makeGmailClient({ getAccessToken, accountEmail }, fetchImpl = globalThis.fetch) {
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  async function api(path, opts = {}) {
    const res = await fetchImpl(`${base}${path}`, { ...opts, headers: { authorization: `Bearer ${await getAccessToken()}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw Object.assign(new Error(`Gmail API ${res.status}`), { status: res.status === 403 ? 403 : 502 });
    return res.json();
  }
  return {
    async listIds(q, max = 500) {
      const ids = []; let pageToken;
      do {
        const r = await api(`/messages?${new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) })}`);
        for (const m of r.messages || []) ids.push(m.id);
        pageToken = r.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },
    async getMessage(mid) { return normalizeGmail(await api(`/messages/${mid}?format=full`), accountEmail); },
    async getThreadMessages(tid) { const t = await api(`/threads/${tid}?format=full`); return (t.messages || []).map((m) => normalizeGmail(m, accountEmail)); },
    async threadMessageIds(tid) {
      try { const t = await api(`/threads/${tid}?format=minimal`); return (t.messages || []).map((m) => m.id); }
      catch (e) { if (e.status === 502) return []; throw e; } // thread deleted in Gmail → just skip it
    },
    async send({ to, subject, body, threadId, inReplyTo }) {
      const headers = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0'];
      if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`).toString('base64url');
      return api('/messages/send', { method: 'POST', body: JSON.stringify({ raw, threadId }) });
    },
  };
}

module.exports = { SCOPES, COLLAB_QUERY, authUrl, makeGoogle, makeGmailClient, normalizeGmail, htmlToText };
