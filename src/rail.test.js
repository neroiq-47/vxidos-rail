import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDraft} from './rail.js';
test('valid VXIDOS draft',()=>assert.equal(validateDraft('privacy is the real luxury.'),'privacy is the real luxury.'));
test('rejects unapproved links',()=>assert.throws(()=>validateDraft('follow https://example.com right now')));
test('rejects too-long text',()=>assert.throws(()=>validateDraft('a'.repeat(281))));
