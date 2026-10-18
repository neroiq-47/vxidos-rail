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
test('near-duplicates (case/punctuation) are blocked', async()=>{
 await saveDraft('quiet ambition is loud enough.');
 await assert.rejects(saveDraft('Quiet ambition, is loud enough!'),/Duplicate/);
});
test('stale lock from a crashed process is recovered', async()=>{
 const {writeFile,utimes}=await import('node:fs/promises');
 const lock=process.env.RAIL_DATA_PATH+'.lock';
 await writeFile(lock,'99999');const old=new Date(Date.now()-60_000);await utimes(lock,old,old);
 assert.ok((await saveDraft('the lock was left behind.')).id);
});
test('weekly posting cap blocks sends past the limit and reports the next slot', async()=>{
 const {claimForQueue,finishQueue,stats,transaction}=await import('./store.js');
 process.env.WEEKLY_POST_CAP='2';
 try {
  const ids=[];
  for(const t of ['cap test one goes out.','cap test two goes out.','cap test three waits.']){const d=await saveDraft(t);await reviewDraft(d.id,'approved','owner');ids.push(d.id);}
  // One send from 8 days ago is outside the rolling window and must not count.
  await transaction(db=>{db.drafts.push({id:'old',text:'x',hash:'old',status:'queued',queuedAt:new Date(Date.now()-8*86400_000).toISOString(),createdAt:'2000-01-01'});});
  for(const id of ids.slice(0,2)){await claimForQueue(id,'owner');await finishQueue(id,'buf_'+id,'owner');}
  await assert.rejects(claimForQueue(ids[2],'owner'),e=>e.status===429&&/2\/2/.test(e.message)&&/next slot/.test(e.message));
  const w=(await stats()).weekly;
  assert.equal(w.used,2);assert.equal(w.remaining,0);assert.ok(Date.parse(w.nextSlotAt)>Date.now()+6*86400_000);
  process.env.WEEKLY_POST_CAP='3';
  assert.equal((await claimForQueue(ids[2],'owner')).status,'queuing','raising the cap frees a slot');
 } finally { delete process.env.WEEKLY_POST_CAP; }
});
test('weekly cap defaults to 200', async()=>{
 const {weeklyCap}=await import('./store.js');
 assert.equal(weeklyCap(),200);
});
