import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { VideoSegmentNativeCluster } from './memoryVideoSegmentsPostgresFixture.js';
const binary=process.env.PORTAVA_TEST_POSTGRES_BIN;
const cluster=binary?new VideoSegmentNativeCluster(binary):null;
const admin='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', official='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', other='cccccccc-cccc-4ccc-8ccc-cccccccccccc', asset='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const path=admin+'/movie.mp4';
async function sql(text:string){const c=cluster!.session();try{return await c.query(text+';');}finally{await c.close();}}
function lit(s:string){return `'${s.replaceAll("'","''")}'`;}
function command({actor=admin,operation=randomUUID(),paths=[path],external=[] as string[],fields={content:'A curated post',visibility:'public'} as Record<string,unknown>}={}){
 return `SELECT public.create_official_post_with_media('${actor}','${operation}',${lit(JSON.stringify(fields))}::jsonb,ARRAY[${paths.map(lit).join(',')}]::text[],ARRAY[${external.map(lit).join(',')}]::text[])`;
}
async function run(opts:Parameters<typeof command>[0]={}){return JSON.parse(await sql('SET ROLE service_role; '+command(opts)));}
describe('Official post media: real PostgreSQL 17',{skip:!binary?'PORTAVA_TEST_POSTGRES_BIN is required for the native gate':false},()=>{
 before(async()=>{
  await cluster!.start();
  // Private disposable cluster only; the production function runs against the
  // same named columns/types and the existing canonical media tables.
  await sql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE SCHEMA IF NOT EXISTS storage; ALTER ROLE service_role BYPASSRLS;
   CREATE TYPE post_visibility AS ENUM('public','private','trip_only','followers_only');
   CREATE TYPE delayed_post_status AS ENUM('published','pending_delay','canceled');
   CREATE TABLE profiles(id uuid PRIMARY KEY,role text,account_status text DEFAULT 'active',handle text,is_official boolean DEFAULT false);
   CREATE TABLE user_account_states(user_id uuid,state text,expires_at timestamptz);
   CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid,created_by uuid,updated_by uuid,content text,category text,media_urls text[],visibility post_visibility,status text,source text,post_status delayed_post_status,
    publish_after_time timestamptz,publish_eligible_at timestamptz,published_at timestamptz,location_name text,location_city text,location_country text,location_lat numeric,location_lng numeric,
    public_location_label text,location_source text,location_verified boolean,location_privacy_mode text,location_sensitivity_level text,add_to_passport boolean,geofence_radius_meters integer,publish_after_exit boolean,geotag_verified boolean,geotag_credit_awarded boolean,
    media_count integer,has_video boolean,primary_media_type text,media_type text,deleted_at timestamptz);
   CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid,uploader_user_id uuid,storage_bucket text,storage_path text UNIQUE,media_type text,mime_type text,size_bytes bigint,width integer,height integer,duration_ms integer,thumbnail_path text,
    processing_status text,moderation_status text,deleted_at timestamptz,purge_status text);
   CREATE TABLE post_media(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,post_id uuid REFERENCES posts(id) ON DELETE CASCADE,user_id uuid,media_type text,storage_bucket text,storage_path text,public_url text,mime_type text,file_size_bytes bigint,width integer,height integer,duration_seconds double precision,processing_status text,moderation_status text,sort_order integer,thumbnail_storage_path text,thumbnail_url text);
   CREATE TABLE media_attachments(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,media_asset_id uuid REFERENCES media_assets(id),entity_type text,entity_id uuid,position integer,is_cover boolean);
   CREATE TABLE post_media_moderation_ledger(storage_path text PRIMARY KEY);
   CREATE TABLE storage.objects(bucket_id text,name text,PRIMARY KEY(bucket_id,name));
   GRANT USAGE ON SCHEMA public,storage TO service_role,anon,authenticated;
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,storage TO service_role;`);
  await sql(readFileSync(new URL('../migrations/4010_official_post_media_registration.sql',import.meta.url),'utf8'));
 });
 after(async()=>{await cluster?.close();});
 beforeEach(async()=>{
  await sql(`TRUNCATE profiles,user_account_states,posts,media_assets,post_media,media_attachments,post_media_moderation_ledger,storage.objects,official_post_media_commands CASCADE;
   INSERT INTO profiles(id,role,handle,is_official) VALUES('${admin}','admin','editor',false),('${official}','user','portava',true),('${other}','user','other',false);
   INSERT INTO media_assets VALUES('${asset}','${admin}','${admin}','post-media','${path}','video','video/mp4',123456,1080,1920,1234,'${path}.poster.jpg','ready','active',NULL,'not_requested');
   INSERT INTO storage.objects VALUES('post-media','${path}'),('post-media','${path}.poster.jpg');`);
 });
 test('canonical post, media, attachment and delegation audit commit atomically without transferring ownership',async()=>{
  const r=await run();assert.equal(r.post.author_id,official);assert.equal(r.post.created_by,admin);assert.deepEqual(r.post.media_urls,[]);assert.equal(r.post.media_count,1);assert.equal(r.post.has_video,true);
  assert.equal(await sql('SELECT owner_user_id FROM media_assets'),admin);
  assert.equal(await sql('SELECT user_id FROM post_media'),admin);
  assert.equal(await sql('SELECT media_asset_id FROM media_attachments'),asset);
  assert.equal(await sql('SELECT count(*) FROM official_post_media_commands'),'1');
  assert.equal(await sql('SELECT duration_seconds FROM post_media'),'1.234');
  assert.equal(await sql('SELECT thumbnail_storage_path FROM post_media'),path+'.poster.jpg');
 });
 test('non-owned paths and canonical ownership mismatch both roll back the whole post',async()=>{
  await assert.rejects(run({paths:[other+'/movie.mp4']}),/official_media_not_owned/);
  await sql(`UPDATE media_assets SET owner_user_id='${other}'`);await assert.rejects(run(),/official_media_unavailable/);
  assert.equal(await sql('SELECT count(*) FROM posts'),'0');
 });
 test('removed, restricted, processing and deletion-requested assets cannot be republished',async()=>{
  for(const mutation of ["moderation_status='removed'","moderation_status='rejected'","moderation_status='limited'","processing_status='processing'","deleted_at=now()","purge_status='pending'"]){
   await sql("UPDATE media_assets SET moderation_status='active',processing_status='ready',deleted_at=NULL,purge_status='not_requested'; UPDATE media_assets SET "+mutation);
   await assert.rejects(run(),/official_media_unavailable/);
  }
  assert.equal(await sql('SELECT count(*) FROM posts'),'0');
 });
 test('a moderation ledger verdict blocks the source and a held poster is never attached',async()=>{
  await sql(`INSERT INTO post_media_moderation_ledger VALUES('${path}')`);await assert.rejects(run(),/official_media_unavailable/);
  await sql(`DELETE FROM post_media_moderation_ledger; INSERT INTO post_media_moderation_ledger VALUES('${path}.poster.jpg')`);
  await run();assert.equal(await sql('SELECT thumbnail_storage_path IS NULL FROM post_media'),'t');
 });
 test('admin permission and current canonical restrictions are checked inside the command',async()=>{
  await assert.rejects(run({actor:other}),/official_post_forbidden/);
  await sql(`INSERT INTO user_account_states VALUES('${admin}','suspended',NULL)`);await assert.rejects(run(),/official_post_forbidden/);
  await sql("UPDATE user_account_states SET expires_at=now()-interval '1 hour'");assert.ok((await run()).post.id);
 });
 test('same intent retries and concurrent submissions yield one post and audit',async()=>{
  const operation=randomUUID();const [one,two]=await Promise.all([run({operation}),run({operation})]);assert.equal(one.post.id,two.post.id);
  assert.equal(await sql('SELECT count(*) FROM posts'),'1');assert.equal(await sql('SELECT count(*) FROM media_attachments'),'1');
  await assert.rejects(run({operation,fields:{content:'Changed'}}),/official_post_intent_conflict/);
 });
 test('a deleted publication is not resurrected by a delayed retry',async()=>{
  const operation=randomUUID();const one=await run({operation});await sql(`DELETE FROM posts WHERE id='${one.post.id}'`);
  await assert.rejects(run({operation}),/official_post_unavailable/);assert.equal(await sql('SELECT count(*) FROM posts'),'0');
 });
 test('audit failure rolls back post, legacy media and canonical attachment',async()=>{
  await sql("CREATE FUNCTION fail_official_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_official_audit BEFORE INSERT ON official_post_media_commands FOR EACH ROW EXECUTE FUNCTION fail_official_audit()");
  try{await assert.rejects(run(),/audit unavailable/);for(const table of ['posts','post_media','media_attachments'])assert.equal(await sql('SELECT count(*) FROM '+table),'0');}
  finally{await sql('DROP TRIGGER fail_official_audit ON official_post_media_commands; DROP FUNCTION fail_official_audit()');}
 });
 test('external refs stay external and cannot conceal a storage key',async()=>{
  const r=await run({paths:[],external:['https://example.org/photo.jpg']});assert.deepEqual(r.post.media_urls,['https://example.org/photo.jpg']);assert.equal(r.post.media_count,0);
  await assert.rejects(run({paths:[],external:['https://project.supabase.co/storage/v1/object/public/post-media/foreign/a.jpg']}),/official_post_invalid/);
 });
 test('storage existence and canonical registration are required independently',async()=>{
  await sql('DELETE FROM storage.objects');await assert.rejects(run(),/official_media_unavailable/);
  await sql('DELETE FROM media_assets');await assert.rejects(run(),/no rows/);assert.equal(await sql('SELECT count(*) FROM posts'),'0');
 });
 test('schedule and audience are preserved; manually supplied location never becomes verified',async()=>{
  const scheduled=new Date(Date.now()+3600000).toISOString();const r=await run({fields:{content:'Scheduled',visibility:'private',scheduledAt:scheduled,locationLat:0,locationLng:0}});
  assert.equal(r.post.visibility,'private');assert.equal(r.post.post_status,'pending_delay');assert.equal(r.post.published_at,null);assert.equal(r.post.geotag_verified,false);assert.equal(r.post.location_verified,false);
  await assert.rejects(run({fields:{content:'Past',scheduledAt:'2020-01-01T00:00:00Z'}}),/official_post_invalid/);
 });
 test('client roles cannot call the writer or forge delegation receipts',async()=>{
  for(const role of ['anon','authenticated']){await assert.rejects(sql(`SET ROLE ${role}; ${command()}`),/permission denied/);await assert.rejects(sql(`SET ROLE ${role}; SELECT * FROM official_post_media_commands`),/permission denied/);}
 });
});
