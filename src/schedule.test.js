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

test('parseBatch: explicit times (up to 100, ordered, 5+ min apart) or start + interval', () => {
  const t0 = Date.now() + 3600_000, iso = i => new Date(t0 + i * 600_000).toISOString();
  const b = parseBatch({times: [iso(0), iso(1)]});
  assert.equal(b.times.length, 2); assert.equal(b.pillars.length, 5);
  assert.equal(parseBatch({startAt: new Date(t0).toISOString()}).times.length, 10, 'interval mode defaults to 10');
  assert.equal(parseBatch({count: 100, startAt: new Date(t0).toISOString(), intervalMinutes: 60}).times.length, 100);
  assert.throws(() => parseBatch({count: 101}), /count must be 1-100/);
  assert.throws(() => parseBatch({times: Array.from({length: 101}, (_, i) => iso(i))}), /1-100/);
  assert.throws(() => parseBatch({times: [iso(1), iso(0)]}), /in order/);
  assert.throws(() => parseBatch({times: [iso(0), new Date(t0 + 60_000).toISOString()]}), /5 minutes/);
  assert.throws(() => parseBatch({pillars: []}), /pillars/);
  assert.throws(() => parseBatch({intervalMinutes: 5}), /intervalMinutes/);
});
