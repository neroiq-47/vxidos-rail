import 'dotenv/config';
import {createApp} from './app.js';
import {draftOnce} from './rail.js';
import {stats} from './store.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const server = createApp({secret: process.env.RAIL_SECRET});
server.listen(port, host, () => console.log(`VXIDOS rail listening on http://${host}:${port}`));

// Optional autopilot: drafts are still created as pending_approval and wait for a human.
const every = Number(process.env.DRAFT_INTERVAL_MINUTES || 0);
const maxPending = Number(process.env.MAX_PENDING_DRAFTS || 10);
let timer;
if (every > 0) {
  timer = setInterval(async () => {
    try {
      if ((await stats()).counts.pending_approval >= maxPending) return;
      const d = await draftOnce({source: 'schedule'});
      console.log(`scheduled draft ${d.id} created`);
    } catch (e) { console.error(`scheduled draft failed: ${e.message}`); }
  }, every * 60_000);
  timer.unref();
  console.log(`autopilot: one draft every ${every} min while fewer than ${maxPending} are pending`);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
});
