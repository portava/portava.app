import { migratedCatalogAndRows } from "./migratedCatalogSnapshot.js";
/** 3898 full-chain rollback, data preservation and definition drift proofs. */
import { before, after, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb } from "./pressedLayoverDb.js";

const forward = readFileSync(new URL("../../migrations/3898_layover_experience_plan_versions.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../../../../../db/rollback/2026-10-18-3898-layover-experience-plan-versions-rollback.sql", import.meta.url), "utf8");
const flag = "layover_experience_execution_enabled";
let db: PressedDb;
async function catalog() {
  return {
    columns: await db.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('layover_experience_plans','layover_sessions') ORDER BY 1,2"),
    constraints: await db.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('layover_experience_plans','layover_sessions') ORDER BY 1,2"),
    functions: await db.query("SELECT proname,prosrc,prosecdef,proconfig,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_experience_plan_write','layover_experience_plan_immutable') ORDER BY 1"),
    indexes: await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='layover_experience_plans' ORDER BY indexname"),
    triggers: await db.query("SELECT tgname,pg_get_triggerdef(t.oid) AS definition,tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='layover_experience_plans' AND NOT tgisinternal ORDER BY 1"),
    grants: await db.query("SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='layover_experience_plans' ORDER BY 1,2,3"),
    flags: await db.query(`SELECT * FROM public.feature_flags WHERE flag='${flag}'`),
    sessions: await db.query("SELECT * FROM public.layover_sessions ORDER BY id"),
  };
}
async function refuses(match: RegExp) {
  try { await assert.rejects(db.exec(rollback), match); } finally { await db.exec("ROLLBACK"); }
}
describe("L15 3898 rollback on a fresh isolated migrated schema", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => { db = await openPressedLayoverDb(); });
  after(async () => { await db?.close(); });
  it("forward/rollback restores catalog and rows, repeat is inert, and forward reapplies", async () => {
    await db.exec(rollback); const baseline = await catalog();
    await db.exec(forward); assert.equal(await db.flag(flag), false);
    await db.exec(rollback); assert.deepEqual(await catalog(), baseline);
    await db.exec(rollback); assert.deepEqual(await catalog(), baseline);
    await db.exec(forward);
    assert.equal((await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_experience_plans'::regclass"))[0].relrowsecurity, true);
  });
  it("enabled switch and flag audit history refuse without losing either row", async () => {
    await db.setFlag(flag, true); await refuses(/flag is enabled/); assert.equal(await db.flag(flag), true);
    await db.setFlag(flag, false);
    await db.exec(`INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES ('${flag}',true,false)`);
    await refuses(/audit history/);
    assert.equal((await db.query(`SELECT id FROM public.feature_flag_audit_log WHERE flag='${flag}'`)).length, 1);
    await db.exec(`DELETE FROM public.feature_flag_audit_log WHERE flag='${flag}'`);
  });
  it("plan evidence refuses and survives unchanged", async () => {
    const user = await db.seedUser("action_rollback"), sid = randomUUID(), aid = randomUUID();
    await db.exec(`INSERT INTO public.layover_sessions(id,user_id,arrival_time,departure_time) VALUES ('${sid}','${user.id}',now(),now()+interval '5 hours')`);
    await db.exec(`INSERT INTO public.layover_experience_plans(id,session_id,user_id,version,operation,phase,stops,refusal_reason) VALUES ('${aid}','${sid}','${user.id}',1,'select','refused','[]','test-refusal')`);
    const before = await db.query(`SELECT * FROM public.layover_experience_plans WHERE id='${aid}'`);
    await refuses(/experience evidence/); assert.deepEqual(await db.query(`SELECT * FROM public.layover_experience_plans WHERE id='${aid}'`), before);
    await db.exec(`DELETE FROM public.layover_sessions WHERE id='${sid}'`);
  });
  it("each modified function refuses before being dropped", async () => {
    for (const name of ["public.layover_experience_plan_immutable()", "public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)"]) {
      await db.exec(`ALTER FUNCTION ${name} SECURITY DEFINER`);
      await refuses(/function was changed/);
      await db.exec(`ALTER FUNCTION ${name} SECURITY INVOKER`);
    }
    const name = "public.layover_experience_plan_immutable()";
    const [{ definition }] = await db.query<{ definition: string }>(`SELECT pg_get_functiondef('${name}'::regprocedure) AS definition`);
    await db.exec("CREATE OR REPLACE FUNCTION public.layover_experience_plan_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$");
    await refuses(/function was changed/); await db.exec(definition);
  });
  it("changed table shape and a partially missing installation each refuse", async () => {
    await db.exec("ALTER TABLE public.layover_experience_plans ADD CONSTRAINT extra_plan_constraint CHECK(version>0)");
    await refuses(/table was changed/);
    assert.equal((await db.query("SELECT conname FROM pg_constraint WHERE conname='extra_plan_constraint'")).length, 1);
    await db.exec("ALTER TABLE public.layover_experience_plans DROP CONSTRAINT extra_plan_constraint");
    const [{ definition }] = await db.query<{ definition: string }>("SELECT pg_get_functiondef('public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)'::regprocedure) AS definition");
    await db.exec("DROP FUNCTION public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)");
    await refuses(/incomplete experience schema/); await db.exec(definition);
    await db.exec("REVOKE ALL ON FUNCTION public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text) TO service_role");
  });
  it("table, column and each function grant or attribute drift refuses and retains later permissions", async () => {
    await db.exec("GRANT SELECT ON public.layover_experience_plans TO authenticated"); await refuses(/privileges were changed/);
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','public.layover_experience_plans','SELECT') AS allowed"))[0]!.allowed, true);
    await db.exec("REVOKE SELECT ON public.layover_experience_plans FROM authenticated");
    await db.exec("GRANT SELECT(contract) ON public.layover_experience_plans TO authenticated"); await refuses(/privileges were changed/);
    await db.exec("REVOKE SELECT(contract) ON public.layover_experience_plans FROM authenticated");
    for (const name of ["public.layover_experience_plan_immutable()", "public.layover_experience_plan_write(uuid,uuid,uuid,text,uuid,text,timestamptz,text,jsonb,jsonb,text)"]) {
      await db.exec(`GRANT EXECUTE ON FUNCTION ${name} TO authenticated`); await refuses(/privileges were changed/); await db.exec(`REVOKE EXECUTE ON FUNCTION ${name} FROM authenticated`);
      await db.exec(`ALTER FUNCTION ${name} COST 101`); await refuses(/attributes or privileges/); await db.exec(`ALTER FUNCTION ${name} COST 100`);
    }
  });
  it("required-column drift is refused on PostgreSQL 17 and 18", async () => {
    await db.exec("ALTER TABLE public.layover_experience_plans ALTER COLUMN stops DROP NOT NULL");
    await refuses(/table .*was changed/);
    assert.equal((await db.query<{ attnotnull: boolean }>("SELECT attnotnull FROM pg_attribute WHERE attrelid='public.layover_experience_plans'::regclass AND attname='stops'"))[0]!.attnotnull, false);
    await db.exec("ALTER TABLE public.layover_experience_plans ALTER COLUMN stops SET NOT NULL");
  });
});

