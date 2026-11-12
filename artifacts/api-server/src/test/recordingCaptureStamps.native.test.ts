import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {VideoSegmentNativeCluster} from './memoryVideoSegmentsPostgresFixture.js';
const binary=process.env.PORTAVA_TEST_POSTGRES_BIN;
const db=binary ? new VideoSegmentNativeCluster(binary) : null;
const alice='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash='e'.repeat(64), digest='f'.repeat(64);
async function sql(statement:string){const c=db!.session();try{return await c.query(statement+';');}finally{await c.close();}}
const asService=(s:string)=>sql('SET ROLE service_role; '+s);
const q=(s:string)=>`'${s.replaceAll("'","''")}'`;
async function open(owner=alice){const id=randomUUID();await asService(`SELECT open_recording_capture(${q(owner)},${q(id)},${q(hash)})`);return id;}
const seal=(id:string,owner=alice,proof=hash,sha=digest)=>asService(`SELECT seal_recording_capture(${[owner,id,proof,sha,'mp4'].map(q)})`);
const issue=(id:string,target:string,type='post',owner=alice,proof=hash)=>asService(`SELECT issue_recording_capture(${[owner,id,proof,type,target].map(q)})`);
async function publish(id:string, type='post', actor=alice){
  const target=randomUUID(), path=`${alice}/capture-stamps/${id}.mp4`;
  if(type==='post') await sql(`INSERT INTO posts VALUES(${q(target)},${q(actor)},'active',NULL,'published'); INSERT INTO post_media VALUES(${q(target)},'video','post-media',${q(path)},'ready','approved')`);
  else await sql(`INSERT INTO stories VALUES(${q(target)},${q(actor)},'active',now()+interval '1 hour','video/mp4',${q('post-media/'+path)})`);
  return target;
}
const read=(target:string,type='post')=>asService(`SELECT count(*) FROM read_recording_capture(${q(type)},${q(target)})`);
describe('Recording capture stamps on PostgreSQL',{skip:!db?'requires PORTAVA_TEST_POSTGRES_BIN':false},()=>{
 before(async()=>{
  await db!.start();
  await sql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE SCHEMA IF NOT EXISTS storage; ALTER ROLE service_role BYPASSRLS;
    CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid,status text,deleted_at timestamptz,post_status text);
    CREATE TABLE stories(id uuid PRIMARY KEY,owner_id uuid,state text,expires_at timestamptz,media_type text,media_url text);
    CREATE TABLE post_media(post_id uuid,media_type text,storage_bucket text,storage_path text,processing_status text,moderation_status text);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,version text,updated_at timestamptz DEFAULT now(),UNIQUE(bucket_id,name));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; CREATE POLICY ordinary_owner_fixture ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
    GRANT USAGE ON SCHEMA public,storage TO service_role,authenticated,anon; GRANT ALL ON ALL TABLES IN SCHEMA public,storage TO service_role;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated; INSERT INTO auth.users(id) VALUES(${q(alice)}),(${q(bob)}) ON CONFLICT DO NOTHING`);
  await sql(readFileSync(new URL('../migrations/4019_recording_capture_stamps.sql',import.meta.url),'utf8'));
 });
 after(async()=>{await db?.close();});
 beforeEach(async()=>{await sql('TRUNCATE recording_capture_stamps,posts,stories,post_media,storage.objects CASCADE');});
 test('a one-time recording binds its verified bytes and exactly one publication, with stable concurrent retry',async()=>{
  const id=await open(),path=await seal(id);
  assert.equal(await seal(id),path);
  await assert.rejects(()=>seal(id,alice,hash,'a'.repeat(64)),/capture_refused/);
  const target=await publish(id); await assert.rejects(()=>issue(id,target),/capture_refused/);
  await sql(`INSERT INTO storage.objects(bucket_id,name,version) VALUES('post-media',${q(path)},'v1')`);
  const [first,retry] = await Promise.all([issue(id,target),issue(id,target)]);
  assert.match(first,/^[0-9a-f-]{36}$/); assert.notEqual(first,id); assert.equal(retry,first);
  assert.equal(await read(target),'1');
  await assert.rejects(()=>issue(id,awaitableTarget),/capture_refused/);
  const second=await open(bob); await assert.rejects(()=>seal(second,bob),/capture_refused/);
 });
 const awaitableTarget='99999999-9999-4999-8999-999999999999';
 test('a different owner, secret, imported URL, deleted asset or target substitution cannot borrow the stamp',async()=>{
  const id=await open(); await assert.rejects(()=>seal(id,bob),/capture_refused/);await assert.rejects(()=>seal(id,alice,'0'.repeat(64)),/capture_refused/);
  const path=await seal(id),target=await publish(id),other=await publish(id,'post',bob);
  await sql(`INSERT INTO storage.objects(bucket_id,name,version) VALUES('post-media',${q(path)},'v1')`);
  await assert.rejects(()=>issue(id,other),/capture_refused/);await assert.rejects(()=>issue(id,target,'post',bob),/capture_refused/);
  await issue(id,target);const fresh=await publish(id);await assert.rejects(()=>issue(id,fresh),/capture_refused/);
  await sql(`UPDATE post_media SET storage_path='import.mp4' WHERE post_id=${q(target)}`);assert.equal(await read(target),'0');
  await sql(`UPDATE post_media SET storage_path=${q(path)},moderation_status='rejected' WHERE post_id=${q(target)}`);assert.equal(await read(target),'0');
  await sql(`UPDATE post_media SET moderation_status='approved' WHERE post_id=${q(target)}; UPDATE storage.objects SET version='v2'`);assert.equal(await read(target),'0');
  await sql(`DELETE FROM posts WHERE id=${q(target)}`);assert.equal(await read(target),'0');await assert.rejects(()=>issue(id,fresh),/capture_refused/);
 });
 test('a Story stamp expires with its Story and a timed-out challenge cannot seal',async()=>{
  const id=await open(),path=await seal(id),target=await publish(id,'story');
  await sql(`INSERT INTO storage.objects(bucket_id,name,version) VALUES('post-media',${q(path)},'v1')`);
  assert.notEqual(await issue(id,target,'story'),id);assert.equal(await read(target,'story'),'1');
  await sql(`UPDATE stories SET expires_at=now()-interval '1 second' WHERE id=${q(target)}`);assert.equal(await read(target,'story'),'0');
  const expired=await open();await sql(`UPDATE recording_capture_stamps SET expires_at=now() WHERE id=${q(expired)}`);await assert.rejects(()=>seal(expired),/capture_refused/);
 });
 test('public roles cannot mint, introspect or write a protected storage original directly',async()=>{
  const id=await open(),path=await seal(id);
  await assert.rejects(()=>sql(`SET ROLE authenticated; SELECT seal_recording_capture(${[alice,id,hash,digest,'mp4'].map(q)})`),/permission denied/);
  await assert.rejects(()=>sql('SET ROLE anon; SELECT * FROM recording_capture_stamps'),/permission denied/);
  await assert.rejects(()=>sql(`SET ROLE authenticated; INSERT INTO storage.objects(bucket_id,name) VALUES('post-media',${q(path)})`),/row-level security/);
  await sql(`SET ROLE authenticated; INSERT INTO storage.objects(bucket_id,name) VALUES('post-media','ordinary/clip.mp4')`);
  await assert.rejects(()=>sql(`SET ROLE authenticated; UPDATE storage.objects SET name=${q(path)} WHERE name='ordinary/clip.mp4'`),/row-level security/);
  await sql(`INSERT INTO storage.objects(bucket_id,name) VALUES('post-media',${q(path)})`);
  await sql(`SET ROLE authenticated; DELETE FROM storage.objects WHERE name=${q(path)}`);
  assert.equal(await sql(`SELECT count(*) FROM storage.objects WHERE name=${q(path)}`),'1');
 });
});
