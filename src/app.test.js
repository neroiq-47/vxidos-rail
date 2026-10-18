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
const bufferCalls = [], deleted = [];
const fakeBuffer = {
  writesEnabled: () => true,
  createBufferPost: async (text, opts = {}) => {
    bufferCalls.push({text, ...opts}); if (text.includes('fail')) throw new Error('boom');
    return {id: 'buf_' + bufferCalls.length, dueAt: opts.mode === 'schedule' ? opts.dueAt : opts.mode === 'queue' ? '2030-01-01T09:00:00.000Z' : null};
  },
  deleteBufferPost: async id => { deleted.push(id); if (id === 'buf_fail_delete') throw new Error('nope'); return true; },
  verifyBufferConnection: async () => ({organizations: [{id: 'org1'}]}),
  listChannels: async () => ({channels: []})
};
const server = createApp({secret, generate: async () => { const i = n++; return i < posts.length ? posts[i] : `${posts[i % posts.length]} ${i}`; }, bufferApi: fakeBuffer, env: {AUTH_FAIL_LIMIT: '3', BUFFER_PACE_MS: '0'}});
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

test('send modes: queue and schedule reach Buffer with the right options; bad input is rejected before claiming', async () => {
  const mk = async t => {
    const {body: {drafts: [d]}} = await api('POST', '/draft', {});
    await api('PATCH', `/drafts/${d.id}`, {text: t, editor: 'owner'});
    await api('POST', `/drafts/${d.id}/review`, {decision: 'approved', reviewer: 'owner'});
    return d.id;
  };
  const q = await mk('queued into the next buffer slot.');
  const r1 = await api('POST', `/drafts/${q}/queue`, {reviewer: 'owner', mode: 'queue'});
  assert.equal(r1.status, 200); assert.equal(r1.body.sendMode, 'queue'); assert.equal(r1.body.dueAt, '2030-01-01T09:00:00.000Z');
  const s = await mk('scheduled for a quiet hour.');
  assert.equal((await api('POST', `/drafts/${s}/queue`, {reviewer: 'owner', mode: 'schedule'})).status, 400, 'schedule needs dueAt');
  assert.equal((await api('POST', `/drafts/${s}/queue`, {reviewer: 'owner', mode: 'schedule', dueAt: '2001-01-01T00:00:00Z'})).status, 400, 'past');
  assert.equal((await api('POST', `/drafts/${s}/queue`, {reviewer: 'owner', mode: 'now'})).status, 400, 'unknown mode');
  assert.equal((await api('GET', `/drafts/${s}`)).body.status, 'approved', 'rejected input did not claim the draft');
  const due = new Date(Date.now() + 3 * 3600_000).toISOString();
  const r2 = await api('POST', `/drafts/${s}/queue`, {reviewer: 'owner', mode: 'schedule', dueAt: due});
  assert.equal(r2.status, 200); assert.equal(r2.body.sendMode, 'schedule'); assert.equal(r2.body.dueAt, due);
  assert.deepEqual(bufferCalls.at(-1), {text: 'scheduled for a quiet hour.', mode: 'schedule', dueAt: due});
});

test('daily draft creation cap: generation stops at the cap and says when a slot frees', async () => {
  const before = (await api('GET', '/stats')).body.daily;
  assert.equal(before.cap, 29, 'default daily cap is ceil(200 weekly posts / 7)');
  process.env.DAILY_DRAFT_CAP = String(before.used + 1);
  try {
    const r = await api('POST', '/draft', {count: 3});
    assert.equal(r.status, 201); assert.equal(r.body.drafts.length, 1);
    assert.match(r.body.errors.join(' '), /only 1 of 3 generated: daily draft cap/);
    const blocked = await api('POST', '/draft', {});
    assert.equal(blocked.status, 429); assert.match(blocked.body.error, /Daily draft creation cap reached .*next slot frees at/);
  } finally { delete process.env.DAILY_DRAFT_CAP; }
});

const waitJob = async id => { for (let i = 0; i < 100; i++) { const j = (await api('GET', `/jobs/${id}`)).body; if (j.state !== 'running') return j; await new Promise(r => setTimeout(r, 20)); } throw new Error('job stuck'); };

