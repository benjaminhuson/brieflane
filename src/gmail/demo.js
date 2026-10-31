'use strict';
/**
 * DEMO INBOX — clearly labelled sample data used when Gmail OAuth is not configured.
 * All brands, people, products and addresses here are fictional (".example" domains).
 * Dates are generated relative to "now" so the dashboard always has something current.
 */

const DAY = 864e5;
function at(now, daysAgo, hour = 10) {
  const d = new Date(now.getTime() - daysAgo * DAY); d.setUTCHours(hour, 15, 0, 0); return d.toISOString();
}
const ME = { addr: 'creator@demo.example', name: 'Ben (demo)' };

function threads(now) {
  const T = [];
  const add = (threadId, daysAgo, dir, from, subject, body, hour) => T.push({
    gmailId: `demo-${threadId}-${T.length}`, threadId: `demo-${threadId}`, sentAt: at(now, daysAgo, hour), direction: dir,
    fromAddr: dir === 'out' ? ME.addr : from.addr, fromName: dir === 'out' ? ME.name : from.name, toAddr: dir === 'out' ? from.addr : ME.addr,
    subject, body, snippet: body.slice(0, 140), isDemo: true,
  });

  const sophie = { addr: 'sophie@kestrel-tools.example', name: 'Sophie Hart' };
  add('kestrel', 9, 'in', sophie, 'Product review: Kestrel RT-20 rotary tool',
    "Hi Ben,\n\nI'm Sophie Hart from Kestrel Tools. We loved your bench grinder restoration video. Would you be interested in reviewing our new Kestrel RT-20 cordless rotary tool on your channel? We'd send you a review unit free of charge, no fee involved, and you'd keep the unit.\n\nCould you share a shipping address?\n\nThanks,\nSophie");
  add('kestrel', 8, 'out', sophie, 'Re: Product review: Kestrel RT-20 rotary tool',
    "Hi Sophie,\n\nThanks, happy to take a look. Address below. Just so we're clear, it would be an honest review with no script approval.\n\n[address removed in demo]\n\nBen\n\nOn Mon, Sophie Hart wrote:\n> Would you be interested in reviewing");
  add('kestrel', 3, 'in', sophie, 'Re: Product review: Kestrel RT-20 rotary tool',
    "Great! The unit has been shipped today with DPD, tracking number DP4471982265GB. We'd love the video to go live by 20 November if possible.\n\nSophie");

  const marcus = { addr: 'marcus.lee@lumora-home.example', name: 'Marcus Lee' };
  add('lumora', 6, 'in', marcus, 'Paid integration — Lumora Hub 2',
    "Hi Ben,\n\nThis is Marcus Lee at Lumora Smart Home. We're planning a paid integration campaign for our new Lumora Hub 2 smart home controller and think your audience is a great fit. We're looking for a 60-second integration in an upcoming video. Our budget is £450. Could you send your media kit and rates?\n\nBest,\nMarcus");
  add('lumora', 5, 'out', marcus, 'Re: Paid integration — Lumora Hub 2',
    "Hi Marcus,\n\nThanks for reaching out. My rate for a 60-second integration is £750. Media kit attached.\n\nBen");
  add('lumora', 0.5, 'in', marcus, 'Re: Paid integration — Lumora Hub 2',
    "Thanks Ben. We can stretch to £600 for the integration plus a YouTube Short. If that works, we'd need the draft by 12 November and the video live by 19 November.\n\nMarcus", 8);

  const priya = { addr: 'priya@northbeam.example', name: 'Priya Shah' };
  add('voltnest', 20, 'in', priya, 'Sponsored video — VoltNest P3',
    "Hi Ben,\n\nI'm Priya Shah from Northbeam, reaching out on behalf of VoltNest. We'd love to sponsor a dedicated video featuring the VoltNest P3 portable power station for workshop builds. The fee would be £1,200.\n\nPriya");
  add('voltnest', 18, 'out', priya, 'Re: Sponsored video — VoltNest P3',
    "Hi Priya,\n\nSounds good in principle. I'm happy to go ahead at £1,200 for a dedicated video, subject to seeing the brief.\n\nBen");
  add('voltnest', 15, 'in', priya, 'Re: Sponsored video — VoltNest P3',
    "Fantastic, we're happy to proceed. Contract has been signed on our side and the brief is attached. The go live date is 28 November.\n\nPriya");
  add('voltnest', 4, 'in', priya, 'Re: Sponsored video — VoltNest P3',
    "Hi Ben, the courier shows the P3 has been delivered, so delivery confirmed on our end. Let us know when filming is scheduled.\n\nPriya");

  const jess = { addr: 'jess@filamentry.example', name: 'Jess Moreau' };
  add('filamentry', 1, 'in', jess, 'Gifted filament for your next build?',
    "Hello!\n\nI'm Jess Moreau from Filamentry. We make recycled PETG filament and would love to send you a few spools to try in an upcoming 3D printing build, gifted with no obligation. If you like it, an affiliate code is available for your audience.\n\nJess");

  // Noise the classifier should ignore.
  add('noise1', 2, 'in', { addr: 'orders@parts-shop.example', name: 'Parts Shop' }, 'Order confirmation #88231', 'Your order has been received. Order confirmation #88231. Receipt for 2x M3 heat-set inserts.');
  add('noise2', 1, 'in', { addr: 'noreply@video-platform.example', name: 'Video Platform' }, 'New comment on your video', 'Someone commented on your video. Unsubscribe from these notifications.');
  add('noise3', 4, 'in', { addr: 'newsletter@maker-weekly.example', name: 'Maker Weekly' }, 'This week in making', 'Top builds of the week. Unsubscribe at any time.');
  return T;
}

