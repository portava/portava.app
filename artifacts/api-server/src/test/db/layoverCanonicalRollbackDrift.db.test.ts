/** Independent destructive refusal proofs, confined to isolated migrated database clones. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESSED_SKIP_REASON, openPressedLayoverDb } from "./pressedLayoverDb.js";
import { migratedCatalogAndRows } from "./migratedCatalogSnapshot.js";
const definitions = [
  { number: "3871", migration: "3871_layover_recommendation_status_and_supersession.sql", rollback: "2026-10-18-3871-layover-recommendation-status-and-supersession-rollback.sql", flag: "layover_recommendation_status_enabled", functions: ["layover_rec_supersessions_are_immutable()"], table: "layover_recommendation_supersessions", column: "card", triggerTable: "layover_recommendation_supersessions", trigger: "layover_rec_supersessions_immutable", parentTable: "layover_recommendations", parentColumn: "plan_json" },
  { number: "3873", migration: "3873_layover_active_snapshot_compare_and_swap.sql", rollback: "2026-10-18-3873-layover-active-snapshot-compare-and-swap-rollback.sql", flag: "layover_canonical_snapshot_enabled", functions: ["layover_certcomp_active_cas()"], table: null, column: null, triggerTable: "layover_certified_computations", trigger: "layover_certcomp_active_cas", parentTable: "layover_certified_computations", parentColumn: "expected_active_version" },
  { number: "3896", migration: "3896_layover_certified_computations_immutable.sql", rollback: "2026-10-18-3896-layover-certified-computations-immutable-rollback.sql", flag: null, functions: ["layover_certified_computations_are_immutable()"], table: null, column: null, triggerTable: "layover_certified_computations", trigger: "layover_certified_computations_immutable", parentTable: null, parentColumn: null },
  { number: "3897", migration: "3897_layover_compass_replan_actions.sql", rollback: "2026-10-18-3897-layover-compass-replan-actions-rollback.sql", flag: "layover_compass_replan_enabled", functions: ["layover_compass_action_guard()", "claim_layover_compass_replan(uuid,uuid,uuid)"], table: "layover_compass_actions", column: "expected_snapshot_id", triggerTable: "layover_compass_actions", trigger: "layover_compass_action_guard", parentTable: null, parentColumn: null },
] as const;
for (const d of definitions) for (const order of ["sorted-gap", "after-3999"] as const) {
 describe(`${d.number}: ${order} full catalog/all rows, immutable evidence and changed-object refusals`, { skip: PRESSED_SKIP_REASON }, ()=>{it(`${d.number}: ${order} full catalog/all rows, immutable evidence and changed-object refusals`, async () => {
  const db = await openPressedLayoverDb({ without: [...(["3871", "3873"].includes(d.number) ? ["3908"] : []), ...(order === "after-3999" ? [d.number] : [])] });
  const forward = readFileSync(new URL(`../../migrations/${d.migration}`, import.meta.url), "utf8");
  const rollback = readFileSync(new URL(`../../../../../db/rollback/${d.rollback}`, import.meta.url), "utf8");
  try {
   if (order === "sorted-gap") await db.exec(rollback);
   await db.seedUser(`rollback_${d.number}`);
   // Changes to unrelated predecessor objects must survive this migration's rollback too.
   await db.exec("COMMENT ON TABLE public.layover_sessions IS 'Preexisting roundtrip evidence retained';");
   const baseline = await migratedCatalogAndRows(db);
   await db.exec(forward); const installed = await migratedCatalogAndRows(db);
   let controls = 0;
   const refuses = async (label: string, setup: string) => {
    await db.exec(`BEGIN; ${setup}`); let error: unknown;
    try { await db.exec(rollback); } catch (caught) { error = caught; }
    await db.exec("ROLLBACK");
    assert.ok(error, `${d.number}/${order}: ${label} did not refuse`);
    assert.match(String((error as Error).message), /REFUSED|depend/i, label);
    assert.deepEqual(await migratedCatalogAndRows(db), installed, `${label}: catalog/rows changed`); controls++;
   };
   if (d.flag) {
    await refuses("enabled capability", `UPDATE public.feature_flags SET enabled=true WHERE flag='${d.flag}';`);
    await refuses("flag audit history", `INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES('${d.flag}',false,true);`);
   }
   for (const fn of d.functions) {
    await refuses(`${fn} execute grant`, `GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    await refuses(`${fn} custom-role grant`, `CREATE ROLE rollback_extra_grantee; GRANT EXECUTE ON FUNCTION public.${fn} TO rollback_extra_grantee;`);
    await refuses(`${fn} zero ACL`, `REVOKE ALL ON FUNCTION public.${fn} FROM CURRENT_USER,service_role;`);
    await refuses(`${fn} cost attribute`, `ALTER FUNCTION public.${fn} COST 101;`);
    await refuses(`${fn} security attribute`, `ALTER FUNCTION public.${fn} SECURITY DEFINER;`);
   }
   await refuses("disabled trigger", `ALTER TABLE public.${d.triggerTable} DISABLE TRIGGER ${d.trigger};`);
   await refuses("missing trigger", `DROP TRIGGER ${d.trigger} ON public.${d.triggerTable};`);
   const [{ definition }] = await db.query<{definition:string}>(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='public.${d.triggerTable}'::regclass AND tgname='${d.trigger}'`);
   await refuses("changed trigger predicate", `DROP TRIGGER ${d.trigger} ON public.${d.triggerTable}; ${definition.replace(' EXECUTE FUNCTION ', ' WHEN (false) EXECUTE FUNCTION ')};`);
   if (d.table) {
    await refuses("table grant", `GRANT SELECT ON public.${d.table} TO authenticated;`);
    await refuses("zero table ACL", `REVOKE ALL ON public.${d.table} FROM CURRENT_USER,service_role;`); await refuses("partial table ACL", `REVOKE TRUNCATE ON public.${d.table} FROM service_role;`); if (Number((await db.query<{v:string}>("SELECT current_setting('server_version_num') AS v"))[0]!.v) >= 170000) await refuses("MAINTAIN-only table ACL", `REVOKE MAINTAIN ON public.${d.table} FROM service_role;`); // the ACL hash reads a full owner-default set as ALL; it must not read a partial one, or MAINTAIN, as unchanged
    await refuses("column grant", `GRANT SELECT(${d.column}) ON public.${d.table} TO authenticated;`);
    await refuses("policy addition", `CREATE POLICY rollback_extra_policy ON public.${d.table} FOR SELECT TO authenticated USING(true);`);
    await refuses("extra table column", `ALTER TABLE public.${d.table} ADD COLUMN extra boolean;`);
    await refuses("changed column nullability", `ALTER TABLE public.${d.table} ALTER COLUMN ${d.column} DROP NOT NULL;`);
    await refuses("external dependency", `CREATE VIEW public.rollback_extra_view AS SELECT * FROM public.${d.table};`);
   }
   if (d.parentTable) {
    await refuses("owned-column grant", `GRANT SELECT(${d.parentColumn}) ON public.${d.parentTable} TO authenticated;`);
    await refuses("owned-column changed default", `ALTER TABLE public.${d.parentTable} ALTER COLUMN ${d.parentColumn} SET DEFAULT ${d.number === "3871" ? "'{}'::jsonb" : "1"};`);
    await refuses("new dependent check", `ALTER TABLE public.${d.parentTable} ADD CONSTRAINT rollback_extra_check CHECK(${d.parentColumn} IS NULL);`);
    await refuses("new dependent index", `CREATE INDEX rollback_extra_index ON public.${d.parentTable}(${d.parentColumn});`);
    await refuses("new column-dependent view", `CREATE VIEW public.rollback_extra_view AS SELECT ${d.parentColumn} FROM public.${d.parentTable};`);
   }
   await db.exec(rollback); assert.deepEqual(await migratedCatalogAndRows(db), baseline, "full catalog/all nonledger rows restored");
   await db.exec(rollback); assert.deepEqual(await migratedCatalogAndRows(db), baseline, "repeat rollback inert");
   await db.exec(forward); await db.exec(rollback); assert.deepEqual(await migratedCatalogAndRows(db), baseline, "reapply restores exact predecessor");
   console.log(`${d.number}/${order}: ${controls} changed-object refusals, complete catalog/rows, repeat/reapply`);
  } finally { await db.close(); }
 });});
}
