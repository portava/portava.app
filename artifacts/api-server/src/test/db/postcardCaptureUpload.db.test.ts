import { installMediaDeliveryFixture } from "../helpers/mediaDeliveryFixture.js";
/** Mounted postcard completion -> real canonical PostgreSQL -> Memory detection. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';
import { _setTestClient } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import postcardsRouter from '../../routes/postcards.js';
import postcardMediaTransportRouter from '../../routes/postcardMediaTransport.js';
import adminMediaRouter from '../../routes/adminMedia.js';
import mediaFileRouter from '../../routes/mediaFile.js';
import candidatesRouter from '../../routes/memoryCandidates.js';
import { recordMediaAssetDetailed } from '../../lib/mediaAssets.js';
import { activateMediaRestoration, copyMediaRestorationDependency, verifyMediaRestorationDependencies, copyMediaRestorationOriginal, copyRetainedMediaOriginal, prepareRetainedMediaOriginal,
  prepareRetainedMediaRestoration, purgeWithdrawnAccountMedia, removeCopiedMediaOriginal } from '../../services/media/MediaLifecycleService.js';
import { sweepAbandonedPendingUploads, renewPendingSlot, PENDING_UPLOAD_ORPHAN_CUTOFF_MS } from '../../services/media/PendingUploadSweep.js';
import { resetCanonicalSchemaMemo } from '../../lib/media/mediaSchemaCapability.js';
import { resetSchemaCapabilityMemo } from '../../lib/capability/schemaCapability.js';
import { resetHighlightSchemaMemo } from '../../services/highlights/highlightSchemaAvailability.js';

const signedPaths:string[]=[];
const signedDownloads:string[]=[];

describe('postcard captures survive completion and recovery', {skip:PRESSED_SKIP_REASON},()=>{
  let db:Awaited<ReturnType<typeof openPressedLayoverDb>>,server:Server,base:string,owner:{id:string;token:string};
  let restoreDelivery:(()=>void)|undefined;const previousStorageUrl=process.env.SUPABASE_URL;
  const bytes=new Map<string,Buffer>();let holdAfterStore:string|null=null;let failAfterStore:string|null=null,cancelAfterStore:{post:string;path:string}|null=null,storageWrites=0;
  const trip=randomUUID(),at=new Date();at.setUTCHours(0,0,0,0);at.setUTCDate(at.getUTCDate()-2);
  const timedIds:string[]=[];
  before(async()=>{
    db=await openPressedLayoverDb();owner=await db.seedUser('postcard-capture');
    await db.exec(`INSERT INTO trips(id,owner_id,title,start_date,end_date,destination_city,destination_country) VALUES('${trip}','${owner.id}','Synthetic postcard proof','${at.toISOString().slice(0,10)}','${at.toISOString().slice(0,10)}','Lisbon','Portugal')`);
    await db.setFlag('media_canonical_enabled',true);await db.setFlag('media_canonical_schema_fallback_enabled',false);
    for(const flag of ['disable_media_uploads','disable_posting','media_moderation_classifier_enabled','media_vision_provider_enabled','media_transcoder_enabled','media_captions_enabled'])await db.setFlag(flag,false);
    db.client.storage.from=()=>({
      createSignedUrl:async(path:string)=>{signedDownloads.push(path);return {data:{signedUrl:`https://synthetic.invalid/download/${encodeURIComponent(path)}`},error:null};},
      createSignedUploadUrl:async(path:string)=>{signedPaths.push(path);return {data:{signedUrl:`https://synthetic.invalid/upload/${encodeURIComponent(path)}`},error:null};},
      download:async(path:string)=>({data:bytes.has(path)?new Blob([new Uint8Array(bytes.get(path)!)]):null,error:bytes.has(path)?null:{message:'missing synthetic object'}}),
      upload:async(path:string,body:Buffer)=>{
        bytes.set(path,Buffer.from(body));storageWrites++;
        if(holdAfterStore===path){holdAfterStore=null;await db.exec(`UPDATE post_media SET moderation_status='flagged' WHERE storage_path='${path}'`);}
        if(cancelAfterStore?.path===path){const post=cancelAfterStore.post;cancelAfterStore=null;await db.exec(`SELECT public.cancel_postcard_draft('${owner.id}','${post}')`);}
        if(failAfterStore===path){failAfterStore=null;return {data:null,error:{message:'synthetic lost upload acknowledgement'}};}
        return {data:{path},error:null};
      },
      list:async(folder:string)=>({data:[...bytes.entries()].filter(([path])=>path.startsWith(folder+'/')).map(([path,body])=>({name:path.slice(folder.length+1),metadata:{size:body.length},created_at:new Date().toISOString()})),error:null}),
      remove:async(paths:string[])=>{paths.forEach(path=>bytes.delete(path));return {data:[],error:null};},
    }) as ReturnType<typeof db.client.storage.from>;
    process.env.SUPABASE_URL='https://synthetic-postcard-storage.example.test';
    restoreDelivery=installMediaDeliveryFixture(read=>signedDownloads.push(read.path),(read,method)=>{
      const body=bytes.get(read.path);
      return body ? new Response(method==='HEAD'?null:new Uint8Array(body),{headers:{'Content-Type':'image/jpeg','Content-Length':String(body.length)}}) : new Response(null,{status:404});
    });
    resetCanonicalSchemaMemo();resetHighlightSchemaMemo();_setTestClient(db.client,true);
    const app=express();app.use((req,_res,next)=>{req.log=logger;next();});app.use(express.json());app.use(postcardsRouter);app.use(postcardMediaTransportRouter);app.use(candidatesRouter);app.use(adminMediaRouter);app.use(mediaFileRouter);
    server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  after(async()=>{restoreDelivery?.();if(previousStorageUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=previousStorageUrl;if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));_setTestClient(null,false);resetCanonicalSchemaMemo();resetHighlightSchemaMemo();await db?.close();});
  async function source(exif=false){
    const post=randomUUID(),media=randomUUID(),path=`${owner.id}/${post}/${media}.jpg`;
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status,post_status,postcard_draft_state,postcard_requested_visibility) VALUES('${post}','${owner.id}','synthetic','private','active','draft','draft','public');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status) VALUES('${media}','${post}','${owner.id}','post-media','${path}','image','image/jpeg','pending')`);
    let image=sharp({create:{width:64,height:48,channels:3,background:'#357'}}).jpeg();
    if(exif)image=image.withExif({IFD0:{ImageDescription:'private synthetic metadata'},IFD2:{DateTimeOriginal:'2026:03:04 05:06:07',OffsetTimeOriginal:'+02:00'}});
    bytes.set(path,await image.toBuffer());return {post,media,path};
  }
  type Source={post:string;media:string;path:string};
  const assets=(s:Source)=>db.query(`SELECT * FROM media_assets WHERE storage_path='${s.path}'`);
  async function complete(s:Source,time?:string){
    const response=await fetch(`${base}/postcards/${s.post}/media/${s.media}/complete`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({mimeType:'image/png',fileSizeBytes:999,width:1,height:1,...(time?{photoCapturedAt:time}:{})})});
    return {status:response.status,body:await response.json()};
  }
  it('reserves the immutable source path through the mounted upload route before signing, then completes that same slot',async()=>{
    const post=randomUUID();
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status,post_status,postcard_draft_state,postcard_requested_visibility) VALUES('${post}','${owner.id}','reservation proof','private','active','draft','draft','public')`);
    const response=await fetch(`${base}/postcards/${post}/media/upload-url`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',fileSizeBytes:1024})});
    const body=await response.json() as {mediaId:string;path:string;uploadUrl:string};
    assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.path,`${owner.id}/${post}/${body.mediaId}.jpg`);
    assert.equal(body.uploadUrl,`https://synthetic.invalid/upload/${encodeURIComponent(body.path)}`);
    const rows=await db.query(`SELECT id,storage_path,processing_status FROM post_media WHERE post_id='${post}'`);
    assert.deepEqual(rows,[{id:body.mediaId,storage_path:body.path,processing_status:'pending'}]);
    await assert.rejects(db.exec(`UPDATE post_media SET storage_path='${owner.id}/replacement.jpg' WHERE id='${body.mediaId}'`),/postcard_retention_identity_immutable/);
    bytes.set(body.path,await sharp({create:{width:64,height:48,channels:3,background:'#357'}}).jpeg().toBuffer());
    const s={post,media:body.mediaId,path:body.path};assert.equal((await complete(s)).status,200);
    assert.equal((await assets(s)).length,1);assert.equal((await assets(s))[0].processing_status,'ready');
  });

  it('inactive accounts cannot mint upload authority or write posters; active recovery restores upload access',async()=>{
    const s=await source();await db.exec(`UPDATE post_media SET media_type='video',mime_type='video/mp4' WHERE id='${s.media}'`);
    const poster=await sharp({create:{width:48,height:32,channels:3,background:'#759'}}).jpeg().toBuffer();
    const upload=()=>fetch(`${base}/postcards/${s.post}/media/upload-url`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',fileSizeBytes:1024})});
    const postPoster=()=>fetch(`${base}/postcards/${s.post}/media/${s.media}/poster`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'image/jpeg'},body:new Uint8Array(poster)});
    const before=await db.query(`SELECT id FROM post_media WHERE post_id='${s.post}' ORDER BY id`);
    const issued=signedPaths.length,writes=storageWrites;
    await db.exec(`SELECT public.set_account_self_deactivation('${owner.id}')`);
    try {
      const signing=await upload(),posting=await postPoster(),completion=await complete(s);
      assert.deepEqual([signing.status,posting.status,completion.status],[403,403,403]);
      assert.equal(signedPaths.length,issued);assert.equal(storageWrites,writes);
      assert.deepEqual(await db.query(`SELECT id FROM post_media WHERE post_id='${s.post}' ORDER BY id`),before);
    } finally {await db.exec(`SELECT public.reactivate_self_deactivated_account('${owner.id}')`);}
    assert.equal((await upload()).status,200);assert.equal((await postPoster()).status,201);
  });

  it('does not issue signed authority when the actual source insert returns no reservation',async()=>{
    const post=randomUUID(),issued=signedPaths.length;
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status,post_status,postcard_draft_state) VALUES('${post}','${owner.id}','rejected reservation','private','active','draft','draft');
      CREATE FUNCTION test_reservation_no_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER test_reservation_no_receipt BEFORE INSERT ON post_media FOR EACH ROW WHEN (NEW.post_id='${post}') EXECUTE FUNCTION test_reservation_no_receipt()`);
    try {
      const response=await fetch(`${base}/postcards/${post}/media/upload-url`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',fileSizeBytes:1024})});
      assert.equal(response.status,500);assert.equal(signedPaths.length,issued);
      assert.deepEqual(await db.query(`SELECT id FROM post_media WHERE post_id='${post}'`),[]);
    } finally {await db.exec('DROP TRIGGER test_reservation_no_receipt ON post_media; DROP FUNCTION test_reservation_no_receipt()');}
  });

  it('persists normalized capture time with measured metadata and preserves a completed retry without more bytes or versions',async()=>{
    for(let n=0;n<3;n++){
      const s=await source(),time=new Date(at.getTime()+n*10*60000).toISOString();const done=await complete(s,time);assert.equal(done.status,200,JSON.stringify(done));
      const rows=await assets(s);assert.equal(rows.length,1);assert.equal(new Date(String(rows[0].captured_at)).toISOString(),time);assert.equal(rows[0].width,64);assert.equal(rows[0].height,48);assert.equal(rows[0].mime_type,'image/jpeg');assert.equal(Number(rows[0].size_bytes),bytes.get(s.path)!.length);assert.equal(rows[0].processing_status,'ready');assert.equal(rows[0].moderation_status,'active');
      timedIds.push(String(rows[0].id));const writes=storageWrites;assert.equal((await complete(s,'2025-01-01T00:00:00.000Z')).status,200);
      assert.deepEqual(await assets(s),rows);assert.equal(storageWrites,writes);
    }
  });
  it('raw EXIF capture survives a lost storage acknowledgement and a retry after the stored EXIF has been stripped',async()=>{
    const s=await source(true);failAfterStore=s.path;const first=await complete(s);assert.equal(first.status,503,JSON.stringify(first));
    const staged=await assets(s);assert.equal(staged.length,1);assert.equal(staged[0].processing_status,'uploaded');assert.equal(staged[0].moderation_status,'limited');assert.equal(new Date(String(staged[0].captured_at)).toISOString(),'2026-03-04T03:06:07.000Z');assert.equal((await sharp(bytes.get(s.path)!).metadata()).exif,undefined);
    const retry=await complete(s);assert.equal(retry.status,200,JSON.stringify(retry));const final=await assets(s);assert.equal(final[0].id,staged[0].id);assert.equal(final[0].captured_at,staged[0].captured_at);assert.deepEqual(final[0].provenance,staged[0].provenance);assert.equal(final[0].processing_status,'ready');
  });
  it('a ready-source retry finishes a failed canonical transition without rewriting Storage or capture metadata',async()=>{
    const s=await source(),time=new Date(at.getTime()-7*86400000).toISOString();
    await db.exec(`UPDATE posts SET content='',postcard_publish_on_complete=true,add_to_passport=true WHERE id='${s.post}'`);
    await db.exec(`CREATE FUNCTION public.test_refuse_postcard_ready() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic canonical completion failure'; END $$;
      CREATE TRIGGER test_refuse_postcard_ready BEFORE UPDATE ON media_assets FOR EACH ROW WHEN (NEW.processing_status='ready') EXECUTE FUNCTION public.test_refuse_postcard_ready()`);
    try{assert.equal((await complete(s,time)).status,500);}
    finally{await db.exec('DROP TRIGGER test_refuse_postcard_ready ON media_assets; DROP FUNCTION public.test_refuse_postcard_ready()');}
    const staged=await assets(s);assert.equal(staged[0].processing_status,'uploaded');assert.equal((await db.query(`SELECT processing_status FROM post_media WHERE id='${s.media}'`))[0].processing_status,'ready');
    const writes=storageWrites;const retry=await complete(s);assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(storageWrites,writes);
    const final=await assets(s);assert.equal(final[0].id,staged[0].id);assert.equal(final[0].captured_at,staged[0].captured_at);assert.equal(final[0].processing_status,'ready');
    const projection=await db.query<{id:string;media_url:string}>(`SELECT id,media_url FROM passport_postcards WHERE post_id='${s.post}'`);assert.equal(projection.length,1);assert.equal(projection[0].media_url,`post-media/${s.path}`);
    let attachments:unknown[]=[];
    for(let n=0;n<100;n++){attachments=await db.query(`SELECT media_asset_id FROM media_attachments WHERE entity_type='postcard' AND entity_id='${projection[0].id}'`);if(attachments.length)break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.deepEqual(attachments,[{media_asset_id:final[0].id}]);
    assert.equal((await complete(s)).status,200);assert.deepEqual(await assets(s),final);
    assert.deepEqual(await db.query(`SELECT id,media_url FROM passport_postcards WHERE post_id='${s.post}'`),projection);
  });
  it('completion preserves a newer canonical moderation hold instead of approving over it',async()=>{
    const s=await source();failAfterStore=s.path;assert.equal((await complete(s,at.toISOString())).status,503);
    await db.exec(`UPDATE media_assets SET moderation_status='limited' WHERE storage_path='${s.path}'`);
    const held=await assets(s);assert.ok(Number(held[0].version)>1);
    assert.equal((await complete(s)).status,200);const final=await assets(s);assert.equal(final[0].moderation_status,'limited');assert.equal(final[0].captured_at,held[0].captured_at);
  });
  it('a source moderation race returns conflict and its retry preserves the hold in both representations',async()=>{
    const s=await source();holdAfterStore=s.path;const first=await complete(s,at.toISOString());assert.equal(first.status,409,JSON.stringify(first));
    assert.equal((await assets(s))[0].processing_status,'uploaded');
    const retry=await complete(s);assert.equal(retry.status,200,JSON.stringify(retry));assert.equal((await assets(s))[0].moderation_status,'limited');
    assert.deepEqual(await db.query(`SELECT processing_status,moderation_status FROM post_media WHERE id='${s.media}'`),[{processing_status:'ready',moderation_status:'flagged'}]);
  });
  it('a legacy minimal processing receipt is measured and completed, preserving its existing identity and unknown capture',async()=>{
    const s=await source();await db.exec(`UPDATE post_media SET processing_status='ready',moderation_status='approved' WHERE id='${s.media}'`);
    const old=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:s.path,publicUrl:`post-media/${s.path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:0,sourceType:'user',processingStatus:'processing'});assert.ok(old.assetId);
    const result=await complete(s);assert.equal(result.status,200,JSON.stringify(result));const rows=await assets(s);assert.equal(rows[0].id,old.assetId);assert.equal(rows[0].processing_status,'ready');assert.equal(rows[0].width,64);assert.equal(rows[0].height,48);assert.equal(Number(rows[0].size_bytes),bytes.get(s.path)!.length);assert.equal(rows[0].captured_at,null);
  });
  it('missing or disabled source protection refuses completion before canonical or Storage writes',async()=>{
    const s=await source(),before=storageWrites,raw=Buffer.from(bytes.get(s.path)!);
    await db.exec('ALTER TABLE media_assets DISABLE TRIGGER postcard_canonical_asset_guard');
    try{const result=await complete(s,at.toISOString());assert.equal(result.status,503,JSON.stringify(result));assert.deepEqual(await assets(s),[]);assert.equal(storageWrites,before);assert.deepEqual(bytes.get(s.path),raw);}
    finally{await db.exec('ALTER TABLE media_assets ENABLE TRIGGER postcard_canonical_asset_guard');}
    const original=(await db.query<{definition:string}>("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='public.media_assets'::regclass AND tgname='postcard_canonical_asset_guard'"))[0].definition;
    await db.exec('DROP TRIGGER postcard_canonical_asset_guard ON public.media_assets; CREATE TRIGGER postcard_canonical_asset_guard BEFORE UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.guard_postcard_canonical_asset()');
    try{assert.equal((await complete(s,at.toISOString())).status,503);assert.deepEqual(await assets(s),[]);assert.equal(storageWrites,before);}
    finally{await db.exec('DROP TRIGGER postcard_canonical_asset_guard ON public.media_assets; '+original);}
    await db.exec('ALTER FUNCTION public.postcard_canonical_lifecycle_ready() RENAME TO test_saved_postcard_readiness');
    try{const result=await complete(s,at.toISOString());assert.equal(result.status,503);assert.deepEqual(await assets(s),[]);assert.equal(storageWrites,before);}
    finally{await db.exec('ALTER FUNCTION public.test_saved_postcard_readiness() RENAME TO postcard_canonical_lifecycle_ready');}
  });
  it('cancellation between normalized Storage and completion retires the staged asset and refuses retry',async()=>{
    const s=await source();cancelAfterStore={post:s.post,path:s.path};const result=await complete(s,at.toISOString());assert.notEqual(result.status,200);
    const rows=await assets(s);assert.equal(rows.length,1);assert.equal(rows[0].moderation_status,'owner_deleted');assert.equal(rows[0].processing_status,'removed');assert.equal(rows[0].purge_status,'retained');
    assert.notEqual((await complete(s,at.toISOString())).status,200);assert.deepEqual(await assets(s),rows);
    assert.equal((await db.query(`SELECT postcard_draft_state FROM posts WHERE id='${s.post}'`))[0].postcard_draft_state,'cancelled');
  });
  it('completed deletion retains canonical bytes and source metadata beyond upload expiry',async()=>{
    const s=await source();assert.equal((await complete(s)).status,200);const original=Buffer.from(bytes.get(s.path)!);
    const response=await fetch(`${base}/postcards/${s.post}/media/${s.media}`,{method:'DELETE',headers:{authorization:`Bearer ${owner.token}`}});
    assert.equal(response.status,200,await response.text());assert.deepEqual(bytes.get(s.path),original);
    const slot=await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`);assert.equal(slot.length,1);assert.ok(slot[0].deleted_at);assert.equal(slot[0].public_url,'');assert.equal(slot[0].processing_status,'pending');
    assert.equal((slot[0].recovery_snapshot as any).processing_status,'ready');
    const retry=await fetch(`${base}/postcards/${s.post}/media/${s.media}`,{method:'DELETE',headers:{authorization:`Bearer ${owner.token}`}});assert.equal(retry.status,200);
    assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),slot,'retry preserves original recovery metadata');
    assert.equal((await renewPendingSlot(db.client,s.media)).ok,false);assert.equal((await complete(s)).status,404);
    await assert.rejects(db.exec(`UPDATE post_media SET deleted_at=NULL,processing_status='ready' WHERE id='${s.media}'`),/postcard_upload_withdrawn/);
    const retired=(await assets(s))[0];assert.equal(retired.purge_status,'retained');
    await assert.rejects(purgeWithdrawnAccountMedia(db.client,String(retired.id),owner.id,{expectedVersion:Number(retired.version),env:{}}),/Media purge source changed/);
    const swept=await sweepAbandonedPendingUploads(db.client,{nowMs:Date.now()+366*86400000});
    assert.equal(swept.ok,true,JSON.stringify(swept));assert.deepEqual(bytes.get(s.path),original);
    assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),slot);
    const staleSweep=await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_before:new Date(Date.now()+366*86400000).toISOString()});
    assert.equal(staleSweep.error,null);assert.equal(staleSweep.data,false,'an old worker cannot claim a retained completed slot');
  });
  it('never-completed deletion still sweeps late signed uploads through its original source',async()=>{
    const s=await source();
    const response=await fetch(`${base}/postcards/${s.post}/media/${s.media}`,{method:'DELETE',headers:{authorization:`Bearer ${owner.token}`}});
    assert.equal(response.status,200);assert.equal(bytes.has(s.path),true);
    const late=Buffer.from('late private upload');bytes.set(s.path,late);bytes.set(`${s.path}.parts/00000`,late);bytes.set(`${s.path}.poster.jpg`,late);
    const swept=await sweepAbandonedPendingUploads(db.client,{nowMs:Date.now()+PENDING_UPLOAD_ORPHAN_CUTOFF_MS+1000});
    assert.equal(swept.ok,true,JSON.stringify(swept));assert.equal(bytes.has(s.path),false);
    assert.equal(bytes.has(`${s.path}.parts/00000`),false);assert.equal(bytes.has(`${s.path}.poster.jpg`),false);
    assert.deepEqual(await db.query(`SELECT id FROM post_media WHERE id='${s.media}'`),[]);
  });
  it('renewal refuses missing, ready and cancelled sources; expiry refuses a renewed source',async()=>{
    const s=await source();assert.equal((await renewPendingSlot(db.client,s.media)).ok,true);
    const cutoff=new Date(Date.now()-1000).toISOString();
    const claimed=await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_before:cutoff});assert.equal(claimed.error,null);assert.equal(claimed.data,false);assert.equal(bytes.has(s.path),true);
    assert.equal((await renewPendingSlot(db.client,randomUUID())).ok,false);
    assert.equal((await complete(s)).status,200);assert.equal((await renewPendingSlot(db.client,s.media)).ok,false);
    const cancelled=await source();await db.exec(`SELECT public.cancel_postcard_draft('${owner.id}','${cancelled.post}')`);
    assert.equal((await renewPendingSlot(db.client,cancelled.media)).ok,false);
    const swept=await sweepAbandonedPendingUploads(db.client,{nowMs:Date.now()+PENDING_UPLOAD_ORPHAN_CUTOFF_MS+1000});assert.equal(swept.ok,true);assert.equal(bytes.has(cancelled.path),false);
  });
  it('withdrawal RPC refuses a foreign actor and pinned moderation without removing the source',async()=>{
    const s=await source(),stranger=(await db.seedUser('foreign-delete')).id;
    const foreign=await db.client.rpc('withdraw_postcard_media',{p_actor:stranger,p_post:s.post,p_media:s.media,p_expected_moderation:'pending'});assert.equal(foreign.error,null);assert.equal(foreign.data,false);
    await db.exec(`UPDATE post_media SET moderation_status='flagged' WHERE id='${s.media}'`);
    const pinned=await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_expected_moderation:'flagged'});assert.equal(pinned.error,null);assert.equal(pinned.data,false);
    assert.equal((await db.query(`SELECT deleted_at FROM post_media WHERE id='${s.media}'`))[0].deleted_at,null);
    const acl=await db.query<{allowed:boolean}>(`SELECT has_function_privilege(role,fn,'EXECUTE') AS allowed FROM (VALUES('anon'),('authenticated')) roles(role) CROSS JOIN (VALUES('public.withdraw_postcard_media(uuid,uuid,uuid,text,timestamp with time zone,text,uuid)'),('public.renew_postcard_upload(uuid)')) functions(fn)`);
    assert.equal(acl.length,4);assert.ok(acl.every(row=>!row.allowed));
  });
  it('admin removal retains held and incomplete sources with one atomic audit, without lifting moderation',async()=>{
    const admin=await db.seedUser('postcard-retention-admin');await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin.id}'`);
    for(const ready of [true,false]) {
      const s=await source();if(ready)assert.equal((await complete(s)).status,200);
      await db.exec(`UPDATE post_media SET moderation_status='flagged' WHERE id='${s.media}'`);const original=Buffer.from(bytes.get(s.path)!);
      assert.equal((await fetch(`${base}/media/file/post-media/${s.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,200);
      const remove=async()=>fetch(`${base}/admin/media/${s.media}/moderate`,{method:'POST',headers:{authorization:`Bearer ${admin.token}`,'content-type':'application/json'},body:JSON.stringify({target:'post_media',action:'delete',reason:'Retain during review'})});
      const response=await remove();assert.equal(response.status,200,await response.text());assert.deepEqual(bytes.get(s.path),original);
      const issued=signedDownloads.length;
      assert.equal((await fetch(`${base}/media/file/post-media/${s.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,403,'withdrawn bytes cannot use the owner signing shortcut');
      const batch=await fetch(`${base}/media/sign`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({urls:[`post-media/${s.path}`]})});
      assert.equal(batch.status,200);assert.equal((await batch.json() as {signed:Record<string,string|null>}).signed[`post-media/${s.path}`],null);
      assert.equal(signedDownloads.length,issued,'neither relay nor batch may mint new bearer authority');
      const retained=(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`))[0];assert.ok(retained.deleted_at);assert.ok(retained.recovery_snapshot);assert.equal(retained.moderation_status,'flagged');
      assert.equal((await remove()).status,200);assert.deepEqual((await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`))[0],retained);
      const audit=await db.query(`SELECT * FROM moderation_actions WHERE metadata->>'target_id'='${s.media}' AND action_type='content_removed'`);assert.equal(audit.length,1);assert.equal(audit[0].performed_by,admin.id);assert.equal(audit[0].target_user_id,owner.id);
      const sweep=await sweepAbandonedPendingUploads(db.client,{nowMs:Date.now()+366*86400000});assert.equal(sweep.ok,true);assert.deepEqual(bytes.get(s.path),original);
    }
  });
  it('shared media keeps its live attachment authority and loses fresh signing after the final source is withdrawn',async()=>{
    const postA=randomUUID(),postB=randomUUID(),mediaA=randomUUID(),mediaB=randomUUID(),path=`${owner.id}/shared-${randomUUID()}.jpg`;
    bytes.set(path,await sharp({create:{width:32,height:24,channels:3,background:'#357'}}).jpeg().toBuffer());
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status) VALUES('${postA}','${owner.id}','shared a','private','active'),('${postB}','${owner.id}','shared b','private','active');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status,moderation_status) VALUES
      ('${mediaA}','${postA}','${owner.id}','post-media','${path}','image','image/jpeg','ready','approved'),
      ('${mediaB}','${postB}','${owner.id}','post-media','${path}','image','image/jpeg','ready','approved')`);
    const sign=()=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'});
    assert.equal((await sign()).status,200);
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:postA,p_media:mediaA,p_expected_moderation:'approved'})).data,true);
    assert.equal((await sign()).status,200,'another live attachment retains access');
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:postB,p_media:mediaB,p_expected_moderation:'approved'})).data,true);
    const issued=signedDownloads.length;assert.equal((await sign()).status,403);assert.equal(signedDownloads.length,issued);
    assert.equal((await db.query(`SELECT id FROM post_media WHERE storage_path='${path}'`)).length,2,'authorization denial must retain both sources');
  });

  it('missing withdrawal schema denies owner signing with warm and cold readiness',async()=>{
    const s=await source();assert.equal((await complete(s)).status,200);
    const sign=()=>fetch(`${base}/media/file/post-media/${s.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'});
    resetSchemaCapabilityMemo();assert.equal((await sign()).status,200);
    const issued=signedDownloads.length;
    await db.exec('ALTER TABLE public.post_media RENAME COLUMN deleted_at TO test_unavailable_deleted_at');
    try {
      assert.equal((await sign()).status,403,'the source read must refuse even with cached readiness');
      resetSchemaCapabilityMemo();
      assert.equal((await sign()).status,403,'the cold readiness probe must also refuse');
      assert.equal(signedDownloads.length,issued,'missing schema cannot mint a download URL');
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM post_media WHERE id='${s.media}'`))[0].n,1);
    } finally {
      await db.exec('ALTER TABLE public.post_media RENAME COLUMN test_unavailable_deleted_at TO deleted_at');
      resetSchemaCapabilityMemo();
    }
    assert.equal((await sign()).status,200);assert.equal(signedDownloads.length,issued+1);
  });

  async function restoredSource(activate=true,withSidecar=false,cycles=1,beforeNextRetirement?: (source:{assetId:string;path:string;media:string})=>Promise<void>) {
    const s=await source(),admin=(await db.seedUser('capture-recovery-admin')).id;
    await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin}'; UPDATE post_media SET processing_status='ready',moderation_status='approved' WHERE id='${s.media}'`);
    const asset=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:s.path,publicUrl:`post-media/${s.path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:bytes.get(s.path)!.length,width:64,height:48,sourceType:'user'});
    assert.ok(asset.assetId);
    await db.exec(`UPDATE media_assets SET processing_status='ready',moderation_status='approved' WHERE id='${asset.assetId}'`);
    const oldSidecar=`${s.path}.feed.jpg`;
    if(withSidecar){
      bytes.set(oldSidecar,Buffer.from(bytes.get(s.path)!));
      await db.exec(`UPDATE post_media SET feed_storage_path='${oldSidecar}',feed_url='post-media/${oldSidecar}' WHERE id='${s.media}'`);
    }
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_expected_moderation:'approved'})).data,true);
    let generation=String((await assets(s))[0].recovery_generation);
    const from=db.client.storage.from,getBucket=db.client.storage.getBucket;
    const identities=new Map([[s.path,{id:randomUUID(),version:randomUUID()}]]);
    if(withSidecar)identities.set(oldSidecar,{id:randomUUID(),version:randomUUID()});
    db.client.storage.getBucket=async (id:string)=>({data:{id,public:false},error:null} as Awaited<ReturnType<typeof getBucket>>);
    db.client.storage.from=((bucket:string)=>({
      ...from.call(db.client.storage,bucket),
      info:async(path:string)=>{const identity=identities.get(path),body=bytes.get(path);return identity&&body?{data:{...identity,bucketId:bucket,name:path,size:body.length},error:null}:{data:null,error:{status:404,statusCode:'NoSuchKey',message:'Object not found'}};},
      download:(path:string)=>({asStream:async()=>{const body=bytes.get(path);return {data:body?new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(body));controller.close();}}):null,error:body?null:{message:'missing'}};}}),
      copy:async(path:string,destination:string)=>{assert.ok(bytes.has(path));assert.equal(bytes.has(destination),false);bytes.set(destination,Buffer.from(bytes.get(path)!));identities.set(destination,{id:randomUUID(),version:randomUUID()});return {data:{path:destination},error:null};},
      remove:async(paths:string[])=>{for(const path of paths){bytes.delete(path);identities.delete(path);}return {data:[],error:null};},
    })) as typeof from;
    try {
      const history:Array<{generation:string;reservationId:string;path:string;sidecars:string[];version:number}>=[];
      for(let cycle=0;cycle<cycles;cycle++){
        await prepareRetainedMediaOriginal(db.client,asset.assetId,generation);await copyRetainedMediaOriginal(db.client,asset.assetId,generation);
        await removeCopiedMediaOriginal(db.client,asset.assetId,generation);
        const reservation=await prepareRetainedMediaRestoration(db.client,admin,asset.assetId,generation,'Reviewed capture fixture recovery');
        if(reservation.dependencies.length)await verifyMediaRestorationDependencies(db.client,admin,asset.assetId,generation,reservation.id);
        await copyMediaRestorationOriginal(db.client,admin,asset.assetId,generation,reservation.id);
        for(const dependency of reservation.dependencies)await copyMediaRestorationDependency(db.client,admin,asset.assetId,generation,reservation.id,dependency.sourcePath);
        if(activate)await activateMediaRestoration(db.client,admin,asset.assetId,generation,reservation.id);
        const current=(await db.query(`SELECT version FROM media_assets WHERE id='${asset.assetId}'`))[0];
        const row=(await db.query(`SELECT feed_storage_path,thumbnail_storage_path FROM post_media WHERE id='${s.media}'`))[0];
        history.push({generation,reservationId:reservation.id,path:reservation.destinationPath,version:Number(current.version),sidecars:[row.feed_storage_path,row.thumbnail_storage_path].filter((v):v is string=>typeof v==='string')});
        if(cycle<cycles-1){
          await beforeNextRetirement?.({assetId:asset.assetId,path:reservation.destinationPath,media:s.media});
          assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_expected_moderation:'approved'})).data,true);
          generation=String((await db.query(`SELECT recovery_generation FROM media_assets WHERE id='${asset.assetId}'`))[0].recovery_generation);
        }
      }
      const latest=history.at(-1)!;
      if(history.length>1){
        const first=history[0];
        const replay=await activateMediaRestoration(db.client,admin,asset.assetId,first.generation,first.reservationId);
        assert.equal(replay.version,first.version);
        const after=(await db.query(`SELECT version,storage_path FROM media_assets WHERE id='${asset.assetId}'`))[0];
        assert.equal(after.version,latest.version);assert.equal(after.storage_path,latest.path);
      }
      return {...s,path:latest.path,assetId:asset.assetId,originalPath:s.path,oldSidecar,reservationId:latest.reservationId,history};
    } finally {db.client.storage.from=from;db.client.storage.getBucket=getBucket;}
  }
  for (const namespace of ['_retained','_recovered','manual-captions']) for (const throughVariant of [false,true]) {
    it(`unverified ${namespace} keys cannot receive ordinary signed URLs${throughVariant ? ' through an attached variant' : ' even with a live canonical owner row'}`,async()=>{
      const restored=namespace==='_recovered'?await restoredSource(throughVariant):null;
      const path=restored?.path??`${namespace}/${randomUUID()}/${randomUUID()}/original`,alias=`${path}.feed.jpg`;
      if(!restored){const asset=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,sourceType:'user'});assert.ok(asset.assetId);}
      if(throughVariant&&restored)await db.exec(`UPDATE post_media SET feed_storage_path='${alias}',feed_url='post-media/${alias}' WHERE id='${restored.media}'`);
      else if(throughVariant){
        const post=randomUUID(),media=randomUUID();
        await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status) VALUES('${post}','${owner.id}','synthetic retained alias','private','active');
          INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status,moderation_status,feed_storage_path,feed_url)
          VALUES('${media}','${post}','${owner.id}','post-media','${path}','image','image/jpeg','ready','approved','${alias}','post-media/${alias}')`);
      }
      const requested=throughVariant ? alias : path,issued=signedDownloads.length;
      assert.equal((await fetch(`${base}/media/file/post-media/${requested}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,403);
      const batch=await fetch(`${base}/media/sign`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({urls:[`post-media/${requested}`]})});
      assert.equal(batch.status,200);assert.equal((await batch.json() as {signed:Record<string,string|null>}).signed[`post-media/${requested}`],null);
      assert.equal(signedDownloads.length,issued);
    });
  }


  it('activated restored media follows current owner, post audience, privacy and block rules',async()=>{
    const r=await restoredSource(),viewer=await db.seedUser('restored-viewer');
    const sign=(token:string,path=r.path)=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[token]}`,{headers:{authorization:`Bearer ${token}`},redirect:'manual'});
    assert.equal((await sign(owner.token)).status,200);assert.equal((await sign(viewer.token)).status,403);
    assert.equal((await sign(owner.token,r.originalPath)).status,403,'retired URL authority never revives');
    await db.exec(`UPDATE posts SET post_status='published',postcard_draft_state='published',visibility='public' WHERE id='${r.post}'`);

    assert.equal((await sign(viewer.token)).status,200);
    for(const state of ['banned','deactivated']){
      await db.exec(`INSERT INTO user_account_states(user_id,state,reason) VALUES('${owner.id}','${state}','Synthetic source restriction')`);
      try {const issued=signedDownloads.length;assert.equal((await sign(viewer.token)).status,403);assert.equal(signedDownloads.length,issued);}
      finally {await db.exec(`DELETE FROM user_account_states WHERE user_id='${owner.id}' AND state='${state}'`);}
    }
    await db.exec(`UPDATE profiles SET is_private=true WHERE id='${owner.id}'`);
    try {assert.equal((await sign(viewer.token)).status,403);assert.equal((await sign(owner.token)).status,200);}
    finally {await db.exec(`UPDATE profiles SET is_private=false WHERE id='${owner.id}'`);}
    for(const [blocker,blocked] of [[owner.id,viewer.id],[viewer.id,owner.id]]) {
      await db.exec(`INSERT INTO blocks(blocker_id,blocked_id) VALUES('${blocker}','${blocked}')`);
      try {assert.equal((await sign(viewer.token)).status,403);}
      finally {await db.exec(`DELETE FROM blocks WHERE blocker_id='${blocker}' AND blocked_id='${blocked}'`);}
    }
    assert.equal((await sign(viewer.token)).status,200);
    await db.exec(`UPDATE posts SET visibility='private' WHERE id='${r.post}'`);assert.equal((await sign(viewer.token)).status,403);
    const batch=await fetch(`${base}/media/sign`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({urls:[`post-media/${r.path}`]})});
    assert.equal(batch.status,200);assert.equal(typeof (await batch.json() as {signed:Record<string,string|null>}).signed[`post-media/${r.path}`],'string');
  });

  it('only verified copied sidecars inherit the restored original audience',async()=>{
    const r=await restoredSource(true,true),viewer=await db.seedUser('restored-sidecar-viewer');
    const sidecar=String((await db.query(`SELECT feed_storage_path FROM post_media WHERE id='${r.media}'`))[0].feed_storage_path);
    assert.ok(sidecar.startsWith('_recovered/'));assert.notEqual(sidecar,r.oldSidecar);
    const sign=(token:string,path:string)=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[token]}`,{headers:{authorization:`Bearer ${token}`},redirect:'manual'});
    assert.equal((await sign(owner.token,sidecar)).status,200);
    assert.equal((await sign(viewer.token,sidecar)).status,403);
    assert.equal((await sign(owner.token,r.oldSidecar)).status,403);
    await db.exec(`UPDATE posts SET post_status='published',postcard_draft_state='published',visibility='public' WHERE id='${r.post}'`);
    assert.equal((await sign(viewer.token,sidecar)).status,200);
    await db.exec(`UPDATE post_media SET feed_storage_path=NULL,feed_url=NULL WHERE id='${r.media}'`);
    const issued=signedDownloads.length;assert.equal((await sign(owner.token,sidecar)).status,403);assert.equal(signedDownloads.length,issued);
  });

  for(const sidecars of [false,true])it(`two recovery cycles preserve one asset and revoke older keys${sidecars?' including copied feed images':''}`,async()=>{
    const r=await restoredSource(true,sidecars,2),first=r.history[0],last=r.history[1];
    assert.notEqual(first.generation,last.generation);assert.notEqual(first.reservationId,last.reservationId);assert.notEqual(first.path,last.path);
    assert.ok(last.version>first.version);
    const canonical=await db.query(`SELECT id,storage_path,owner_user_id,purge_status FROM media_assets WHERE id='${r.assetId}'`);
    assert.deepEqual(canonical,[{id:r.assetId,storage_path:last.path,owner_user_id:owner.id,purge_status:'not_requested'}]);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM media_asset_lifecycle_events WHERE media_asset_id='${r.assetId}' AND event_type='restoration_activated'`))[0].count,2);
    const sign=(path:string)=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'});
    for(const path of [r.originalPath,first.path,...first.sidecars])assert.equal((await sign(path)).status,403);
    for(const path of [last.path,...last.sidecars])assert.equal((await sign(path)).status,200);
    const viewer=await db.seedUser('repeat-recovery-viewer');
    const view=(path:string)=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[viewer.token]}`,{headers:{authorization:`Bearer ${viewer.token}`},redirect:'manual'});
    for(const path of [last.path,...last.sidecars])assert.equal((await view(path)).status,403,'restoration does not publish private drafts');
    await db.exec(`UPDATE posts SET post_status='published',postcard_draft_state='published',visibility='public' WHERE id='${r.post}'`);
    for(const path of [last.path,...last.sidecars])assert.equal((await view(path)).status,200);
    for(const path of [first.path,...first.sidecars])assert.equal((await view(path)).status,403);

    if(sidecars){assert.equal(last.sidecars.length,1);assert.notDeepEqual(first.sidecars,last.sidecars);assert.equal((await sign(r.oldSidecar)).status,403);}
  });

  it('restored source proof is exact, service-only, and survives retention without trusting old keys',async()=>{
    const r=await restoredSource(true,true,2),current=r.history[1],old=r.history[0];
    const owned=(path:string,source:string|null=r.media,assetId=r.assetId,bucket='post-media')=>db.client.rpc('restored_media_object_owned',{p_asset:assetId,p_bucket:bucket,p_path:path,p_source:source});
    assert.equal((await owned(current.path)).data,true);
    assert.equal((await owned(current.sidecars[0],null)).data,true);
    for(const query of [()=>owned(current.path,randomUUID()),()=>owned(current.path,r.media,randomUUID()),()=>owned(current.path,r.media,r.assetId,'profile-media'),()=>owned(old.path),()=>owned(old.sidecars[0],null),()=>owned(current.sidecars[0])])assert.equal((await query()).data,false);
    for(const role of ['anon','authenticated'])assert.equal((await db.query(`SELECT has_function_privilege('${role}','restored_media_object_owned(uuid,text,text,uuid)','EXECUTE') AS allowed`))[0].allowed,false);
    assert.equal((await db.query(`SELECT has_function_privilege('service_role','restored_media_object_owned(uuid,text,text,uuid)','EXECUTE') AS allowed`))[0].allowed,true);
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:r.post,p_media:r.media,p_expected_moderation:'approved'})).data,true);
    assert.equal((await owned(current.path)).data,true,'frozen pre-retirement version retains identity, not read authority');
    assert.equal((await fetch(`${base}/media/file/post-media/${current.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,403);
  });
  for(const mode of ['cancel','delete'] as const)it(`${mode} of the original restored parent retires its canonical source`,async()=>{
    const r=await restoredSource();
    if(mode==='cancel'){const result=await db.client.rpc('cancel_postcard_draft',{p_actor:owner.id,p_post:r.post});assert.equal(result.error,null);assert.equal(result.data?.ok,true);}
    else await db.exec(`UPDATE posts SET deleted_at=clock_timestamp() WHERE id='${r.post}'`);
    const current=(await db.query(`SELECT purge_status,recovery_generation FROM media_assets WHERE id='${r.assetId}'`))[0];
    assert.equal(current.purge_status,'retained');assert.match(String(current.recovery_generation),/^[a-f0-9-]{36}$/);
    assert.equal((await fetch(`${base}/media/file/post-media/${r.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,403);
  });
  it('a new attachment of a restored object does not inherit retirement ownership',async()=>{
    const r=await restoredSource(),post=randomUUID(),media=randomUUID();
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status) VALUES('${post}','${owner.id}','shared restored source','private','active');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status,moderation_status)
      VALUES('${media}','${post}','${owner.id}','post-media','${r.path}','image','image/jpeg','ready','approved')`);
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:post,p_media:media,p_expected_moderation:'approved'})).data,true);
    await db.exec(`UPDATE posts SET deleted_at=clock_timestamp() WHERE id='${post}'`);
    assert.equal((await db.query(`SELECT purge_status FROM media_assets WHERE id='${r.assetId}'`))[0].purge_status,'not_requested');
    assert.equal((await fetch(`${base}/media/file/post-media/${r.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'})).status,200);
  });
  for(const mode of ['foreign-asset','foreign-reservation','unverified-object'] as const)it(`repeated recovery refuses a ${mode} copied dependency`,async()=>{
    let assetId='';
    await assert.rejects(restoredSource(true,true,2,async current=>{
      assetId=current.assetId;
      const parts=current.path.split('/');
      const path=`_recovered/${mode==='foreign-asset'?randomUUID():parts[1]}/${mode==='foreign-reservation'?randomUUID():parts[2]}/objects/${'a'.repeat(64)}`;
      await db.exec(`UPDATE post_media SET feed_storage_path='${path}',feed_url='post-media/${path}' WHERE id='${current.media}'`);
    }),/Restoration reservation unconfirmed/);
    assert.equal((await db.query(`SELECT purge_status FROM media_assets WHERE id='${assetId}'`))[0].purge_status,'retained');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM media_asset_lifecycle_events WHERE media_asset_id='${assetId}' AND event_type='restoration_activated'`))[0].count,1);
  });
  it('restored signing refuses current source sanctions, retirement and missing activation evidence',async()=>{
    const r=await restoredSource();const sign=()=>fetch(`${base}/media/file/post-media/${r.path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'});
    assert.equal((await sign()).status,200);
    await db.exec(`INSERT INTO user_account_states(user_id,state,reason) VALUES('${owner.id}','banned','Synthetic restored-source restriction')`);
    try {const issued=signedDownloads.length;assert.equal((await sign()).status,403);assert.equal(signedDownloads.length,issued);}
    finally {await db.exec(`DELETE FROM user_account_states WHERE user_id='${owner.id}' AND state='banned'`);}
    assert.equal((await sign()).status,200);
    await db.exec('ALTER TABLE media_asset_lifecycle_events RENAME COLUMN details TO test_unavailable_details');
    try {const issued=signedDownloads.length;assert.equal((await sign()).status,403);assert.equal(signedDownloads.length,issued);}
    finally {await db.exec('ALTER TABLE media_asset_lifecycle_events RENAME COLUMN test_unavailable_details TO details');}
    assert.equal((await sign()).status,200);
    const retired=await db.client.rpc('retire_media_asset',{p_asset:r.assetId,p_actor:owner.id});assert.equal(retired.error,null);
    assert.equal((await db.query(`SELECT purge_status FROM media_assets WHERE id='${r.assetId}'`))[0].purge_status,'retained');
    const issued=signedDownloads.length;assert.equal((await sign()).status,403);assert.equal(signedDownloads.length,issued);
  });
  it('an independently active canonical owner source survives attachment withdrawal but its own retirement denies signing',async()=>{
    const post=randomUUID(),media=randomUUID(),path=`${owner.id}/library-${randomUUID()}.jpg`;
    bytes.set(path,await sharp({create:{width:32,height:24,channels:3,background:'#357'}}).jpeg().toBuffer());
    const asset=await recordMediaAssetDetailed(db.client,{ownerUserId:owner.id,storageBucket:'post-media',storagePath:path,publicUrl:`post-media/${path}`,mediaType:'image',mimeType:'image/jpeg',sizeBytes:100,sourceType:'user'});assert.ok(asset.assetId);
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status) VALUES('${post}','${owner.id}','library attachment','private','active');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status,moderation_status) VALUES
      ('${media}','${post}','${owner.id}','post-media','${path}','image','image/jpeg','ready','approved')`);
    assert.equal((await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:post,p_media:media,p_expected_moderation:'approved'})).data,true);
    const sign=()=>fetch(`${base}/media/file/post-media/${path}?viewer=${db.tokens[owner.token]}`,{headers:{authorization:`Bearer ${owner.token}`},redirect:'manual'});
    assert.equal((await sign()).status,200,'canonical ownership is independent of a withdrawn shared attachment');
    const retired=await db.client.rpc('retire_media_asset',{p_asset:asset.assetId,p_actor:owner.id});assert.equal(retired.error,null);
    const issued=signedDownloads.length;assert.equal((await sign()).status,403);assert.equal(signedDownloads.length,issued);
  });

  it('admin withdrawal and its audit roll back together, and owners cannot claim admin removal authority',async()=>{
    const s=await source();assert.equal((await complete(s)).status,200);const before=await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),original=Buffer.from(bytes.get(s.path)!);
    const refused=await db.client.rpc('withdraw_postcard_media',{p_actor:owner.id,p_post:s.post,p_media:s.media,p_expected_moderation:'approved',p_admin_reason:'Forged admin action'});assert.equal(refused.error,null);assert.equal(refused.data,false);
    const admin=await db.seedUser('postcard-audit-admin');await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin.id}'`);
    await db.exec(`CREATE FUNCTION public.test_withdrawal_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic withdrawal audit failure'; END $$; CREATE TRIGGER test_withdrawal_audit_failure BEFORE INSERT ON moderation_actions FOR EACH ROW EXECUTE FUNCTION public.test_withdrawal_audit_failure()`);
    try {
      const response=await fetch(`${base}/admin/media/${s.media}/moderate`,{method:'POST',headers:{authorization:`Bearer ${admin.token}`,'content-type':'application/json'},body:JSON.stringify({target:'post_media',action:'delete',reason:'Review complete'})});assert.equal(response.status,500);
      assert.deepEqual(await db.query(`SELECT * FROM post_media WHERE id='${s.media}'`),before);assert.deepEqual(bytes.get(s.path),original);assert.equal((await assets(s))[0].deleted_at,null);
    } finally {await db.exec('DROP TRIGGER test_withdrawal_audit_failure ON moderation_actions; DROP FUNCTION test_withdrawal_audit_failure()');}
  });
  it('admin withdrawal names the reviewed report and refuses a report closed before the command',async()=>{
    const s=await source();assert.equal((await complete(s)).status,200);const admin=await db.seedUser('postcard-report-admin'),report=randomUUID();await db.exec(`UPDATE profiles SET role='admin' WHERE id='${admin.id}';
      INSERT INTO moderation_reports(id,reporter_id,subject_type,subject_id,subject_user_id,category,status) VALUES('${report}','${admin.id}','post','${s.post}','${owner.id}','scam_fraud','open')`);
    const input={p_actor:admin.id,p_post:s.post,p_media:s.media,p_expected_moderation:'approved',p_admin_reason:'Reported media review',p_report_id:report};
    await db.exec(`UPDATE moderation_reports SET status='dismissed' WHERE id='${report}'`);
    const closed=await db.client.rpc('withdraw_postcard_media',input);assert.equal(closed.error,null);assert.equal(closed.data,false);
    await db.exec(`UPDATE moderation_reports SET status='open',subject_user_id=NULL WHERE id='${report}'`); // legacy reports resolve the canonical content owner
    const result=await db.client.rpc('withdraw_postcard_media',input);assert.equal(result.error,null);assert.equal(result.data,true);
    const audits=await db.query(`SELECT report_id,metadata->>'report_id' AS linked FROM moderation_actions WHERE metadata->>'target_id'='${s.media}'`);assert.deepEqual(audits,[{report_id:report,linked:report}]);
  });
  it('only dated completed photos enter one private candidate, without duplicate evidence on detection retry',async()=>{
    const undated=await source();assert.equal((await complete(undated)).status,200);assert.equal((await assets(undated))[0].captured_at,null);
    const detect=async()=>{const response=await fetch(base+'/me/memory-candidates/detect',{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({tripId:trip})});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
    const first=z.object({report:z.object({capturesRead:z.number(),candidates:z.array(z.object({episodeId:z.string().uuid()}))})}).parse(await detect());assert.equal(first.report.capturesRead,3);assert.equal(first.report.candidates.length,1);const id=first.report.candidates[0].episodeId;
    assert.deepEqual(await db.query(`SELECT state,visibility FROM memory_episodes WHERE id='${id}'`),[{state:'candidate',visibility:'private'}]);
    const evidence=await db.query<{source_id:string}>(`SELECT source_id FROM memory_evidence WHERE episode_id='${id}' ORDER BY source_id`);assert.deepEqual(evidence.map(row=>row.source_id),[...timedIds].sort());
    await detect();assert.deepEqual(await db.query(`SELECT source_id FROM memory_evidence WHERE episode_id='${id}' ORDER BY source_id`),evidence);
  });
});