function historical(now) {
  const T = [];
  const add = (threadId, daysAgo, dir, from, subject, body) => T.push({
    gmailId: `demo-h-${threadId}-${T.length}`, threadId: `demo-h-${threadId}`, sentAt: at(now, daysAgo), direction: dir,
    fromAddr: dir === 'out' ? ME.addr : from.addr, fromName: dir === 'out' ? ME.name : from.name, toAddr: dir === 'out' ? from.addr : ME.addr,
    subject, body, snippet: body.slice(0, 140), isDemo: true,
  });
  const tom = { addr: 'tom@printforge.example', name: 'Tom Okafor' };
  add('printforge', 240, 'in', tom, 'Sponsored integration — PrintForge X1',
    "Hi Ben, I'm Tom Okafor from PrintForge. We'd like a sponsored integration for the PrintForge X1 printer in one of your builds. Our fee for this is £500.");
  add('printforge', 236, 'out', tom, 'Re: Sponsored integration — PrintForge X1', "Hi Tom, happy to go ahead at £500 for the integration. Ben");
  add('printforge', 200, 'in', tom, 'Re: Sponsored integration — PrintForge X1', 'Payment of £500 has been processed for invoice INV-0042. Thanks again for the video!');
  add('vague', 150, 'in', { addr: 'deals.team@freemail.example', name: 'Gadget Deals Team' }, 'Collaboration',
    'Hi, we are a gadget brand interested in a collaboration with your channel. What are your rates for a sponsored video?');
  return T;
}

function makeDemoProvider(nowFn = () => new Date()) {
  const sent = [];
  return {
    isDemo: true,
    accountEmail: ME.addr,
    async recent() { return threads(nowFn()); },
    async historical() { return historical(nowFn()); },
    async send({ to, subject, body, threadId }) {
      // Simulated send: nothing leaves the server.
      const m = { id: `demo-sent-${sent.length + 1}`, to, subject, body, threadId };
      sent.push(m); return m;
    },
    sent,
  };
}

module.exports = { makeDemoProvider, DEMO_ACCOUNT: ME };
