import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'vxidos-test-'));
process.env.RAIL_DATA_PATH=join(dir,'drafts.json');
const {saveDraft,reviewDraft,listDrafts}=await import('./store.js');
test('draft lifecycle and audit transitions',async()=>{
 const d=await saveDraft('privacy is the real luxury.');
 assert.equal(d.status,'pending_approval');
 await assert.rejects(saveDraft('privacy is the real luxury.'),/Duplicate/);
 const approved=await reviewDraft(d.id,'approved','owner');
 assert.equal(approved.status,'approved');
 await assert.rejects(reviewDraft(d.id,'rejected','owner'),/already reviewed/);
 assert.equal((await listDrafts()).length,1);
});
test('concurrent duplicates prevented',async()=>{
 const results=await Promise.allSettled([saveDraft('the vision stays the same.'),saveDraft('the vision stays the same.')]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
});
