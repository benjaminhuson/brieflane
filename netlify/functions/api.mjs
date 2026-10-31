// Netlify Function: serves every /api/* and /auth/* request. Static files come straight from the CDN.
import netlifyApp from '../../src/netlify-app.js'; // CommonJS module, bundled by esbuild

const { getApp } = netlifyApp;
process.env.NETLIFY_FUNCTIONS = '1'; // read lazily by loadConfig() inside getApp()

export default async (req, context) => {
  const app = await getApp();
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text();
  const headers = Object.fromEntries(req.headers);
  const out = await app.handleRequest({ method: req.method, url: req.url, headers, body, ip: context.ip || headers['x-nf-client-connection-ip'] || '' });
  const h = new Headers(out.headers);
  for (const c of out.cookies) h.append('Set-Cookie', c);
  return new Response(out.body, { status: out.status, headers: h });
};

export const config = { path: ['/api/*', '/auth/*'] };
