import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { dwellRowFor, dwellTokenFor } from '../lib/discoveryDwell.js';
const viewer='a0000000-0000-4000-8000-000000000001', other='a0000000-0000-4000-8000-000000000002';
const exposureId='b0000000-0000-4000-8000-000000000001', sessionId='c0000000-0000-4000-8000-000000000001';
const clientId='d0000000-0000-4000-8000-000000000001', rid='Ab3_-x9QzW7kLmN2pR4tUv', item='node/2001', servedAt='2026-11-14T03:00:00.123Z';
const measurements=[
 {kind:'active' as const,ms:4200,token:dwellTokenFor(viewer,clientId,'active',item)},
 {kind:'passive_foreground' as const,ms:9000,token:dwellTokenFor(viewer,clientId,'passive_foreground',item)},
 {kind:'idle' as const,ms:60000,token:dwellTokenFor(viewer,clientId,'idle',item)},
];
// Actual canonical DDL and PL/pgSQL in one PostgreSQL-compatible connection.
// This does not establish two-connection lock ordering or hosted performance.
describe('Discovery atomic dwell admission on executed canonical SQL',()=>{
 let db:PGlite;
 before(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
   CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
   CREATE TABLE auth.users(id uuid PRIMARY KEY);
   CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,account_status text NOT NULL DEFAULT 'active');
   CREATE TABLE public.feature_flags(flag text PRIMARY KEY,enabled boolean NOT NULL);
   INSERT INTO auth.users VALUES('${viewer}'),('${other}'); INSERT INTO profiles(id) VALUES('${viewer}'),('${other}');`);
  for(const file of ['0153_add_rank_events','0197_rank_events_analytics_columns','0202_rank_events_living_page_watch_feed_surfaces','2890_rank_events_behavior_engine_columns','2891_rank_events_recommendation_id','3375_rank_events_schema_version_admitted','4033_discovery_dwell_atomic_receipts'])
   await db.exec(readFileSync(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
  await db.exec('GRANT USAGE ON SCHEMA public,auth TO service_role; GRANT SELECT,INSERT,UPDATE ON rank_events,profiles,feature_flags TO service_role;');
 });
 after(async()=>{await db?.close();});
 beforeEach(async()=>{
  await db.exec(`RESET ROLE; DROP TRIGGER IF EXISTS refuse_dwell ON rank_events; DROP FUNCTION IF EXISTS refuse_dwell();
   TRUNCATE rank_events; UPDATE profiles SET account_status='active';
   INSERT INTO feature_flags VALUES('discovery_dwell_telemetry_enabled',true) ON CONFLICT(flag) DO UPDATE SET enabled=true;`);
  await db.query(`INSERT INTO rank_events(id,user_id,item_id,item_kind,position,surface,session_id,served_at,recommendation_id,features)
   VALUES($1,$2,$3,'place',2,'discovery',$4,$5,$6,jsonb_build_object('recommendationId',$6::text))`,[exposureId,viewer,item,sessionId,servedAt,rid]);
 });
 async function admit(batch:unknown=measurements,overrides:{user?:string;exposure?:string;recommendation?:string;item?:string}={}){
  return(await db.query<{receipt:any}>('SELECT public.admit_discovery_dwell($1,$2,$3,$4,$5::jsonb) AS receipt',
   [overrides.user??viewer,overrides.exposure??exposureId,overrides.recommendation??rid,overrides.item??item,JSON.stringify(batch)])).rows[0]!.receipt;
 }
 async function attention(){return(await db.query<any>("SELECT * FROM rank_events WHERE event_type='place_dwell' ORDER BY dwell_kind")).rows;}
 it('stores canonical kinds once and confirms exact duplicates after lost response or reordered retry',async()=>{
  assert.deepEqual(await admit(),{ok:true,recorded:3,duplicates:0});
  assert.deepEqual(await admit([...measurements].reverse()),{ok:true,recorded:0,duplicates:3});
  const rows=await attention();assert.equal(rows.length,3);
  for(const measurement of measurements){
   const row=rows.find(r=>r.dwell_kind===measurement.kind)!;
   const expected=dwellRowFor(viewer,{item_id:item,item_kind:'place',position:2,session_id:sessionId,served_at:servedAt},rid,clientId,measurement,servedAt);
   for(const[key,value]of Object.entries(expected)){
    if(key==='outcome_at'){assert.ok(row.outcome_at);continue;}
    if(key==='served_at'){assert.equal(row[key] instanceof Date ? row[key].getTime() : Date.parse(row[key]),Date.parse(String(value)));continue;}
    assert.deepEqual(row[key],value,key);
   }
  }
  const exposure=(await db.query<any>('SELECT outcome,dwell_ms FROM rank_events WHERE id=$1',[exposureId])).rows[0];
  assert.equal(exposure.outcome,'impression');assert.equal(exposure.dwell_ms,null);
 });
 it('conflicting mixed batch rolls back every newly inserted kind and preserves the original measurement',async()=>{
  assert.deepEqual(await admit([measurements[0]]),{ok:true,recorded:1,duplicates:0});
  await assert.rejects(admit([{...measurements[0],ms:4300},measurements[1],measurements[2]]),/dwell_receipt_conflict/);
  assert.equal((await attention()).length,1);assert.equal((await attention())[0].dwell_ms,4200);
  assert.deepEqual(await admit(),{ok:true,recorded:2,duplicates:1});
  await db.query("UPDATE rank_events SET features=features || '{\"extra\":1}'::jsonb WHERE recommendation_id=$1",[measurements[0].token]);
  await assert.rejects(admit(),/dwell_receipt_conflict/,'extra persisted payload is not an exact duplicate');
 });
 it('silent trigger refusal cannot produce a success receipt or leave a partial batch',async()=>{
  await db.exec(`CREATE FUNCTION refuse_dwell() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.event_type='place_dwell' AND NEW.dwell_kind='idle' THEN RETURN NULL; END IF; RETURN NEW; END $$;
   CREATE TRIGGER refuse_dwell BEFORE INSERT ON rank_events FOR EACH ROW EXECUTE FUNCTION refuse_dwell();`);
  await assert.rejects(admit(),/dwell_receipt_unverified/);assert.equal((await attention()).length,0);
  await db.exec('DROP TRIGGER refuse_dwell ON rank_events;');
  assert.deepEqual(await admit(),{ok:true,recorded:3,duplicates:0});
 });
 it('rejects malformed single and mixed service batches before any write',async()=>{
  for(const batch of [null,{},[],[null],['raw'],[2],[measurements[0],null],[measurements[0],measurements[0]],
   [{...measurements[0],kind:'scroll'}],[{...measurements[0],ms:0}],[{...measurements[0],ms:1.5}],
   [{...measurements[0],ms:2147483648}],[{...measurements[0],token:null}],
   [{...measurements[0],token:'1234567890123456789012',text:'private note'}],
   [measurements[0],{...measurements[1],token:measurements[0].token}],
   [measurements[0],{...measurements[1],ms:'100'}]]){
   await assert.rejects(admit(batch),/dwell_invalid_payload/);assert.equal((await attention()).length,0);
  }
 });
 it('rechecks collection, active owner and owned served exposure at the database write boundary',async()=>{
  await db.exec('UPDATE feature_flags SET enabled=false');assert.deepEqual(await admit(),{ok:false,reason:'disabled'});
  await db.exec('DELETE FROM feature_flags');assert.deepEqual(await admit(),{ok:false,reason:'disabled'});
  await db.exec("INSERT INTO feature_flags VALUES('discovery_dwell_telemetry_enabled',true); UPDATE profiles SET account_status='deleted'");
  assert.deepEqual(await admit(),{ok:false,reason:'account_unavailable'});
  await db.exec("UPDATE profiles SET account_status='active'");
  for(const overrides of [{user:other},{exposure:other},{item:'node/wrong'},{recommendation:'BBBBBBBBBBBBBBBBBBBBBB'}])
   assert.deepEqual(await admit(measurements,overrides),{ok:false,reason:'not_found'});
  await db.exec("UPDATE rank_events SET event_type='ranking_item_scored'");
  assert.deepEqual(await admit(),{ok:false,reason:'not_found'});assert.equal((await attention()).length,0);
 });
 it('is service-only SECURITY INVOKER and executes with explicit service table grants',async()=>{
  assert.equal((await db.query<any>("SELECT prosecdef FROM pg_proc WHERE oid='public.admit_discovery_dwell(uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0].prosecdef,false);
  for(const role of ['anon','authenticated']){
   await db.exec(`SET ROLE ${role}`);
   try{await assert.rejects(admit(),/permission denied/);}finally{await db.exec('RESET ROLE');}
  }
  await db.exec('SET ROLE service_role');
  try{assert.deepEqual(await admit(),{ok:true,recorded:3,duplicates:0});}finally{await db.exec('RESET ROLE');}
 });
});
