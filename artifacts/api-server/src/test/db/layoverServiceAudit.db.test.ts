import assert from 'node:assert/strict';
import { before,after,describe,it } from 'node:test';
import { openForPress,type PressedDb,type PressedUser,PRESSED_SKIP_REASON } from './pressedLayoverDb.js';
import { productionBaseFlags,startPressedLayoverApp,startSession,type PressedApp } from './pressedLayoverApp.js';
import { withLayoverSystemAudit,auditedLayoverClient } from '../../lib/layoverServiceAudit.js';
import { runLayoverPresenceExpirySweep } from '../../lib/layoverPresenceExpiryScheduler.js';
import { runLayoverAuditRetentionTick,getLayoverAuditRetentionStatus } from '../../lib/layoverAuditRetentionScheduler.js';
let db:PressedDb,app:PressedApp,owner:PressedUser,outsider:PressedUser,sid:string;
const PRESS={migrations:['3890'],flags:{}};
describe('atomic scoped Layover service audit',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{db=await openForPress(PRESS);await productionBaseFlags(db);app=await startPressedLayoverApp(db);owner=await db.seedUser('audit-owner');outsider=await db.seedUser('audit-outsider');await db.setFlag('layover_service_write_audit_enabled',true);sid=(await startSession(app,owner)).id;});
 after(async()=>{await app?.close();await db?.close();});
 it('A1 successful HTTP writes record verified actor, route, session and applied outcome in the same database',async()=>{
  const rows=await db.query<any>(`SELECT * FROM public.layover_service_write_audit WHERE layover_session_id='${sid}' AND table_name='layover_sessions'`);
  assert.equal(rows.length,1);assert.equal(rows[0].actor_user_id,owner.id);assert.equal(rows[0].actor_kind,'user');assert.match(rows[0].route,/POST.*airport\/sessions/);assert.equal(rows[0].outcome,'applied');assert.ok(rows[0].request_id);
  assert.deepEqual(Object.keys(rows[0]).sort(),['id','request_id','actor_kind','actor_user_id','system_actor','route','layover_session_id','table_name','operation','outcome','created_at','retain_until'].sort());
 });
 it('A2 incoming spoofed actor headers cannot replace the authenticated actor; ownership denial causes no protected write',async()=>{
  const before=(await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit`))[0].n;
  const denied=await app.call('PATCH',`/api/airport/sessions/${sid}`,outsider,{checkedBags:true},{'x-portava-layover-actor':owner.id,'x-portava-layover-system':'trusted_worker'});assert.equal(denied.status,404,denied.raw);
  assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit`))[0].n,before);
  const applied=await app.call('PATCH',`/api/airport/sessions/${sid}`,owner,{checkedBags:true},{'x-portava-layover-actor':outsider.id,'x-portava-layover-system':'trusted_worker'});assert.equal(applied.status,200,applied.raw);
  const rows=await db.query<any>(`SELECT actor_user_id,actor_kind,system_actor FROM public.layover_service_write_audit WHERE layover_session_id='${sid}' AND operation='UPDATE'`);
  assert.ok(rows.length);assert.ok(rows.every(r=>r.actor_user_id===owner.id&&r.actor_kind==='user'&&r.system_actor===null));
 });
 it('A3 unscoped service writes refuse and roll back; trusted worker identity is explicit',async()=>{
  const unscoped=await db.client.from('layover_sessions').update({checked_bags:false}).eq('id',sid);assert.equal(unscoped.error?.code,'42501');
  assert.equal((await db.query<any>(`SELECT checked_bags FROM public.layover_sessions WHERE id='${sid}'`))[0].checked_bags,true);
  const applied=await withLayoverSystemAudit('test:verified-worker',async()=>auditedLayoverClient(db.client).from('layover_sessions').update({checked_bags:false}).eq('id',sid));assert.equal(applied.error,null);
  const rows=await db.query<any>(`SELECT * FROM public.layover_service_write_audit WHERE system_actor='test:verified-worker'`);assert.equal(rows.length,1);assert.equal(rows[0].actor_user_id,null);assert.equal(rows[0].actor_kind,'system');
 });
 it('A4 every protected table receives the atomic trigger at activation; no direct client audit access or service edits',async()=>{
  const uncovered=await db.query<any>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND left(c.relname,8)='layover_' AND c.relname<>'layover_service_write_audit' AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='layover_service_write_audit')`);assert.deepEqual(uncovered,[]);
  await assert.rejects(db.asUser(owner.id,'SELECT * FROM public.layover_service_write_audit'),/permission denied/);
  const mutation=await db.client.from('layover_service_write_audit').delete().eq('layover_session_id',sid);assert.equal(mutation.error?.code,'42501');
 });
 it('A5 rolled-back protected writes leave no applied audit record',async()=>{
  const before=(await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit`))[0].n;
  await assert.rejects(db.exec(`BEGIN;UPDATE public.layover_sessions SET checked_bags=true WHERE id='${sid}';SELECT 1/0;COMMIT;`));
  await db.exec('ROLLBACK');assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit`))[0].n,before);
 });
 it('A6 the actual presence worker deletes expired rows under a named system scope',async()=>{
  await db.exec(`INSERT INTO public.layover_presence(session_id,user_id,intents,available_from,available_until,expires_at) VALUES('${sid}','${owner.id}','{food}',now()-interval '3 hours',now()-interval '1 hour',now()-interval '1 hour')`);
  const result=await runLayoverPresenceExpirySweep({client:db.client,now:new Date()});assert.equal(result.outcome,'swept');assert.equal(result.deleted,1);
  const rows=await db.query<any>(`SELECT * FROM public.layover_service_write_audit WHERE table_name='layover_presence' AND operation='DELETE'`);assert.equal(rows.length,1);assert.equal(rows[0].system_actor,'layover:presence-expiry');assert.equal(rows[0].actor_user_id,null);
 });
 it('A7 the running retention tick expires old records even after auditing is disabled',async()=>{
  const kept=(await db.query<any>(`SELECT id FROM public.layover_service_write_audit ORDER BY id LIMIT 1`))[0].id;
  await db.exec(`UPDATE public.layover_service_write_audit SET created_at=now()-interval '31 days',retain_until=now()-interval '1 day' WHERE id<>'${kept}'`);
  await db.setFlag('layover_service_write_audit_enabled',false);
  await runLayoverAuditRetentionTick({client:db.client,now:new Date()});assert.equal(getLayoverAuditRetentionStatus().consecutiveFailures,0);
  assert.deepEqual((await db.query<any>('SELECT id FROM public.layover_service_write_audit')).map(r=>r.id),[kept]);
  await db.setFlag('layover_service_write_audit_enabled',true);
 });
 it('A8 account tombstoning removes the actor and session identifier without deleting retained evidence',async()=>{
  const changed=await app.call('PATCH',`/api/airport/sessions/${sid}`,owner,{checkedBags:true});assert.equal(changed.status,200,changed.raw);
  const ids=(await db.query<any>(`SELECT id FROM public.layover_service_write_audit WHERE actor_user_id='${owner.id}'`)).map(r=>r.id);assert.ok(ids.length);
  await db.exec(`UPDATE public.profiles SET account_status='deleted' WHERE id='${owner.id}'`);
  const rows=await db.query<any>(`SELECT id,actor_user_id,layover_session_id FROM public.layover_service_write_audit WHERE id IN (${ids.map(id=>`'${id}'`).join(',')})`);assert.equal(rows.length,ids.length);assert.ok(rows.every(r=>r.actor_user_id===null&&r.layover_session_id===null));
 });
 it('A9 the running expiry tick catches up more than one page, preserving unexpired evidence even while auditing is OFF',async()=>{
  await db.setFlag('layover_service_write_audit_enabled',false);const kept=(await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until>now()`))[0].n;
  await db.exec(`INSERT INTO public.layover_service_write_audit(actor_kind,system_actor,route,table_name,operation,created_at,retain_until) SELECT 'system','fixture:backlog','SYSTEM fixture:backlog','layover_sessions','UPDATE',now()-interval '31 days',now()-interval '1 day' FROM generate_series(1,501)`);
  await runLayoverAuditRetentionTick({client:db.client,now:new Date()});assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until<=now()`))[0].n,0,'one full page must trigger another bounded page');assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until>now()`))[0].n,kept);assert.equal(getLayoverAuditRetentionStatus().consecutiveFailures,0);
 });
 it('A10 an over-cap backlog is bounded, visible as incomplete health, and cleared by the next pass',async()=>{
  const kept=(await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until>now()`))[0].n;
  await db.exec(`INSERT INTO public.layover_service_write_audit(actor_kind,system_actor,route,table_name,operation,created_at,retain_until) SELECT 'system','fixture:backlog','SYSTEM fixture:backlog','layover_sessions','UPDATE',now()-interval '31 days',now()-interval '1 day' FROM generate_series(1,5001)`);
  const success=getLayoverAuditRetentionStatus().lastSuccessAt;
  const first=await runLayoverAuditRetentionTick({client:db.client,now:new Date()});assert.equal(first.reason,'retention_backlog');assert.equal(first.complete,false);
  const health=getLayoverAuditRetentionStatus();assert.equal(health.lastServiceAudit?.deleted,5000);assert.equal(health.lastServiceAudit?.batches,10);assert.equal(health.lastServiceAudit?.complete,false);assert.ok(health.lastServiceAudit?.oldestExpiredAt);assert.ok(health.consecutiveFailures>0);assert.equal(health.lastSuccessAt,success);
  assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until<=now()`))[0].n,1);
  await runLayoverAuditRetentionTick({client:db.client,now:new Date()});assert.equal(getLayoverAuditRetentionStatus().consecutiveFailures,0);assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until<=now()`))[0].n,0);assert.equal((await db.query<any>(`SELECT count(*)::int n FROM public.layover_service_write_audit WHERE retain_until>now()`))[0].n,kept);
 });
});
