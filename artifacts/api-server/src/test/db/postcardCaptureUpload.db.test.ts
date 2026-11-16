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
import candidatesRouter from '../../routes/memoryCandidates.js';
import { recordMediaAssetDetailed } from '../../lib/mediaAssets.js';
import { resetCanonicalSchemaMemo } from '../../lib/media/mediaSchemaCapability.js';
import { resetHighlightSchemaMemo } from '../../services/highlights/highlightSchemaAvailability.js';

describe('postcard captures survive completion and recovery', {skip:PRESSED_SKIP_REASON},()=>{
  let db:Awaited<ReturnType<typeof openPressedLayoverDb>>,server:Server,base:string,owner:{id:string;token:string};
  const bytes=new Map<string,Buffer>();let holdAfterStore:string|null=null;let failAfterStore:string|null=null,cancelAfterStore:{post:string;path:string}|null=null,storageWrites=0;
  const trip=randomUUID(),at=new Date();at.setUTCHours(0,0,0,0);at.setUTCDate(at.getUTCDate()-2);
  const timedIds:string[]=[];
  before(async()=>{
    db=await openPressedLayoverDb();owner=await db.seedUser('postcard-capture');
    await db.exec(`INSERT INTO trips(id,owner_id,title,start_date,end_date,destination_city,destination_country) VALUES('${trip}','${owner.id}','Synthetic postcard proof','${at.toISOString().slice(0,10)}','${at.toISOString().slice(0,10)}','Lisbon','Portugal')`);
    await db.setFlag('media_canonical_enabled',true);await db.setFlag('media_canonical_schema_fallback_enabled',false);
    for(const flag of ['disable_media_uploads','disable_posting','media_moderation_classifier_enabled','media_vision_provider_enabled','media_transcoder_enabled','media_captions_enabled'])await db.setFlag(flag,false);
    db.client.storage.from=()=>({
      download:async(path:string)=>({data:bytes.has(path)?new Blob([new Uint8Array(bytes.get(path)!)]):null,error:bytes.has(path)?null:{message:'missing synthetic object'}}),
      upload:async(path:string,body:Buffer)=>{
        bytes.set(path,Buffer.from(body));storageWrites++;
        if(holdAfterStore===path){holdAfterStore=null;await db.exec(`UPDATE post_media SET moderation_status='flagged' WHERE storage_path='${path}'`);}
        if(cancelAfterStore?.path===path){const post=cancelAfterStore.post;cancelAfterStore=null;await db.exec(`SELECT public.cancel_postcard_draft('${owner.id}','${post}')`);}
        if(failAfterStore===path){failAfterStore=null;return {data:null,error:{message:'synthetic lost upload acknowledgement'}};}
        return {data:{path},error:null};
      },
      remove:async(paths:string[])=>{paths.forEach(path=>bytes.delete(path));return {data:[],error:null};},
    }) as ReturnType<typeof db.client.storage.from>;
    resetCanonicalSchemaMemo();resetHighlightSchemaMemo();_setTestClient(db.client,true);
    const app=express();app.use((req,_res,next)=>{req.log=logger;next();});app.use(express.json());app.use(postcardsRouter);app.use(candidatesRouter);
    server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  after(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));_setTestClient(null,false);resetCanonicalSchemaMemo();resetHighlightSchemaMemo();await db?.close();});
  async function source(exif=false){
    const post=randomUUID(),media=randomUUID(),path=`${owner.id}/${post}/${media}.jpg`;
    await db.exec(`INSERT INTO posts(id,author_id,content,visibility,status,post_status,postcard_draft_state,postcard_requested_visibility) VALUES('${post}','${owner.id}','synthetic','private','active','draft','draft','public');
      INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,media_type,mime_type,processing_status) VALUES('${media}','${post}','${owner.id}','post-media','${path}','image','image/jpeg','pending')`);
    let image=sharp({create:{width:64,height:48,channels:3,background:'#357'}}).jpeg();
    if(exif)image=image.withExif({IFD0:{ImageDescription:'private synthetic metadata'},IFD2:{DateTimeOriginal:'2026:03:04 05:06:07',OffsetTimeOriginal:'+02:00'}});
    bytes.set(path,await image.toBuffer());return {post,media,path};
  }
  type Source=Awaited<ReturnType<typeof source>>;
  const assets=(s:Source)=>db.query(`SELECT * FROM media_assets WHERE storage_path='${s.path}'`);
  async function complete(s:Source,time?:string){
    const response=await fetch(`${base}/postcards/${s.post}/media/${s.media}/complete`,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify({mimeType:'image/png',fileSizeBytes:999,width:1,height:1,...(time?{photoCapturedAt:time}:{})})});
    return {status:response.status,body:await response.json()};
  }
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
    const rows=await assets(s);assert.equal(rows.length,1);assert.equal(rows[0].moderation_status,'owner_deleted');assert.equal(rows[0].processing_status,'removed');assert.equal(rows[0].purge_status,'pending');
    assert.notEqual((await complete(s,at.toISOString())).status,200);assert.deepEqual(await assets(s),rows);
    assert.equal((await db.query(`SELECT postcard_draft_state FROM posts WHERE id='${s.post}'`))[0].postcard_draft_state,'cancelled');
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
