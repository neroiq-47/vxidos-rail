import {createServer} from 'node:http';
import {timingSafeEqual, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {HttpError, badRequest, notFound} from './errors.js';
import {draftBatch} from './rail.js';
import * as buffer from './buffer.js';
import {SEND_MODES, checkDueAt} from './buffer.js';
import * as store from './store.js';
import {isId, isReviewer} from './validate.js';
import {logger} from './log.js';
import {createJobRunner} from './jobs.js';
import {pickForSchedule, parseBatch} from './schedule.js';
import {providersFromEnv} from './llm.js';

export const VERSION = '1.0.0';
const PUBLIC = new URL('./public/', import.meta.url);
const STATIC = {'/': ['index.html', 'text/html; charset=utf-8'], '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'], '/ui.css': ['ui.css', 'text/css; charset=utf-8'], '/tweetlen.js': ['tweetlen.js', 'text/javascript; charset=utf-8'], '/slots.js': ['slots.js', 'text/javascript; charset=utf-8']};
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};
// Compare fixed-length digests so neither the token's content nor its length leaks through timing.
const digest = s => createHash('sha256').update(String(s ?? '')).digest();
const tokenEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

// Fixed-window counter per key; good enough for a single-process deployment.
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  const current = key => { const h = hits.get(key); return h && Date.now() - h.start < windowMs ? h : null; };
  const hit = key => {
    const h = current(key);
    if (!h) { if (hits.size > 10_000) hits.clear(); hits.set(key, {start: Date.now(), n: 1}); return 1 <= limit; }
    return ++h.n <= limit;
  };
  hit.blocked = key => (current(key)?.n || 0) >= limit;
  return hit;
}

async function readJson(req, max = 8192) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > max) throw new HttpError(413, 'Body too large'); }
  if (!body) return {};
  try { const v = JSON.parse(body); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch { throw badRequest('Invalid JSON'); }
}

