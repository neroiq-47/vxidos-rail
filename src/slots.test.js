import test from 'node:test';
import assert from 'node:assert/strict';
import {planSlots} from './public/slots.js';

const at = (h, m = 0, d = 18) => new Date(2026, 9, d, h, m);
const hhmm = iso => { const t = new Date(iso); return t.getHours() * 60 + t.getMinutes(); };

test('100 posts at 8/day in a 09:00-23:00 window: evenly spaced, inside the window, 13 days', () => {
  const s = planSlots({count: 100, start: at(8), perDay: 8});
  assert.equal(s.length, 100);
  assert.ok(s.every(t => hhmm(t) >= 9 * 60 && hhmm(t) < 23 * 60), 'all inside the window');
  assert.equal(hhmm(s[0]), 9 * 60 + 53, 'first slot is half a 105-min step into the window');
  assert.equal(new Date(s[99]).getDate() - new Date(s[0]).getDate(), 12);
  for (let i = 1; i < s.length; i++) assert.ok(Date.parse(s[i]) > Date.parse(s[i - 1]), 'strictly increasing');
});

test('skips slots already past today and respects jitter bounds', () => {
  const s = planSlots({count: 3, start: at(20), perDay: 8});
  assert.ok(Date.parse(s[0]) > at(20).getTime());
  const exact = planSlots({count: 16, start: at(0), perDay: 8});
  const jit = planSlots({count: 16, start: at(0), perDay: 8, jitterMin: 10, rand: () => 1});
  jit.forEach((t, i) => { const d = (Date.parse(t) - Date.parse(exact[i])) / 60_000; assert.ok(d >= -10 && d <= 10, `±10 min, got ${d}`); });
  assert.throws(() => planSlots({count: 1, from: '23:00', to: '09:00'}), /window/);
});
