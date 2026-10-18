import 'dotenv/config';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {draftOnce} from './rail.js';
import {verifyBufferConnection} from './buffer.js';
import {listDrafts,reviewDraft} from './store.js';
const secret=process.env.RAIL_SECRET;
if(!secret || secret.length<24) throw new Error('Set RAIL_SECRET to at least 24 characters');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length && timingSafeEqual(x,y);};
const server=createServer(async(req,res)=>{
 const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
 if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,brand:'VXIDOS'});
 if(!equal(req.headers.authorization,`Bearer ${secret}`))return send(401,{error:'Unauthorized'});
 try {
  if(req.method==='POST'&&req.url==='/draft')return send(201,await draftOnce());
  if(req.method==='GET'&&req.url==='/drafts')return send(200,{drafts:await listDrafts()});
  if(req.method==='GET'&&req.url==='/buffer/check')return send(200,await verifyBufferConnection());
  if(req.method==='POST'&&/^\/drafts\/[a-f0-9-]{36}\/review$/.test(req.url||'')){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return send(413,{error:'Body too large'});}
    let input;try{input=JSON.parse(body);}catch{return send(400,{error:'Invalid JSON'});}
    return send(200,await reviewDraft(req.url.split('/')[2],input.decision,input.reviewer));
  }
  return send(404,{error:'Not found'});
 }catch(e){return send(/not found/i.test(e.message)?404:/already|invalid|duplicate/i.test(e.message)?400:500,{error:e.message});}
});
server.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>console.log('VXIDOS rail listening on localhost'));
