import {readFile, writeFile, mkdir, open, rename} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
const path = resolve(process.env.RAIL_DATA_PATH || './data/drafts.json');
const lockPath = path + '.lock';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function transaction(fn) {
  await mkdir(dirname(path), {recursive:true});
  let lock;
  for (let n=0;n<30;n++) {
    try { lock=await open(lockPath,'wx',0o600); break; }
    catch(e) { if(e.code!=='EEXIST') throw e; await sleep(100); }
  }
  if(!lock) throw new Error('Storage busy');
  try {
    let db={drafts:[],events:[]};
    try { db=JSON.parse(await readFile(path,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
    const result=await fn(db);
    const tmp=path+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,JSON.stringify(db,null,2),{mode:0o600});
    await rename(tmp,path);
    return result;
  } finally { await lock.close(); await import('node:fs/promises').then(m=>m.unlink(lockPath)); }
}
export async function saveDraft(text) {
  const hash=createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
  return transaction(db=>{
    if(db.drafts.some(d=>d.hash===hash)) throw new Error('Duplicate draft detected');
    const entry={id:randomUUID(),text,hash,status:'pending_approval',createdAt:new Date().toISOString()};
    db.drafts.push(entry);db.events.push({type:'draft_created',id:entry.id,at:entry.createdAt});return entry;
  });
}
export async function reviewDraft(id,decision,reviewer) {
  if(!['approved','rejected'].includes(decision)) throw new Error('Invalid decision');
  if(!/^[a-zA-Z0-9_-]{2,64}$/.test(reviewer)) throw new Error('Invalid reviewer');
  return transaction(db=>{
    const d=db.drafts.find(x=>x.id===id);if(!d) throw new Error('Draft not found');
    if(d.status!=='pending_approval') throw new Error('Draft already reviewed');
    d.status=decision;d.reviewedBy=reviewer;d.reviewedAt=new Date().toISOString();
    db.events.push({type:'draft_'+decision,id,reviewer,at:d.reviewedAt});return d;
  });
}
export async function listDrafts(){
  try { return JSON.parse(await readFile(path,'utf8')).drafts; }
  catch(e) { if(e.code==='ENOENT') return [];throw e; }
}
