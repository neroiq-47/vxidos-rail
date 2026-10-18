import {readFile, writeFile, mkdir, open, rename, unlink, stat} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {HttpError, badRequest, notFound, conflict} from './errors.js';
import {validateDraft, isReviewer} from './validate.js';

export const STATUSES = ['pending_approval', 'approved', 'rejected', 'queuing', 'queued'];
const STALE_LOCK_MS = 30_000;
const STALE_QUEUING_MS = 10 * 60_000;
const MAX_EVENTS = 5000;
const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
const capFromEnv = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};
export const weeklyCap = () => capFromEnv('WEEKLY_POST_CAP', 200);
// Generation is sized to what can actually be posted: by default no more drafts per week than the
// weekly post cap, spread evenly per day. DAILY_DRAFT_CAP / WEEKLY_DRAFT_CAP override with a number.
const derivedCap = (name, derived) => /^\d+$/.test(String(process.env[name] ?? '').trim()) ? Number(process.env[name]) : derived;
export const weeklyDraftCap = () => derivedCap('WEEKLY_DRAFT_CAP', weeklyCap());
export const dailyDraftCap = () => derivedCap('DAILY_DRAFT_CAP', Math.ceil(weeklyDraftCap() / 7));

// Rolling-window usage; the slot that frees soonest is the oldest event still inside the window.
function windowUsage(times, cap, windowMs, at = Date.now()) {
  const inWindow = times.filter(t => t > at - windowMs).sort((a, b) => a - b);
  const used = inWindow.length;
  const nextSlotAt = used >= cap && used ? new Date(inWindow[used - cap] + windowMs).toISOString() : null;
  return {cap, used, remaining: Math.max(0, cap - used), nextSlotAt};
}
// A post counts at the time it publishes: Buffer's dueAt for queued/scheduled posts, otherwise the send time
// (a Buffer draft has no publish time yet, so count it conservatively when it was sent).
const publishTime = d => d.status === 'queued' ? Date.parse(d.dueAt || d.queuedAt)
  : d.status === 'queuing' ? Date.parse(d.plannedAt || d.queuingAt) : NaN;
export const publishTimes = drafts => drafts.map(publishTime).filter(t => !Number.isNaN(t));
// For the chip: posts in the 7 days up to now, plus how many are scheduled after now.
const weeklyUsage = drafts => {
  const at = Date.now(), times = publishTimes(drafts);
  return {...windowUsage(times.filter(t => t <= at), weeklyCap(), WEEK_MS, at), scheduled: times.filter(t => t > at).length};
};
// Would one more post at `at` push ANY rolling 7-day window [s, s+7d) containing it over the cap?
// A window's count only rises when a later post enters on the right, so the candidate starts are at-7d and
// just after t-7d for each post t in (at, at+7d), plus existing posts in (at-7d, at]. Checking them all
// means scheduling ahead can't stack more than the cap into any week.
export function weekFits(times, at, cap = weeklyCap()) {
  const starts = [at - WEEK_MS + 1,
    ...times.filter(t => t > at && t < at + WEEK_MS).map(t => t - WEEK_MS + 1),
    ...times.filter(t => t > at - WEEK_MS && t <= at)];
  let worst = {count: 0, start: starts[0]};
  for (const s of starts) {
    const count = times.filter(t => t >= s && t < s + WEEK_MS).length;
    if (count > worst.count) worst = {count, start: s};
  }
  return {ok: worst.count + 1 <= cap, used: worst.count, cap, windowStart: new Date(worst.start).toISOString()};
}
// Every draft created counts for 24 hours, whatever happened to it since (so rejecting doesn't refund).
const createdTimes = drafts => drafts.map(d => Date.parse(d.createdAt));
const dailyDraftUsage = drafts => windowUsage(createdTimes(drafts), dailyDraftCap(), DAY_MS);
const weeklyDraftUsage = drafts => windowUsage(createdTimes(drafts), weeklyDraftCap(), WEEK_MS);
// Whichever creation window is tighter decides how many drafts may be made right now.
export function creationBudget(drafts) {
  const day = dailyDraftUsage(drafts), week = weeklyDraftUsage(drafts);
  return day.remaining <= week.remaining ? {...day, window: 'daily'} : {...week, window: 'weekly'};
}
export const creationCapError = b => capError(b.window === 'daily' ? 'Daily draft creation cap reached' : 'Weekly draft creation cap reached', b);
const capError = (what, u) => new HttpError(429, `${what} (${u.used}/${u.cap})` + (u.nextSlotAt ? `; next slot frees at ${u.nextSlotAt}` : ''));
const dataPath = () => resolve(process.env.RAIL_DATA_PATH || './data/drafts.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
// Normalised so trivial punctuation/case/spacing changes still count as duplicates.
export const hashText = t => createHash('sha256')
  .update(t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).digest('hex');

async function acquireLock(lockPath) {
  for (let n = 0; n < 60; n++) {
    try { const h = await open(lockPath, 'wx', 0o600); await h.writeFile(String(process.pid)); return h; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock older than STALE_LOCK_MS was left by a crashed process; transactions take milliseconds.
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS) { await unlink(lockPath).catch(() => {}); continue; } }
      catch (e2) { if (e2.code === 'ENOENT') continue; throw e2; }
      await sleep(50 + Math.random() * 50);
    }
  }
  throw new HttpError(503, 'Storage busy');
}

