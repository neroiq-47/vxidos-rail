import {PILLARS} from './brand.js';
import {badRequest} from './errors.js';
import {checkDueAt} from './buffer.js';

export const MAX_BATCH = 100;
const MIN_INTERVAL = 15, MAX_INTERVAL = 7 * 24 * 60, MIN_GAP_MS = 5 * 60_000;

// Approved drafts from the chosen pillars, oldest first, interleaved round-robin across pillars
// (in the order given) so a batch doesn't post five of one theme back to back.
export function pickForSchedule(drafts, pillars, count) {
  const byPillar = new Map(pillars.map(p => [p, []]));
  for (const d of [...drafts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    if (d.status === 'approved' && byPillar.has(d.pillar)) byPillar.get(d.pillar).push(d);
  const out = [];
  while (out.length < count && [...byPillar.values()].some(q => q.length))
    for (const q of byPillar.values()) if (q.length && out.length < count) out.push(q.shift());
  return out;
}

// Either explicit `times` (planned in the browser, e.g. N per day in a window) or startAt + intervalMinutes.
export function parseBatch({count, pillars = PILLARS, times, startAt, intervalMinutes = 180} = {}, at = Date.now()) {
  if (!Array.isArray(pillars) || !pillars.length || pillars.some(p => !PILLARS.includes(p))) throw badRequest('pillars must be a non-empty list of known pillars');
  let list;
  if (times != null) {
    if (!Array.isArray(times) || !times.length || times.length > MAX_BATCH) throw badRequest(`times must list 1-${MAX_BATCH} publish times`);
    try { list = times.map(t => checkDueAt(t, at)); } catch (e) { throw badRequest(e.message); }
    for (let i = 1; i < list.length; i++)
      if (Date.parse(list[i]) - Date.parse(list[i - 1]) < MIN_GAP_MS) throw badRequest('times must be in order and at least 5 minutes apart');
  } else {
    count ??= 10;
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw badRequest(`count must be 1-${MAX_BATCH}`);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL)
      throw badRequest(`intervalMinutes must be ${MIN_INTERVAL}-${MAX_INTERVAL}`);
    const start = startAt == null ? at + 10 * 60_000 : Date.parse(startAt);
    if (Number.isNaN(start)) throw badRequest('startAt must be an ISO 8601 date-time');
    try { list = Array.from({length: count}, (_, i) => checkDueAt(new Date(start + i * intervalMinutes * 60_000).toISOString(), at)); }
    catch (e) { throw badRequest(e.message); }
  }
  return {pillars: [...new Set(pillars)], times: list};
}