export function createApp({secret, generate, bufferApi = buffer, env = process.env, sleep} = {}) {
  if (!secret || secret.length < 24) throw new Error('Set RAIL_SECRET to at least 24 characters');
  const authFail = rateLimiter(Number(env.AUTH_FAIL_LIMIT || 10), 15 * 60_000);
  const general = rateLimiter(Number(env.RATE_LIMIT_PER_MIN || 120), 60_000);
  const drafting = rateLimiter(Number(env.DRAFT_LIMIT_PER_HOUR || 30), 3600_000);
  const generating = {busy: false}, scheduling = {busy: false};
  // claim → Buffer → finish; a Buffer failure returns the draft to approved with the error recorded.
  async function sendOne(id, reviewer, mode, due) {
    const d = await store.claimForQueue(id, reviewer, {plannedAt: due ? Date.parse(due) : Date.now()});
    let post;
    try { post = await bufferApi.createBufferPost(d.text, {mode, dueAt: due}); }
    catch (e) {
      await store.failQueue(d.id, e.message);
      if (e.status === 429) throw new HttpError(429, `Buffer rate limit reached (100 requests / 15 min); try again later`);
      throw new HttpError(502, e.message);
    }
    return store.finishQueue(d.id, post.id, reviewer, {sendMode: mode, dueAt: post.dueAt || due || null});
  }
  // Delete in Buffer first; only a confirmed delete returns the draft to approved.
  async function unscheduleOne(id, reviewer) {
    if (!isReviewer(reviewer)) throw badRequest('Invalid reviewer');
    if (!bufferApi.writesEnabled()) throw new HttpError(409, 'Buffer writes are disabled');
    const d = await store.getDraft(id);
    if (d.status !== 'queued') throw new HttpError(409, 'Only sent drafts can be unscheduled');
    if (d.sendMode !== 'draft' && Date.parse(d.dueAt) <= Date.now()) throw new HttpError(409, 'Post already published');
    try { await bufferApi.deleteBufferPost(d.bufferPostId); }
    catch (e) { throw new HttpError(e.status === 429 ? 429 : 502, `Buffer delete failed: ${e.message}`); }
    return store.unqueue(id, reviewer);
  }
  // Buffer allows 100 requests per 15 minutes, so batches send one post about every 10 s.
  const jobs = createJobRunner({paceMs: Number(env.BUFFER_PACE_MS ?? 10_000), ...(sleep ? {sleep} : {})});
  const checkJob = id => { const j = /^[a-f0-9-]{36}$/.test(id) && jobs.get(id); if (!j) throw notFound('Job not found'); return j; };
  // Which approved drafts a batch would take, with each one's time and whether the weekly cap allows it.
  async function planBatch(pillars, times) {
    const all = await store.listDrafts();
    const picked = pickForSchedule(all, pillars, times.length);
    const taken = store.publishTimes(all);
    const items = picked.map((d, i) => {
      const at = Date.parse(times[i]), fits = store.weekFits(taken, at).ok;
      if (fits) taken.push(at);
      return {id: d.id, pillar: d.pillar, text: d.text, dueAt: times[i], fits};
    });
    const available = all.filter(d => d.status === 'approved' && pillars.includes(d.pillar)).length;
    return {available, requested: times.length, items, blocked: items.filter(x => !x.fits).length};
  }
  const trust = parseTrustProxy(env.TRUST_PROXY);
  const providers = providersFromEnv(env);

  const routes = [
    ['GET', /^\/stats$/, async () => [200, await store.stats()]],
    ['GET', /^\/drafts$/, async (_r, _m, q) => [200, {drafts: await store.listDrafts({status: q.get('status') || undefined})}]],
    ['GET', /^\/events$/, async (_r, _m, q) => [200, {events: await store.listEvents(Number(q.get('limit')) || 50)}]],
    ['GET', /^\/drafts\/([^/]+)$/, async (_r, [, id]) => [200, await store.getDraft(checkId(id))]],
    ['POST', /^\/draft$/, async (req, _m, _q, ip) => {
      const {count = 1, pillar} = await readJson(req);
      if (!Number.isInteger(count) || count < 1 || count > 5) throw badRequest('count must be 1-5');
      for (let i = 0; i < count; i++) if (!drafting(ip)) throw new HttpError(429, 'Draft generation rate limit reached');
      if (generating.busy) throw new HttpError(409, 'Generation already in progress');
      // Check the creation caps (daily and weekly) before spending LLM calls; generate only what still fits.
      const {creation} = await store.stats();
      if (creation.remaining <= 0) throw store.creationCapError(creation);
      const n = Math.min(count, creation.remaining);
      generating.busy = true;
      try {
        const out = await draftBatch(n, {pillar, generate, source: 'api'});
        if (n < count) out.errors.push(`only ${n} of ${count} generated: ${creation.window} draft cap is ${creation.cap}`);
        return [201, out];
      }
      finally { generating.busy = false; }
    }],
    ['PATCH', /^\/drafts\/([^/]+)$/, async (req, [, id]) => {
      const {text, editor} = await readJson(req);
      return [200, await store.editDraft(checkId(id), text, editor)];
    }],
    ['POST', /^\/drafts\/([^/]+)\/review$/, async (req, [, id]) => {
      const {decision, reviewer, note} = await readJson(req);
      return [200, await store.reviewDraft(checkId(id), decision, reviewer, note)];
    }],
    ['POST', /^\/drafts\/([^/]+)\/queue$/, async (req, [, id]) => {
      const {reviewer, mode = 'draft', dueAt} = await readJson(req);
      if (!SEND_MODES.includes(mode)) throw badRequest(`mode must be one of ${SEND_MODES.join(', ')}`);
      let due;
      if (mode === 'schedule') { try { due = checkDueAt(dueAt); } catch (e) { throw badRequest(e.message); } }
      if (!bufferApi.writesEnabled()) throw new HttpError(409, 'Buffer writes are disabled');
      return [200, await sendOne(checkId(id), reviewer, mode, due)];
    }],
    // Dry run: what a batch would schedule, when, and which posts the weekly cap would block.
    ['POST', /^\/schedule-batch\/preview$/, async req => {
      const {pillars, times} = parseBatch(await readJson(req));
      return [200, await planBatch(pillars, times)];
    }],
    // Schedule up to 100 approved drafts as a background job (paced for Buffer's rate limit); poll /jobs/:id.
    ['POST', /^\/schedule-batch$/, async req => {
      const body = await readJson(req);
      const {pillars, times} = parseBatch(body);
      if (!isReviewer(body.reviewer)) throw badRequest('Invalid reviewer');
      if (!bufferApi.writesEnabled()) throw new HttpError(409, 'Buffer writes are disabled');
      if (jobs.running()) throw new HttpError(409, 'A batch is already running');
      const plan = await planBatch(pillars, times);
      const items = plan.items.filter(x => x.fits);
      if (!items.length) throw new HttpError(409, plan.items.length ? 'Weekly posting cap leaves no room for these times' : 'No approved drafts in the selected pillars');
      const job = jobs.start('schedule', items, async x => {
        const r = await sendOne(x.id, body.reviewer, 'schedule', x.dueAt);
        return {id: r.id, pillar: r.pillar, dueAt: r.dueAt, text: r.text};
      });
      const notes = [];
      if (plan.available < plan.requested) notes.push(`only ${plan.available} approved draft${plan.available === 1 ? '' : 's'} in the selected pillars`);
      if (plan.blocked) notes.push(`${plan.blocked} skipped: weekly posting cap`);
      return [202, {job, notes}];
    }],
    ['GET', /^\/jobs$/, async () => [200, {jobs: jobs.list()}]],
    ['GET', /^\/jobs\/([^/]+)$/, async (_r, [, id]) => [200, checkJob(id)]],
    ['POST', /^\/jobs\/([^/]+)\/cancel$/, async (_r, [, id]) => { checkJob(id); return [200, jobs.cancel(id)]; }],
    // Undo a whole batch: unschedule every post it scheduled that hasn't published yet (also paced).
    ['POST', /^\/jobs\/([^/]+)\/unschedule$/, async (req, [, id]) => {
      const {reviewer} = await readJson(req);
      if (!isReviewer(reviewer)) throw badRequest('Invalid reviewer');
      const src = checkJob(id);
      if (src.kind !== 'schedule') throw badRequest('Only schedule batches can be unscheduled');
      if (jobs.running()) throw new HttpError(409, 'A batch is already running');
      const now = Date.now();
      const ids = (await store.listDrafts({status: 'queued'})).filter(d => src.results.some(r => r.id === d.id) && Date.parse(d.dueAt) > now).map(d => d.id);
      if (!ids.length) throw new HttpError(409, 'Nothing left to unschedule in that batch');
      return [202, {job: jobs.start('unschedule', ids, x => unscheduleOne(x, reviewer))}];
    }],
    ['POST', /^\/drafts\/([^/]+)\/unschedule$/, async (req, [, id]) => {
      const {reviewer} = await readJson(req);
      return [200, await unscheduleOne(checkId(id), reviewer)];
    }],
    ['GET', /^\/buffer\/check$/, async () => [200, await wrapUpstream(() => bufferApi.verifyBufferConnection())]],
    ['GET', /^\/buffer\/channels$/, async () => [200, await wrapUpstream(() => bufferApi.listChannels())]]
  ];

  return createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, {'Content-Type': 'application/json', ...SECURITY_HEADERS, ...headers});
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const url = new URL(req.url || '/', 'http://localhost');
    const ip = clientIp(req, trust);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(200, await readFile(new URL(file, PUBLIC)), {'Content-Type': type});
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, {ok: true, brand: 'VXIDOS', version: VERSION, generation: providers.length > 0, providers: providers.map(p => p.name), bufferWrites: bufferApi.writesEnabled()});
      // Once an IP exhausts its failed attempts it is locked out even with the right token, so guessing can't continue.
      if (authFail.blocked(ip)) return send(429, {error: 'Too many failed attempts'});
      if (!tokenEqual(req.headers.authorization, `Bearer ${secret}`)) { authFail(ip); return send(401, {error: 'Unauthorized'}, {'WWW-Authenticate': 'Bearer'}); }
      if (!general(ip)) return send(429, {error: 'Rate limit exceeded'});
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) { const [status, body] = await handler(req, m, url.searchParams, ip); return send(status, body); }
      }
      throw notFound('Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && status !== 502 && status !== 503) logger.error('request failed', {method: req.method, path: url.pathname, error: e.message, stack: e.stack});
      return send(status, {error: status === 500 ? 'Internal error' : e.message});
    }
  });
}

// Behind a reverse proxy (Railway, Fly, nginx) every socket is the proxy, so TRUST_PROXY says where the real
// client IP is: a header name the proxy sets itself (Railway documents `x-real-ip`), or a hop count N meaning
// "N entries from the right of X-Forwarded-For" (entries further left are client-supplied and spoofable).
export function parseTrustProxy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false') return null;
  if (/^\d+$/.test(v)) return {hops: Number(v)};
  if (/^[a-z0-9-]+$/.test(v)) return {header: v};
  throw new Error(`Invalid TRUST_PROXY: ${value}`);
}
export function clientIp(req, trust = null) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (typeof trust === 'number') trust = trust ? {hops: trust} : null; // legacy numeric form
  if (!trust) return socketIp;
  if (trust.header) return String(req.headers[trust.header] || '').split(',')[0].trim() || socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return chain[chain.length - trust.hops] || socketIp;
}

function checkId(id) { if (!isId(id)) throw notFound('Draft not found'); return id; }
async function wrapUpstream(fn) { try { return await fn(); } catch (e) { throw new HttpError(502, e.message); } }