async function readDb(path) {
  try { const db = JSON.parse(await readFile(path, 'utf8')); return {drafts: db.drafts || [], events: db.events || []}; }
  catch (e) { if (e.code === 'ENOENT') return {drafts: [], events: []}; throw e; }
}

// In-process queue serialises transactions; the lock file guards against other processes (e.g. `npm run draft`).
let queue = Promise.resolve();
export function transaction(fn) {
  const run = queue.then(async () => {
    const path = dataPath(), lockPath = path + '.lock';
    await mkdir(dirname(path), {recursive: true});
    const lock = await acquireLock(lockPath);
    try {
      const db = await readDb(path);
      const result = await fn(db);
      if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
      const tmp = path + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify(db, null, 2), {mode: 0o600});
      await rename(tmp, path);
      return result;
    } finally { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); }
  });
  queue = run.catch(() => {});
  return run;
}

const find = (db, id) => { const d = db.drafts.find(x => x.id === id); if (!d) throw notFound('Draft not found'); return d; };
const event = (db, type, id, extra = {}) => { const e = {type, id, at: now(), ...extra}; db.events.push(e); return e; };

export async function saveDraft(text, meta = {}) {
  const clean = validateDraft(text), hash = hashText(clean);
  return transaction(db => {
    const budget = creationBudget(db.drafts);
    if (budget.remaining <= 0) throw creationCapError(budget);
    if (db.drafts.some(d => d.hash === hash)) throw conflict('Duplicate draft detected');
    const at = now();
    const entry = {id: randomUUID(), text: clean, hash, status: 'pending_approval', pillar: meta.pillar || null, source: meta.source || 'manual', ...(meta.provider ? {provider: meta.provider, model: meta.model} : {}), createdAt: at, updatedAt: at};
    db.drafts.push(entry); event(db, 'draft_created', entry.id, {source: entry.source});
    return entry;
  });
}

export async function editDraft(id, text, editor) {
  if (!isReviewer(editor)) throw badRequest('Invalid editor');
  const clean = validateDraft(text), hash = hashText(clean);
  return transaction(db => {
    const d = find(db, id);
    if (d.status !== 'pending_approval') throw conflict('Only pending drafts can be edited');
    if (d.text === clean) return d;
    if (db.drafts.some(x => x.id !== id && x.hash === hash)) throw conflict('Duplicate draft detected');
    event(db, 'draft_edited', id, {reviewer: editor, previous: d.text});
    Object.assign(d, {text: clean, hash, updatedAt: now(), editedBy: editor});
    return d;
  });
}

export async function reviewDraft(id, decision, reviewer, note) {
  if (!['approved', 'rejected'].includes(decision)) throw badRequest('Invalid decision');
  if (!isReviewer(reviewer)) throw badRequest('Invalid reviewer');
  if (note != null && (typeof note !== 'string' || note.length > 500)) throw badRequest('Invalid note');
  return transaction(db => {
    const d = find(db, id);
    if (d.status !== 'pending_approval') throw conflict('Draft already reviewed');
    const at = now();
    Object.assign(d, {status: decision, reviewedBy: reviewer, reviewedAt: at, updatedAt: at}, note ? {note: note.trim()} : {});
    event(db, 'draft_' + decision, id, {reviewer, ...(note ? {note: note.trim()} : {})});
    return d;
  });
}

