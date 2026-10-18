import 'dotenv/config';
import {mkdir, access, constants} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createApp} from './app.js';
import {draftOnce} from './rail.js';
import {stats} from './store.js';
import {logger} from './log.js';
import {checkBufferSetup} from './buffer.js';

const host = process.env.HOST || '127.0.0.1'; // Dockerfile sets 0.0.0.0 for containers
const port = Number(process.env.PORT || 3000);

// Fail fast with a clear message if the data directory (e.g. a Railway volume) isn't writable,
// instead of booting "healthy" and failing on the first draft.
const dataDir = dirname(resolve(process.env.RAIL_DATA_PATH || './data/drafts.json'));
try { await mkdir(dataDir, {recursive: true}); await access(dataDir, constants.W_OK); }
catch (e) {
  logger.error('data directory not writable', {dataDir, error: e.message, hint: 'on Railway with a volume, set RAILWAY_RUN_UID=0'});
  process.exit(1);
}

let server;
try { server = createApp({secret: process.env.RAIL_SECRET}); }
catch (e) { logger.error('startup failed', {error: e.message}); process.exit(1); }
server.listen(port, host, () => logger.info('VXIDOS rail listening', {host, port, dataDir, generation: Boolean(process.env.OPENAI_API_KEY)}));
if (!process.env.OPENAI_API_KEY) logger.warn('OPENAI_API_KEY missing: dashboard works, generation will return 503');

// Buffer setup check: lists channels in the logs so BUFFER_CHANNEL_ID can be picked without calling the API by hand.
if (process.env.BUFFER_API_KEY) checkBufferSetup().then(r => logger[r.level](r.message, r.fields)).catch(e => logger.warn('buffer check failed', {error: e.message}));

// Optional autopilot: drafts are still created as pending_approval and wait for a human.
const every = Number(process.env.DRAFT_INTERVAL_MINUTES || 0);
const maxPending = Number(process.env.MAX_PENDING_DRAFTS || 10);
let timer;
if (every > 0) {
  timer = setInterval(async () => {
    try {
      const s = await stats();
      if (s.counts.pending_approval >= maxPending || s.creation.remaining <= 0) return;
      const d = await draftOnce({source: 'schedule'});
      logger.info('scheduled draft created', {id: d.id});
    } catch (e) { logger.error('scheduled draft failed', {error: e.message}); }
  }, every * 60_000);
  timer.unref();
  logger.info('autopilot enabled', {everyMinutes: every, maxPending});
}

// Railway sends SIGTERM on redeploy; finish in-flight requests (store writes are atomic renames) then exit.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  logger.info('shutting down', {signal: sig});
  clearInterval(timer);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 8000).unref();
});
