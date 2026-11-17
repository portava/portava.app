import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const actor='10000000-0000-4000-8000-000000000032';
const other='10000000-0000-4000-8000-000000000033';
async function database() {
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${other}');
  CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text);GRANT SELECT ON feature_flags TO service_role;`);
 for(const file of ['3780_input_outcome_learning','3783_input_outcome_task_aggregate','4029_input_outcome_consent_fence','4032_input_outcome_memory_current_consent']) {
  await db.exec(readFileSync(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
 }
 await db.exec(`UPDATE feature_flags SET enabled=true;INSERT INTO input_outcome_consent(user_id,enabled,consent_version,consented_at) VALUES
  ('${actor}',true,'input_outcome_learning_v1',now()),('${other}',true,'input_outcome_learning_v1',now());
  INSERT INTO input_outcome_counters(user_id,context,entity_type,entity_id,completed_count,bucket_day) VALUES
   ('${actor}','city_picker','city','kept-city',3,current_date),
   ('${other}','city_picker','city','other-account-city',7,current_date),
   ('${actor}','different_context','city','other-context-city',9,current_date),
   ('${actor}','city_picker','city','expired-city',99,current_date-30);`);
 return db;
}
async function memory(db:PGlite,id=actor) {
 return (await db.query<{value:any}>("SELECT input_outcome_memory($1,'city_picker',current_date-29) value",[id])).rows[0]!.value;
}
test('actual4032: current grant reads only this owner/context/window; old disclosure cannot influence ranking',async()=>{
 const db=await database();try {
  await db.exec('SET ROLE service_role');
  assert.deepEqual(await memory(db),{active:true,counts:[{entity_type:'city',entity_id:'kept-city',completed:3}]});
  await db.exec(`UPDATE input_outcome_consent SET consent_version='old_disclosure' WHERE user_id='${actor}'`);
  assert.deepEqual(await memory(db),{active:false});
  assert.deepEqual(await memory(db,other),{active:true,counts:[{entity_type:'city',entity_id:'other-account-city',completed:7}]});
 }finally{await db.close();}
});
test('disabled, withdrawn, missing and flag-off consent cannot read retained counters',async()=>{
 const db=await database();try {
  for(const assignment of ["enabled=false","enabled=true,withdrawn_at=now()"]){
   await db.exec(`UPDATE input_outcome_consent SET ${assignment} WHERE user_id='${actor}'`);
   assert.deepEqual(await memory(db),{active:false});
  }
  await db.exec(`UPDATE input_outcome_consent SET enabled=true,withdrawn_at=null WHERE user_id='${actor}';UPDATE feature_flags SET enabled=false;`);
  assert.deepEqual(await memory(db),{active:false});
  await db.exec(`UPDATE feature_flags SET enabled=true;DELETE FROM input_outcome_consent WHERE user_id='${actor}'`);
  assert.deepEqual(await memory(db),{active:false});
  assert.equal((await db.query<{n:number}>(`SELECT count(*)::int n FROM input_outcome_counters WHERE user_id='${actor}'`)).rows[0]!.n,3,'reader refuses even while cleanup has not removed counters');
 }finally{await db.close();}
});
test('reader is a service-only invoker; ordinary roles cannot fetch a different owner',async()=>{
 const db=await database();try {
  const rights=(await db.query<any>(`SELECT has_function_privilege('anon','input_outcome_memory(uuid,text,date)','EXECUTE') anon,
   has_function_privilege('authenticated','input_outcome_memory(uuid,text,date)','EXECUTE') authenticated,
   has_function_privilege('service_role','input_outcome_memory(uuid,text,date)','EXECUTE') service,
   (SELECT prosecdef FROM pg_proc WHERE oid='input_outcome_memory(uuid,text,date)'::regprocedure) definer`)).rows[0];
  assert.deepEqual(rights,{anon:false,authenticated:false,service:true,definer:false});
  await db.exec('SET ROLE authenticated');await assert.rejects(memory(db,other),/permission denied/);
  await db.exec('RESET ROLE;SET ROLE service_role');assert.equal((await memory(db)).active,true);
 }finally{await db.close();}
});
