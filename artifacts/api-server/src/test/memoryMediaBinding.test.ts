import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {listMemoryMediaBindings,memoryRecoveryStorageRef,reviewUnboundMemoryReferences} from '../services/memory/memoryMediaBinding.js';

const itemId='11111111-1111-4111-8111-111111111111',memoryId='22222222-2222-4222-8222-222222222222',ownerId='33333333-3333-4333-8333-333333333333',assetId='44444444-4444-4444-8444-444444444444';
function fixture(overrides:Record<string,unknown>={}) {
 const replies:Record<string,unknown>={
  memory_items:{data:[{id:itemId,memory_id:memoryId,media_url:`post-media/${ownerId}/photo.jpg`}],error:null},
  memories:{data:{id:memoryId,owner_id:ownerId,state:'published'},error:null},
  media_assets:{data:[{id:assetId,owner_user_id:ownerId,purge_status:'retained'}],error:null},...overrides,
 };
 const reads:string[]=[],limits:Array<[string,number]>=[];
 const client={from(table:string){reads.push(table);const chain={select:()=>chain,is:()=>chain,eq:()=>chain,gt:()=>chain,order:()=>chain,limit:(n:number)=>{limits.push([table,n]);return chain;},maybeSingle:()=>Promise.resolve(replies[table]),then:(resolve:(x:unknown)=>unknown,reject:(x:unknown)=>unknown)=>Promise.resolve(replies[table]).then(resolve,reject)};return chain;},rpc:()=>{throw new Error('Inventory must not write');}} as unknown as SupabaseClient;
 return {client,reads,limits};
}
describe('bounded Memory reference inventory',()=>{
 it('reads a bounded page and proposes a source without mutating or exposing a URL',async()=>{
  const f=fixture(),result=await listMemoryMediaBindings(f.client,{limit:1});
  assert.equal(result.items[0]?.status,'candidate');assert.equal(result.items[0]?.assetId,assetId);assert.equal(result.nextCursor,null);
  assert.deepEqual(f.limits,[['memory_items',2],['media_assets',2]]);assert.ok(!JSON.stringify(result).includes('media_url'));
 });
 for(const table of ['memory_items','memories','media_assets'])for(const mode of ['error','missing-error','malformed'])it(`${table} ${mode} refuses the whole page`,async()=>{
  const reply=mode==='error'?{data:null,error:{code:'42501'}}:mode==='missing-error'?{data:[]}: {data:42,error:null};
  await assert.rejects(listMemoryMediaBindings(fixture({[table]:reply}).client),/inventory unavailable/);
 });
 for(const [label,rows,status] of [
  ['missing',[],'missing_source'],
  ['ambiguous',[{id:assetId,owner_user_id:ownerId,purge_status:'retained'},{id:itemId,owner_user_id:ownerId,purge_status:'retained'}],'ambiguous_source'],
  ['foreign',[{id:assetId,owner_user_id:memoryId,purge_status:'retained'}],'owner_mismatch'],
  ['permanent purge',[{id:assetId,owner_user_id:ownerId,purge_status:'pending'}],'unavailable'],
 ] as const)it(`${label} source is not eligible for reconciliation`,async()=>{
  const result=await listMemoryMediaBindings(fixture({media_assets:{data:rows,error:null}}).client);
  assert.equal(result.items[0]?.status,status);assert.equal(result.items[0]?.assetId,null);
 });
 it('rejects invalid bounds before reading',async()=>{
  for(const options of [{limit:0},{limit:51},{limit:1.5},{after:'bad'},{memoryId:'bad'}]){
   const f=fixture();await assert.rejects(listMemoryMediaBindings(f.client,options),/Invalid Memory binding page/);assert.deepEqual(f.reads,[]);
  }
 });
 it('uses the configured origin for historical signed references and never treats credentials as proof',()=>{
  const prior=process.env.SUPABASE_URL;process.env.SUPABASE_URL='https://storage.invalid';
  try {
   assert.deepEqual(memoryRecoveryStorageRef(`https://storage.invalid/storage/v1/object/sign/post-media/${ownerId}%2Fphoto.jpg?token=old`),{bucket:'post-media',path:`${ownerId}/photo.jpg`});
   for(const url of [`https://foreign.invalid/storage/v1/object/sign/post-media/${ownerId}/photo.jpg`, `https://user:secret@storage.invalid/storage/v1/object/sign/post-media/${ownerId}/photo.jpg`, 'https://storage.invalid/storage/v1/object/sign/post-media/%ZZ', 'https://storage.invalid/storage/v1/object/sign/post-media/..%2Fprivate'])assert.equal(memoryRecoveryStorageRef(url),null);
  }finally {if(prior===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior;}
 });
});


describe('restoration unbound reference review',()=>{
 const source={bucket:'post-media',path:`${ownerId}/photo.jpg`};
 const row={id:itemId,memory_id:memoryId,media_url:'https://external.invalid/photo.jpg'};
 const snapshot=(items:unknown[],total=items.length,fingerprint='a'.repeat(64))=>({ownerId,fingerprint,total,items});
 function client(replies:unknown[]){let calls=0;return {sc:{rpc:async()=>{const reply=replies[calls++];if(reply===undefined)throw new Error('Unexpected extra read');return reply;}} as unknown as SupabaseClient,calls:()=>calls};}
 it('reads all pages at one digest and returns no raw URLs in the review proof',async()=>{
  const f=client([{data:snapshot([row],2),error:null},{data:snapshot([{...row,id:assetId}],2),error:null}]);
  const proof=await reviewUnboundMemoryReferences(f.sc,assetId,source,ownerId);assert.equal(proof.total,2);assert.equal(proof.reviewed,true);assert.equal(f.calls(),2);assert.ok(!JSON.stringify(proof).includes('external.invalid'));
 });
 for(const url of [`post-media/${ownerId}/photo.jpg`,`${process.env.SUPABASE_URL}/storage/v1/object/public/post-media/${ownerId}/photo.jpg`,`${process.env.SUPABASE_URL}/storage/v1/object/sign/post-media/${ownerId}%2Fphoto.jpg?token=expired`])it(`matching alias requires reconciliation (${url.includes('/sign/')?'signed':url.includes('://')?'public':'bare'})`,async()=>{
  await assert.rejects(reviewUnboundMemoryReferences(client([{data:snapshot([{...row,media_url:url}]),error:null}]).sc,assetId,source,ownerId),/requires reconciliation/);
 });
 for(const [name,replies] of Object.entries({
  unreadable:[{data:null,error:{code:'42501'}}],missingError:[{data:snapshot([])}],malformed:[{data:{},error:null}],incomplete:[{data:snapshot([],1),error:null}],overfull:[{data:snapshot([row],0),error:null}],
  changed:[{data:snapshot([row],2),error:null},{data:snapshot([{...row,id:assetId}],2,'b'.repeat(64)),error:null}],
  repeated:[{data:snapshot([row],2),error:null},{data:snapshot([row],2),error:null}],
 }))it(`${name} cannot certify a complete unchanged review`,async()=>{await assert.rejects(reviewUnboundMemoryReferences(client(replies).sc,assetId,source,ownerId));});
});
