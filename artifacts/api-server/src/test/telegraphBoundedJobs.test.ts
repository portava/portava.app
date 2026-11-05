import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {boundedServiceFetch} from '../lib/boundedServiceFetch.js';
import {runOutcomeRetentionTick} from '../lib/telegraphOutcomeRetention.js';
import type {SupabaseClient} from '@supabase/supabase-js';
describe('bounded service operation transport',()=>{
 it('bounds headers and aborts the underlying request',async()=>{let signal:AbortSignal|undefined;const fetcher=boundedServiceFetch(100,10,async(_input,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});});await assert.rejects(fetcher('https://fixture.invalid'),/deadline/);assert.equal(signal?.aborted,true);});
 it('bounds body decoding as well as headers',async()=>{let signal:AbortSignal|undefined;const fetcher=boundedServiceFetch(100,10,async(_input,init)=>{signal=init?.signal??undefined;return new Response(new ReadableStream({start(){}}));});await assert.rejects(fetcher('https://fixture.invalid'),/deadline/);assert.equal(signal?.aborted,true);});
 it('one overall deadline covers later requests, including after slow processing',async()=>{let reads=0;const fetcher=boundedServiceFetch(15,100,async()=>{reads++;return new Response('ok');});assert.equal(await (await fetcher('https://fixture.invalid')).text(),'ok');await new Promise(r=>setTimeout(r,25));await assert.rejects(fetcher('https://fixture.invalid'),/deadline/);assert.equal(reads,1);});
 it('passes response headers/body and refuses already-aborted calls',async()=>{let reads=0;const fetcher=boundedServiceFetch(100,100,async()=>{reads++;return new Response('bytes',{status:201,headers:{'Content-Type':'image/png'}});});const r=await fetcher('https://fixture.invalid');assert.equal(r.status,201);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(await r.text(),'bytes');const abort=new AbortController();abort.abort();await assert.rejects(fetcher('https://fixture.invalid',{signal:abort.signal}),/aborted/);assert.equal(reads,1);});
});
describe('outcome retention scheduler',()=>{
 it('purges bounded batches independently of feature activation',async()=>{let calls=0;const c={async rpc(name:string){assert.equal(name,'telegraph_purge_outcome_feedback');calls++;return {data:calls===1?1000:2,error:null};}};const r=await runOutcomeRetentionTick(c as unknown as SupabaseClient);assert.equal(calls,2);assert.equal(r.deleted,1002);assert.equal(r.backlog,false);assert.equal(r.consecutiveFailures,0);});
 it('caps a large backlog at twenty batches',async()=>{let calls=0;const c={async rpc(){calls++;return {data:1000,error:null};}};const r=await runOutcomeRetentionTick(c as unknown as SupabaseClient);assert.equal(calls,20);assert.equal(r.backlog,true);});
 it('reports unavailable cleanup instead of successful deletion',async()=>{const c={async rpc(){return {data:null,error:{message:'offline'}};}};const r=await runOutcomeRetentionTick(c as unknown as SupabaseClient);assert.equal(r.deleted,0);assert.equal(r.consecutiveFailures,1);});
});
