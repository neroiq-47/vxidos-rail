import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.RAIL_DATA_PATH = join(await mkdtemp(join(tmpdir(), 'vxidos-pillars-')), 'drafts.json');
const {validateDraft, nextPillar, buildMessages} = await import('./rail.js');
const {PILLARS} = await import('./brand.js');

test('web3 pillars: guided prompts, rotation includes them', () => {
  assert.ok(PILLARS.includes('dark web3') && PILLARS.includes('privacy protocols'));
  assert.match(buildMessages('dark web3')[1].content, /wallet drainers.*never instruct/);
  assert.match(buildMessages('privacy protocols')[1].content, /zero-knowledge proofs/);
  assert.doesNotMatch(buildMessages('midnight lifestyle')[1].content, /\(/, 'legacy pillars get no guide');
  const old = '2026-01-01';
  assert.equal(nextPillar(PILLARS.slice(0, 4).map(p => ({pillar: p, createdAt: old}))), 'privacy protocols');
});
test('blocks crypto hype and drainer bait, allows security warnings', () => {
  for (const bad of ['this token is going to the moon tonight', 'quiet 100x gem nobody sees yet', 'presale is live for the chosen few',
    'connect your wallet here for the drop', 'claim your airdrop now, phantom holders', 'send 1 eth to this address and get 2 eth back'])
    assert.throws(() => validateDraft(bad), /hype or scam-bait/, bad);
  for (const ok of ['never connect your wallet to a site you found in replies.', 'that airdrop claim page is a drainer. check the contract first.',
    'zk proofs: show you know without showing what you know.', 'rollups made it 10x cheaper to stay private.'])
    assert.ok(validateDraft(ok), ok);
});
