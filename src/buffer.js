// Buffer GraphQL API — queries verified against developers.buffer.com examples
// (get-organizations, get-channels, create-draft-post).
const endpoint = () => process.env.BUFFER_GRAPHQL_URL || 'https://api.buffer.com';
export const writesEnabled = () => process.env.BUFFER_WRITES_ENABLED === 'true' && !!process.env.BUFFER_API_KEY && !!process.env.BUFFER_CHANNEL_ID;

export async function bufferGraphql(query, variables = {}, fetchImpl = fetch) {
  if (!process.env.BUFFER_API_KEY) throw new Error('BUFFER_API_KEY missing');
  const response = await fetchImpl(endpoint(), {
    method: 'POST',
    headers: {Authorization: `Bearer ${process.env.BUFFER_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(15000)
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Buffer API error: HTTP ${response.status}`); }
  if (!response.ok || body.errors?.length) throw new Error(`Buffer API error: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  return body.data;
}

export async function verifyBufferConnection(fetchImpl) {
  const data = await bufferGraphql('query GetOrganizations { account { organizations { id name } } }', {}, fetchImpl);
  return {organizations: data.account?.organizations || []};
}

const gqlId = id => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id || '')) throw new Error('Invalid Buffer id'); return JSON.stringify(id); };

export async function listChannels(organizationId = process.env.BUFFER_ORGANIZATION_ID, fetchImpl) {
  if (!organizationId) organizationId = (await verifyBufferConnection(fetchImpl)).organizations[0]?.id;
  if (!organizationId) throw new Error('No Buffer organization found');
  const data = await bufferGraphql(`query GetChannels { channels(input: { organizationId: ${gqlId(organizationId)} }) { id name displayName service isQueuePaused } }`, {}, fetchImpl);
  return {organizationId, channels: data.channels || []};
}

export const SEND_MODES = ['draft', 'queue', 'schedule'];
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600_000;
export function checkDueAt(dueAt, at = Date.now()) {
  const t = Date.parse(dueAt);
  if (typeof dueAt !== 'string' || Number.isNaN(t)) throw new Error('dueAt must be an ISO 8601 date-time');
  if (t < at + 60_000) throw new Error('dueAt must be at least a minute in the future');
  if (t > at + MAX_SCHEDULE_AHEAD_MS) throw new Error('dueAt must be within a year');
  return new Date(t).toISOString();
}

// mode 'draft': Buffer draft (nothing publishes until scheduled inside Buffer).
// mode 'queue': next free slot in the channel's Buffer posting schedule.
// mode 'schedule': publishes at dueAt (UTC). Field names follow developers.buffer.com "Posts & Scheduling".
// Text is embedded as a JSON-escaped string literal, which is a valid GraphQL string.
export async function createBufferPost(text, {mode = 'draft', dueAt, channelId = process.env.BUFFER_CHANNEL_ID, fetchImpl} = {}) {
  if (process.env.BUFFER_WRITES_ENABLED !== 'true') throw new Error('Buffer writes disabled (set BUFFER_WRITES_ENABLED=true)');
  if (!SEND_MODES.includes(mode)) throw new Error(`mode must be one of ${SEND_MODES.join(', ')}`);
  const fields = mode === 'draft' ? 'mode: addToQueue, saveToDraft: true'
    : mode === 'queue' ? 'mode: addToQueue'
    : `mode: customScheduled, dueAt: ${JSON.stringify(checkDueAt(dueAt))}`;
  const data = await bufferGraphql(`mutation CreatePost {
  createPost(input: { text: ${JSON.stringify(text)}, channelId: ${gqlId(channelId)}, schedulingType: automatic, ${fields} }) {
    ... on PostActionSuccess { post { id text dueAt } }
    ... on MutationError { message }
  }
}`, {}, fetchImpl);
  const r = data.createPost;
  if (!r?.post?.id) throw new Error(`Buffer rejected post: ${r?.message || 'unknown error'}`);
  return r.post;
}
export const createBufferDraft = (text, opts = {}) => createBufferPost(text, {...opts, mode: 'draft'});

// Read-only startup check: reports available channels and whether BUFFER_CHANNEL_ID matches one of them.
export async function checkBufferSetup(fetchImpl) {
  const {organizationId, channels} = await listChannels(undefined, fetchImpl);
  const list = channels.map(c => ({id: c.id, service: c.service, name: c.displayName || c.name, paused: !!c.isQueuePaused}));
  const configured = process.env.BUFFER_CHANNEL_ID;
  const fields = {organizationId, channels: list, writesEnabled: writesEnabled()};
  if (!configured) return {level: 'info', message: 'buffer connected; set BUFFER_CHANNEL_ID to one of these channels', fields};
  if (!list.some(c => c.id === configured)) return {level: 'warn', message: 'BUFFER_CHANNEL_ID not found in this Buffer organization', fields: {...fields, configured}};
  return {level: 'info', message: 'buffer channel ok', fields: {...fields, configured}};
}