// Persist the independent whole-catalog proofs so CI exercises both installation orders.
for(const order of ['sorted-gap','after-3999'] as const)test('3898 full catalog rollback '+order,{skip:PRESSED_SKIP_REASON},async()=>{
 const db=await openPressedLayoverDb({without:order==='after-3999'?['3898']:[]});
 try{
 if(order==='sorted-gap')await db.exec(rollback);const u=await db.seedUser('full_rollback3898');const baseline=await migratedCatalogAndRows(db);
 await db.exec(forward);const installed=await migratedCatalogAndRows(db);
 const refuses=async(label:string,setup:string,re:RegExp)=>{
 await db.exec('BEGIN;'+setup);let err:unknown;try{await db.exec(rollback);}catch(e){err=e;}await db.exec('ROLLBACK');assert.ok(err,label);assert.match(String((err as Error).message),re);assert.deepEqual(await migratedCatalogAndRows(db),installed,label+' changed catalog or rows');console.log('refused',order,label);
 };
 await refuses('flag ON',"UPDATE public.feature_flags SET enabled=true WHERE flag='layover_experience_execution_enabled';",/flag is enabled/);
 await refuses('flag audit history',`INSERT INTO public.feature_flag_audit_log(flag,changed_by_user_id,old_enabled,new_enabled) VALUES('layover_experience_execution_enabled','${u.id}',false,true);`,/audit history/);
 await refuses('table grant',"GRANT SELECT ON public.layover_experience_plans TO authenticated;",/privileges were changed/);
 await refuses('custom-role grant',"CREATE ROLE objective_extra_grantee; GRANT SELECT ON public.layover_experience_plans TO objective_extra_grantee;",/privileges were changed/);
 await refuses('column grant',"GRANT SELECT(contract) ON public.layover_experience_plans TO authenticated;",/privileges were changed/);
 await refuses('function grant',"GRANT EXECUTE ON FUNCTION public.layover_experience_plan_immutable() TO authenticated;",/privileges were changed/);
 await refuses('all table privileges removed',"REVOKE ALL ON public.layover_experience_plans FROM CURRENT_USER,service_role;",/privileges were changed/); await refuses('partial table privileges removed',"REVOKE TRUNCATE ON public.layover_experience_plans FROM service_role;",/privileges were changed/);
 await refuses('all function privileges removed',"REVOKE ALL ON FUNCTION public.layover_experience_plan_immutable() FROM CURRENT_USER,service_role;",/privileges were changed/);
 await refuses('function attributes',"ALTER FUNCTION public.layover_experience_plan_immutable() COST 99;",/attributes or privileges/);
 await refuses('trigger disabled',"ALTER TABLE public.layover_experience_plans DISABLE TRIGGER layover_experience_plan_immutable;",/table.*was changed/);
 await refuses('policy addition',"CREATE POLICY later_policy ON public.layover_experience_plans FOR SELECT TO authenticated USING(true);",/table.*was changed/);
 await refuses('required column relaxed',"ALTER TABLE public.layover_experience_plans ALTER COLUMN stops DROP NOT NULL;",/table .*was changed/);
 await refuses('external dependency',"CREATE VIEW public.objective_external AS SELECT * FROM public.layover_experience_plans;",/depend/);
 await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'full catalog/all nonledger rows');await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'repeat inert');await db.exec(forward);await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'reapply then rollback');
 console.log(order,'full catalog + every nonledger row equal; repeat/reapply; 13 refusals');
 }finally{await db.close();}
});
