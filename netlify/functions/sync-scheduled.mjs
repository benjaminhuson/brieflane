// Netlify Scheduled Function: checks every connected Gmail inbox every 15 minutes,
// so each device sees fresh deals without pressing "Check email". Also runs retention.
import netlifyApp from '../../src/netlify-app.js'; // CommonJS module, bundled by esbuild

const { getApp } = netlifyApp;
process.env.NETLIFY_FUNCTIONS = '1'; // read lazily by loadConfig() inside getApp()

export default async () => {
  const app = await getApp();
  const results = await app.svc.scheduledSync({ budgetMs: 22000 });
  console.log('scheduled sync', JSON.stringify(results.map(({ tid, collabMessages, remaining, error }) => ({ tid, collabMessages, remaining, error }))));
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
