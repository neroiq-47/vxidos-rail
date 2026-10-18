import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.RAIL_DATA_PATH = join(await mkdtemp(join(tmpdir(), 'vxidos-rail-')), 'drafts.json');
const {validateDraft, draftOnce, draftBatch, nextPillar, buildMessages} = await import('./rail.js');
const {PILLARS} = await import('./brand.js');

test('valid VXIDOS draft', () => assert.equal(validateDraft('privacy is the real luxury.'), 'privacy is the real luxury.'));
test('strips wrapping quotes and labels', () => assert.equal(validateDraft('Tweet: "privacy is the real luxury."'), 'privacy is the real luxury.'));
test('rejects unapproved links', () => assert.throws(() => validateDraft('follow https://example.com right now')));
test('rejects too-long text', () => assert.throws(() => validateDraft('a'.repeat(281))));
test('counts emoji/unicode as single characters', () => assert.ok(validateDraft('ñ'.repeat(280))));
test('rejects financial claims, mass mentions, hashtag spam', () => {
  assert.throws(() => validateDraft('guaranteed returns if you follow my system'), /financial/);
  assert.throws(() => validateDraft('made $50,000 earned this week from nothing'), /financial/);
  assert.throws(() => validateDraft('hey @everyone look at this'), /Mass-mention/);
  assert.throws(() => validateDraft('vision #a #b #c every night'), /hashtags/);
});
test('pillar rotation picks least recently used', () => {
  assert.equal(nextPillar([]), PILLARS[0]);
  assert.equal(nextPillar([{pillar: PILLARS[0], createdAt: '2026-01-02'}, {pillar: PILLARS[1], createdAt: '2026-01-01'}]), PILLARS[2]);
});
test('prompt includes recent posts to avoid', () => assert.match(buildMessages('phantom identity', ['old post'])[1].content, /old post/));

test('retries invalid output, then saves', async () => {
  const outputs = ['bad https://link.com spam', 'the work is the alibi.'];
  const d = await draftOnce({generate: async () => outputs.shift()});
  assert.equal(d.text, 'the work is the alibi.'); assert.equal(d.status, 'pending_approval');
});
test('upstream errors are wrapped as 502 and not retried', async () => {
  let calls = 0;
  const err = Object.assign(new Error('Incorrect API key'), {status: 401});
  await assert.rejects(draftOnce({generate: async () => { calls++; throw err; }}), e => e.status === 502);
  assert.equal(calls, 1);
});
test('batch collects content errors without failing', async () => {
  const r = await draftBatch(2, {generate: async () => 'the work is the alibi.'});
  assert.equal(r.drafts.length, 0); assert.equal(r.errors.length, 2);
});
