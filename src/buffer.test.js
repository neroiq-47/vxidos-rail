import test from 'node:test';
import assert from 'node:assert/strict';
import {createBufferDraft, listChannels, writesEnabled} from './buffer.js';

const fake = responses => {
  const calls = [];
  const f = async (url, init) => { calls.push({url, body: JSON.parse(init.body), auth: init.headers.Authorization}); return {ok: true, status: 200, json: async () => responses.shift()}; };
  f.calls = calls; return f;
};
test('writes stay disabled unless explicitly enabled', async () => {
  delete process.env.BUFFER_WRITES_ENABLED;
  process.env.BUFFER_API_KEY = 'k'; process.env.BUFFER_CHANNEL_ID = 'ch_1';
  assert.equal(writesEnabled(), false);
  await assert.rejects(createBufferDraft('hello world post'), /disabled/);
});
test('createBufferDraft sends the documented draft mutation with escaped text', async () => {
  process.env.BUFFER_WRITES_ENABLED = 'true';
  const f = fake([{data: {createPost: {post: {id: 'p1', text: 'x'}}}}]);
  const post = await createBufferDraft('say "hi"\nnow', {fetchImpl: f});
  assert.equal(post.id, 'p1');
  const q = f.calls[0].body.query;
  assert.match(q, /saveToDraft: true/); assert.match(q, /channelId: "ch_1"/);
  assert.ok(q.includes('text: "say \\"hi\\"\\nnow"'));
  assert.equal(f.calls[0].auth, 'Bearer k');
});
test('MutationError surfaces as an error', async () => {
  const f = fake([{data: {createPost: {message: 'channel disconnected'}}}]);
  await assert.rejects(createBufferDraft('hello world post', {fetchImpl: f}), /channel disconnected/);
});
test('rejects injection in ids', async () => {
  await assert.rejects(createBufferDraft('hello world post', {channelId: 'x" } evil', fetchImpl: fake([])}), /Invalid Buffer id/);
});
test('listChannels resolves first organization when none configured', async () => {
  delete process.env.BUFFER_ORGANIZATION_ID;
  const f = fake([{data: {account: {organizations: [{id: 'org_1'}]}}}, {data: {channels: [{id: 'ch_1', service: 'twitter'}]}}]);
  const r = await listChannels(undefined, f);
  assert.equal(r.organizationId, 'org_1'); assert.equal(r.channels[0].id, 'ch_1');
  assert.match(f.calls[1].body.query, /organizationId: "org_1"/);
});
test('checkBufferSetup lists channels and validates BUFFER_CHANNEL_ID', async () => {
  const {checkBufferSetup} = await import('./buffer.js');
  const resp = () => [{data: {account: {organizations: [{id: 'org_1'}]}}}, {data: {channels: [{id: 'ch_x', service: 'twitter', name: 'vxid'}]}}];
  delete process.env.BUFFER_CHANNEL_ID;
  let r = await checkBufferSetup(fake(resp()));
  assert.match(r.message, /set BUFFER_CHANNEL_ID/); assert.equal(r.fields.channels[0].id, 'ch_x');
  process.env.BUFFER_CHANNEL_ID = 'nope';
  r = await checkBufferSetup(fake(resp()));
  assert.equal(r.level, 'warn');
  process.env.BUFFER_CHANNEL_ID = 'ch_x';
  r = await checkBufferSetup(fake(resp()));
  assert.equal(r.message, 'buffer channel ok');
});
test('createBufferPost sends the documented queue / customScheduled fields', async () => {
  const {createBufferPost} = await import('./buffer.js');
  process.env.BUFFER_WRITES_ENABLED = 'true'; process.env.BUFFER_CHANNEL_ID = 'ch_1';
  let f = fake([{data: {createPost: {post: {id: 'p2', dueAt: '2030-01-01T09:00:00Z'}}}}]);
  await createBufferPost('queued post text', {mode: 'queue', fetchImpl: f});
  assert.match(f.calls[0].body.query, /mode: addToQueue \}/); assert.doesNotMatch(f.calls[0].body.query, /saveToDraft/);
  const due = new Date(Date.now() + 86400_000).toISOString();
  f = fake([{data: {createPost: {post: {id: 'p3', dueAt: due}}}}]);
  const p = await createBufferPost('scheduled post text', {mode: 'schedule', dueAt: due, fetchImpl: f});
  assert.equal(p.dueAt, due);
  assert.ok(f.calls[0].body.query.includes(`mode: customScheduled, dueAt: "${due}"`));
  await assert.rejects(createBufferPost('x'.repeat(20), {mode: 'schedule', dueAt: 'tomorrow', fetchImpl: fake([])}), /ISO 8601/);
});
