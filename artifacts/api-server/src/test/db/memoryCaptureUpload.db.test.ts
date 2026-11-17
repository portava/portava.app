import { recordMediaAssetDetailed } from "../../lib/mediaAssets.js";
/** Real normalization -> mounted upload -> canonical PostgreSQL asset -> mounted
 * Memory detection. Storage bytes stay in a synthetic in-memory adapter; this
 * does not certify Expo's native picker or a deployed Storage provider. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';
import { _setTestClient } from '../../lib/http.js';
import memoriesRouter from '../../routes/memories.js';
import adminMediaRouter from '../../routes/adminMedia.js';
import {lit} from './postgrestSqlBridge.js';
import postsRouter from '../../routes/posts.js';
import candidatesRouter from '../../routes/memoryCandidates.js';
import { resetCanonicalSchemaMemo } from '../../lib/media/mediaSchemaCapability.js';
import { resetHighlightSchemaMemo } from '../../services/highlights/highlightSchemaAvailability.js';
import { normalizeForUploadWith } from '../../../../../travel-buddy-standalone/src/lib/media/normalizeUpload.core.ts';

describe('normalized photos become private Memory candidates through actual upload and database paths', {skip:PRESSED_SKIP_REASON},()=>{
 let db:Awaited<ReturnType<typeof openPressedLayoverDb>>, server:Server;
 let owner:{id:string;token:string}, base:string, episodeId:string;
 const tripId=randomUUID(), bytes=new Map<string,Buffer>();
 const midnight=new Date();midnight.setUTCHours(0,0,0,0);
 const first=new Date(midnight.getTime()-24*3600000-10*60000);
 const second=new Date(first.getTime()+20*60000);
 const third=new Date(second.getTime()+10*60000);
 const timedIds:string[]=[];
 before(async()=>{
  db=await openPressedLayoverDb();owner=await db.seedUser('capture-pipeline');
  await db.exec(`INSERT INTO public.trips(id,owner_id,title,start_date,end_date,destination_city,destination_country) VALUES('${tripId}','${owner.id}','Synthetic capture proof','${first.toISOString().slice(0,10)}','${third.toISOString().slice(0,10)}','Lisbon','Portugal')`);
  await db.setFlag('media_canonical_enabled',true);
  for(const flag of ['disable_media_uploads','media_moderation_classifier_enabled','media_vision_provider_enabled','media_transcoder_enabled','media_captions_enabled'])await db.setFlag(flag,false);
  // All database operations still use the real service-role SQL bridge.
  db.client.storage.from=()=>({upload:async(path:string,body:Buffer,options:{upsert?:boolean})=>{
   if(bytes.has(path)&&!options.upsert)return {data:null,error:{statusCode:'409',error:'Duplicate'}};
   bytes.set(path,Buffer.from(body));return {data:{path},error:null};
  }}) as ReturnType<typeof db.client.storage.from>;
  resetCanonicalSchemaMemo();resetHighlightSchemaMemo();_setTestClient(db.client,true);
  const app=express();app.use((req,_res,next)=>{req.log=logger;next();});
  app.use(express.json());app.use(postsRouter);app.use(candidatesRouter);app.use(memoriesRouter);app.use(adminMediaRouter);
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 });
 after(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));_setTestClient(null,false);resetCanonicalSchemaMemo();resetHighlightSchemaMemo();await db?.close();});
 async function post(path:string,body:unknown){const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
 async function upload(at:Date|null,operation:string|null=randomUUID()){
  const local=at?new Date(at.getTime()+2*3600000).toISOString().slice(0,19).replaceAll('-' ,':').replace('T',' '):null;
  const source=await sharp({create:{width:64,height:48,channels:3,background:'#3a5'}}).jpeg().withExif({IFD0:{ImageDescription:'synthetic private metadata'}}).toBuffer();
  let normalized=Buffer.alloc(0);
  const pick=await normalizeForUploadWith({uri:'synthetic.jpg',mimeType:'image/jpeg',fileName:'synthetic.jpg',width:64,height:48,fileSize:source.length,exif:local?{DateTimeOriginal:local,OffsetTimeOriginal:'+02:00',GPSLatitude:1,GPSLongitude:2}:null},{
   manipulate:async(_uri,actions,options)=>{let image=sharp(source);for(const action of actions)image=image.resize(action.resize);normalized=await image.toFormat(options.format,{quality:Math.round(options.compress*100)}).toBuffer();return {uri:'normalized.jpg',width:64,height:48};},
   fileSize:async()=>normalized.length,
  });
  assert.equal(pick.exif,null);assert.equal((await sharp(normalized).metadata()).exif,undefined);
  const response=await fetch(base+'/media/upload',{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'image/jpeg',...(operation?{'x-composer-operation':operation}:{}),...(pick.photoCapturedAt?{'x-photo-captured-at':pick.photoCapturedAt}:{})},body:normalized});
  const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));
  const result=z.object({path:z.string()}).parse(body);
  const rows=await db.query<{id:string;captured_at:string|null;version:number}>(`SELECT id,captured_at::text,version FROM public.media_assets WHERE owner_user_id='${owner.id}' AND storage_path='${result.path}'`);
  assert.equal(rows.length,1);assert.equal(rows[0].captured_at?new Date(rows[0].captured_at).toISOString():null,at?.toISOString()??null);
  assert.equal((await sharp(bytes.get(result.path)!).metadata()).exif,undefined);
  return {row:rows[0],operation,path:result.path};
 }
 it('retains offset-qualified times after EXIF stripping and reuses an upload receipt without rewriting its asset',async()=>{
  const firstUpload=await upload(first);timedIds.push(firstUpload.row.id);
  const retry=await upload(first,firstUpload.operation);assert.deepEqual(retry.row,firstUpload.row);
  for(const at of [second,third])timedIds.push((await upload(at)).row.id);
  await upload(null);
 });
 it('detects one cross-midnight candidate from those stored uploads, excludes undated media, and replays without duplicate evidence',async()=>{
  const initial=z.object({report:z.object({capturesRead:z.number(),candidates:z.array(z.object({episodeId:z.string().uuid()}))})}).parse(await post('/me/memory-candidates/detect',{tripId}));
  assert.equal(initial.report.capturesRead,3);assert.equal(initial.report.candidates.length,1,JSON.stringify(initial));
  episodeId=initial.report.candidates[0].episodeId;
  const episodes=await db.query<{id:string;state:string;visibility:string}>(`SELECT id,state,visibility FROM public.memory_episodes WHERE user_id='${owner.id}'`);
  assert.deepEqual(episodes,[{id:episodeId,state:'candidate',visibility:'private'}]);
  const evidence=await db.query<{source_id:string}>(`SELECT source_id FROM public.memory_evidence WHERE episode_id='${episodeId}' ORDER BY source_id`);
  assert.deepEqual(evidence.map(row=>row.source_id),[...timedIds].sort());
  await post('/me/memory-candidates/detect',{tripId});
  assert.deepEqual(await db.query(`SELECT source_id FROM public.memory_evidence WHERE episode_id='${episodeId}' ORDER BY source_id`),evidence);
  assert.equal((await db.query(`SELECT id FROM public.memories WHERE owner_id='${owner.id}'`)).length,0);
 });
 it('rejects the candidate without creating a Memory and does not resurrect it when later capture evidence arrives',async()=>{
  await post(`/me/memory-candidates/${episodeId}/reject`,{});
  await upload(new Date(third.getTime()+10*60000));
  await post('/me/memory-candidates/detect',{tripId});
  assert.deepEqual(await db.query(`SELECT id,state FROM public.memory_episodes WHERE user_id='${owner.id}'`),[{id:episodeId,state:'rejected'}]);
  assert.equal((await db.query(`SELECT id FROM public.memories WHERE owner_id='${owner.id}'`)).length,0);
  assert.equal((await db.query(`SELECT id FROM public.memory_evidence WHERE episode_id='${episodeId}'`)).length,3);
 });
 it('waits for canonical registration before returning an ordinary upload response',async()=>{
  let release!:()=>void,entered!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const from=db.client.from.bind(db.client);let held=false;
  const delayed=new Proxy(db.client,{get(target,key){
   if(key!=='from')return Reflect.get(target,key);
   return (table:string)=>{
    const query=from(table);if(table!=='media_assets')return query;
    return new Proxy(query,{get(builder,method){
     if(method!=='upsert')return Reflect.get(builder,method);
     return (...args:unknown[])=>{
      const write=(builder.upsert as (...values:unknown[])=>unknown)(...args);
      const wrap=(value:object):object=>new Proxy(value,{get(chain,op){
       if(op==='then')return async(resolve:(v:unknown)=>unknown,reject:(e:unknown)=>unknown)=>{
        if(!held){held=true;entered();await hold;}
        return Promise.resolve(chain).then(resolve,reject);
       };
       const value=Reflect.get(chain,op);return typeof value==='function'?((...args:unknown[])=>wrap(value.apply(chain,args))):value;
      }});return wrap(write as object);
     };
    }});
   };
  }});
  _setTestClient(delayed,true);let completed=false;
  const pending=upload(null,null).then(result=>{completed=true;return result;});
  try{
   await Promise.race([started,pending.then(()=>{throw new Error('Response preceded canonical insertion');})]);
   await new Promise(resolve=>setTimeout(resolve,40));assert.equal(completed,false,'HTTP response waits while registration is held');
   release();const result=await pending;assert.ok(result.row.id);
  }finally{release();await pending.catch(()=>{});_setTestClient(db.client,true);}
 });
 for(const kernel of [false,true]) it(`mounted Memory item and from-post routes use canonical binding with kernel ${kernel}`,async()=>{
  await db.setFlag('memory_kernel_enabled',kernel);await db.setFlag('memory_from_own_media_enabled',true);
  const capture=await upload(null,null),memory=randomUUID(),postId=randomUUID(),url=`post-media/${capture.path}`;
  await db.exec(`INSERT INTO memories(id,owner_id,title,state,visibility) VALUES('${memory}','${owner.id}','Direct upload Memory','published','only_me');
   INSERT INTO posts(id,author_id,content,status,visibility,media_urls) VALUES('${postId}','${owner.id}','Own source','active','private',ARRAY[${lit(url)}])`);
  for(const fromPost of [false,true]){
   const path=`/memories/${memory}/items${fromPost?'/from-post':''}`,key=randomUUID();
   const body=fromPost?{postId,caption:'From my post'}:{mediaUrl:url,mediaType:'image/jpeg',caption:'Own upload'};
   const request=()=>fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
   const response=await request(),item=await response.json();assert.equal(response.status,201,JSON.stringify(item));
   const replay=await request();assert.equal(replay.status,201,JSON.stringify(await replay.json()));
  }
  const items=await db.query<{media_asset_id:string;source_post_id:string|null}>(`SELECT media_asset_id,source_post_id FROM memory_items WHERE memory_id='${memory}' ORDER BY source_post_id NULLS FIRST`);
  assert.deepEqual(items,[{media_asset_id:capture.row.id,source_post_id:null},{media_asset_id:capture.row.id,source_post_id:postId}]);
 });
 for(const kernel of [false,true]) it(`mounted candidate confirmation binds each uploaded capture once with kernel ${kernel}`,async()=>{
  await db.setFlag('memory_kernel_enabled',kernel);
  const capture=await upload(first,null),id=randomUUID();
  await db.exec(`INSERT INTO memory_episodes(id,user_id,episode_kind,summary,started_at,ended_at,detection_reason,detector_version,detection_digest,significance,significance_basis,state,visibility)
   VALUES('${id}','${owner.id}','activity','Binding suggestion',now()-interval '2 days',now()-interval '2 days'+interval '1 hour','media_cluster',1,'${id}',0.8,'user_affirmed','candidate','private');
   INSERT INTO memory_evidence(episode_id,user_id,truth_level,source_class,source_table,source_id,source_ref,observed_at,weight)
   VALUES('${id}','${owner.id}','observed','system','media_assets','${capture.row.id}','{}',now(),1)`);
  const receipt=z.object({memoryId:z.string().uuid()});
  const firstKeep=receipt.parse(await post(`/me/memory-candidates/${id}/confirm`,{})),again=receipt.parse(await post(`/me/memory-candidates/${id}/confirm`,{}));
  assert.equal(again.memoryId,firstKeep.memoryId);
  assert.deepEqual(await db.query(`SELECT media_asset_id FROM memory_items WHERE memory_id=${lit(firstKeep.memoryId)}`),[{media_asset_id:capture.row.id}]);
 });

 for(const kernel of [false,true]) it(`current from-post writer preserves selection video type uniqueness and outcome signal with kernel ${kernel}`,async()=>{
  await db.setFlag('memory_kernel_enabled',kernel);await db.setFlag('memory_from_own_media_enabled',true);await db.setFlag('MEDIA_ANALYTICS_ENABLED',true);
  const a=await upload(null,null),b=await upload(null,null),memory=randomUUID(),photoPost=randomUUID(),videoPost=randomUUID();
  const videoPath=`${owner.id}/${randomUUID()}.mp4`,videoUrl=`post-media/${videoPath}`;
  const video=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:videoPath,publicUrl:videoUrl,
   mediaType:'video',mimeType:'video/mp4',sourceType:'user',sizeBytes:1024,width:64,height:48,durationMs:1000,preserveExisting:true});assert.ok(video.assetId);
  await db.exec(`INSERT INTO memories(id,owner_id,title,state,visibility) VALUES('${memory}','${owner.id}','Types and selection','published','only_me');
   INSERT INTO posts(id,author_id,content,status,visibility,media_urls,media_type) VALUES
    ('${photoPost}','${owner.id}','Own photos','active','private',ARRAY['post-media/${a.path}','post-media/${b.path}'],'image'),
    ('${videoPost}','${owner.id}','Own video','active','private',ARRAY[${lit(videoUrl)}],'video')`);
  const request=(postId:string,mediaIndex=0)=>fetch(`${base}/memories/${memory}/items/from-post`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({postId,mediaIndex,caption:'Kept caption'})});
  const photo=await request(photoPost,1),photoBody=await photo.json();assert.equal(photo.status,201,JSON.stringify(photoBody));
  const clip=await request(videoPost),clipBody=await clip.json();assert.equal(clip.status,201,JSON.stringify(clipBody));
  const repeated=await request(photoPost,1);assert.equal(repeated.status,409,JSON.stringify(await repeated.json()));
  assert.deepEqual(await db.query(`SELECT media_url,media_type,caption,source_post_id,media_asset_id FROM memory_items WHERE memory_id='${memory}' ORDER BY media_type`),[
   {media_url:`post-media/${b.path}`,media_type:'image/jpeg',caption:'Kept caption',source_post_id:photoPost,media_asset_id:b.row.id},
   {media_url:videoUrl,media_type:'video/mp4',caption:'Kept caption',source_post_id:videoPost,media_asset_id:video.assetId}]);
  let events:Record<string,unknown>[]=[];
  for(let attempt=0;attempt<50;attempt++){
   events=await db.query(`SELECT payload FROM media_events WHERE event_type='memory_create' AND payload->>'post_id' IN ('${photoPost}','${videoPost}') ORDER BY payload->>'post_id'`);
   if(events.length===2)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  const payloads=events.map(row=>row.payload);assert.deepEqual(payloads,[photoPost,videoPost].sort().map(postId=>({viewer_id:owner.id,media_id:postId,post_id:postId,surface:'memory'})));
 });
 for(const kernel of [false,true]) it(`current from-post writer rolls back the entire insert if source provenance changes with kernel ${kernel}`,async()=>{
  await db.setFlag('memory_kernel_enabled',kernel);await db.setFlag('memory_from_own_media_enabled',true);await db.setFlag('MEDIA_ANALYTICS_ENABLED',true);
  const capture=await upload(null,null),memory=randomUUID(),postId=randomUUID();
  await db.exec(`INSERT INTO memories(id,owner_id,title,state,visibility) VALUES('${memory}','${owner.id}','Atomic provenance','published','only_me');
   INSERT INTO posts(id,author_id,content,status,visibility,media_urls) VALUES('${postId}','${owner.id}','Source before race','active','private',ARRAY['post-media/${capture.path}']);
   CREATE FUNCTION test_memory_source_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE posts SET media_urls='{}' WHERE id=NEW.source_post_id; RETURN NEW; END $$;
   CREATE TRIGGER aa_test_memory_source_change BEFORE INSERT ON memory_items FOR EACH ROW WHEN(NEW.memory_id='${memory}') EXECUTE FUNCTION test_memory_source_change()`);
  try{
   const response=await fetch(`${base}/memories/${memory}/items/from-post`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({postId})});
   assert.equal(response.status,503,JSON.stringify(await response.json()));
   for(const table of ['memory_items','memory_command_receipts','memory_domain_events'])assert.deepEqual(await db.query(`SELECT * FROM ${table} WHERE memory_id='${memory}'`),[]);
   assert.deepEqual(await db.query(`SELECT media_urls FROM posts WHERE id='${postId}'`),[{media_urls:[`post-media/${capture.path}`]}]);
   assert.deepEqual(await db.query(`SELECT id FROM media_events WHERE event_type='memory_create' AND payload->>'post_id'='${postId}'`),[]);
  }finally{await db.exec('DROP TRIGGER aa_test_memory_source_change ON memory_items; DROP FUNCTION test_memory_source_change()');}
 });

 it('candidate confirmation refuses before claiming an episode when its item writer protection is disabled',async()=>{
  const id=randomUUID();await db.exec(`INSERT INTO memory_episodes(id,user_id,episode_kind,summary,started_at,ended_at,detection_reason,detector_version,detection_digest,significance,significance_basis,state,visibility)
   VALUES('${id}','${owner.id}','activity','Unavailable writer',now()-interval '2 days',now()-interval '2 days'+interval '1 hour','media_cluster',1,'${id}',0.8,'user_affirmed','candidate','private')`);
  await db.exec('ALTER TABLE memory_items DISABLE TRIGGER memory_items_media_binding_guard');
  try{
   for(const kernel of [false,true]){
    await db.setFlag('memory_kernel_enabled',kernel);
    const response=await fetch(`${base}/me/memory-candidates/${id}/confirm`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,503,JSON.stringify(await response.json()));
    assert.deepEqual(await db.query(`SELECT state FROM memory_episodes WHERE id='${id}'`),[{state:'candidate'}]);
    assert.deepEqual(await db.query(`SELECT id FROM memory_evidence WHERE episode_id='${id}'`),[]);
   }
  }finally{await db.exec('ALTER TABLE memory_items ENABLE TRIGGER memory_items_media_binding_guard');}
 });

 async function bindingReviewFixture(urls:(path:string)=>string[]) {
  const asset=await upload(null),admin=await db.seedUser('binding-review-admin'),memory=randomUUID();
  await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin.id}'; INSERT INTO memories(id,owner_id,title,visibility,state) VALUES('${memory}','${owner.id}','Historical references','only_me','published')`);
  const items=[] as string[];
  for(const url of urls(asset.path)) {const id=randomUUID();items.push(id);await db.exec(`INSERT INTO memory_items(id,memory_id,media_url,media_type) VALUES('${id}','${memory}',${lit(url)},'image/jpeg')`);}
  const request=(path:string,body?:unknown,token=admin.token)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {asset,admin,memory,items,request};
 }
 const reviewPage=z.object({items:z.array(z.object({itemId:z.string(),memoryId:z.string(),reviewedUrlHash:z.string(),status:z.string(),assetId:z.string().nullable()})),nextCursor:z.string().nullable()});
 it('admin reference review pages existing links, binds once and never returns signed URL tokens',async()=>{
  const origin=new URL(process.env.SUPABASE_URL!).origin;
  const r=await bindingReviewFixture(path=>[`post-media/${path}`,`${origin}/storage/v1/object/public/post-media/${path}`,`${origin}/storage/v1/object/sign/post-media/${encodeURIComponent(path)}?token=private-test-token`,`${origin}/storage/v1/render/image/public/post-media/${encodeURIComponent(path)}?width=200`]);
  let cursor:string|null=null;const seen:string[]=[];
  do {
   const response=await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}&limit=1${cursor?`&after=${cursor}`:''}`);
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const raw=await response.text();assert.ok(!raw.includes('private-test-token'));assert.ok(!raw.includes('media_url'));
   const page=reviewPage.parse(JSON.parse(raw));assert.equal(page.items.length,1);const item=page.items[0]!;
   assert.equal(item.status,'candidate');assert.equal(item.assetId,r.asset.row.id);seen.push(item.itemId);cursor=page.nextCursor;
   const before=(await db.query(`SELECT * FROM memory_items WHERE id='${item.itemId}'`))[0];
   const body={assetId:item.assetId,reviewedUrlHash:item.reviewedUrlHash,reason:'Reviewed historical source'};
   for(let n=0;n<2;n++) {const bound=await r.request(`/admin/media/memory-bindings/${item.itemId}/reconcile`,body);assert.equal(bound.status,200,await bound.text());}
   assert.deepEqual((await db.query(`SELECT * FROM memory_items WHERE id='${item.itemId}'`))[0],{...before,media_asset_id:r.asset.row.id});
   assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${item.itemId}'`)).length,1);
  }while(cursor);
  assert.deepEqual(seen,[...r.items].sort());
  const final=reviewPage.parse(await (await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`)).json());assert.deepEqual(final,{items:[],nextCursor:null});
  assert.equal((await db.query(`SELECT visibility FROM memories WHERE id='${r.memory}'`))[0].visibility,'only_me');
 });
 it('admin inventory distinguishes unresolved references and denies ordinary users',async()=>{
  const r=await bindingReviewFixture(path=>[`post-media/${owner.id}/absent.jpg`,`https://foreign.invalid/storage/v1/object/public/post-media/${path}`,'https://external.invalid/photo.jpg','data:image/png;base64,abc']);
  const response=await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`);assert.equal(response.status,200);
  const page=reviewPage.parse(await response.json());assert.deepEqual(page.items.map(x=>x.status).sort(),['external_reference','missing_source','unsupported_reference','unsupported_reference'].sort());assert.ok(page.items.every(x=>x.assetId===null));
  assert.equal((await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`,undefined,owner.token)).status,403);
  assert.equal((await r.request(`/admin/media/memory-bindings/${r.items[0]}/reconcile`,{assetId:r.asset.row.id,reviewedUrlHash:'a'.repeat(64),reason:'Not admin'},owner.token)).status,403);
  for(const query of ['limit=51','after=not-a-uuid','unknown=yes'])assert.equal((await r.request(`/admin/media/memory-bindings?${query}`)).status,400);
  assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'memory_id'='${r.memory}'`)).length,0);
 });
 it('admin reconciliation rejects changes after review and after the service source read',async()=>{
  for(const afterRead of [false,true]){
   const r=await bindingReviewFixture(path=>[`post-media/${path}`]);
   const page=reviewPage.parse(await (await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`)).json()),item=page.items[0]!;
   const replace=()=>db.exec(`UPDATE memory_items SET media_url='https://external.invalid/replaced.jpg' WHERE id='${item.itemId}'`);
   const original=db.client.rpc.bind(db.client);
   if(afterRead)db.client.rpc=(async(name:string,args?:Record<string,unknown>)=>{if(name==='reconcile_memory_media_binding')await replace();return original(name,args);}) as typeof db.client.rpc;
   else await replace();
   try {const response=await r.request(`/admin/media/memory-bindings/${item.itemId}/reconcile`,{assetId:item.assetId,reviewedUrlHash:item.reviewedUrlHash,reason:'Review now stale'});assert.equal(response.status,409,await response.text());}
   finally {db.client.rpc=original;}
   assert.equal((await db.query(`SELECT media_asset_id FROM memory_items WHERE id='${item.itemId}'`))[0].media_asset_id,null);
   assert.equal((await db.query(`SELECT id FROM moderation_actions WHERE action_type='memory_media_source_bound' AND metadata->>'item_id'='${item.itemId}'`)).length,0);
  }
 });
 it('admin inventory reports schema failure as unavailable rather than an empty review',async()=>{
  const r=await bindingReviewFixture(path=>[`post-media/${path}`]);
  await db.exec('ALTER TABLE memory_items RENAME COLUMN media_asset_id TO test_missing_media_asset_id');
  try {assert.equal((await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`)).status,503);}
  finally {await db.exec('ALTER TABLE memory_items RENAME COLUMN test_missing_media_asset_id TO media_asset_id');}
  assert.equal((await r.request(`/admin/media/memory-bindings?memoryId=${r.memory}`)).status,200);
 });

});
