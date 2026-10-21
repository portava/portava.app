/** Isolated catalog + row proofs for 3890, including destructive refusal cases. */
import assert from 'node:assert/strict';
import { before,after,describe,it } from 'node:test';
import { readFileSync } from 'node:fs';
import { openPressedLayoverDb,PRESSED_SKIP_REASON,type PressedDb } from './pressedLayoverDb.js';
import { migratedCatalogAndRows } from './migratedCatalogSnapshot.js';
const forward=readFileSync(new URL('../../migrations/3890_layover_service_write_audit.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('../../../../../db/rollback/2026-10-18-3890-layover-service-write-audit-rollback.sql',import.meta.url),'utf8');
const names=['layover_capture_service_write()','layover_install_service_write_audit()','layover_service_audit_activation()','layover_expire_service_write_audit(integer)','layover_service_audit_erase_actor()'];
for (const order of ['sorted-gap','after-3999'] as const) it(`3890 whole catalog and every non-ledger row roundtrip: ${order}`, { skip: PRESSED_SKIP_REASON }, async () => {
 const isolated=await openPressedLayoverDb({without:order==='after-3999'?['3890']:[]});
 try {
  if(order==='sorted-gap')await isolated.exec(rollback);
  const user=await isolated.seedUser('audit-whole-catalog');
  await isolated.exec(`INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time) VALUES('${user.id}',now(),now()+interval '5 hours')`);
  const baseline=await migratedCatalogAndRows(isolated);
  assert.ok(Object.keys(baseline).length>20000,'whole catalog proof unexpectedly collapsed');
  await isolated.exec(forward);assert.equal(await isolated.flag('layover_service_write_audit_enabled'),false);
  await isolated.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(isolated),baseline);
  await isolated.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(isolated),baseline);
  await isolated.exec(forward);await isolated.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(isolated),baseline);
 } finally { await isolated.close(); }
});
let db:PressedDb;
async function catalog(){return {
 columns:await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='layover_service_write_audit' ORDER BY 1,2`),
 constraints:await db.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='layover_service_write_audit' ORDER BY 1,2`),
 triggers:await db.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND t.tgname LIKE 'layover_service_%' ORDER BY 1,2`),
 functions:await db.query(`SELECT proname,prosrc,prosecdef,proconfig,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (${names.map(n=>`'${n.split('(')[0]}'`).join(',')}) ORDER BY 1`),
 grants:await db.query(`SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name='layover_service_write_audit' ORDER BY 1,2,3`),
 policies:await db.query(`SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='layover_service_write_audit' ORDER BY policyname`),
 indexes:await db.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='layover_service_write_audit' ORDER BY indexname`),
 flags:await db.query(`SELECT flag,enabled,description FROM public.feature_flags WHERE flag='layover_service_write_audit_enabled'`),
 rows:await db.query(`SELECT id,user_id,status,checked_bags,arrival_time,departure_time FROM public.layover_sessions ORDER BY id`),
};}
async function refuses(pattern:RegExp){try{await assert.rejects(db.exec(rollback),pattern);}finally{await db.exec('ROLLBACK');}}
describe('3890 service audit migration recovery',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openPressedLayoverDb();const u=await db.seedUser('audit-rollback');await db.exec(`INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time) VALUES('${u.id}',now(),now()+interval '5 hours')`);});
 after(async()=>{await db?.close();});
 it('restores catalog and preexisting rows, repeats safely, and reapplies with a FALSE flag',async()=>{
  await db.exec(rollback);const original=await catalog();await db.exec(forward);assert.equal(await db.flag('layover_service_write_audit_enabled'),false);
  await db.exec(rollback);assert.deepEqual(await catalog(),original);await db.exec(rollback);assert.deepEqual(await catalog(),original);await db.exec(forward);
 });
 it('refuses an active switch, flag history, and retained audit data independently',async()=>{
  await db.setFlag('layover_service_write_audit_enabled',true);await refuses(/live flag/);assert.equal(await db.flag('layover_service_write_audit_enabled'),true);await db.setFlag('layover_service_write_audit_enabled',false);
  await db.exec(`INSERT INTO public.feature_flag_audit_log(flag,old_enabled,new_enabled) VALUES('layover_service_write_audit_enabled',true,false)`);await refuses(/flag audit history/);assert.equal((await db.query(`SELECT id FROM public.feature_flag_audit_log WHERE flag='layover_service_write_audit_enabled'`)).length,1);await db.exec(`DELETE FROM public.feature_flag_audit_log WHERE flag='layover_service_write_audit_enabled'`);
  await db.exec(`INSERT INTO public.layover_service_write_audit(actor_kind,route,table_name,operation) VALUES('database_operator','TEST','layover_sessions','UPDATE')`);await refuses(/retained audit records/);assert.equal((await db.query('SELECT id FROM public.layover_service_write_audit')).length,1);await db.exec('DELETE FROM public.layover_service_write_audit');
 });
 it('refuses changed function definitions instead of deleting later work',async()=>{
  for(const name of names){
   const definition=(await db.query<any>(`SELECT pg_get_functiondef('public.${name}'::regprocedure) AS definition`))[0].definition as string;
   await db.exec(definition.replace(/\$function\$/,'$function$\n-- changed by a later migration\n'));
   await refuses(/function was changed/);await db.exec(definition);
  }
 });
 it('refuses changed table privileges instead of removing a later grant',async()=>{
  await db.exec('GRANT UPDATE ON public.layover_service_write_audit TO service_role');await refuses(/drift|changed|definition|privilege/i);assert.equal((await db.query<any>(`SELECT has_table_privilege('service_role','public.layover_service_write_audit','UPDATE') allowed`))[0].allowed,true);await db.exec('REVOKE UPDATE ON public.layover_service_write_audit FROM service_role');
 });
 it('refuses changed planner attributes before removing a later function definition',async()=>{
  const fn='public.layover_expire_service_write_audit(integer)';
  for(const [change,restore] of [['COST 101','COST 100'],['PARALLEL SAFE','PARALLEL UNSAFE'],['LEAKPROOF','NOT LEAKPROOF']]){
   await db.exec(`ALTER FUNCTION ${fn} ${change}`);await refuses(/planner or support attributes changed/);await db.exec(`ALTER FUNCTION ${fn} ${restore}`);
  }
 });
 it('refuses disabled static or activation-installed triggers, policy drift, and changed function security attributes',async()=>{
  await db.exec('ALTER TABLE public.feature_flags DISABLE TRIGGER layover_service_audit_activation');await refuses(/changed|definition/i);assert.equal((await db.query<any>(`SELECT tgenabled FROM pg_trigger WHERE tgname='layover_service_audit_activation'`))[0].tgenabled,'D');await db.exec('ALTER TABLE public.feature_flags ENABLE TRIGGER layover_service_audit_activation');
  await db.exec('ALTER TABLE public.layover_sessions DISABLE TRIGGER layover_service_write_audit');await refuses(/trigger.*changed/i);await db.exec('ALTER TABLE public.layover_sessions ENABLE TRIGGER layover_service_write_audit');
  await db.exec('ALTER POLICY layover_service_write_audit_service_read ON public.layover_service_write_audit USING(false)');await refuses(/changed|definition/i);await db.exec('ALTER POLICY layover_service_write_audit_service_read ON public.layover_service_write_audit USING(true)');
  await db.exec('ALTER FUNCTION public.layover_expire_service_write_audit(integer) SECURITY INVOKER');await refuses(/changed|definition/i);await db.exec('ALTER FUNCTION public.layover_expire_service_write_audit(integer) SECURITY DEFINER');
  await db.exec('GRANT EXECUTE ON FUNCTION public.layover_expire_service_write_audit(integer) TO authenticated');await refuses(/changed|privilege/i);await db.exec('REVOKE EXECUTE ON FUNCTION public.layover_expire_service_write_audit(integer) FROM authenticated');
 });
 it('refuses extra objects and missing objects, preserving later work and catalog state',async()=>{
  await db.exec('CREATE VIEW public.audit_review_dependency AS SELECT id FROM public.layover_service_write_audit');await refuses(/depend|cannot drop/i);assert.ok((await db.query<any>(`SELECT to_regclass('public.audit_review_dependency') name`))[0].name);await db.exec('DROP VIEW public.audit_review_dependency');
  const definition=(await db.query<any>(`SELECT pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgname='layover_service_audit_erase_actor'`))[0].definition;await db.exec('DROP TRIGGER layover_service_audit_erase_actor ON public.profiles');await refuses(/changed|definition/i);await db.exec(definition);
  await db.exec('CREATE ROLE audit_review_grantee');await db.exec('GRANT SELECT ON public.layover_service_write_audit TO audit_review_grantee');await refuses(/changed|privilege/i);await db.exec('REVOKE SELECT ON public.layover_service_write_audit FROM audit_review_grantee');await db.exec('DROP ROLE audit_review_grantee');
 });
});
