import { before,after,beforeEach,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const A='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000001',C='cccccccc-0000-4000-8000-000000000001';
const S='11111111-0000-4000-8000-000000000001',T='22222222-0000-4000-8000-000000000001',M='33333333-0000-4000-8000-000000000001',J='44444444-0000-4000-8000-000000000001',R='55555555-0000-4000-8000-000000000001';
let db:PGlite;
const raw=`post-media/${A}/old.jpg`;
const path=`${A}/telegraph-forwards/${J}/0`;
const snapshot=['',raw,'image','media',null];
before(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE message_threads(id uuid PRIMARY KEY,is_e2ee boolean,status text,last_message_at timestamptz,updated_at timestamptz);
 CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),content_ref text,thread_id uuid REFERENCES message_threads(id),sender_id uuid,body text,msg_type text,subtype text,media_url text,media_type text,media_thumbnail_url text,deleted_at timestamptz,unsent_at timestamptz,ciphertext text,sequence bigint DEFAULT 10,created_at timestamptz DEFAULT now());
 CREATE TABLE message_thread_members(thread_id uuid,user_id uuid,left_at timestamptz,visible_from_at timestamptz,visible_from_sequence bigint,visible_until_sequence bigint);
 CREATE TABLE blocks(blocker_id uuid,blocked_id uuid);
 CREATE TABLE message_content_capabilities(message_id uuid PRIMARY KEY,capability text,set_by uuid,updated_at timestamptz);
 CREATE TABLE message_forwards(target_message_id uuid,source_message_id uuid,provenance text,capability text,forwarded_by uuid);
 `);
 const previous=readFileSync(new URL('../migrations/3665_telegraph_forwarding_and_structured_schemas.sql',import.meta.url),'utf8');
 await db.exec(previous.slice(previous.indexOf('CREATE OR REPLACE FUNCTION public.telegraph_record_forward('),previous.indexOf('COMMENT ON FUNCTION public.telegraph_record_forward(')));
 await db.exec(readFileSync(new URL('../migrations/4016_telegraph_attachment_forwards.sql',import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
 await db.exec(`TRUNCATE telegraph_forward_media_jobs,messages,message_threads,message_thread_members,blocks,message_content_capabilities,message_forwards CASCADE;
 INSERT INTO message_threads(id,is_e2ee,status) VALUES('${S}',false,'active'),('${T}',false,'active');
 INSERT INTO messages(id,thread_id,sender_id,body,msg_type,media_url,media_type,sequence) VALUES('${M}','${S}','${A}','','media','${raw}','image',5);
 INSERT INTO message_thread_members(thread_id,user_id) VALUES('${S}','${A}'),('${T}','${A}'),('${T}','${B}');`);
});
async function prepare(actor=A,key=R,id=J){return (await db.query<{result:any}>('SELECT telegraph_prepare_media_forward($1,$2,$3,$4,$5,1,$6::jsonb) result',[id,key,M,T,actor,JSON.stringify(snapshot)])).rows[0].result;}
async function finish(url=`post-media/${path}`,type:string|null='image'){return (await db.query<{result:any}>('SELECT telegraph_finish_media_forward($1,$2,$3,$4,$5,$6) result',[J,'','media',url,type,null])).rows[0].result;}
async function access(user:string,p=path){return (await db.query<{ok:boolean}>('SELECT telegraph_can_read_forward_media($1,$2,$3) ok',[J,user,p])).rows[0].ok;}
async function count(table:string){return Number((await db.query<{n:string}>(`SELECT count(*) n FROM ${table}`)).rows[0].n);}
describe('4016 attachment copy commit and revocation',()=>{
 it('the reference overload runs the real existing writer and commits its pointer atomically',async()=>{
  const args=[M,T,A,'shared body','portava_object','place','RESHARED_FROM_SOURCE','SOURCE_POLICY','portava-object.v1:PLACE:'+M];
  const result=(await db.query<{r:any}>('SELECT telegraph_record_forward($1,$2,$3,$4,$5,$6,$7,$8,$9) r',args)).rows[0].r;
  assert.equal(result.outcome,'forwarded');const row=(await db.query<{content_ref:string}>('SELECT content_ref FROM messages WHERE id=$1',[result.messageId])).rows[0];assert.equal(row.content_ref,args[8]);assert.equal(await count('message_forwards'),1);
  await db.exec(`CREATE FUNCTION reject_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.content_ref IS NOT NULL THEN RAISE EXCEPTION 'pointer failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_pointer BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_pointer();`);
  try{await assert.rejects(db.query('SELECT telegraph_record_forward($1,$2,$3,$4,$5,$6,$7,$8,$9)',args),/pointer failed/);assert.equal(await count('messages'),2);assert.equal(await count('message_forwards'),1);}finally{await db.exec('DROP TRIGGER reject_pointer ON messages;DROP FUNCTION reject_pointer()');}
 });

 it('journals before upload, then atomically publishes media and private provenance',async()=>{
  const p=await prepare();assert.equal(p.outcome,'prepared');assert.ok(p.paths.includes(path));assert.equal(await count('messages'),1);
  assert.equal(await access(A),false);const f=await finish();assert.equal(f.messageId,J);assert.equal(await count('message_forwards'),1);
  const row=(await db.query<{media_url:string;body:string}>('SELECT * FROM messages WHERE id=$1',[J])).rows[0];assert.equal(row.media_url,`post-media/${path}`);assert.equal(row.body,'');
  assert.equal(await access(A),true);assert.equal(await access(B),true);assert.equal(await access(C),false);
 });
 it('a repeated request is busy during processing and replays one completed message',async()=>{await prepare();assert.equal((await prepare()).outcome,'busy');await finish();assert.equal((await prepare()).outcome,'replay');assert.equal(await count('message_forwards'),1);});
 it('rejects an edit before preparation and another edit during copy',async()=>{
  await db.exec(`UPDATE messages SET body='changed' WHERE id='${M}'`);await assert.rejects(prepare(),/forward_source_changed/);
  await db.exec(`UPDATE messages SET body='' WHERE id='${M}'`);await prepare();await db.exec(`UPDATE messages SET media_url='another' WHERE id='${M}'`);await assert.rejects(finish(),/forward_source_changed/);assert.equal(await count('message_forwards'),0);
 });
 it('rechecks source deletion, unsend, departure, capability and encryption at commit',async()=>{
  for(const sql of [`UPDATE messages SET deleted_at=now() WHERE id='${M}'`,`UPDATE messages SET unsent_at=now() WHERE id='${M}'`,`UPDATE message_thread_members SET left_at=now() WHERE thread_id='${S}'`,`INSERT INTO message_content_capabilities VALUES('${M}','NO_FORWARD')`,`UPDATE message_threads SET is_e2ee=true WHERE id='${T}'`]){
   await db.exec('BEGIN');await prepare();await db.exec(sql);await assert.rejects(finish(),/forward_(unavailable|restricted|source_changed)/);await db.exec('ROLLBACK');
  }
 });
 it('source policy belongs to the source author, and history bounds still apply to explicit ALLOW',async()=>{
  await db.exec(`INSERT INTO message_thread_members(thread_id,user_id) VALUES('${S}','${B}')`);
  await assert.rejects(prepare(B),/forward_restricted/);await db.exec(`INSERT INTO message_content_capabilities VALUES('${M}','ALLOW'); UPDATE message_thread_members SET visible_from_sequence=6 WHERE user_id='${B}' AND thread_id='${S}'`);
  await assert.rejects(prepare(B),/forward_unavailable/);
 });
 it('never commits a URL outside the prepared private namespace or an unknown type',async()=>{
  await prepare();for(const url of [raw,'https://external.invalid/x','post-media/'+A+'/telegraph-forwards/'+R+'/0'])await assert.rejects(finish(url),/invalid_forward_attachment/);
  await assert.rejects(finish(undefined,null),/invalid_forward_attachment/);assert.equal(await count('messages'),1);
 });
 it('the provenance insert failing rolls the whole message commit back',async()=>{
  await prepare();await db.exec(`CREATE FUNCTION reject_forward() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reject provenance'; END $$; CREATE TRIGGER reject_forward BEFORE INSERT ON message_forwards FOR EACH ROW EXECUTE FUNCTION reject_forward();`);
  try{await assert.rejects(finish(),/reject provenance/);assert.equal(await count('messages'),1);assert.equal((await db.query<{state:string}>('SELECT state FROM telegraph_forward_media_jobs')).rows[0].state,'preparing');}finally{await db.exec('DROP TRIGGER reject_forward ON message_forwards;DROP FUNCTION reject_forward()');}
 });
 it('copied bytes are denied on tombstone, departure, history bounds and block, including owner tombstones',async()=>{
  await prepare();await finish();
  for(const sql of [`UPDATE messages SET deleted_at=now() WHERE id='${J}'`,`UPDATE message_thread_members SET left_at=now() WHERE thread_id='${T}' AND user_id='${B}'`,`UPDATE message_thread_members SET visible_from_sequence=11 WHERE user_id='${B}'`,`INSERT INTO blocks VALUES('${A}','${B}')`]){await db.exec('BEGIN');await db.exec(sql);assert.equal(await access(B),false);if(sql.includes('deleted_at'))assert.equal(await access(A),false);await db.exec('ROLLBACK');}
 });
 it('cleanup claims old jobs before removal and makes late commits impossible',async()=>{
  await prepare();await db.exec("UPDATE telegraph_forward_media_jobs SET expires_at=now()-interval '1 second'");
  assert.equal((await db.query('SELECT * FROM telegraph_claim_forward_media_cleanup()')).rows.length,1);await assert.rejects(finish(),/forward_unavailable/);
 });
 it('a live committed copy is retained, and tombstoned or hard-deleted copies are claimed',async()=>{
  await prepare();await finish();assert.equal((await db.query('SELECT * FROM telegraph_claim_forward_media_cleanup()')).rows.length,0);
  await db.exec(`DELETE FROM messages WHERE id='${J}'`);assert.equal((await db.query('SELECT * FROM telegraph_claim_forward_media_cleanup()')).rows.length,1);
 });
 it('the capability writer rechecks authorship, membership and derivative status under the source lock',async()=>{
  await db.query('SELECT telegraph_set_content_capability($1,$2,$3)',[M,A,'ALLOW']);
  assert.equal((await db.query<{capability:string}>('SELECT capability FROM message_content_capabilities')).rows[0].capability,'ALLOW');
  await assert.rejects(db.query('SELECT telegraph_set_content_capability($1,$2,$3)',[M,B,'NO_FORWARD']),/forward_policy_unavailable/);
  await prepare();await finish();await assert.rejects(db.query('SELECT telegraph_set_content_capability($1,$2,$3)',[J,A,'ALLOW']),/forward_policy_unavailable/);
 });
 it('ordinary clients cannot read lineage or invoke the copy writers',async()=>{
  for(const role of ['anon','authenticated']){await db.exec(`SET ROLE ${role}`);try{await assert.rejects(db.query('SELECT * FROM telegraph_forward_media_jobs'),/permission denied/);await assert.rejects(prepare(),/permission denied/);}finally{await db.exec('RESET ROLE');}}
 });
});
