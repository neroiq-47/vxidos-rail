import {PILLARS} from './brand.js';
import {badRequest} from './errors.js';

export const MAX_BATCH = 10;
const MIN_INTERVAL = 15, MAX_INTERVAL = 7 * 24 * 60;

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

export function parseBatch({count = MAX_BATCH, pillars = PILLARS, startAt, intervalMinutes = 180} = {}, at = Date.now()) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw badRequest(`count must be 1-${MAX_BATCH}`);
  if (!Array.isArray(pillars) || !pillars.length || pillars.some(p => !PILLARS.includes(p))) throw badRequest('pillars must be a non-empty list of known pillars');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL)
    throw badRequest(`intervalMinutes must be ${MIN_INTERVAL}-${MAX_INTERVAL}`);
  const start = startAt == null ? at + 10 * 60_000 : Date.parse(startAt);
  if (Number.isNaN(start)) throw badRequest('startAt must be an ISO 8601 date-time');
  return {count, pillars: [...new Set(pillars)], start, intervalMs: intervalMinutes * 60_000};
}
