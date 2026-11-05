import assert from'node:assert/strict';
import{test,after}from'node:test';
import express from'express';
import{createServer}from'node:http';
import router from'../routes/tripNearby.js';
import{runTripNearbyRetention,getTripNearbyRetentionStatus}from'../lib/tripNearbyRetention.js';
import{_setTestClient}from'../lib/http.js';
import{_setTestServiceClient}from'../lib/supabase.js';
import{makeFailClosedClient}from'./helpers/failClosedSupabase.js';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',T='11111111-1111-4111-8111-111111111111',S='22222222-2222-4222-8222-222222222222';
const app=express();app.use(express.json());app.use('/api',router);const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address()as any).port}/api/trips/${T}/nearby`;
after(async()=>{_setTestClient(null,false);_setTestServiceClient(null);await new Promise<void>(r=>server.close(()=>r()));});
function setup(failed=false){
 const calls:Array<{name:string;args:any}>=[];const db=makeFailClosedClient({users:{token:A},rows:{profiles:[{id:A,account_status:'active',user_account_states:[]}],feature_flags:[{flag:'trip_nearby_checkpoints_enabled',enabled:true}]}});
 db.rpc=async(name:string,args:any)=>{calls.push({name,args});return failed?{data:null,error:{message:'down'}}:{data:name==='trip_nearby_member_eligible'?true:{state:args.p_action==='stop'?'stopped':'disabled'},error:null};};
 _setTestClient(db,true);_setTestServiceClient(db);return calls;
}
async function request(action:string,body?:object,token='token'){
 const r=await fetch(url+(action?'/'+action:''),{method:action?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,cache:r.headers.get('cache-control'),body:await r.json() as any};
}
test('authenticated owner is taken from the token and unavailable/disabled stays explicit',async()=>{
 const calls=setup();assert.equal((await request('')).body.available,true);
 const r=await request('start',{sessionId:S,consentVersion:'trip-nearby-v1',durationMinutes:5});assert.equal(r.status,200);assert.equal(r.body.state,'disabled');assert.equal(r.cache,'no-store');assert.equal(calls.at(-1)!.args.p_actor,A);
});
test('coordinates, stable user IDs, background flags and unbounded opt-in are refused at the HTTP boundary',async()=>{
 const calls=setup();for(const extra of[{lat:12,lng:34},{subjectUserId:A},{background:true},{durationMinutes:16},{consentVersion:'old'}]){
  assert.equal((await request('start',{sessionId:S,consentVersion:'trip-nearby-v1',durationMinutes:5,...extra})).status,400);
 }
 assert.equal((await request('observe',{sessionId:S,token:'a'.repeat(64),proximity:'nearby',observedAt:new Date().toISOString(),location:{lat:12,lng:34}})).status,400);
 assert.equal(calls.length,0);
});
test('unknown current reads are unavailable and signed-out requests never reach the privileged command',async()=>{
 const calls=setup(true);assert.equal((await request('read',{sessionId:S})).status,503);const before=calls.length;assert.equal((await request('start',{sessionId:S,consentVersion:'trip-nearby-v1',durationMinutes:5},'invalid')).status,401);assert.equal(calls.length,before);
});
test('withdrawal remains routed even if the enrollment endpoint would be disabled',async()=>{
 const calls=setup();assert.equal((await request('stop',{sessionId:S})).body.state,'stopped');assert.equal(calls.at(-1)!.args.p_action,'stop');
});
test('retention uses bounded batches and failure never advances success',async()=>{
 let calls=0;const db={rpc(name:string,args:any){assert.equal(name,'purge_trip_nearby_expired');assert.equal(args.p_limit,500);return{abortSignal:async()=>({data:++calls===1?500:0,error:null})};}};
 assert.equal(await runTripNearbyRetention(db),true);assert.equal(calls,2);const success=getTripNearbyRetentionStatus().lastSuccessAt;
 assert.equal(await runTripNearbyRetention({rpc:()=>({abortSignal:async()=>({data:null,error:{}})})}),false);assert.equal(getTripNearbyRetentionStatus().lastSuccessAt,success);assert.equal(getTripNearbyRetentionStatus().consecutiveFailures,1);
});
