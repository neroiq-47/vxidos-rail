const endpoint = process.env.BUFFER_GRAPHQL_URL || 'https://api.buffer.com';
export async function bufferGraphql(query, variables = {}) {
  if (!process.env.BUFFER_API_KEY) throw new Error('BUFFER_API_KEY missing');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {Authorization: `Bearer ${process.env.BUFFER_API_KEY}`, 'Content-Type':'application/json'},
    body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(15000)
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Buffer API error: ${JSON.stringify(body.errors || body)}`);
  return body.data;
}
export async function verifyBufferConnection() {
  return bufferGraphql('query { account { id } }');
}
// Buffer mutation schemas can change. No publishing mutation is guessed here.
// Integrate only after confirming the exact create-draft mutation in the live API docs.
export async function createBufferDraft() {
  throw new Error('Buffer draft mutation not configured. Verify the current schema and implement a draft-only mutation before enabling writes.');
}
