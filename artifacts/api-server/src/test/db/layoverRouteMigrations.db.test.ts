/** 3895 and 3908 full-catalog rollbacks: both installation orders, every refusal leaves catalog and rows unchanged, no-op and reapply. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESSED_SKIP_REASON, openPressedLayoverDb } from './pressedLayoverDb.js';
import { migratedCatalogAndRows } from './migratedCatalogSnapshot.js';

const forward=readFileSync(new URL('../../migrations/3908_layover_route_fanout.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('../../../../../db/rollback/2026-10-19-3908-layover-route-fanout-rollback.sql',import.meta.url),'utf8');
const routeForward=readFileSync(new URL('../../migrations/3895_layover_route_subject_index.sql',import.meta.url),'utf8');
const routeRollback=readFileSync(new URL('../../../../../db/rollback/2026-10-18-3895-layover-route-subject-index-rollback.sql',import.meta.url),'utf8');
for(const order of ['sorted-gap','after-3999'] as const)describe('3908 full catalog rollback '+order,{skip:PRESSED_SKIP_REASON},()=>{it('3908 full catalog rollback '+order,async()=>{
 const db=await openPressedLayoverDb({without:order==='after-3999'?['3908']:[]});
 try{
  if(order==='sorted-gap')await db.exec(rollback);
  const u=await db.seedUser('rollback3908');const baseline=await migratedCatalogAndRows(db);await db.exec(forward);const installed=await migratedCatalogAndRows(db);
  const refuses=async(label:string,setup:string,re:RegExp,sql=rollback)=>{await db.exec('BEGIN;'+setup);let err:unknown;try{await db.exec(sql);}catch(e){err=e;}await db.exec('ROLLBACK');assert.ok(err,label);assert.match(String((err as Error).message),re);assert.deepEqual(await migratedCatalogAndRows(db),installed,label+' changed catalog/data');};
  await refuses('flag ON',"UPDATE public.feature_flags SET enabled=true WHERE flag='layover_route_fanout_enabled';",/flag is enabled/);
  await refuses('audit history',`INSERT INTO public.feature_flag_audit_log(flag,changed_by_user_id,old_enabled,new_enabled) VALUES('layover_route_fanout_enabled','${u.id}',false,true);`,/audit history/);
  const event=`INSERT INTO public.layover_external_events(event_id,event_type,occurred_at,received_at,source,source_event_id,dedup_key,subject_refs,payload,confidence) VALUES('rollback3908','mobility.route_degraded',now(),now(),'fixture','1','fixture-rollback3908','[]','{}','HIGH');`;
  await refuses('cursor evidence',event+"INSERT INTO public.layover_route_dispatches(event_id) VALUES('rollback3908');",/evidence exists/);
  await refuses('work evidence',event+`WITH s AS(INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time) VALUES('${u.id}',now(),now()+interval '8 hours') RETURNING id) INSERT INTO public.layover_route_work(event_id,session_id,user_id) SELECT 'rollback3908',id,'${u.id}' FROM s;`,/evidence exists/);
  await refuses('grant drift','GRANT SELECT ON public.layover_route_work TO authenticated;',/definition changed/);
  await refuses('empty table ACL','REVOKE ALL ON public.layover_route_work FROM service_role;',/definition changed/);
  await refuses('empty function ACL','REVOKE ALL ON FUNCTION public.layover_route_fanout_claim(integer) FROM service_role;',/definition changed/);
  await refuses('column ACL','GRANT SELECT(state) ON public.layover_route_work TO authenticated;',/definition changed/);
  await refuses('NOT NULL drift','ALTER TABLE public.layover_route_work ALTER COLUMN attempts DROP NOT NULL;',/definition changed/);
  await refuses('planner attributes','ALTER FUNCTION public.layover_route_fanout_claim(integer) COST 123;',/definition changed/);
  await refuses('security drift','ALTER FUNCTION public.layover_route_fanout_claim(integer) SECURITY INVOKER;',/definition changed/);
  await refuses('partial install','DROP FUNCTION public.layover_route_watch_state(text,uuid,uuid);',/incomplete/);
  await refuses('RLS policy','CREATE POLICY route_fanout_extra ON public.layover_route_work FOR SELECT TO authenticated USING(true);',/definition changed/);
  await refuses('later dependent','CREATE VIEW public.rollback3908_extra AS SELECT * FROM public.layover_route_work;',/depend|cannot drop/i);
  await refuses('3895 cannot strand 3908','',/retire dependent ?3908/,routeRollback);
  await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'full catalog + all nonledger rows');
  await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'second run is a no-op');
  await db.exec(forward);await db.exec(rollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'reapply roundtrip');
 }finally{await db.close();}
});});
for(const order of ['sorted-gap','after-3999'] as const)describe('3895 full catalog rollback '+order,{skip:PRESSED_SKIP_REASON},()=>{it('3895 full catalog rollback '+order,async()=>{
 // 3908 depends on 3895 and is proven above; it is omitted here so 3895 is the newest route object.
 const db=await openPressedLayoverDb({without:order==='after-3999'?['3895','3908']:['3908']});
 try{
  if(order==='sorted-gap')await db.exec(routeRollback);
  const u=await db.seedUser('rollback3895');const baseline=await migratedCatalogAndRows(db);await db.exec(routeForward);const installed=await migratedCatalogAndRows(db);
  const refuses=async(label:string,setup:string,re:RegExp)=>{await db.exec('BEGIN;'+setup);let err:unknown;try{await db.exec(routeRollback);}catch(e){err=e;}await db.exec('ROLLBACK');assert.ok(err,label);assert.match(String((err as Error).message),re);assert.deepEqual(await migratedCatalogAndRows(db),installed,label+' changed catalog/data');};
  await refuses('flag ON',"UPDATE public.feature_flags SET enabled=true WHERE flag='layover_route_subjects_enabled';",/flag is enabled/);
  await refuses('audit history',`INSERT INTO public.feature_flag_audit_log(flag,changed_by_user_id,old_enabled,new_enabled) VALUES('layover_route_subjects_enabled','${u.id}',false,true);`,/audit history exists/);
  await refuses('private route watch',`WITH l AS (INSERT INTO public.layover_sessions(user_id,arrival_time,departure_time) VALUES('${u.id}',now(),now()+interval '8 hours') RETURNING id), r AS (INSERT INTO public.layover_recommendations(session_id,rec_type,title,inside_airport) SELECT id,'food','Rollback fixture',true FROM l RETURNING id,session_id) INSERT INTO public.layover_route_subjects(session_id,user_id,snapshot_id,recommendation_id,route_ref) SELECT r.session_id,'${u.id}','fixture-provenance',r.id,'layover-route:v1:'||repeat('a',64) FROM r;`,/evidence exists/);
  await refuses('grant drift','GRANT SELECT ON public.layover_route_subjects TO authenticated;',/definition changed/);
  await refuses('function drift','ALTER FUNCTION public.layover_recommendation_route_watch() SECURITY INVOKER;',/definition changed/);
  await refuses('partial install','DROP TRIGGER layover_recommendation_route_watch ON public.layover_recommendations; DROP FUNCTION public.layover_recommendation_route_watch();',/incomplete/);
  await refuses('trigger drift','ALTER TABLE public.layover_recommendations DISABLE TRIGGER layover_recommendation_route_watch;',/definition changed/);
  await refuses('extra policy','CREATE POLICY rollback_route_extra ON public.layover_route_subjects FOR SELECT TO authenticated USING(true);',/definition changed/);
  await refuses('custom role grant','CREATE ROLE rollback_extra_grantee;GRANT SELECT ON public.layover_route_subjects TO rollback_extra_grantee;',/definition changed/);
  await refuses('column grant drift','GRANT SELECT(route_ref) ON public.layover_route_subjects TO authenticated;',/definition changed/);
  await refuses('empty table ACL','REVOKE ALL ON public.layover_route_subjects FROM service_role;',/definition changed/);
  await refuses('empty function ACL','REVOKE ALL ON FUNCTION public.layover_active_sessions_by_routes(text[],timestamptz,integer) FROM service_role;',/definition changed/);
  await refuses('function planner attributes','ALTER FUNCTION public.layover_recommendation_route_watch() COST 123;',/definition changed/);
  await refuses('external view','CREATE VIEW public.rollback3895_extra AS SELECT * FROM public.layover_route_subjects;',/depend|cannot drop/i);
  await db.exec(routeRollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'full catalog + all nonledger rows');
  await db.exec(routeRollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'second run is a no-op');
  await db.exec(routeForward);await db.exec(routeRollback);assert.deepEqual(await migratedCatalogAndRows(db),baseline,'reapply roundtrip');
 }finally{await db.close();}
});});
