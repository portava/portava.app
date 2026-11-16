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
  app.use(express.json());app.use(postsRouter);app.use(candidatesRouter);
  server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 });
 after(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));_setTestClient(null,false);resetCanonicalSchemaMemo();resetHighlightSchemaMemo();await db?.close();});
 async function post(path:string,body:unknown){const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
 async function upload(at:Date|null,operation=randomUUID()){
  const local=at?new Date(at.getTime()+2*3600000).toISOString().slice(0,19).replaceAll('-' ,':').replace('T',' '):null;
  const source=await sharp({create:{width:64,height:48,channels:3,background:'#3a5'}}).jpeg().withExif({IFD0:{ImageDescription:'synthetic private metadata'}}).toBuffer();
  let normalized=Buffer.alloc(0);
  const pick=await normalizeForUploadWith({uri:'synthetic.jpg',mimeType:'image/jpeg',fileName:'synthetic.jpg',width:64,height:48,fileSize:source.length,exif:local?{DateTimeOriginal:local,OffsetTimeOriginal:'+02:00',GPSLatitude:1,GPSLongitude:2}:null},{
   manipulate:async(_uri,actions,options)=>{let image=sharp(source);for(const action of actions)image=image.resize(action.resize);normalized=await image.toFormat(options.format,{quality:Math.round(options.compress*100)}).toBuffer();return {uri:'normalized.jpg',width:64,height:48};},
   fileSize:async()=>normalized.length,
  });
  assert.equal(pick.exif,null);assert.equal((await sharp(normalized).metadata()).exif,undefined);
  const response=await fetch(base+'/media/upload',{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'image/jpeg','x-composer-operation':operation,...(pick.photoCapturedAt?{'x-photo-captured-at':pick.photoCapturedAt}:{})},body:normalized});
  const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));
  const result=z.object({path:z.string()}).parse(body);
  const rows=await db.query<{id:string;captured_at:string|null;version:number}>(`SELECT id,captured_at::text,version FROM public.media_assets WHERE owner_user_id='${owner.id}' AND storage_path='${result.path}'`);
  assert.equal(rows.length,1);assert.equal(rows[0].captured_at?new Date(rows[0].captured_at).toISOString():null,at?.toISOString()??null);
  assert.equal((await sharp(bytes.get(result.path)!).metadata()).exif,undefined);
  return {row:rows[0],operation};
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
});