// Queuing is claim → external call → finish/fail, so two concurrent requests can't both push to Buffer.
// plannedAt: when the post will publish (the schedule time; now for drafts and the Buffer queue).
export async function claimForQueue(id, reviewer, {plannedAt = Date.now()} = {}) {
  if (!isReviewer(reviewer)) throw badRequest('Invalid reviewer');
  return transaction(db => {
    const d = find(db, id);
    const stale = d.status === 'queuing' && Date.now() - Date.parse(d.queuingAt) > STALE_QUEUING_MS;
    if (d.status !== 'approved' && !stale) throw conflict(d.status === 'queued' ? 'Draft already queued' : 'Only approved drafts can be queued');
    // Checked inside the transaction so concurrent sends can't overshoot the cap.
    const fit = weekFits(publishTimes(db.drafts.filter(x => x.id !== id)), plannedAt);
    if (!fit.ok) throw new HttpError(429, `Weekly posting cap reached (${fit.used}/${fit.cap} posts in the 7 days from ${fit.windowStart})`);
    Object.assign(d, {status: 'queuing', queuingAt: now(), plannedAt: new Date(plannedAt).toISOString(), updatedAt: now()});
    event(db, 'draft_queuing', id, {reviewer});
    return {...d};
  });
}
// sendMode: 'draft' (Buffer draft), 'queue' (next Buffer slot) or 'schedule' (exact time); dueAt is Buffer's publish time.
export async function finishQueue(id, bufferPostId, reviewer, {sendMode = 'draft', dueAt = null} = {}) {
  return transaction(db => {
    const d = find(db, id);
    const at = now();
    Object.assign(d, {status: 'queued', bufferPostId, queuedAt: at, queuedBy: reviewer, updatedAt: at, sendMode, dueAt});
    delete d.queueError; delete d.queuingAt; delete d.plannedAt;
    event(db, 'draft_queued', id, {reviewer, bufferPostId, sendMode, ...(dueAt ? {dueAt} : {})});
    return d;
  });
}
export async function failQueue(id, message) {
  return transaction(db => {
    const d = find(db, id);
    Object.assign(d, {status: 'approved', queueError: String(message).slice(0, 500), updatedAt: now()});
    delete d.queuingAt; delete d.plannedAt;
    event(db, 'draft_queue_failed', id, {error: d.queueError});
    return d;
  });
}

// Undo a send: only for posts that haven't published yet (or Buffer drafts). Back to approved so it can be re-sent.
export async function unqueue(id, reviewer) {
  if (!isReviewer(reviewer)) throw badRequest('Invalid reviewer');
  return transaction(db => {
    const d = find(db, id);
    if (d.status !== 'queued') throw conflict('Only sent drafts can be unscheduled');
    if (d.sendMode !== 'draft' && Date.parse(d.dueAt) <= Date.now()) throw conflict('Post already published');
    const was = {bufferPostId: d.bufferPostId, dueAt: d.dueAt, sendMode: d.sendMode};
    for (const k of ['bufferPostId', 'dueAt', 'sendMode', 'queuedAt', 'queuedBy']) delete d[k];
    Object.assign(d, {status: 'approved', updatedAt: now()});
    event(db, 'draft_unscheduled', id, {reviewer, ...was});
    return d;
  });
}
export async function listDrafts({status} = {}) {
  if (status && !STATUSES.includes(status)) throw badRequest('Invalid status');
  const {drafts} = await readDb(dataPath());
  return drafts.filter(d => !status || d.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getDraft(id) { return find(await readDb(dataPath()), id); }
export async function listEvents(limit = 50) {
  const {events} = await readDb(dataPath());
  return events.slice(-Math.min(Math.max(1, limit | 0), 500)).reverse();
}
export async function stats() {
  const {drafts} = await readDb(dataPath());
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const d of drafts) counts[d.status] = (counts[d.status] || 0) + 1;
  return {counts, total: drafts.length, weekly: weeklyUsage(drafts), daily: dailyDraftUsage(drafts), weeklyDrafts: weeklyDraftUsage(drafts), creation: creationBudget(drafts)};
}
