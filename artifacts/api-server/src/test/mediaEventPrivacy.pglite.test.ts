import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
const POST='20000000-0000-4000-8000-000000000001',ASSET='20000000-0000-4000-8000-000000000002',GEM='20000000-0000-4000-8000-000000000003';
async function setup() {
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text);INSERT INTO profiles VALUES('${A}','active'),('${B}','active');
  CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid,created_by uuid);INSERT INTO posts VALUES('${POST}','${A}','${A}');
  CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid,uploader_user_id uuid);INSERT INTO media_assets VALUES('${ASSET}','${A}','${A}');
  CREATE TABLE hidden_gems(id uuid PRIMARY KEY,submitted_by uuid);INSERT INTO hidden_gems VALUES('${GEM}','${A}');
  CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text,metadata jsonb);`);
 await db.exec(readFileSync(new URL('../migrations/2039_media_events.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../migrations/4031_media_event_erasure_and_retention.sql',import.meta.url),'utf8'));
 await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON profiles,posts,media_assets,hidden_gems,feature_flags,media_events TO service_role;');
 return db;
}
async function insert(db:PGlite,payload:unknown,type='impression') {
 return (await db.query('INSERT INTO media_events(event_type,payload) VALUES($1,$2) RETURNING id',[type,JSON.stringify(payload)])).rows.length;
}
async function erase(db:PGlite,limit=500) {return (await db.query<{r:{deleted:number;more:boolean}}>('SELECT erase_media_events_for_actor($1,$2) r',[A,limit])).rows[0]!.r;}
async function purge(db:PGlite,limit=500) {return (await db.query<{r:{deleted:number;more:boolean;enabled:boolean}}>('SELECT purge_expired_media_events($1) r',[limit])).rows[0]!.r;}
const composer={version:1,surface:'post',outcome:'published'};
test('actor, creator and canonical-only references erase in bounded pages; anonymous composer privacy stays intact',async()=>{
 const db=await setup();try {
  for(const payload of [{viewer_id:A},{viewer_id:B,creator_id:A},{viewer_id:B,media_id:POST},{viewer_id:B,media_id:ASSET},{viewer_id:B,gem_id:GEM}]) assert.equal(await insert(db,payload),1);
  assert.equal(await insert(db,{viewer_id:B}),1); assert.equal(await insert(db,composer,'composer_outcome'),1);
  await db.exec('SET ROLE service_role');
  assert.deepEqual(await erase(db,2),{deleted:2,more:true});
  assert.equal(await insert(db,{viewer_id:A}),0);assert.equal(await insert(db,{viewer_id:B,media_id:POST}),0);
  assert.deepEqual(await erase(db,2),{deleted:2,more:true});assert.deepEqual(await erase(db,2),{deleted:1,more:false});
  assert.deepEqual(await erase(db),{deleted:0,more:false});
  const rows=(await db.query<{payload:any}>('SELECT payload FROM media_events')).rows;
  assert.equal(rows.length,2);assert.ok(rows.some(r=>r.payload.viewer_id===B));assert.ok(rows.some(r=>r.payload.surface==='post'));
  await db.exec('RESET ROLE');
  const allowed=(await db.query<any>(`SELECT has_function_privilege('authenticated','erase_media_events_for_actor(uuid,integer)','EXECUTE') erase,has_function_privilege('anon','purge_expired_media_events(integer)','EXECUTE') purge,has_table_privilege('authenticated','media_event_erasure_fences','SELECT') read`)).rows[0];
  assert.deepEqual(allowed,{erase:false,purge:false,read:false});
 }finally{await db.close();}
});
test('30-day purge requires the explicit legal-review marker as well as activation, bounds cleanup and preserves newer rows',async()=>{
 const db=await setup();try{
  await db.query(`INSERT INTO media_events(event_type,payload,occurred_at) SELECT 'composer_outcome',$1::jsonb,now()-interval '31 days' FROM generate_series(1,501)`,[JSON.stringify(composer)]);
  await insert(db,composer,'composer_outcome');
  assert.deepEqual(await purge(db),{enabled:false,deleted:0,more:false});
  await db.exec("UPDATE feature_flags SET enabled=true WHERE flag='media_event_retention_enabled'");
  assert.deepEqual(await purge(db),{enabled:false,deleted:0,more:false});
  await db.exec("UPDATE feature_flags SET metadata=metadata||'{\"policy_status\":\"approved_after_legal_review\"}'::jsonb WHERE flag='media_event_retention_enabled'");
  assert.deepEqual(await purge(db,9999),{enabled:true,deleted:500,more:true});assert.deepEqual(await purge(db),{enabled:true,deleted:1,more:false});
  assert.equal((await db.query('SELECT * FROM media_events')).rows.length,1);
  await db.exec("UPDATE media_events SET occurred_at=now()+interval '100 days'");
  assert.equal((await db.query<any>('SELECT occurred_at<=now() AS bounded FROM media_events')).rows[0].bounded,true);
 }finally{await db.close();}
});
test('all writers pass structured payload and deleted-account guards',async()=>{
 const db=await setup();try{
  for(const payload of [{viewer_id:A,text:'private'}, {viewer_id:A,failure_reason:'raw private error'}, {viewer_id:A,watched_ms:-1}, {viewer_id:A,media_id:{raw:'private'}}, {viewer_id:'not-a-uuid'}]) assert.equal(await insert(db,payload),0);
  assert.equal(await insert(db,{...composer,text:'unsent'},'composer_outcome'),0);
  assert.equal(await insert(db,{...composer,surface:null},'composer_outcome'),0);
  assert.equal(await insert(db,{...composer,outcome:null},'composer_outcome'),0);
  assert.equal(await insert(db,{...composer,failure_code:'raw message'},'composer_outcome'),0);
  await db.exec(`UPDATE profiles SET account_status='deleted' WHERE id='${B}'`);
  assert.equal(await insert(db,{viewer_id:B}),0);
  assert.equal(await insert(db,{viewer_id:A,media_id:'20000000-0000-4000-8000-000000000099'}),0);
 }finally{await db.close();}
});

test('composer admission checks actor transiently, preserves retry identity, and does not add an erasure mapping',async()=>{
 const db=await setup();try {
  const row={id:'30000000-0000-4000-8000-000000000001',event_type:'composer_outcome',payload:composer};
  const admit=async(actor:string)=>(await db.query<{ok:boolean}>('SELECT admit_composer_outcomes($1,$2) ok',[actor,JSON.stringify([row])])).rows[0]!.ok;
  await db.exec('SET ROLE service_role');
  assert.equal(await admit(A),true);assert.equal(await admit(A),true);
  assert.equal((await db.query('SELECT * FROM media_events')).rows.length,1);
  assert.deepEqual(await erase(db),{deleted:0,more:false});assert.equal(await admit(A),false);
  const saved=(await db.query<{payload:unknown}>('SELECT payload FROM media_events')).rows;
  assert.deepEqual(saved,[{payload:composer}]); // Existing unlinked outcomes are not claimed erased.
  await db.exec('RESET ROLE');
  assert.equal((await db.query<{allowed:boolean}>("SELECT has_function_privilege('authenticated','admit_composer_outcomes(uuid,jsonb)','EXECUTE') allowed")).rows[0]!.allowed,false);
 }finally{await db.close();}
});

test('composer service admission is atomic, exact duplicates succeed and malformed/conflicting batches never partially commit',async()=>{
 const db=await setup();try {
  const one={id:'30000000-0000-4000-8000-000000000041',event_type:'composer_outcome',payload:composer};
  const two={...one,id:'30000000-0000-4000-8000-000000000042'};
  const admit=async(rows:unknown[])=>(await db.query<{ok:boolean}>('SELECT admit_composer_outcomes($1,$2) ok',[A,JSON.stringify(rows)])).rows[0]!.ok;
  const count=async()=>(await db.query<{n:number}>('SELECT count(*)::int n FROM media_events')).rows[0]!.n;
  await db.exec('SET ROLE service_role');
  for (const payload of [{...composer,text:'private'}, {...composer,surface:null}, {...composer,outcome:'invalid'}, {...composer,failure_code:'network'}]) {
   await assert.rejects(admit([{...one,payload}]),/composer_admission_invalid/);assert.equal(await count(),0);
   await assert.rejects(admit([one,{...two,payload}]),/composer_admission_invalid/);assert.equal(await count(),0);
  }
  assert.equal(await admit([one,one]),true);assert.equal(await count(),1);assert.equal(await admit([one]),true);
  await assert.rejects(admit([{...one,payload:{...composer,outcome:'discarded_draft'}}]),/composer_admission_conflict/);assert.equal(await count(),1);
  await assert.rejects(admit([two,{...one,payload:{...composer,outcome:'discarded_draft'}}]),/composer_admission_conflict/);assert.equal(await count(),1);
  await assert.rejects(admit([two,{...two,payload:{...composer,outcome:'discarded_draft'}}]),/composer_admission_conflict/);assert.equal(await count(),1);
  assert.deepEqual((await db.query<{payload:unknown}>('SELECT payload FROM media_events')).rows,[{payload:composer}]);
 }finally{await db.close();}
});
