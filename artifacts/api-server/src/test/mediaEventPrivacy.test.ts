import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eraseAccountMediaEvents } from '../services/accountDeletion/mediaEvents.js';
import { executeAccountDeletion } from '../services/accountDeletion/AccountDeletionService.js';
import { runMediaEventRetentionSweep } from '../lib/mediaEventRetention.js';
import { recordMediaEvent } from '../lib/mediaAnalytics.js';
import { logger } from '../lib/logger.js';
const actor='10000000-0000-4000-8000-000000000001';
test('erasure pages explicitly, requires a complete receipt, and bounds one deletion attempt',async()=>{
 const calls:any[]=[];const replies=[{deleted:500,more:true},{deleted:2,more:false}];
 assert.equal(await eraseAccountMediaEvents({rpc:async(name:string,args:any)=>{calls.push({name,args});return{data:replies.shift(),error:null};}},actor),502);
 assert.deepEqual(calls.map(c=>c.args),[{p_actor:actor,p_limit:500},{p_actor:actor,p_limit:500}]);
 for(const data of [null,{deleted:0,more:true},{deleted:501,more:false},{deleted:0}]) await assert.rejects(eraseAccountMediaEvents({rpc:async()=>({data,error:null})},actor));
 let count=0;await assert.rejects(eraseAccountMediaEvents({rpc:async()=>{count++;return{data:{deleted:500,more:true},error:null};}},actor),/backlog/);assert.equal(count,40);
});
test('account deletion stops before destroying canonical creator links when erasure is uncertain',async()=>{
 let queried=false;
 const result=await executeAccountDeletion({rpc:async()=>({error:{code:'PGRST202'},data:null}),from:()=>{queried=true;throw new Error('must not destroy content');}},actor,{source:'test'} as any);
 assert.equal(result.ok,false);assert.equal(queried,false);assert.equal(result.steps[0].step,'erase_account_media_events');assert.equal(result.steps[0].ok,false);
});
test('retention distinguishes disabled policy, complete cleanup, failure and bounded backlog',async()=>{
 const client=(data:any)=>({rpc:async()=>({data,error:null})});
 assert.deepEqual(await runMediaEventRetentionSweep({client:null}),{purged:0,skipped:true,reason:'no_client'});
 assert.deepEqual(await runMediaEventRetentionSweep({client:client({enabled:false,deleted:0,more:false})}),{purged:0,skipped:true,reason:'disabled'});
 const replies=[{enabled:true,deleted:500,more:true},{enabled:true,deleted:3,more:false}];
 assert.deepEqual(await runMediaEventRetentionSweep({client:{rpc:async()=>({data:replies.shift(),error:null})}}),{purged:503,skipped:false,reason:null});
 assert.equal((await runMediaEventRetentionSweep({client:client(null)})).reason,'error');
 assert.equal((await runMediaEventRetentionSweep({client:client({enabled:true,deleted:0,more:true})})).reason,'error');
 let count=0;const r=await runMediaEventRetentionSweep({client:{rpc:async()=>{count++;return {data:{enabled:true,deleted:500,more:true},error:null};}}});
 assert.equal(count,10);assert.equal(r.purged,5000);assert.equal(r.reason,'error');
});
test('server media producer rejects raw error text and nested identities without logging payload contents',async(t)=>{
 const logged:unknown[]=[];t.mock.method(logger,'warn',(...args:unknown[])=>{logged.push(args);});
 const rows:any[]=[];
 const sc={from:(table:string)=>table==='feature_flags'?{select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{enabled:true},error:null})}:{insert:async(row:any)=>{rows.push(row);return{error:null};}}};
 recordMediaEvent('playback_failure',{viewer_id:actor,failure_reason:'private transcript with spaces'},sc);
 recordMediaEvent('playback_failure',{viewer_id:{raw:'private'},failure_reason:'network'},sc);
 recordMediaEvent('playback_failure',{viewer_id:actor,failure_reason:'network'},sc);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(rows.length,1);assert.equal(rows[0].payload.failure_reason,'network');
 const broken={...sc,from:(table:string)=>table==='feature_flags'?sc.from(table):{insert:async()=>({error:{message:'private database detail',details:'private row'}})}};
 recordMediaEvent('playback_failure',{viewer_id:actor,failure_reason:'network'},broken);
 const thrown={...sc,from:(table:string)=>table==='feature_flags'?sc.from(table):{insert:async()=>{throw new Error('private thrown detail');}}};
 recordMediaEvent('playback_failure',{viewer_id:actor,failure_reason:'network'},thrown);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(logged.length,4);assert.doesNotMatch(JSON.stringify(logged),/private|transcript|row|detail/);
});
