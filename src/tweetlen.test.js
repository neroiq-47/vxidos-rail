import test from 'node:test';
import assert from 'node:assert/strict';
import {tweetLength} from './public/tweetlen.js';
import {validateDraft} from './validate.js';

test('counts like X: latin 1, emoji 2 regardless of code points, CJK 2', () => {
  assert.equal(tweetLength('a'.repeat(280)), 280);
  assert.equal(tweetLength('🔥'), 2);
  assert.equal(tweetLength('👨‍👩‍👧'), 2, 'ZWJ family is one emoji');
  assert.equal(tweetLength('🇯🇵'), 2, 'flag');
  assert.equal(tweetLength('1️⃣'), 2, 'keycap');
  assert.equal(tweetLength('👍🏽'), 2, 'skin tone');
  assert.equal(tweetLength('漢字'), 4);
  assert.equal(tweetLength('é'), 1, 'NFC-normalised');
  assert.equal(tweetLength('—'), 1, 'em dash is in the light range');
  assert.equal(tweetLength('…'), 2, 'ellipsis is not');
});

test('validateDraft rejects posts X would reject even when under 280 code points', () => {
  assert.ok(validateDraft('a'.repeat(280)));
  assert.throws(() => validateDraft('a'.repeat(281)), /281\/280/);
  assert.throws(() => validateDraft('night '.repeat(10) + '🔥'.repeat(111)), /as X counts them/); // 171 code points, 282 weighted
  assert.ok(validateDraft('漢'.repeat(140)));
  assert.throws(() => validateDraft('漢'.repeat(141)), /282\/280/);
});
