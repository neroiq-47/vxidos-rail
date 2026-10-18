import test from 'node:test';
import assert from 'node:assert/strict';
import {pickForSchedule, parseBatch} from './schedule.js';

const d = (id, pillar, status = 'approved', day = id) => ({id: String(id), pillar, status, createdAt: `2026-10-${String(day).padStart(2, '0')}`});

test('picks approved drafts from chosen pillars, oldest first, alternating pillars', () => {
  const drafts = [d(1, 'dark web3'), d(2, 'dark web3'), d(3, 'dark web3'), d(4, 'privacy protocols'), d(5, 'midnight lifestyle'),
    d(6, 'privacy protocols', 'pending_approval'), d(7, 'privacy protocols', 'queued'), d(8, 'privacy protocols')];
  const ids = pickForSchedule(drafts, ['dark web3', 'privacy protocols'], 10).map(x => x.id);
  assert.deepEqual(ids, ['1', '4', '2', '8', '3'], 'interleaved, only approved, only chosen pillars');
  assert.deepEqual(pickForSchedule(drafts, ['dark web3', 'privacy protocols'], 3).map(x => x.id), ['1', '4', '2']);
  assert.deepEqual(pickForSchedule(drafts, ['phantom identity'], 10), []);
});

test('parseBatch validates input and defaults to 10 posts, all pillars, every 3 hours', () => {
  const b = parseBatch({startAt: '2030-01-01T00:00:00Z'});
  assert.equal(b.count, 10); assert.equal(b.pillars.length, 5); assert.equal(b.intervalMs, 3 * 3600_000);
  assert.throws(() => parseBatch({count: 11}), /count must be 1-10/);
  assert.throws(() => parseBatch({pillars: []}), /pillars/);
  assert.throws(() => parseBatch({pillars: ['crypto pumps']}), /pillars/);
  assert.throws(() => parseBatch({intervalMinutes: 5}), /intervalMinutes/);
  assert.throws(() => parseBatch({startAt: 'soon'}), /ISO/);
});
