/** Independent L205 checks: real service-role HTTP ownership and request scope lifetime. */
import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openPressedLayoverDb, PRESSED_SKIP_REASON, type PressedDb, type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from './pressedLayoverApp.js';
import { auditedLayoverClient, withLayoverSystemAudit } from '../../lib/layoverServiceAudit.js';
import { _setTestClient } from '../../lib/http.js';
import { executeAccountDeletion } from '../../services/accountDeletion/AccountDeletionService.js';
let db:PressedDb, app:PressedApp, owner:PressedUser, other:PressedUser, ownSid:string, otherSid:string, ownStop:string, otherStop:string;
async function protectedRows(){
 const tables=await db.query<{name:string}>("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND left(c.relname,8)='layover_' ORDER BY 1");
 const rows:Record<string,string>={};
 for(const {name} of tables){const [r]=await db.query<{hash:string}>(`SELECT count(*)::text||':'||md5(coalesce(string_agg(r::text,'|' ORDER BY r::text),'')) AS hash FROM public."${name.replaceAll('"','""')}" r`);rows[name]=r!.hash;}
 return rows;
}
describe('L205 independent service role ownership and audit boundaries',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{
  db=await openPressedLayoverDb();await productionBaseFlags(db);
  await db.setFlags({layover_plans_enabled:true,layover_compass_replan_enabled:true,layover_experience_execution_enabled:true,layover_recommendation_status_enabled:true,layover_objective_evidence_enabled:true,layover_constraints_enabled:true,layover_stable_recommendation_ids_enabled:true}); // GET experiences must refuse by OWNERSHIP, not by getCandidates' cutover prerequisite (a0f8754f3)
  owner=await db.seedUser('audit_boundary_owner');other=await db.seedUser('audit_boundary_other');app=await startPressedLayoverApp(db);
  await db.setFlag('layover_service_write_audit_enabled',true);
  ownSid=(await startSession(app,owner,{wantsToLeave:false})).id;otherSid=(await startSession(app,other,{wantsToLeave:false})).id;
  for(const [who,sid] of [[owner,ownSid],[other,otherSid]] as const){
   const r=await app.call('POST',`/api/airport/sessions/${sid}/stops`,who,{title:'Private stop',insideAirport:true,durationMin:30});assert.equal(r.status,200,r.raw);
   if(who===owner)ownStop=r.body.stops[0].id;else otherStop=r.body.stops[0].id;
  }
 });
 after(async()=>{await app?.close();await db?.close();});
 it('a builder reused outside its verified scope cannot replay its old audit credentials',async()=>{
  let builder:any;
  await withLayoverSystemAudit('test:scope-lifetime',async()=>{
   builder=auditedLayoverClient(db.client).from('layover_sessions').update({checked_bags:true}).eq('id',ownSid);
   assert.equal((await builder).error,null);
  });
  const before=await protectedRows();const escaped=await builder;
  assert.equal(escaped.error?.code,'42501','no live scope must clear any previously injected actor/worker/request headers');
  assert.deepEqual(await protectedRows(),before,'refused replay must leave both data and audit rows untouched');
 });
 it('foreign session reads and writes refuse before any protected side effect despite spoofed identity headers',async t=>{
  const base=`/api/airport/sessions/${otherSid}`,id=randomUUID();
  const cases:Array<[string,string,unknown?]>=[
   ...['overview','safety','recommendations','stops','experiences','experiences/plan','objective-intent','safe-return'].map(path=>['GET',`${base}/${path}`] as [string,string]),
   ['PATCH',base,{checkedBags:true}],['DELETE',base],['POST',`${base}/stops`,{title:'Intrusion',insideAirport:true,durationMin:30}],
   ['PATCH',`${base}/stops/${otherStop}`,{title:'Intrusion'}],['DELETE',`${base}/stops/${otherStop}`],
   ['POST',`${base}/stops/reorder`,{orderedIds:[otherStop]}],['POST',`${base}/stops/from-recommendation`,{recommendationId:id}],
   ['POST',`${base}/experiences/compile`,{candidateIds:[id]}],['POST',`${base}/experiences/plan/select`,{requestId:id,expectedStopIds:[otherStop]}],
   ['POST',`${base}/experiences/plan/start`,{requestId:id,expectedStopIds:[otherStop],selectedPlanId:id,confirmed:true}],
   ['POST',`${base}/compass/replan`,{actionId:id,confirmed:true}],
   ['PUT',`${base}/objective-intent`,{socialPreference:null,availableEnergy:null,budget:null,meaningfulPlaces:[]}],
   ['POST',`${base}/return-now`,{}],['POST',`${base}/checkpoints`,{type:'LANDSIDE_EXIT',operationId:id}],['PATCH',`${base}/share`,{enabled:true}],
  ];
  const before=await protectedRows();
  for(const [method,path,body] of cases){const r=await app.call(method,path,owner,body,{'x-portava-layover-actor':other.id,'x-portava-layover-system':'trusted:worker','x-portava-layover-request':id});assert.equal(r.status,404,`${method} ${path}: ${r.raw}`);}
  assert.deepEqual(await protectedRows(),before);t.diagnostic(`${cases.length} actual HTTP denials; every protected table plus audit unchanged`);
 });
 it('an owned session cannot mutate a different session stop through a nested identifier',async()=>{
  const base=`/api/airport/sessions/${ownSid}`,before=await protectedRows();
  for(const method of ['PATCH','DELETE']){
   const r=await app.call(method,`${base}/stops/${otherStop}`,owner,method==='PATCH'?{title:'Intrusion'}:undefined);assert.equal(r.status,404,r.raw);
  }
  const reorder=await app.call('POST',`${base}/stops/reorder`,owner,{orderedIds:[otherStop]});assert.equal(reorder.status,400,reorder.raw);
  assert.deepEqual(await protectedRows(),before);
 });
 it('concurrent authenticated requests retain their own actor, request id and templated route',async()=>{
  const before=new Set((await db.query<{id:string}>('SELECT id FROM public.layover_service_write_audit')).map(r=>r.id));
  const replies=await Promise.all([0,1,2,3,4,5].map(i=>{const [who,sid]=i%2?[other,otherSid]as const:[owner,ownSid]as const;return app.call('PATCH',`/api/airport/sessions/${sid}`,who,{checkedBags:i%2===0},{'x-portava-layover-actor':i%2?owner.id:other.id,'x-portava-layover-route':'FORGED','x-portava-layover-request':randomUUID()});}));
  for(const r of replies)assert.equal(r.status,200,r.raw);
  const writes=(await db.query<any>("SELECT * FROM public.layover_service_write_audit WHERE table_name='layover_sessions' AND operation='UPDATE'")).filter(r=>!before.has(r.id));assert.equal(writes.length,6);
  assert.equal(new Set(writes.map(r=>r.request_id)).size,6);
  for(const row of writes){assert.equal(row.actor_user_id,row.layover_session_id===ownSid?owner.id:other.id);assert.equal(row.actor_kind,'user');assert.equal(row.system_actor,null);assert.equal(row.route,'PATCH /api/airport/sessions/:id');assert.ok(!row.route.includes(row.layover_session_id));}
 });
 it('removing the nested write session filter is killed by the same real HTTP ownership invariant',async()=>{
  // Deliberately broken service client for this request only. The live router,
  // auth, SQL and audit triggers still execute; no worktree source is mutated.
  const added=await app.call('POST',`/api/airport/sessions/${otherSid}/stops`,other,{title:'Disposable mutant control',insideAirport:true,durationMin:30});assert.equal(added.status,200,added.raw);
  const id=added.body.stops.find((s:any)=>s.title==='Disposable mutant control').id as string;
  const wrap=(builder:any,deleting=false):any=>new Proxy(builder,{get(target,key){
   const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;
   if(key==='then')return value.bind(target);
   return(...args:any[])=>key==='eq'&&deleting&&args[0]==='session_id'?wrap(target,deleting):wrap(value.apply(target,args),deleting||key==='delete');
  }});
  const mutant=new Proxy(db.client,{get(target,key){
   if(key==='from')return(name:string)=>name==='layover_plan_stops'?wrap(target.from(name)):target.from(name);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try{
   _setTestClient(mutant,true);
   const r=await app.call('DELETE',`/api/airport/sessions/${ownSid}/stops/${id}`,owner);
   assert.equal(r.status,200,r.raw);
   assert.throws(()=>assert.equal(r.status,404,'foreign nested record must be denied'),/foreign nested record must be denied/);
   assert.equal((await db.query(`SELECT id FROM public.layover_plan_stops WHERE id='${id}'`)).length,0,'mutant actually performs a foreign delete');
   const [audit]=await db.query<any>(`SELECT actor_user_id,layover_session_id FROM public.layover_service_write_audit WHERE table_name='layover_plan_stops' AND operation='DELETE' AND layover_session_id='${otherSid}' ORDER BY created_at DESC LIMIT 1`);
   assert.equal(audit.actor_user_id,owner.id,'auditing attributes the action; it does not replace route ownership checks');
  }finally{_setTestClient(db.client,true);}
 });
 it('failed activation rolls back every installed trigger and the flag; successful activation covers a newly present table',async()=>{
  await db.setFlag('layover_service_write_audit_enabled',false);
  await db.exec(`DO $drop$ DECLARE r record;BEGIN FOR r IN SELECT tgrelid::regclass AS tbl FROM pg_trigger WHERE tgname='layover_service_write_audit' LOOP EXECUTE format('DROP TRIGGER layover_service_write_audit ON %s',r.tbl);END LOOP;END $drop$;
   CREATE TABLE public.layover_audit_boundary_probe(id uuid PRIMARY KEY);GRANT ALL ON public.layover_audit_boundary_probe TO service_role;`);
  const [{definition}]=await db.query<{definition:string}>("SELECT pg_get_functiondef('public.layover_install_service_write_audit()'::regprocedure) AS definition");
  assert.equal(definition!.match(/END LOOP;/gi)?.length,1);
  const before=await protectedRows();
  try{
   await db.exec(definition!.replace(/END LOOP;/i,"END LOOP; RAISE EXCEPTION 'injected_activation_failure';"));
   await assert.rejects(db.setFlag('layover_service_write_audit_enabled',true),/injected_activation_failure/);
   assert.equal(await db.flag('layover_service_write_audit_enabled'),false);
   assert.equal((await db.query("SELECT oid FROM pg_trigger WHERE tgname='layover_service_write_audit'")).length,0,'no partially installed triggers survive failure');
   assert.deepEqual(await protectedRows(),before);
  }finally{await db.exec(definition!);}
  await db.setFlag('layover_service_write_audit_enabled',true);
  const uncovered=await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND left(c.relname,8)='layover_' AND c.relname<>'layover_service_write_audit' AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='layover_service_write_audit')");assert.deepEqual(uncovered,[]);
  // The bridge caches its schema before this DDL, so exercise the new table
  // directly under the same database role and internal request-header contract.
  const id=randomUUID();
  try{await assert.rejects(db.exec(`BEGIN;SET LOCAL ROLE service_role;SELECT set_config('request.headers','{}',true);INSERT INTO public.layover_audit_boundary_probe VALUES('${id}');COMMIT;`),/verified_scope_required/);}finally{await db.exec('ROLLBACK');}
  const headers=JSON.stringify({'x-portava-layover-system':'test:new-table','x-portava-layover-route':'SYSTEM test:new-table','x-portava-layover-request':randomUUID()});
  await db.exec(`BEGIN;SET LOCAL ROLE service_role;SELECT set_config('request.headers','${headers}',true);INSERT INTO public.layover_audit_boundary_probe VALUES('${id}');COMMIT;`);
  assert.equal((await db.query("SELECT id FROM public.layover_service_write_audit WHERE table_name='layover_audit_boundary_probe' AND system_actor='test:new-table'")).length,1);
  await db.exec('DROP TABLE public.layover_audit_boundary_probe');
 });
 it('the real content eraser plus profile tombstone removes both user and worker session links while retaining bounded audit evidence',async()=>{
  const leaver=await db.seedUser('audit_erasure_boundary'),sid=(await startSession(app,leaver)).id;
  await withLayoverSystemAudit('test:erasure-worker',async()=>{const r=await auditedLayoverClient(db.client).from('layover_sessions').update({checked_bags:true}).eq('id',sid);assert.equal(r.error,null);});
  const before=await db.query<any>(`SELECT * FROM public.layover_service_write_audit WHERE layover_session_id='${sid}'`);
  assert.ok(before.some(r=>r.actor_kind==='user')&&before.some(r=>r.actor_kind==='system'));
  const otherBefore=await db.query(`SELECT id,actor_user_id,layover_session_id FROM public.layover_service_write_audit WHERE layover_session_id='${otherSid}' ORDER BY id`);
  const out=await withLayoverSystemAudit('account:scheduled-deletion',()=>executeAccountDeletion(auditedLayoverClient(db.client),leaver.id,{actorId:null,contentOnly:true}));
  for(const step of ['pseudonymise_layover_events','delete_layover_crew_memberships','anonymise_layover_objective_sources','delete_layover_sessions'])assert.equal(out.steps.find(s=>s.step===step)?.ok,true,JSON.stringify(out.steps.filter(s=>!s.ok)));
  assert.equal((await db.query(`SELECT id FROM public.layover_sessions WHERE id='${sid}'`)).length,0);
  // contentOnly deliberately stops before profile anonymisation; execute its
  // actual tombstone boundary explicitly, without claiming auth-provider deletion.
  await db.exec(`UPDATE public.profiles SET account_status='deleted' WHERE id='${leaver.id}'`);
  const after=await db.query<any>(`SELECT * FROM public.layover_service_write_audit WHERE id IN (${before.map(r=>`'${r.id}'`).join(',')})`);assert.equal(after.length,before.length);
  for(const row of after){assert.equal(row.actor_user_id,null);assert.equal(row.layover_session_id,null);assert.ok(Date.parse(row.retain_until)-Date.parse(row.created_at)<=30*86400000);assert.ok(!JSON.stringify(row).includes(leaver.id)&&!JSON.stringify(row).includes(sid));}
  assert.deepEqual(await db.query(`SELECT id,actor_user_id,layover_session_id FROM public.layover_service_write_audit WHERE layover_session_id='${otherSid}' ORDER BY id`),otherBefore);
 });
});
