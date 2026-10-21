import { migratedCatalogAndRows } from "./migratedCatalogSnapshot.js";
/** 3899 rollback after the complete migrated schema, with retained source/intent proofs. */
import { before, after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb } from "./pressedLayoverDb.js";
const forward=readFileSync(new URL("../../migrations/3899_layover_objective_evidence.sql",import.meta.url),"utf8");
const rollback=readFileSync(new URL("../../../../../db/rollback/2026-10-18-3899-layover-objective-evidence-rollback.sql",import.meta.url),"utf8");
const flag="layover_objective_evidence_enabled";
let db:PressedDb;
async function catalog(){return {
 columns:await db.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('layover_objective_facts','layover_objective_intents','layover_sessions') ORDER BY 1,2"),
 constraints:await db.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('layover_objective_facts','layover_objective_intents','layover_sessions') ORDER BY 1,2"),
 functions:await db.query("SELECT proname,prosrc,prosecdef,proconfig,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='layover_objective_evidence_guard'"),
 indexes:await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('layover_objective_facts','layover_objective_intents') ORDER BY 1,2"),
 triggers:await db.query("SELECT c.relname,tgname,pg_get_triggerdef(t.oid) AS definition,tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('layover_objective_facts','layover_objective_intents') AND NOT tgisinternal ORDER BY 1,2"),
 grants:await db.query("SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name IN ('layover_objective_facts','layover_objective_intents') ORDER BY 1,2,3"),
 flags:await db.query(`SELECT * FROM public.feature_flags WHERE flag='${flag}'`),sessions:await db.query("SELECT * FROM public.layover_sessions ORDER BY id"),
};}
async function refuses(match:RegExp){try{await assert.rejects(db.exec(rollback),match);}finally{await db.exec("ROLLBACK");}}
describe("L78 3899 full-chain rollback and privacy contracts",{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openPressedLayoverDb({without:['3907']});});after(async()=>{await db?.close();});
 it("restores exact catalog and rows, repeats inertly and reapplies after all later migrations",async()=>{
  await db.exec(rollback);const baseline=await catalog();await db.exec(forward);assert.equal(await db.flag(flag),false);
  await db.exec(rollback);assert.deepEqual(await catalog(),baseline);await db.exec(rollback);assert.deepEqual(await catalog(),baseline);await db.exec(forward);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM pg_class WHERE relname IN ('layover_objective_facts','layover_objective_intents') AND relrowsecurity"))[0]!.n,2);
 });
 it("enabled flag and flag audit history refuse and survive",async()=>{
  await db.setFlag(flag,true);await refuses(/flag is enabled/);assert.equal(await db.flag(flag),true);await db.setFlag(flag,false);
  await db.exec(`INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES('${flag}',true,false)`);await refuses(/audit history/);
  assert.equal((await db.query(`SELECT id FROM public.feature_flag_audit_log WHERE flag='${flag}'`)).length,1);await db.exec(`DELETE FROM public.feature_flag_audit_log WHERE flag='${flag}'`);
 });
 it("private intent survives refusal, rejects a foreign owner and erases with its session",async()=>{
  const owner=await db.seedUser("objective_rollback"),foreign=await db.seedUser("objective_foreign"),sid=randomUUID();
  await db.exec(`INSERT INTO public.layover_sessions(id,user_id,arrival_time,departure_time) VALUES('${sid}','${owner.id}',now(),now()+interval '5 hours')`);
  await assert.rejects(db.exec(`INSERT INTO public.layover_objective_intents(session_id,user_id,intent) VALUES('${sid}','${foreign.id}','{}')`),/session owner/);
  await db.exec(`INSERT INTO public.layover_objective_intents(session_id,user_id,intent) VALUES('${sid}','${owner.id}','{}')`);
  const before=await db.query("SELECT * FROM public.layover_objective_intents");await refuses(/objective evidence/);assert.deepEqual(await db.query("SELECT * FROM public.layover_objective_intents"),before);
  await db.exec(`DELETE FROM public.layover_sessions WHERE id='${sid}'`);assert.equal((await db.query("SELECT * FROM public.layover_objective_intents")).length,0);
 });
 it("source facts survive refusal and curator erasure, while their subject deletion cascades",async()=>{
  const curator=await db.seedUser("objective_source"),aid=randomUUID(),pid=randomUUID(),fid=randomUUID();
  await db.exec(`INSERT INTO public.airport_profiles(id,iata_code,name,city,country,country_code,lat,lng) VALUES('${aid}','ZZQ','Fixture','Fixture','Singapore','SG',1,1)`);
  await db.exec(`INSERT INTO public.discovery_places(id,name,city,place_type,status,lat,lng) VALUES('${pid}','Fixture','Fixture','cafe','active',1,1)`);
  await db.exec(`INSERT INTO public.layover_objective_facts(id,airport_id,place_id,kind,value,source_class,source_url,source_note,observed_at,expires_at,stated_by) VALUES('${fid}','${aid}','${pid}','exertion','{"level":"light"}','venue_operator','https://example.test/source','Explicit rollback fixture',now(),now()+interval '1 hour','${curator.id}')`);
  const before=await db.query("SELECT * FROM public.layover_objective_facts");await refuses(/objective evidence/);assert.deepEqual(await db.query("SELECT * FROM public.layover_objective_facts"),before);
  await assert.rejects(db.exec(`UPDATE public.layover_objective_facts SET value='{"level":"strenuous"}' WHERE id='${fid}'`),/immutable/);
  await db.exec(`DELETE FROM public.profiles WHERE id='${curator.id}'`);assert.equal((await db.query<{stated_by:null}>(`SELECT stated_by FROM public.layover_objective_facts WHERE id='${fid}'`))[0]!.stated_by,null);
  await db.exec(`DELETE FROM public.discovery_places WHERE id='${pid}'`);assert.equal((await db.query("SELECT * FROM public.layover_objective_facts")).length,0);await db.exec(`DELETE FROM public.airport_profiles WHERE id='${aid}'`);
 });
 it("table grants, column grants and function attributes/grants refuse without discarding the change",async()=>{
  for(const table of ["layover_objective_facts","layover_objective_intents"]){
   await db.exec(`GRANT SELECT ON public.${table} TO authenticated`);await refuses(/privileges were changed/);
   assert.equal((await db.query<{allowed:boolean}>(`SELECT has_table_privilege('authenticated','public.${table}','SELECT') AS allowed`))[0]!.allowed,true);await db.exec(`REVOKE SELECT ON public.${table} FROM authenticated`);
   const column=table==="layover_objective_facts"?"source_note":"intent";
   await db.exec(`GRANT SELECT(${column}) ON public.${table} TO authenticated`);await refuses(/privileges were changed/);await db.exec(`REVOKE SELECT(${column}) ON public.${table} FROM authenticated`);
  }
  await db.exec("GRANT EXECUTE ON FUNCTION public.layover_objective_evidence_guard() TO authenticated");await refuses(/privileges were changed/);await db.exec("REVOKE EXECUTE ON FUNCTION public.layover_objective_evidence_guard() FROM authenticated");
  await db.exec("ALTER FUNCTION public.layover_objective_evidence_guard() COST 101");await refuses(/attributes or privileges/);await db.exec("ALTER FUNCTION public.layover_objective_evidence_guard() COST 100");
 });
 it("modified function body, security, table and incomplete installation all refuse",async()=>{
  const [{definition}]=await db.query<{definition:string}>("SELECT pg_get_functiondef('public.layover_objective_evidence_guard()'::regprocedure) AS definition");
  await db.exec("ALTER FUNCTION public.layover_objective_evidence_guard() SECURITY DEFINER");await refuses(/function was changed/);await db.exec("ALTER FUNCTION public.layover_objective_evidence_guard() SECURITY INVOKER");
  await db.exec("CREATE OR REPLACE FUNCTION public.layover_objective_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$");await refuses(/function was changed/);await db.exec(definition);
  for(const table of ["layover_objective_facts","layover_objective_intents"]){await db.exec(`ALTER TABLE public.${table} ADD COLUMN changed boolean`);await refuses(/table .* was changed/);await db.exec(`ALTER TABLE public.${table} DROP COLUMN changed`);}
  await db.exec("ALTER TABLE public.layover_objective_intents RENAME TO objective_intents_moved");await refuses(/incomplete objective schema/);await db.exec("ALTER TABLE public.objective_intents_moved RENAME TO layover_objective_intents");
 });
  it("required-column drift is refused on PostgreSQL 17 and 18", async () => {
    await db.exec("ALTER TABLE public.layover_objective_facts ALTER COLUMN source_note DROP NOT NULL");
    await refuses(/table .*was changed/);
    assert.equal((await db.query<{ attnotnull: boolean }>("SELECT attnotnull FROM pg_attribute WHERE attrelid='public.layover_objective_facts'::regclass AND attname='source_note'"))[0]!.attnotnull, false);
    await db.exec("ALTER TABLE public.layover_objective_facts ALTER COLUMN source_note SET NOT NULL");
    await db.exec("ALTER TABLE public.layover_objective_intents ALTER COLUMN intent DROP NOT NULL");
    await refuses(/table .*was changed/);
    assert.equal((await db.query<{ attnotnull: boolean }>("SELECT attnotnull FROM pg_attribute WHERE attrelid='public.layover_objective_intents'::regclass AND attname='intent'"))[0]!.attnotnull, false);
    await db.exec("ALTER TABLE public.layover_objective_intents ALTER COLUMN intent SET NOT NULL");
  });
});

