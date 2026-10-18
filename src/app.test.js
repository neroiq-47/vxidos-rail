import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.RAIL_DATA_PATH = join(await mkdtemp(join(tmpdir(), 'vxidos-app-')), 'drafts.json');
const {createApp} = await import('./app.js');

const secret = 'test-secret-that-is-long-enough-123';
const posts = ['privacy is the real luxury.', 'build quietly. ship loudly.', 'the city sleeps. the work does not.', 'no face. only output.', 'midnight is a deadline.'];
let n = 0;
const bufferCalls = [];
const fakeBuffer = {
  writesEnabled: () => true,
  createBufferDraft: async text => { bufferCalls.push(text); if (text.includes('fail')) throw new Error('boom'); return {id: 'buf_' + bufferCalls.length}; },
  verifyBufferConnection: async () => ({organizations: [{id: 'org1'}]}),
  listChannels: async () => ({channels: []})
};
const server = createApp({secret, generate: async () => posts[n++ % posts.length], bufferApi: fakeBuffer, env: {AUTH_FAIL_LIMIT: '3'}});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const api = async (method, path, body, token = secret) => {
  const res = await fetch(base + path, {method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: body && JSON.stringify(body)});
  return {status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text(), headers: res.headers};
};

test('health and dashboard are public with security headers', async () => {
  const h = await fetch(base + '/health').then(r => r.json());
  assert.equal(h.ok, true); assert.equal(h.bufferWrites, true);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /<html/i);
});

test('full lifecycle: generate, edit, approve, queue', async () => {
  const gen = await api('POST', '/draft', {count: 2});
  assert.equal(gen.status, 201); assert.equal(gen.body.drafts.length, 2);
  const [a, b] = gen.body.drafts;
  assert.ok(a.pillar);
  assert.equal((await api('GET', '/drafts?status=pending_approval')).body.drafts.length, 2);
  const edited = await api('PATCH', `/drafts/${a.id}`, {text: '  "privacy is the only luxury left."  ', editor: 'owner'});
  assert.equal(edited.status, 200); assert.equal(edited.body.text, 'privacy is the only luxury left.');
  assert.equal((await api('POST', `/drafts/${a.id}/queue`, {reviewer: 'owner'})).status, 409, 'cannot queue unapproved');
  const ok = await api('POST', `/drafts/${a.id}/review`, {decision: 'approved', reviewer: 'owner', note: 'good'});
  assert.equal(ok.body.status, 'approved');
  assert.equal((await api('PATCH', `/drafts/${a.id}`, {text: 'changed after approval ok', editor: 'owner'})).status, 409);
  const q = await api('POST', `/drafts/${a.id}/queue`, {reviewer: 'owner'});
  assert.equal(q.status, 200); assert.equal(q.body.status, 'queued'); assert.equal(q.body.bufferPostId, 'buf_1');
  assert.equal((await api('POST', `/drafts/${a.id}/queue`, {reviewer: 'owner'})).status, 409, 'no double queue');
  assert.equal((await api('POST', `/drafts/${b.id}/review`, {decision: 'rejected', reviewer: 'owner'})).body.status, 'rejected');
  const s = await api('GET', '/stats');
  assert.equal(s.body.counts.queued, 1); assert.equal(s.body.counts.rejected, 1);
  const ev = await api('GET', '/events?limit=3');
  assert.equal(ev.body.events[0].type, 'draft_rejected');
});

test('failed Buffer push returns draft to approved with error', async () => {
  n = 0;
  const {body: {drafts: [d]}} = await api('POST', '/draft', {});
  await api('PATCH', `/drafts/${d.id}`, {text: 'this one will fail upstream', editor: 'owner'});
  await api('POST', `/drafts/${d.id}/review`, {decision: 'approved', reviewer: 'owner'});
  const r = await api('POST', `/drafts/${d.id}/queue`, {reviewer: 'owner'});
  assert.equal(r.status, 502);
  const after = await api('GET', `/drafts/${d.id}`);
  assert.equal(after.body.status, 'approved'); assert.match(after.body.queueError, /boom/);
});

