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

// Creates a Buffer *draft* only (saveToDraft: true) — nothing publishes until scheduled inside Buffer.
// Text is embedded as a JSON-escaped string literal, which is a valid GraphQL string.
export async function createBufferDraft(text, {channelId = process.env.BUFFER_CHANNEL_ID, fetchImpl} = {}) {
  if (process.env.BUFFER_WRITES_ENABLED !== 'true') throw new Error('Buffer writes disabled (set BUFFER_WRITES_ENABLED=true)');
  const data = await bufferGraphql(`mutation CreateDraftPost {
  createPost(input: { text: ${JSON.stringify(text)}, channelId: ${gqlId(channelId)}, schedulingType: automatic, mode: addToQueue, saveToDraft: true }) {
    ... on PostActionSuccess { post { id text } }
    ... on MutationError { message }
  }
}`, {}, fetchImpl);
  const r = data.createPost;
  if (!r?.post?.id) throw new Error(`Buffer rejected draft: ${r?.message || 'unknown error'}`);
  return r.post;
}
