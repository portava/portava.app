import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {after,before,beforeEach,test} from 'node:test';
import {createServer, type Server} from 'node:http';
import express from 'express';
import { _setTestClient } from '../lib/http.js';
import recordingRouter from '../routes/recordingCaptureStamps.js';
import {sealRecordingUpload} from '../services/stamps/recordingCapture.js';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', viewer='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target=randomUUID();
let client:any, server:Server, base:string, token:string, calls:Array<{fn:string,args:any}>, story:any;
function shareRow(){return {id:token.split('.')[0], owner_id:owner,issued_at:'2026-11-09T15:00:00Z',storage_path:`${owner}/capture-stamps/${token.split('.')[0]}.mp4`};}
before(async()=>{
 const app=express();app.use(express.json());app.use('/api',recordingRouter);
 server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+((server.address() as any).port)+'/api/capture-stamps';
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));_setTestClient(null,false);});
beforeEach(()=>{
 calls=[];token='';story={id:target,owner_id:owner,state:'active',visibility:'private',expires_at:new Date(Date.now()+60000).toISOString()};
 client={auth:{getUser:async(b:string)=>({data:{user: b===owner || b===viewer ? {id:b}: null},error:null})},
  rpc:async(fn:string,args:any)=>{calls.push({fn,args}); if(fn==='open_recording_capture')return{data:new Date(Date.now()+1800000).toISOString()};
    if(fn==='seal_recording_capture')return{data:`${args.p_owner}/capture-stamps/${args.p_id}.${args.p_extension}`};
    if(fn==='read_recording_capture')return{data:[shareRow()]};return{error:{message:'capture_refused'}};},
  from:(table:string)=>{
    const rows= table==='profiles'?[{id:owner,account_status:'active'}]:table==='stories'?[story]:[];
    const b:any={select(){return b;},eq(){return b;},or(){return b;},limit(){return b;},maybeSingle:async()=>({data:rows[0]??null,error:null}),then:(yes:any,no:any)=>Promise.resolve({data:rows,error:null}).then(yes,no)};return b;
  }};
 _setTestClient(client,true);
});
const post=(path:string,body:any,actor?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(actor?{authorization:'Bearer '+actor}:{})},body:JSON.stringify(body)});
test('anonymous clients cannot start, claim, or verify a stamp',async()=>{
 assert.equal((await post('/sessions',{})).status,401);assert.equal((await post('/issue',{})).status,401);
 assert.equal((await fetch(`${base}/story/${target}`)).status,401);assert.equal(calls.length,0);
});
test('issuer hashes the credential and stored bytes itself and never accepts identity or fingerprint from the client',async()=>{
 const res=await post('/sessions',{},owner);assert.equal(res.status,201);const opened = await res.json() as {captureToken: string}; token=opened.captureToken;
 const [id,secret]=token.split('.');assert.equal(calls[0].args.p_owner,owner);assert.equal(calls[0].args.p_hash,createHash('sha256').update(secret).digest('hex'));
 assert.equal(JSON.stringify(calls).includes(secret),false);
 const bytes=Buffer.from('verified scrubbed fixture video bytes');
 assert.equal(await sealRecordingUpload(client,owner,token,bytes,'mp4'),`${owner}/capture-stamps/${id}.mp4`);
 assert.equal(calls.at(-1)!.args.p_sha,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await post('/issue',{captureToken:token,targetType:'story',targetId:target,ownerId:owner,digest:'forged'},viewer)).status,400);
 assert.equal((await post('/issue',{captureToken:token,targetType:'story',targetId:target},viewer)).status,409);assert.equal(calls.at(-1)!.args.p_owner,viewer);
});
test('a known stamp ID or target never reveals a hidden/expired Story',async()=>{
 token=randomUUID()+'.'+'a'.repeat(43);story.state='expired';
 const expired=await fetch(`${base}/story/${target}`,{headers:{authorization:'Bearer '+viewer}});assert.equal(expired.status,200);assert.deepEqual(await expired.json(),{stamp:null});
 story.state='active';story.hidden_user_ids=[viewer];
 const hidden=await fetch(`${base}/story/${target}`,{headers:{authorization:'Bearer '+viewer}});assert.deepEqual(await hidden.json(),{stamp:null});
});