test('input validation', async () => {
  const {body: {drafts: [d]}} = await api('POST', '/draft', {});
  assert.equal((await api('POST', `/drafts/${d.id}/review`, {decision: 'approved'})).status, 400, 'missing reviewer rejected');
  assert.equal((await api('POST', `/drafts/${d.id}/review`, {decision: 'maybe', reviewer: 'owner'})).status, 400);
  assert.equal((await api('PATCH', `/drafts/${d.id}`, {text: 'see https://x.co now please', editor: 'owner'})).status, 400);
  assert.equal((await api('POST', '/draft', {count: 9})).status, 400);
  assert.equal((await api('POST', '/draft', {pillar: 'crypto shilling'})).status, 400);
  assert.equal((await api('GET', '/drafts?status=bogus')).status, 400);
  assert.equal((await api('GET', '/drafts/not-a-uuid')).status, 404);
  assert.equal((await api('GET', '/nope')).status, 404);
  const big = await fetch(base + '/draft', {method: 'POST', headers: {authorization: `Bearer ${secret}`}, body: 'x'.repeat(9000)});
  assert.equal(big.status, 413);
});

test('auth: wrong token is 401, then locked out even with right token', async () => {
  assert.equal((await api('GET', '/drafts', null, 'wrong')).status, 401);
  assert.equal((await api('GET', '/drafts', null, 'wrong')).status, 401);
  assert.equal((await api('GET', '/drafts', null, 'wrong')).status, 401);
  assert.equal((await api('GET', '/drafts', null, 'wrong')).status, 429);
  assert.equal((await api('GET', '/drafts')).status, 429);
});

test('clientIp honours TRUST_PROXY hops and ignores spoofed left entries', async () => {
  const {clientIp} = await import('./app.js');
  const req = xff => ({socket: {remoteAddress: '10.0.0.1'}, headers: xff ? {'x-forwarded-for': xff} : {}});
  assert.equal(clientIp(req('1.1.1.1')), '10.0.0.1', 'off by default');
  assert.equal(clientIp(req('6.6.6.6, 2.2.2.2'), 1), '2.2.2.2', 'rightmost entry is the one the proxy added');
  assert.equal(clientIp(req(''), 1), '10.0.0.1', 'falls back to socket');
});

test('behind a proxy, one client being locked out does not lock out others', async () => {
  const proxied = createApp({secret, generate: async () => 'x', bufferApi: fakeBuffer, env: {AUTH_FAIL_LIMIT: '2', TRUST_PROXY: '1'}});
  await new Promise(r => proxied.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxied.address().port}/stats`;
  const hit = (ip, token) => fetch(url, {headers: {authorization: `Bearer ${token}`, 'x-forwarded-for': ip}}).then(r => r.status);
  try {
    assert.equal(await hit('6.6.6.6', 'bad'), 401);
    assert.equal(await hit('6.6.6.6', 'bad'), 401);
    assert.equal(await hit('6.6.6.6', secret), 429, 'attacker locked out');
    assert.equal(await hit('7.7.7.7', secret), 200, 'owner unaffected');
  } finally { proxied.close(); }
});

test('TRUST_PROXY header mode reads the proxy-set header (Railway: x-real-ip)', async () => {
  const {clientIp, parseTrustProxy} = await import('./app.js');
  const req = h => ({socket: {remoteAddress: '10.0.0.1'}, headers: h});
  const trust = parseTrustProxy('X-Real-IP');
  assert.deepEqual(trust, {header: 'x-real-ip'});
  assert.equal(clientIp(req({'x-real-ip': '3.3.3.3', 'x-forwarded-for': '6.6.6.6'}), trust), '3.3.3.3');
  assert.equal(clientIp(req({}), trust), '10.0.0.1', 'falls back to socket');
  assert.equal(parseTrustProxy('0'), null); assert.equal(parseTrustProxy(undefined), null);
  assert.deepEqual(parseTrustProxy('2'), {hops: 2});
  assert.throws(() => parseTrustProxy('x real ip'), /Invalid TRUST_PROXY/);
});

test('health reports whether generation is configured', async () => {
  const h = await fetch(base + '/health').then(r => r.json());
  assert.equal(typeof h.generation, 'boolean');
});
