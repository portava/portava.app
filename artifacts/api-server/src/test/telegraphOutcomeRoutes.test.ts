import {before,after,beforeEach,describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {makeFakeClient,startRouter,type RouterHarness} from './telegraphCertificationHarness.js';
import {_setTestClient} from '../lib/http.js';
import {_setTestServiceClient} from '../lib/supabase.js';
import router from '../routes/telegraphMemory.js';
const A='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000001',T='cccccccc-0000-4000-8000-000000000001',P='dddddddd-0000-4000-8000-000000000001';
let h:RouterHarness,client:ReturnType<typeof makeFakeClient>,calls:Array<{name:string;args:any}>,error:{code:string}|null;
before(async()=>{h=await startRouter(router);});after(async()=>{_setTestClient(null,false);_setTestServiceClient(null);await h.close();});
beforeEach(()=>{calls=[];error=null;client=makeFakeClient({profiles:[{id:A,account_status:'active'},{id:B,account_status:'active'}],feature_flags:[],telegraph_outcome_feedback:[{plan_id:P,user_id:A,response:'met'},{plan_id:P,user_id:B,response:'did_not_meet'}]});client.rpc=async(name,args)=>{calls.push({name,args});return {error,data:error?null:name==='telegraph_outcome_context'?{enabled:true,response:'met',retentionDays:30}:{response:args.p_response}};};_setTestClient(client,true);_setTestServiceClient(client as unknown as SupabaseClient);});
async function request(method='GET',body?:unknown,auth=A,path=`/threads/${T}/plans/${P}/outcome`){const res=await fetch(h.base+path,{method,headers:{...(auth?{Authorization:`Bearer ${auth}`} :{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:res.status,headers:res.headers,body:await res.json() as any};}
describe('private outcome HTTP boundary',()=>{
 it('binds reads to the authenticated actor and makes no write',async()=>{const r=await request();assert.equal(r.status,200);assert.match(r.headers.get('cache-control')??'',/no-store/);assert.deepEqual(calls,[{name:'telegraph_outcome_context',args:{p_thread:T,p_plan:P,p_actor:A}}]);});
 it('accepts only the two explicit responses and never an actor or plan override',async()=>{for(const body of [{response:'going'},{response:'met',userId:B},{response:'met',planId:B},{}])assert.equal((await request('PUT',body)).status,400);assert.equal(calls.length,0);assert.equal((await request('PUT',{response:'did_not_meet'})).status,200);assert.deepEqual(calls[0].args,{p_thread:T,p_plan:P,p_actor:A,p_response:'did_not_meet'});});
 it('refuses unauthenticated and malformed requests before service work',async()=>{assert.equal((await request('GET',undefined,'')).status,401);assert.equal((await request('GET',undefined,A,'/threads/no/plans/no/outcome')).status,400);assert.equal(calls.length,0);});
 it('distinguishes revoked eligibility from service failure and never claims a save',async()=>{error={code:'P0001'};assert.equal((await request('PUT',{response:'met'})).status,404);error={code:'XX000'};const r=await request('PUT',{response:'met'});assert.equal(r.status,503);assert.equal(r.body.response,undefined);});
 it('withdrawal deletes only the current actor even with no membership and no active flag',async()=>{assert.equal((await request('DELETE')).status,200);assert.deepEqual(client._store.telegraph_outcome_feedback,[{plan_id:P,user_id:B,response:'did_not_meet'}]);assert.equal(calls.length,0);assert.equal((await request('DELETE')).status,200);});
 it('settings can clear all of the current actor’s answers while preserving another person’s',async()=>{const r=await request('DELETE',undefined,A,'/me/coordination-feedback');assert.equal(r.status,200);assert.deepEqual(r.body,{removed:true});assert.deepEqual(client._store.telegraph_outcome_feedback,[{plan_id:P,user_id:B,response:'did_not_meet'}]);});
 it('a failed deletion cannot show successful removal',async()=>{client=makeFakeClient({profiles:[{id:A,account_status:'active'}]},{errors:{telegraph_outcome_feedback:{message:'offline',ops:['delete']}}});_setTestServiceClient(client as unknown as SupabaseClient);assert.equal((await request('DELETE')).status,503);});
});
