import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { VideoSegmentNativeCluster } from './memoryVideoSegmentsPostgresFixture.js';
const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', author='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const post='cccccccc-cccc-4ccc-8ccc-cccccccccccc', memory='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const cluster = binary ? new VideoSegmentNativeCluster(binary) : null;
async function sql(script:string){const connection=cluster!.session();try{return await connection.query(script+';');}finally{await connection.close();}}
function migration(name:string){return readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');}
function literal(value:string|null){return value===null?'NULL':`'${value.replaceAll("'","''")}'`;}
function save({operation=randomUUID(),destination='memory',target=null,actor=owner,title='My saved posts',visibility=null}:{operation?:string;destination?:string;target?:string|null;actor?:string;title?:string;visibility?:string|null}={}) {
 return `SELECT share_post_to_destination('${actor}','${post}','${operation}',${literal(destination)},${literal(target)},${literal(title)},NULL,${literal(visibility)})`;
}
async function runSave(options:Parameters<typeof save>[0]={}) {return JSON.parse(await sql(`SET ROLE service_role; ${save(options)}`));}
describe('Post reference destinations: real PostgreSQL 17',{skip:!binary?'PORTAVA_TEST_POSTGRES_BIN is required for the native gate':false},()=>{
 before(async()=>{
  await cluster!.start();
  // This is a fresh private Unix-socket cluster. Replace its segment fixture
  // with the destination schema and apply the real canonical kernel migrations.
  await sql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER ROLE service_role BYPASSRLS;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
   CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),account_status text DEFAULT 'active',is_private boolean DEFAULT false);
   CREATE TABLE user_account_states(user_id uuid REFERENCES profiles(id),state text,expires_at timestamptz);
   CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid REFERENCES profiles(id),status text DEFAULT 'active',post_status text DEFAULT 'published',visibility text DEFAULT 'public',deleted_at timestamptz,sharing_disabled boolean DEFAULT false,reposting_disabled boolean DEFAULT false);
   CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);
   CREATE TABLE user_follows(follower_id uuid REFERENCES profiles(id),following_id uuid REFERENCES profiles(id),PRIMARY KEY(follower_id,following_id));
   CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean NOT NULL,description text);
   CREATE TABLE memories(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid REFERENCES profiles(id),title text,caption text,visibility text,allowed_user_ids uuid[],hidden_user_ids uuid[],trip_id uuid,event_id uuid,place_id text,location_city text,location_country text,location_lat double precision,location_lng double precision,canonical_location_id uuid,starts_at timestamptz,ends_at timestamptz,state text,location_precision text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
   CREATE TABLE memory_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),memory_id uuid REFERENCES memories(id) ON DELETE CASCADE,media_url text NOT NULL,media_type text NOT NULL,caption text,position integer,source_post_id uuid);
   CREATE TABLE highlights(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid REFERENCES profiles(id),media_url text NOT NULL,media_type text NOT NULL,video_duration_seconds double precision,caption text,location_name text,location_city text,location_country text,visibility text,expires_at timestamptz,lifetime_class text,filter_id text,filter_intensity integer,pinned_at timestamptz,archived_at timestamptz,deleted_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
   GRANT USAGE ON SCHEMA public,auth TO service_role,anon,authenticated;`);
  await sql('ALTER TABLE memories ADD COLUMN memory_type text, ADD COLUMN place_display_name_at_occurrence text; CREATE TABLE memory_tags(memory_id uuid REFERENCES memories(id), tagged_user_id uuid REFERENCES profiles(id), status text, PRIMARY KEY(memory_id,tagged_user_id))');
  for(const name of ['2710_memory_command_kernel_tables.sql','2711_memory_kernel_execute.sql','2993_highlight_command_boundary.sql','3677_highlight_lifecycle_events.sql','3911_memory_kernel_create_participants_and_canonical_fields.sql']) await sql(migration(name));
  await sql("ALTER TABLE posts ADD COLUMN media_urls text[] DEFAULT '{}'; CREATE TABLE post_media(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),post_id uuid REFERENCES posts(id) ON DELETE CASCADE,public_url text,storage_bucket text,storage_path text,processing_status text,moderation_status text)");
  await sql(readFileSync(new URL('./fixtures/hosted4000MemorySourceGuard.sql',import.meta.url),'utf8'));
  await sql('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role');
  await sql(migration('4007_post_reference_destinations.sql'));
  await sql('ALTER TABLE posts ADD COLUMN content text, ADD COLUMN created_by uuid, ADD COLUMN updated_by uuid, ADD COLUMN source text');
  await sql(migration('4018_profile_post_references.sql'));
  await sql(migration('4020_uploaded_highlight_receipts.sql'));
 });
 after(async()=>{await cluster?.close();});
 beforeEach(async()=>{
  await sql(`TRUNCATE auth.users,profiles,posts,blocks,memories,memory_items,highlights,post_destination_references,post_destination_operations,memory_domain_events,memory_event_outbox,memory_command_receipts,memory_command_audit CASCADE;
   INSERT INTO auth.users VALUES('${owner}'),('${author}'); INSERT INTO profiles(id) VALUES('${owner}'),('${author}');
   INSERT INTO posts(id,author_id) VALUES('${post}','${author}');
   INSERT INTO memories(id,owner_id,title,state,visibility) VALUES('${memory}','${owner}','Existing','published','only_me');`);
 });
 for (const kernel of [false,true]) test('direct Highlight upload retries across kernel rollout: '+kernel, async () => {
  const key=randomUUID();
  const payload={uploaded_highlight_receipt:true,media_url:'post-media/'+owner+'/clip.mp4',media_type:'video/mp4',
    video_duration_seconds:6,expires_in_hours:24,visibility:'public',filter_id:'original',filter_intensity:100,
    verified_thumbnail_url:'post-media/'+owner+'/clip.mp4.poster.jpg',source_memory_ids:[]};
  const write=(events:boolean,caption:string) => sql(`SELECT submit_uploaded_highlight('${JSON.stringify({command_id:randomUUID(),actor_user_id:owner,
    type:'CREATE_HIGHLIGHT',idempotency_key:key,payload:{...payload,caption}})}'::jsonb, ${events})`).then(JSON.parse);
  const [one,two]=await Promise.all([write(kernel,'video'),write(kernel,'video')]);
  assert.equal(one.ok,true);assert.equal(two.ok,true);assert.equal(one.result.id,two.result.id);
  assert.equal((await write(!kernel,'video')).result.id,one.result.id);
  assert.equal((await write(kernel,'edited')).reason,'MEMORY_IDEMPOTENCY_KEY_REUSED');
  assert.equal(await sql('SELECT count(*) FROM highlights'),'1');
  assert.equal(await sql('SELECT count(*) FROM memory_domain_events'),kernel?'2':'0');
  assert.equal(await sql('SELECT media_thumbnail_url FROM highlights'),payload.verified_thumbnail_url);
  await sql('DELETE FROM highlights');
  assert.equal((await write(kernel,'video')).reason,'HIGHLIGHT_NOT_FOUND');
 });
 test('new Memory and reference commit with canonical events and no copied media',async()=>{
  const r=await runSave();assert.equal(r.memoryCreated,true);
  assert.equal(await sql(`SELECT visibility FROM memories WHERE id='${r.memoryId}'`),'only_me');
  assert.equal(await sql('SELECT media_type||\'|\'||media_url FROM memory_items'),`application/vnd.portava.post-reference+json|portava-post-reference:${r.referenceId}`);
  assert.equal(await sql('SELECT count(*) FROM memory_domain_events'),'2');assert.equal(await sql('SELECT count(*) FROM memory_event_outbox'),'2');
  assert.equal(await sql('SELECT count(*) FROM memory_command_audit'),'2');assert.equal(await sql('SELECT source_post_id IS NULL FROM memory_items'),'t');
 });
 test('profile repost keeps provenance, survives a retry and stops replay after removal', async () => {
  const operation=randomUUID();
  const write=`SELECT share_post_to_profile('${owner}','${post}','${operation}','My note','public')`;
  const first=JSON.parse(await sql(write));
  assert.equal(first.profilePostId,first.referenceId);
  assert.equal(await sql(`SELECT content FROM posts WHERE post_reference_id='${first.referenceId}'`),'My note');
  const replay=JSON.parse(await sql(write)); assert.equal(replay.profilePostId,first.profilePostId); assert.equal(replay.replayed,true);
  await assert.rejects(sql(write.replace('My note','A different note')),/destination_intent_conflict/);
  await sql(`DELETE FROM posts WHERE id='${first.profilePostId}'`); await assert.rejects(sql(write),/destination_unavailable/);
 });
 test('Highlight creates two lifecycle events and expires after 24 hours',async()=>{
  const r=await runSave({destination:'highlight'});assert.ok(r.highlightId);assert.equal(r.memoryId,null);
  assert.equal(await sql("SELECT visibility||':'||(expires_at-created_at=interval '24 hours')::text FROM highlights"),'public:true');
  assert.equal(await sql("SELECT string_agg(type,',' ORDER BY sequence) FROM memory_domain_events"),'highlight.created,highlight.published');
 });
 test('hosted4000 source-copy guard coexists with references without widening byte-copy ownership',async()=>{
  const shared=await runSave({target:memory});
  assert.ok(shared.referenceId);
  assert.equal(await sql('SELECT source_post_id IS NULL FROM memory_items'),'t');
  const url='post-media/synthetic/owned.jpg';
  await sql(`INSERT INTO post_media(post_id,storage_bucket,storage_path,processing_status,moderation_status) VALUES('${post}','post-media','synthetic/owned.jpg','ready','approved')`);
  const copy=`INSERT INTO memory_items(memory_id,media_url,media_type,source_post_id) VALUES('${memory}','${url}','image/jpeg','${post}')`;
  await assert.rejects(sql(copy),/Memory's own owner/);
  await sql(`UPDATE posts SET author_id='${owner}' WHERE id='${post}'`);
  await sql(copy);
  await sql("UPDATE post_media SET moderation_status='rejected'");
  await assert.rejects(sql(copy),/Memory's own owner/);
  assert.equal(await sql('SELECT count(*) FROM memory_items'),'2');
 });
 test('retry is exact and does not duplicate any event or item',async()=>{
  const operation=randomUUID();const one=await runSave({operation});const two=await runSave({operation});assert.equal(one.referenceId,two.referenceId);assert.equal(two.replayed,true);
  assert.equal(await sql('SELECT count(*) FROM memory_items'),'1');assert.equal(await sql('SELECT count(*) FROM memory_domain_events'),'2');
  await assert.rejects(sql(save({operation,title:'changed'})),/destination_intent_conflict/);
 });
 test('same source in an existing Memory deduplicates distinct intents without changing its audience',async()=>{
  const one=await runSave({target:memory,visibility:'public'});const operation=randomUUID();const two=await runSave({target:memory,operation});
  assert.equal(one.referenceId,two.referenceId);assert.equal(await sql('SELECT count(*) FROM memory_items'),'1');
  assert.equal(await sql(`SELECT visibility FROM memories WHERE id='${memory}'`),'only_me');assert.equal((await runSave({target:memory,operation})).referenceId,one.referenceId);
 });
 test('deleted destination is not resurrected by a delayed retry',async()=>{
  const operation=randomUUID();const one=await runSave({operation});await sql(`DELETE FROM memories WHERE id='${one.memoryId}'`);
  await assert.rejects(sql(save({operation})),/destination_unavailable/);assert.equal(await sql('SELECT count(*) FROM memory_items'),'0');
 });
 test('moderated, private, disabled and blocked sources cannot be reposted',async()=>{
  for(const change of ["visibility='private'","post_status='draft'","status='removed'","deleted_at=now()","sharing_disabled=true","reposting_disabled=true"]){
   await sql(`UPDATE posts SET visibility='public',post_status='published',status='active',deleted_at=NULL,sharing_disabled=false,reposting_disabled=false; UPDATE posts SET ${change}`);
   await assert.rejects(sql(save()),/source_post_unavailable/);
  }
  await sql(`UPDATE posts SET reposting_disabled=false; INSERT INTO blocks VALUES('${author}','${owner}')`);await assert.rejects(sql(save()),/source_post_unavailable/);
  await sql(`DELETE FROM blocks; UPDATE profiles SET account_status='suspended' WHERE id='${author}'`);await assert.rejects(sql(save()),/source_post_unavailable/);
  assert.equal(await sql('SELECT count(*) FROM memory_items'),'0');
 });
 test('in-force canonical bans or suspensions refuse either actor, expired restrictions do not',async()=>{
  for(const user of [owner,author]){
   await sql(`INSERT INTO user_account_states VALUES('${user}','suspended',NULL)`);
   await assert.rejects(sql(save()),/source_post_unavailable/);
   await sql('DELETE FROM user_account_states');
  }
  await sql(`INSERT INTO user_account_states VALUES('${author}','suspended',now()-interval '1 hour')`);
  assert.ok((await runSave()).referenceId);
 });
 test('private source accounts require a current approved follow, including after revocation',async()=>{
  await sql(`UPDATE profiles SET is_private=true WHERE id='${author}'`);
  await assert.rejects(sql(save()),/source_post_unavailable/);
  assert.equal(await sql('SELECT count(*) FROM post_destination_references'),'0');
  await sql(`INSERT INTO user_follows VALUES('${owner}','${author}')`);
  assert.ok((await runSave()).referenceId);
  await sql('DELETE FROM user_follows');
  await assert.rejects(sql(save()),/source_post_unavailable/);
 });
 test('only the destination owner may add and terminal destinations stay terminal',async()=>{
  await assert.rejects(sql(save({target:memory,actor:author})),/destination_unavailable/);
  for(const state of ['archived','removed','deleted']){await sql(`UPDATE memories SET state='${state}' WHERE id='${memory}'`);await assert.rejects(sql(save({target:memory})),/destination_unavailable/);}
 });
 test('failed canonical outbox rolls back destination, provenance and operation receipt',async()=>{
  await sql("CREATE FUNCTION reject_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$; CREATE TRIGGER reject_test_outbox BEFORE INSERT ON memory_event_outbox FOR EACH ROW EXECUTE FUNCTION reject_test_outbox()");
  try {await assert.rejects(sql(save()),/outbox unavailable/);assert.equal(await sql('SELECT count(*) FROM memory_items'),'0');assert.equal(await sql('SELECT count(*) FROM post_destination_references'),'0');assert.equal(await sql('SELECT count(*) FROM post_destination_operations'),'0');assert.equal(await sql('SELECT count(*) FROM memories'),'1');}
  finally {await sql('DROP TRIGGER reject_test_outbox ON memory_event_outbox; DROP FUNCTION reject_test_outbox()');}
 });
 test('provenance is mandatory and client roles cannot forge it or call the RPC',async()=>{
  await assert.rejects(sql(`INSERT INTO memory_items(memory_id,media_url,media_type) VALUES('${memory}','portava-post-reference:${post}','application/vnd.portava.post-reference+json')`),/post_reference_provenance_required/);
  for(const role of ['anon','authenticated']){await assert.rejects(sql(`SET ROLE ${role}; ${save()}`),/permission denied/);await assert.rejects(sql(`SET ROLE ${role}; SELECT * FROM post_destination_references`),/permission denied/);}
 });
 test('two concurrent retries return one canonical destination',async()=>{
  const operation=randomUUID();const results=await Promise.all([runSave({operation}),runSave({operation})]);
  assert.equal(results[0].referenceId,results[1].referenceId);assert.equal(await sql('SELECT count(*) FROM memory_items'),'1');
 });
});
