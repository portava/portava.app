/** B2-RECS-A migration/rollback and TEXT+CHECK contract proofs, on the actual baseline plus migration chain. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb } from "./pressedLayoverDb.js";

const files = [
  ["3871_layover_recommendation_status_and_supersession.sql", "2026-10-18-3871-layover-recommendation-status-and-supersession-rollback.sql", "layover_recommendation_status_enabled"],
  ["3873_layover_active_snapshot_compare_and_swap.sql", "2026-10-18-3873-layover-active-snapshot-compare-and-swap-rollback.sql", "layover_canonical_snapshot_enabled"],
  ["3896_layover_certified_computations_immutable.sql", "2026-10-18-3896-layover-certified-computations-immutable-rollback.sql", null],
] as const;
const forward = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");
const rollback = (f: string) => readFileSync(new URL(`../../../../../db/rollback/${f}`, import.meta.url), "utf8");
const tables = "'layover_sessions','layover_recommendations','layover_certified_computations','layover_recommendation_supersessions'";
let db: PressedDb;
async function catalog() {
  return {
    columns: await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${tables}) ORDER BY table_name,column_name`),
    constraints: await db.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${tables}) ORDER BY 1,2`),
    triggers: await db.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND c.relname IN (${tables}) ORDER BY 1,2`),
    functions: await db.query(`SELECT proname,prosrc,prosecdef,proconfig,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('layover_certcomp_active_cas','layover_certified_computations_are_immutable','layover_rec_supersessions_are_immutable') ORDER BY 1`),
    grants: await db.query(`SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name IN (${tables}) ORDER BY 1,2,3`),
    flags: await db.query(`SELECT flag,enabled FROM public.feature_flags WHERE flag IN ('layover_canonical_snapshot_enabled','layover_recommendation_status_enabled') ORDER BY flag`),
    rows: await db.query(`SELECT * FROM (SELECT 'sessions' AS kind,to_jsonb(s) AS row FROM public.layover_sessions s UNION ALL SELECT 'recs',to_jsonb(r) FROM public.layover_recommendations r UNION ALL SELECT 'computations',to_jsonb(c) FROM public.layover_certified_computations c) evidence ORDER BY kind,row::text`),
  };
}
async function refuses(sql: string, match: RegExp) {
  try { await assert.rejects(db.exec(sql), match); } finally { await db.exec("ROLLBACK"); }
}

describe("B2-RECS-A 3871/3873/3896 rollback proofs", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => { db = await openPressedLayoverDb({ without: ["3908"] }); });
  after(async () => { await db?.close(); });
  for (const [migration, recipe, flag] of files) {
    it(`${migration}: rollback restores catalog/rows, repeats without effect, and forward reapplies`, async () => {
      await db.exec(rollback(recipe));
      const before = await catalog();
      await db.exec(forward(migration));
      await db.exec(rollback(recipe));
      assert.deepEqual(await catalog(), before);
      await db.exec(rollback(recipe));
      assert.deepEqual(await catalog(), before);
      await db.exec(forward(migration));
      if (flag) assert.equal(await db.flag(flag), false);
    });
    if (flag) it(`${migration}: enabled switch and audit history each refuse without deleting either row`, async () => {
      await db.setFlag(flag, true);
      await refuses(rollback(recipe), /flag is enabled/);
      assert.equal(await db.flag(flag), true);
      await db.setFlag(flag, false);
      await db.exec(`INSERT INTO public.feature_flag_audit_log (flag,old_enabled,new_enabled) VALUES ('${flag}',true,false)`);
      await refuses(rollback(recipe), /audit history/);
      assert.equal((await db.query(`SELECT id FROM public.feature_flag_audit_log WHERE flag='${flag}'`)).length, 1);
      await db.exec(`DELETE FROM public.feature_flag_audit_log WHERE flag='${flag}'`);
    });
  }
  it("3871 refuses classified cards and supersession history independently", async () => {
    const user = await db.seedUser("rec_rollback"), sid = randomUUID(), rid = randomUUID();
    await db.exec(`INSERT INTO public.layover_sessions (id,user_id,arrival_time,departure_time) VALUES ('${sid}','${user.id}',now(),now()+interval '5 hours')`);
    await db.exec(`INSERT INTO public.layover_recommendations (id,session_id,rec_type,title,risk_band,recommendation_status,status_reason) VALUES ('${rid}','${sid}','rest','Late','UNSAFE','BLOCKED','unsafe_return_risk')`);
    await refuses(rollback(files[0][1]), /classified recommendation data/);
    await db.exec(`DELETE FROM public.layover_recommendations WHERE id='${rid}'`);
    await db.exec(`INSERT INTO public.layover_recommendation_supersessions (session_id,recommendation_id,superseding_snapshot_id,reasons,cause,card) VALUES ('${sid}','${rid}','kept-snapshot',ARRAY['stale_certification'],'regeneration','{}')`);
    await refuses(rollback(files[0][1]), /supersession history/);
    await db.exec(`DELETE FROM public.layover_sessions WHERE id='${sid}'`);
  });
  it("all function-definition drift checks refuse before dropping altered objects", async () => {
    const names = ["layover_rec_supersessions_are_immutable", "layover_certcomp_active_cas", "layover_certified_computations_are_immutable"];
    for (let i = 0; i < files.length; i++) {
      const definition = (await db.query<any>(`SELECT pg_get_functiondef('public.${names[i]}()'::regprocedure) AS body`))[0].body;
      await db.exec(`CREATE OR REPLACE FUNCTION public.${names[i]}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await refuses(rollback(files[i]![1]), /function was changed/);
      await db.exec(definition);
    }
  });
});

describe("L192 vocabulary and authorization on the real layover_sessions schema", { skip: PRESSED_SKIP_REASON }, () => {
  let schema: PressedDb;
  before(async () => { schema = await openPressedLayoverDb(); });
  after(async () => { await schema?.close(); });
  it("pins every vocabulary column to TEXT and the complete allowed value set", async () => {
    const vocab: Record<string, string[]> = {
      flight_type: ["domestic","international"], comfort_level: ["safe_only","moderate","adventurous"],
      status: ["active","returning","completed","cancelled","expired"],
      state: ["DETECTED","NEEDS_INFO","EVALUATING","AIRPORT_ONLY","LANDSIDE_AVAILABLE","PLAN_SELECTED","EXECUTING","RETURN_SOON","RETURN_NOW","RETURNING","AIRPORT_REENTERED","BOARDING","COMPLETED","DISRUPTED","CANCELLED","ABANDONED","EXPIRED"],
      connection_type: ["single_booking","separate_bookings","unknown"], detected_source: ["manual","trip_itinerary"],
      confidence_band: ["HIGH","MEDIUM","LOW","INSUFFICIENT"],
    };
    const columns = await schema.query<any>(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_sessions'`);
    const checks = await schema.query<any>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.layover_sessions'::regclass AND contype='c'`);
    for (const [column, expected] of Object.entries(vocab)) {
      assert.equal(columns.find(c => c.column_name === column)?.data_type, "text", column);
      const relevant = checks.filter(c => new RegExp(`\\b${column}\\b`).test(c.def));
      const values = [...new Set(relevant.flatMap(c => [...String(c.def).matchAll(/'([^']+)'::text/g)].map(m => m[1])))].sort();
      assert.deepEqual(values, expected.sort(), column);
    }
  });
  it("RLS is on, owner reads own sessions, another traveller cannot read or update them", async () => {
    assert.equal((await schema.query<any>(`SELECT relrowsecurity FROM pg_class WHERE oid='public.layover_sessions'::regclass`))[0].relrowsecurity, true);
    const owner = await schema.seedUser("session_owner"), other = await schema.seedUser("session_other"), sid = randomUUID();
    await schema.exec(`INSERT INTO public.layover_sessions (id,user_id,arrival_time,departure_time) VALUES ('${sid}','${owner.id}',now(),now()+interval '5 hours')`);
    assert.equal((await schema.asUser(owner.id, `SELECT id FROM public.layover_sessions WHERE id='${sid}'`)).length, 1);
    assert.equal((await schema.asUser(other.id, `SELECT id FROM public.layover_sessions WHERE id='${sid}'`)).length, 0);
    await assert.rejects(schema.asUser(owner.id, `UPDATE public.layover_sessions SET active_snapshot_id='fake' WHERE id='${sid}' RETURNING id`), /permission|server|authoritative|42501/i);
    await assert.rejects(schema.asUser(other.id, `UPDATE public.layover_sessions SET wants_to_leave=false WHERE id='${sid}' RETURNING id`), (e: any) => e.code === "42501");
  });
});


describe("canonical rollback preserves later durable route dependencies", { skip: PRESSED_SKIP_REASON }, () => {
  let full: PressedDb;
  before(async () => { full = await openPressedLayoverDb(); });
  after(async () => { await full?.close(); });
  for (const [, recipe] of files.slice(0, 2)) it(`${recipe}: refuses installed 3908 without changing catalog or rows`, async () => {
    const { migratedCatalogAndRows } = await import("./migratedCatalogSnapshot.js");
    const before = await migratedCatalogAndRows(full);
    try { await assert.rejects(full.exec(rollback(recipe)), /later migration 3908/); } finally { await full.exec("ROLLBACK"); }
    assert.deepEqual(await migratedCatalogAndRows(full), before);
  });
});
