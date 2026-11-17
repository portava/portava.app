import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readRestoredMediaSource,recoveryPathStillUsable} from '../lib/media/restoredMediaSource.js';
const assetId='11111111-1111-4111-8111-111111111111',reservationId='22222222-2222-4222-8222-222222222222',ownerId='33333333-3333-4333-8333-333333333333',eventId='44444444-4444-4444-8444-444444444444';
const path=`_recovered/${assetId}/${reservationId}/original.jpg`,sidecar=`_recovered/${assetId}/${reservationId}/dependencies/feed.jpg`;
const asset={id:assetId,owner_user_id:ownerId,storage_bucket:'post-media',storage_path:path,thumbnail_path:null,version:4,deleted_at:null,purge_status:'not_requested',moderation_status:'approved',processing_status:'ready'};
const receipt={id:eventId,details:{reservationId,bucket:'post-media',destinationPath:path,version:4,objects:[{path},{path:sidecar}]}};
function fixture(overrides:Record<string,unknown>={}) {
 const responses:Record<string,unknown>={media_assets:{data:asset,error:null},media_asset_lifecycle_events:{data:receipt,error:null},profiles:{data:{id:ownerId,account_status:'active',user_account_states:[]},error:null},post_media:{data:[{storage_path:path,feed_storage_path:sidecar,thumbnail_storage_path:null,deleted_at:null}],error:null},...overrides};
 const sc={from(table:string){const chain={select:()=>chain,eq:()=>chain,limit:()=>chain,maybeSingle:()=>Promise.resolve(responses[table]),then:(resolve:(x:unknown)=>unknown,reject:(x:unknown)=>unknown)=>Promise.resolve(responses[table]).then(resolve,reject)};return chain;}} as unknown as SupabaseClient;
 return sc;
}
describe('restored media source identity',()=>{
 it('resolves only an activated live original and its currently referenced copied sidecar',async()=>{
  const expected={assetId,ownerId,sourcePath:path,version:4};
  assert.deepEqual(await readRestoredMediaSource(fixture(),'post-media',path),expected);
  assert.deepEqual(await readRestoredMediaSource(fixture(),'post-media',sidecar),expected);
 });
 for(const [name,change] of Object.entries({retained:{purge_status:'retained'},deleted:{deleted_at:'2026-01-01'},removed:{moderation_status:'removed'},processing:{processing_status:'processing'},version:{version:5},foreign:{id:eventId},oldPath:{storage_path:'owner/old.jpg'}}))it(`${name} canonical state cannot use the activation receipt`,async()=>{
  assert.equal(await readRestoredMediaSource(fixture({media_assets:{data:{...asset,...change},error:null}}),'post-media',path),null);
 });
 for(const [name,details] of Object.entries({reservation:{...receipt.details,reservationId:eventId},bucket:{...receipt.details,bucket:'profile-media'},path:{...receipt.details,destinationPath:'other'},version:{...receipt.details,version:3},unlisted:{...receipt.details,objects:[]},duplicate:{...receipt.details,objects:[{path},{path}]}}))it(`${name} receipt mismatch denies`,async()=>{
  assert.equal(await readRestoredMediaSource(fixture({media_asset_lifecycle_events:{data:{...receipt,details},error:null}}),'post-media',path),null);
 });
 for(const table of ['media_assets','media_asset_lifecycle_events','profiles'])for(const mode of ['error','absent','missing-envelope'])it(`${table} ${mode} denies`,async()=>{
  const response=mode==='error'?{data:null,error:{code:'42501'}}:mode==='absent'?{data:null,error:null}:{data:asset};
  assert.equal(await readRestoredMediaSource(fixture({[table]:response}),'post-media',path),null);
 });
 for(const [name,profile] of Object.entries({deactivated:{id:ownerId,account_status:'deactivated',user_account_states:[]},banned:{id:ownerId,account_status:'active',user_account_states:[{state:'banned',expires_at:null}]},deactivationRow:{id:ownerId,account_status:'active',user_account_states:[{state:'deactivated',expires_at:null}]},missingStates:{id:ownerId,account_status:'active'}}))it(`${name} source owner denies`,async()=>{
  assert.equal(await readRestoredMediaSource(fixture({profiles:{data:profile,error:null}}),'post-media',path),null);
 });
 it('does not grant an unlisted or detached variant through a live original',async()=>{
  assert.equal(await readRestoredMediaSource(fixture(),'post-media',`${path}.feed.jpg`),null);
  assert.equal(await readRestoredMediaSource(fixture({post_media:{data:[],error:null}}),'post-media',sidecar),null);
  assert.equal(await readRestoredMediaSource(fixture({post_media:{data:[{storage_path:path,feed_storage_path:sidecar,deleted_at:'2026-01-01'}],error:null}}),'post-media',sidecar),null);
 });
 it('rejects noncanonical namespace spellings and buckets',async()=>{
  for(const bad of [path.replace('_recovered','%5Frecovered'),path.replace('/original','//original'),path+'/../other.jpg',path+'?token=x',path.replace(reservationId,'bad')])assert.equal(await readRestoredMediaSource(fixture(),'post-media',bad),null);
  assert.equal(await readRestoredMediaSource(fixture(),'profile-media',path),null);
 });
});

describe('retired media path authority',()=>{
 function receiptClient(responses:unknown[]){
  let index=0;return {from(table:string){assert.equal(table,'media_asset_lifecycle_events');const result=responses[index++];const chain={select:()=>chain,eq:()=>chain,contains:()=>chain,limit:()=>Promise.resolve(result)};return chain;}} as unknown as SupabaseClient;
 }
 it('requires explicit successful absence of both original and sidecar receipts',async()=>{
  assert.equal(await recoveryPathStillUsable(receiptClient([{data:[],error:null},{data:[],error:null}]),'post-media','old.jpg'),true);
  for(const bad of [{data:[{id:eventId}],error:null},{data:null,error:null},{data:[],error:{code:'42501'}},{data:[]}])for(const side of [0,1]){
   const responses:unknown[]=[{data:[],error:null},{data:[],error:null}];responses[side]=bad;
   assert.equal(await recoveryPathStillUsable(receiptClient(responses),'post-media','old.jpg'),false);
  }
 });
});