// Persist the independent whole-catalog proofs so CI exercises both installation orders.
for(const order of ['sorted-gap','after-3999'] as const)test('3899 full catalog rollback '+order,{skip:PRESSED_SKIP_REASON},async()=>{
 const db=await openPressedLayoverDb({without:order==='after-3999'?['3899','3907']:['3907']});
 try{
 if(order==='sorted-gap')await db.exec(rollback);const u=await db.seedUser('full_rollback3899');const baseline=await migratedCatalogAndRows(db);
 await db.exec(forward);const installed=await migratedCatalogAndRows(db);
 const refuses=async(label:string,setup:string,re:RegExp)=>{
 await db.exec('BEGIN;'+setup);let err:unknown;try{await db.exec(rollback);}catch(e){err=e;}await db.exec('ROLLBACK');assert.ok(err,label);assert.match(String((err as Error).message),re);assert.deepEqual(await migratedCatalogAndRows(db),installed,label+' changed catalog or rows');console.log('refused',order,label);
 };
 await refuses('flag ON',"UPDATE public.feature_flags SET enabled=true WHERE flag='layover_objective_evidence_enabled';",/flag is enabled/);
 await refuses('flag audit history',`INSERT INTO public.feature_flag_audit_log(flag,changed_by_user_id,old_enabled,new_enabled) VALUES('layover_objective_evidence_enabled','${u.id}',false,true);`,/audit history/);
 await refuses('table grant',"GRANT SELECT ON public.layover_objective_facts TO authenticated;",/privileges were changed/);
 await refuses('custom-role grant',"CREATE ROLE objective_extra_grantee; GRANT SELECT ON public.layover_objective_intents TO objective_extra_grantee;",/privileges were changed/);
 await refuses('column grant',"GRANT SELECT(intent) ON public.layover_objective_intents TO authenticated;",/privileges were changed/);
 await refuses('function grant',"GRANT EXECUTE ON FUNCTION public.layover_objective_evidence_guard() TO authenticated;",/privileges were changed/);
 await refuses('all table privileges removed',"REVOKE ALL ON public.layover_objective_facts FROM CURRENT_USER,service_role;",/privileges were changed/); await refuses('partial table privileges removed',"REVOKE TRUNCATE ON public.layover_objective_facts FROM service_role;",/privileges were changed/);
 await refuses('all function privileges removed',"REVOKE ALL ON FUNCTION public.layover_objective_evidence_guard() FROM CURRENT_USER,service_role;",/privileges were changed/);
 await refuses('function attributes',"ALTER FUNCTION public.layover_objective_evidence_guard() COST 99;",/attributes or privileges/);
 await refuses('trigger disabled',"ALTER TABLE public.layover_objective_intents DISABLE TRIGGER layover_objective_intent_owner;",/table .* was changed/);
 await refuses('policy addition',"CREATE POLICY later_policy ON public.layover_objective_facts FOR SELECT TO authenticated USING(true);",/table .* was changed/);
 await refuses('required column relaxed',"ALTER TABLE public.layover_objective_facts ALTER COLUMN source_note DROP NOT NULL;",/table .*was changed/);
 await refuses('intent required column relaxed',"ALTER TABLE public.layover_objective_intents ALTER COLUMN intent DROP NOT NULL;",/table .*was changed/);
 await refuses('external dependency',"CREATE VIEW public.objective_external AS SELECT * FROM public.layover_objective_facts;",/depend/);
 await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'full catalog/all nonledger rows');await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'repeat inert');await db.exec(forward);await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'reapply then rollback');
 console.log(order,'full catalog + every nonledger row equal; repeat/reapply; 14 refusals');
 }finally{await db.close();}
});