test('schedule-batch: preview, then a background job schedules approved drafts at the planned times', async () => {
  const ids = [];
  for (const [t, p] of [['batch one in the dark.', 'dark web3'], ['batch two, shielded.', 'privacy protocols'], ['batch three in the dark.', 'dark web3']]) {
    const {body: {drafts: [x]}} = await api('POST', '/draft', {pillar: p});
    await api('PATCH', `/drafts/${x.id}`, {text: t, editor: 'owner'});
    await api('POST', `/drafts/${x.id}/review`, {decision: 'approved', reviewer: 'owner'});
    ids.push(x.id);
  }
  const t0 = Date.now() + 2 * 3600_000;
  const times = Array.from({length: 5}, (_, i) => new Date(t0 + i * 3600_000).toISOString());
  assert.equal((await api('POST', '/schedule-batch', {reviewer: 'owner', pillars: ['nope'], times})).status, 400);
  assert.equal((await api('POST', '/schedule-batch', {reviewer: 'owner', times: [times[1], times[0]]})).status, 400, 'out of order');
  assert.equal((await api('POST', '/schedule-batch', {reviewer: 'owner', times: Array(101).fill(times[0])})).status, 400, 'over 100');
  const pv = await api('POST', '/schedule-batch/preview', {pillars: ['dark web3', 'privacy protocols'], times});
  assert.equal(pv.status, 200); assert.ok(pv.body.items.length >= 3); assert.equal(pv.body.blocked, 0);
  const before = bufferCalls.length;
  const r = await api('POST', '/schedule-batch', {reviewer: 'owner', pillars: ['dark web3', 'privacy protocols'], times});
  assert.equal(r.status, 202); assert.match(r.body.notes.join(' '), /only \d+ approved/);
  const job = await waitJob(r.body.job.id);
  assert.equal(job.state, 'done');
  assert.deepEqual(job.results.map(x => x.dueAt), times.slice(0, job.results.length), 'each post at its planned time');
  assert.ok(ids.every(id => job.results.some(x => x.id === id)));
  assert.ok(bufferCalls.slice(before).every(c => c.mode === 'schedule'));
  assert.equal((await api('POST', '/schedule-batch', {reviewer: 'owner', pillars: ['dark web3'], times})).status, 409, 'nothing left');
  // Undo the whole batch: every post is deleted in Buffer and returns to approved.
  const u = await api('POST', `/jobs/${job.id}/unschedule`, {reviewer: 'owner'});
  assert.equal(u.status, 202);
  const uj = await waitJob(u.body.job.id);
  assert.equal(uj.state, 'done'); assert.equal(uj.results.length, job.results.length);
  for (const x of job.results) assert.equal((await api('GET', `/drafts/${x.id}`)).body.status, 'approved');
  assert.equal((await api('GET', '/jobs/not-a-job')).status, 404);
});

test('unschedule one post; a failed Buffer delete changes nothing', async () => {
  const {body: {drafts: [x]}} = await api('POST', '/draft', {});
  await api('PATCH', `/drafts/${x.id}`, {text: 'unschedule me before dawn.', editor: 'owner'});
  await api('POST', `/drafts/${x.id}/review`, {decision: 'approved', reviewer: 'owner'});
  const due = new Date(Date.now() + 5 * 3600_000).toISOString();
  const q = await api('POST', `/drafts/${x.id}/queue`, {reviewer: 'owner', mode: 'schedule', dueAt: due});
  assert.equal(q.body.status, 'queued');
  const u = await api('POST', `/drafts/${x.id}/unschedule`, {reviewer: 'owner'});
  assert.equal(u.status, 200); assert.equal(u.body.status, 'approved'); assert.equal(u.body.bufferPostId, undefined);
  assert.equal(deleted.at(-1), q.body.bufferPostId);
  assert.equal((await api('POST', `/drafts/${x.id}/unschedule`, {reviewer: 'owner'})).status, 409, 'not sent any more');
});

test('jobs can be cancelled mid-run', async () => {
  const {createApp: mk} = await import('./app.js');
  let release; const gate = new Promise(r => { release = r; });
  const slow = mk({secret, generate: async () => 'x', bufferApi: fakeBuffer, env: {BUFFER_PACE_MS: '1'}, sleep: () => gate});
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${slow.address().port}`;
  const call = (m, p, b) => fetch(url + p, {method: m, headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/json'}, body: b && JSON.stringify(b)}).then(async r => ({status: r.status, body: await r.json()}));
  try {
    const approved = (await call('GET', '/drafts?status=approved')).body.drafts;
    assert.ok(approved.length >= 2, 'needs approved drafts from earlier tests');
    const t0 = Date.now() + 3 * 3600_000;
    const r = await call('POST', '/schedule-batch', {reviewer: 'owner', times: [0, 1, 2].map(i => new Date(t0 + i * 3600_000).toISOString())});
    assert.equal(r.status, 202);
    assert.equal((await call('POST', '/schedule-batch', {reviewer: 'owner', times: [new Date(t0).toISOString()]})).status, 409, 'one batch at a time');
    await call('POST', `/jobs/${r.body.job.id}/cancel`); release();
    let j; for (let i = 0; i < 100 && (j = (await call('GET', `/jobs/${r.body.job.id}`)).body).state === 'running'; i++) await new Promise(z => setTimeout(z, 10));
    assert.equal(j.state, 'cancelled', JSON.stringify(j)); assert.equal(j.done, 1, 'stopped after the first post'); assert.equal(j.results.length + j.errors.length, 1);
  } finally { slow.close(); }
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
