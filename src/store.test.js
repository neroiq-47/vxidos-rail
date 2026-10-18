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
 process.env.WEEKLY_POST_CAP='2'; process.env.DAILY_DRAFT_CAP='100'; process.env.WEEKLY_DRAFT_CAP='100'; // isolate the send cap
 try {
  const ids=[];
  for(const t of ['cap test one goes out.','cap test two goes out.','cap test three waits.']){const d=await saveDraft(t);await reviewDraft(d.id,'approved','owner');ids.push(d.id);}
  // One send from 8 days ago is outside the rolling window and must not count.
  await transaction(db=>{db.drafts.push({id:'old',text:'x',hash:'old',status:'queued',queuedAt:new Date(Date.now()-8*86400_000).toISOString(),createdAt:'2000-01-01'});});
  for(const id of ids.slice(0,2)){await claimForQueue(id,'owner');await finishQueue(id,'buf_'+id,'owner');}
  await assert.rejects(claimForQueue(ids[2],'owner'),e=>e.status===429&&/2\/2 posts in the 7 days/.test(e.message));
  const w=(await stats()).weekly;
  assert.equal(w.used,2);assert.equal(w.remaining,0);assert.ok(Date.parse(w.nextSlotAt)>Date.now()+6*86400_000);assert.equal(w.scheduled,0);
  process.env.WEEKLY_POST_CAP='3';
  assert.equal((await claimForQueue(ids[2],'owner')).status,'queuing','raising the cap frees a slot');
 } finally { delete process.env.WEEKLY_POST_CAP; delete process.env.DAILY_DRAFT_CAP; delete process.env.WEEKLY_DRAFT_CAP; }
});
test('weekly cap defaults to 200', async()=>{
 const {weeklyCap}=await import('./store.js');
 assert.equal(weeklyCap(),200);
});
test('creation caps follow the weekly post cap: daily = ceil(weekly/7), weekly drafts = weekly posts', async()=>{
 const {dailyDraftCap,weeklyDraftCap,creationBudget}=await import('./store.js');
 assert.equal(weeklyDraftCap(),200); assert.equal(dailyDraftCap(),29);
 process.env.WEEKLY_POST_CAP='70';
 try {
  assert.equal(weeklyDraftCap(),70); assert.equal(dailyDraftCap(),10);
  process.env.DAILY_DRAFT_CAP='auto'; assert.equal(dailyDraftCap(),10,'auto keeps the derived value');
  process.env.DAILY_DRAFT_CAP='5'; assert.equal(dailyDraftCap(),5,'explicit number overrides');
  delete process.env.DAILY_DRAFT_CAP;
  // 6 days of 10/day = 60 this week: daily has room (10) but the weekly budget (70) leaves exactly 10, then 9 after one more.
  const day=86400_000, drafts=[];
  for(let d=1;d<=6;d++) for(let i=0;i<10;i++) drafts.push({createdAt:new Date(Date.now()-d*day-1000).toISOString()});
  drafts.push({createdAt:new Date().toISOString()});
  const b=creationBudget(drafts);
  assert.equal(b.remaining,9); assert.ok(['daily','weekly'].includes(b.window));
  for(let i=0;i<9;i++) drafts.push({createdAt:new Date().toISOString()});
  const full=creationBudget(drafts);
  assert.equal(full.remaining,0); assert.equal(full.window,'daily');
  // a full week at the weekly limit blocks even when today is empty
  const week=Array.from({length:70},(_, i)=>({createdAt:new Date(Date.now()-day-1000-i*60_000).toISOString()}));
  const wk=creationBudget(week);
  assert.equal(wk.remaining,0); assert.equal(wk.window,'weekly');
 } finally { delete process.env.WEEKLY_POST_CAP; delete process.env.DAILY_DRAFT_CAP; }
});
test('weekly cap counts publish time: scheduling ahead cannot stack more than the cap into one week', async()=>{
 const {weekFits}=await import('./store.js');
 const day=86400_000, t0=Date.now();
 const times=[t0+8*day, t0+9*day, t0+10*day]; // 3 posts already scheduled for days 8-10
 assert.equal(weekFits(times, t0, 3).ok, true, 'today: no week contains both today and day 8+');
 assert.equal(weekFits(times, t0+12*day, 3).ok, false, 'day 12 shares a week with days 8-10');
 assert.equal(weekFits(times, t0+5*day, 3).ok, false, 'day 5 shares a week [4.x, 11.x) with days 8-10 (future window)');
 assert.equal(weekFits(times, t0+2*day, 3).ok, true, 'day 2 can only share a week with day 8');
 assert.equal(weekFits(times, t0+2*day, 1).ok, false, '...which matters when the cap is 1');
 assert.equal(weekFits(times, t0+17.5*day, 3).ok, true, 'more than 7 days after day 10');
 // brute force agrees on random schedules
 for (let k=0;k<200;k++){
  const ts=Array.from({length:6},()=>t0+Math.random()*20*day), at=t0+Math.random()*20*day, cap=1+Math.floor(Math.random()*4);
  let worst=0; for(let s=at-7*day;s<=at;s+=day/96){const c=ts.filter(t=>t>=s&&t<s+7*day).length; if(c>worst) worst=c;}
  assert.equal(weekFits(ts, at, cap).ok, worst+1<=cap);
 }
});
