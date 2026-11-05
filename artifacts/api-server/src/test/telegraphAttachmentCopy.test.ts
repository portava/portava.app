import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {copyForwardAttachments,sweepForwardMedia} from '../services/telegraph/forwardAttachments.js';
import {forwardAttachmentsOf} from '../services/telegraph/forwardAttachmentShape.js';
import {decideForward,type ForwardSource} from '../services/telegraph/forwarding.js';
import {authorizeMediaAccess} from '../lib/mediaAccess.js';
import {makeFakeClient} from './telegraphCertificationHarness.js';
import type {SupabaseClient} from '@supabase/supabase-js';
const A='aaaaaaaa-0000-4000-8000-000000000001',T='bbbbbbbb-0000-4000-8000-000000000001',M='cccccccc-0000-4000-8000-000000000001';
const source:ForwardSource={id:M,thread_id:T,sender_id:A,body:'private caption',msg_type:'media',subtype:null,media_url:`post-media/${A}/source.jpg`,media_type:'image'};
async function fixture(options:{uploadFail?:boolean;commitError?:string;removeFail?:boolean;access?:boolean;unknownAuthor?:boolean}={}){
 const raw=await sharp({create:{width:8,height:8,channels:3,background:'#ee4433'}}).jpeg().withMetadata().withExif({IFD0:{Artist:'PRIVATE CAMERA OWNER'}}).toBuffer();
 const uploaded=new Map<string,Buffer>();let downloads=0,finishes=0,prepared=0;const removed:string[][]=[];let finishArgs:any;
 const seed:Record<string,any[]>={profiles:[{id:A,account_status:options.unknownAuthor?'deleted':'active'}],feature_flags:[{flag:'disable_media_uploads',enabled:false}],telegraph_forward_media_jobs:[]};
 const base=makeFakeClient(seed);
 const store=base._store;
 const client={...base,storage:{from(){return {
  async download(){downloads++;return {data:new Blob([new Uint8Array(raw)]),error:null};},
  async upload(path:string,bytes:Buffer){assert.ok(store.telegraph_forward_media_jobs.length,'journal exists before any upload');if(options.uploadFail)return {error:{message:'failed'}};uploaded.set(path,bytes);return {error:null};},
  async remove(paths:string[]){removed.push(paths);if(options.removeFail)return {error:{message:'failed'}};for(const path of paths)uploaded.delete(path);return {error:null};},
 };}},async rpc(name:string,args:any){
  if(name==='telegraph_prepare_media_forward'){
   prepared++;const id=args.p_id,paths=Array.from({length:args.p_asset_count},(_,i)=>`${A}/telegraph-forwards/${id}/${i}`).flatMap(path=>[path,path+'.thumb.jpg']);
   store.telegraph_forward_media_jobs.push({id,forwarder_id:A,state:'preparing',storage_paths:paths});return {data:{outcome:'prepared',id,paths},error:null};
  }
  if(name==='telegraph_finish_media_forward'){finishes++;finishArgs=args;if(options.commitError)return {data:null,error:{code:options.commitError}};store.telegraph_forward_media_jobs[0].state='ready';return {data:{outcome:'forwarded',messageId:args.p_id,createdAt:new Date().toISOString()},error:null};}
  if(name==='telegraph_can_read_forward_media')return {data:options.access??false,error:null};
  if(name==='telegraph_claim_forward_media_cleanup')return {data:store.telegraph_forward_media_jobs,error:null};
  return {data:null,error:{message:'unexpected rpc'}};
 }};
 return {client,raw,uploaded,removed,store,stats:()=>({downloads,finishes,prepared,finishArgs})};
}
const run=(f:Awaited<ReturnType<typeof fixture>>,src=source)=>copyForwardAttachments(f.client,{source:src,targetThreadId:T,actorId:A});
describe('real attachment sanitization with Storage boundary fixture',()=>{
 it('copies to new paths, strips EXIF, generates a thumbnail and never forwards the private caption',async()=>{
  const f=await fixture();assert.ok((await sharp(f.raw).metadata()).exif);const result=await run(f);assert.equal(result.outcome,'forwarded');
  assert.equal(f.uploaded.size,2);for(const [path,bytes] of f.uploaded){assert.ok(path.includes('/telegraph-forwards/'));assert.equal((await sharp(bytes).metadata()).exif,undefined);}
  const args=f.stats().finishArgs;assert.equal(args.p_body,'');assert.equal(args.p_media_type,'image');assert.ok(!JSON.stringify(args).includes('source.jpg'));assert.equal(f.stats().finishes,1);
 });
 it('albums copy every image into one new envelope with no source caption or source URL',async()=>{
  const f=await fixture();const album={...source,msg_type:'media_album',media_url:null,body:JSON.stringify({kind:'MEDIA_ALBUM',envelopeVersion:'1',payload:{assets:[{url:source.media_url,mediaType:'image'},{url:source.media_url,mediaType:'image'}],caption:'secret caption'}})};
  await run(f,album);const args=f.stats().finishArgs;assert.equal(args.p_msg_type,'media_album');assert.equal(JSON.parse(args.p_body).payload.assets.length,2);assert.ok(!args.p_body.includes('secret caption'));assert.ok(!args.p_body.includes('source.jpg'));assert.equal(f.uploaded.size,4);
 });
 it('never downloads external or foreign unowned storage paths',async()=>{
  for(const media_url of ['https://external.invalid/image.jpg','post-media/dddddddd-0000-4000-8000-000000000001/private.jpg']){const f=await fixture();await assert.rejects(run(f,{...source,media_url}),/attachment_unavailable/);assert.equal(f.stats().downloads,0);assert.equal(f.stats().prepared,0);}
 });
 it('an inactive source author is refused before storage work',async()=>{const f=await fixture({unknownAuthor:true});await assert.rejects(run(f),/attachment_unavailable/);assert.equal(f.stats().downloads,0);});
 it('uncertain uploads retain their journaled paths for delayed cleanup and never commit a message',async()=>{const f=await fixture({uploadFail:true});await assert.rejects(run(f),/attachment_upload_failed/);assert.equal(f.stats().finishes,0);assert.equal(f.removed.length,0);assert.equal(f.store.telegraph_forward_media_jobs.length,1);});
 it('an explicit transaction rollback cleans copies; an unknown commit retains them for safe retry',async()=>{
  const failed=await fixture({commitError:'P0001'});await assert.rejects(run(failed));assert.equal(failed.removed.length,1);assert.equal(failed.store.telegraph_forward_media_jobs.length,0);
  const uncertain=await fixture({commitError:'network'});await assert.rejects(run(uncertain));assert.equal(uncertain.removed.length,0);assert.equal(uncertain.store.telegraph_forward_media_jobs.length,1);
 });
 it('cleanup failures retain the journal for a later pass',async()=>{const f=await fixture({commitError:'P0001',removeFail:true});await assert.rejects(run(f));assert.equal(f.store.telegraph_forward_media_jobs.length,1);await assert.rejects(sweepForwardMedia(f.client),/cleanup_failed/);assert.equal(f.store.telegraph_forward_media_jobs.length,1);});
 it('copied media cannot bypass the live message check through the owner shortcut',async()=>{
  const denied=await fixture();const path=`${A}/telegraph-forwards/${M}/0`;
  assert.equal(await authorizeMediaAccess(denied.client as unknown as SupabaseClient,A,'post-media',path),false);
  const allowed=await fixture({access:true});assert.equal(await authorizeMediaAccess(allowed.client as unknown as SupabaseClient,A,'post-media',path),true);
 });
 it('forwarding preserves source-policy restrictions and only admits validated image/video attachments',()=>{
  const input={source,forwarderId:A,sourceIsE2ee:false,explicitCapability:null,inheritedCapability:null};
  assert.equal(decideForward(input).ok,true);assert.equal(decideForward({...input,forwarderId:T}).ok,false);
  assert.equal(decideForward({...input,forwarderId:T,explicitCapability:'ALLOW'}).ok,true);
  assert.equal(decideForward({...input,explicitCapability:'NO_FORWARD'}).ok,false);
  assert.equal(forwardAttachmentsOf({...source,msg_type:'voice'}),null);
 });
});
