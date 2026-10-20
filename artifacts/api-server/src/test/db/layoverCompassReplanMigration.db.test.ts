/** 3897 full-chain rollback, data preservation and definition drift proofs. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb } from "./pressedLayoverDb.js";

const forward = readFileSync(new URL("../../migrations/3897_layover_compass_replan_actions.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../../../../../db/rollback/2026-10-18-3897-layover-compass-replan-actions-rollback.sql", import.meta.url), "utf8");
const flag = "layover_compass_replan_enabled";
let db: PressedDb;
async function catalog() {
  return {
    columns: await db.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('layover_compass_actions','layover_sessions') ORDER BY 1,2"),
    constraints: await db.query("SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('layover_compass_actions','layover_sessions') ORDER BY 1,2"),
    functions: await db.query("SELECT proname,prosrc,prosecdef,proconfig,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('claim_layover_compass_replan','layover_compass_action_guard') ORDER BY 1"),
    indexes: await db.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='layover_compass_actions' ORDER BY indexname"),
    triggers: await db.query("SELECT tgname,pg_get_triggerdef(t.oid) AS definition,tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='layover_compass_actions' AND NOT tgisinternal ORDER BY 1"),
    grants: await db.query("SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='layover_compass_actions' ORDER BY 1,2,3"),
    flags: await db.query(`SELECT * FROM public.feature_flags WHERE flag='${flag}'`),
    sessions: await db.query("SELECT * FROM public.layover_sessions ORDER BY id"),
  };
}
async function refuses(match: RegExp) {
  try { await assert.rejects(db.exec(rollback), match); } finally { await db.exec("ROLLBACK"); }
}
describe("L112 3897 rollback on a fresh isolated migrated schema", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => { db = await openPressedLayoverDb(); });
  after(async () => { await db?.close(); });
  it("forward/rollback restores catalog and rows, repeat is inert, and forward reapplies", async () => {
    await db.exec(rollback); const baseline = await catalog();
    await db.exec(forward); assert.equal(await db.flag(flag), false);
    await db.exec(rollback); assert.deepEqual(await catalog(), baseline);
    await db.exec(rollback); assert.deepEqual(await catalog(), baseline);
    await db.exec(forward);
    assert.equal((await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_compass_actions'::regclass"))[0].relrowsecurity, true);
  });
  it("enabled switch and flag audit history refuse without losing either row", async () => {
    await db.setFlag(flag, true); await refuses(/flag is enabled/); assert.equal(await db.flag(flag), true);
    await db.setFlag(flag, false);
    await db.exec(`INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES ('${flag}',true,false)`);
    await refuses(/audit history/);
    assert.equal((await db.query(`SELECT id FROM public.feature_flag_audit_log WHERE flag='${flag}'`)).length, 1);
    await db.exec(`DELETE FROM public.feature_flag_audit_log WHERE flag='${flag}'`);
  });
  it("approval evidence refuses and survives unchanged", async () => {
    const user = await db.seedUser("action_rollback"), sid = randomUUID(), aid = randomUUID();
    await db.exec(`INSERT INTO public.layover_sessions(id,user_id,arrival_time,departure_time) VALUES ('${sid}','${user.id}',now(),now()+interval '5 hours')`);
    await db.exec(`INSERT INTO public.layover_compass_actions(id,session_id,user_id,kind,expected_snapshot_id,expected_session_updated_at,created_at,expires_at) SELECT '${aid}',id,user_id,'recheck_current_facts','test-snapshot',updated_at,now(),now()+interval '5 minutes' FROM public.layover_sessions WHERE id='${sid}'`);
    const before = await db.query(`SELECT * FROM public.layover_compass_actions WHERE id='${aid}'`);
    await refuses(/action evidence/); assert.deepEqual(await db.query(`SELECT * FROM public.layover_compass_actions WHERE id='${aid}'`), before);
    await db.exec(`DELETE FROM public.layover_sessions WHERE id='${sid}'`);
  });
  it("each modified function refuses before being dropped", async () => {
    for (const name of ["public.layover_compass_action_guard()", "public.claim_layover_compass_replan(uuid,uuid,uuid)"]) {
      await db.exec(`ALTER FUNCTION ${name} SECURITY DEFINER`);
      await refuses(/function was changed/);
      await db.exec(`ALTER FUNCTION ${name} SECURITY INVOKER`);
    }
    const name = "public.layover_compass_action_guard()";
    const [{ definition }] = await db.query<{ definition: string }>(`SELECT pg_get_functiondef('${name}'::regprocedure) AS definition`);
    await db.exec("CREATE OR REPLACE FUNCTION public.layover_compass_action_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$");
    await refuses(/function was changed/); await db.exec(definition);
  });
  it("changed table shape and a partially missing installation each refuse", async () => {
    await db.exec("ALTER TABLE public.layover_compass_actions ADD CONSTRAINT extra_action_constraint CHECK(length(expected_snapshot_id)>0)");
    await refuses(/table was changed/);
    assert.equal((await db.query("SELECT conname FROM pg_constraint WHERE conname='extra_action_constraint'")).length, 1);
    await db.exec("ALTER TABLE public.layover_compass_actions DROP CONSTRAINT extra_action_constraint");
    const [{ definition }] = await db.query<{ definition: string }>("SELECT pg_get_functiondef('public.claim_layover_compass_replan(uuid,uuid,uuid)'::regprocedure) AS definition");
    await db.exec("DROP FUNCTION public.claim_layover_compass_replan(uuid,uuid,uuid)");
    await refuses(/incomplete action schema/); await db.exec(definition);
  });
});
