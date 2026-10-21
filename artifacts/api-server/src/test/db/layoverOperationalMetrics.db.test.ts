import assert from 'node:assert/strict';
import { before,after,describe,it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { openForPress, applyPress, PRESSED_SKIP_REASON,type PressedDb,type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags,startPressedLayoverApp,startSession,type PressedApp } from './pressedLayoverApp.js';
import { runLayoverMetricsTick,resetLayoverMetricAlertsForTests } from '../../lib/layoverMetricsScheduler.js';
import { resetSchemaCapabilityMemo } from '../../lib/capability/schemaCapability.js';
const PRESS={migrations:['3893'],flags:{layover_decision_persistence_enabled:true,layover_safe_return_status_enabled:true}};
let db:PressedDb,app:PressedApp,admin:PressedUser;
const users:PressedUser[]=[],sessions:string[]=[];
const metric=(report:any,name:string)=>report.metrics.find((m:any)=>m.name===name);
const read=()=>app.call('GET','/api/admin/layover/metrics?days=1',admin);
describe('Layover operational metrics on the real migrated schema',{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{
  db=await openForPress(PRESS);await productionBaseFlags(db);await applyPress(db,PRESS);app=await startPressedLayoverApp(db);
  admin=await db.seedUser('metrics-admin');await db.exec(`UPDATE public.profiles SET role='admin' WHERE id='${admin.id}'`);
  for(let n=0;n<3;n++){users.push(await db.seedUser(`metrics-${n}`));sessions.push((await startSession(app,users[n]!)).id);}
 });
 after(async()=>{await app?.close();await db?.close();resetLayoverMetricAlertsForTests();});
 it('M1 exports measured session detections through the protected HTTP and scheduled paths',async()=>{
  const response=await read();assert.equal(response.status,200,response.raw);assert.equal(metric(response.body,'layover_sessions_detected').value,3);
  assert.notEqual((await app.call('GET','/api/admin/layover/metrics',users[0]!)).status,200);
  const scrape=await app.call('GET','/api/admin/layover/metrics?format=prometheus',admin);assert.equal(scrape.status,200,scrape.raw);assert.match(scrape.raw,/portava_layover_layover_sessions_detected\{window_days="7"\} 3/);assert.match(scrape.raw,/# TYPE portava_layover_layover_sessions_detected gauge/);
  let exported='';const tick=await runLayoverMetricsTick({client:db.client,sink:{id:'test',async publish(x){exported=x.text;return {ok:true,value:{delivered:x.seriesCount}};}},capture:()=>{}});assert.equal(tick.ok,true);assert.match(exported,/layover_sessions_detected\{window_days="7"\} 3/);assert.ok(!exported.includes(users[0]!.id));
 });
 it('M2 deduplicates replan ledger fanout and excludes ordinary session edits from numerator',async()=>{
  await db.exec(`INSERT INTO public.layover_events(session_id,user_id,event_type,metadata,created_at) VALUES
   ('${sessions[0]}','${users[0]!.id}','session_updated','{"replan":{"counts":{"replanned":8}}}',now()-interval '1 second'),
   ('${sessions[0]}','${users[0]!.id}','session_updated','{"replan":{"counts":{"replanned":8}}}',now()-interval '1 second'),
   ('${sessions[1]}','${users[1]!.id}','session_updated','{}',now()-interval '1 second')`);
  const r=await read();assert.equal(r.status,200,r.raw);assert.equal(metric(r.body,'replan_rate').value,1/3);assert.equal(metric(r.body,'replan_rate').sampleSize,3);
 });
 it('M3 actual return-now → checkpoint reentry → outcome closes one of two started returns',async()=>{
  const exit=await app.call('POST',`/api/airport/sessions/${sessions[0]}/checkpoints`,users[0]!,{type:'LANDSIDE_EXIT',operationId:randomUUID()});assert.equal(exit.status,201,exit.raw);
  for(const n of [0,0,1]){const abort=await app.call('POST',`/api/airport/sessions/${sessions[n]}/return-now`,users[n]!,{});assert.equal(abort.status,200,abort.raw);}
  const entry=await app.call('POST',`/api/airport/sessions/${sessions[0]}/checkpoints`,users[0]!,{type:'AIRPORT_REENTRY',operationId:randomUUID()});assert.equal(entry.status,201,entry.raw);
  for(const n of [0,1]){const close=await app.call('DELETE',`/api/airport/sessions/${sessions[n]}`,users[n]!,{outcome:'completed'});assert.equal(close.status,200,close.raw);assert.equal(close.body.outcomeRecord.recorded,true);}
  const r=await read();assert.equal(r.status,200,r.raw);assert.equal(metric(r.body,'safe_return_completion_rate').value,0.5,JSON.stringify(r.body.operationalSources));assert.equal(metric(r.body,'safe_return_completion_rate').sampleSize,2);
 });
 it('M4 missing outcome schema is named unavailable, then recovery sees the measured rate',async()=>{
  resetSchemaCapabilityMemo();await db.exec('ALTER TABLE public.layover_outcomes RENAME TO layover_outcomes_metric_test');
  try{const r=await read();assert.equal(r.status,200,r.raw);assert.equal(metric(r.body,'safe_return_completion_rate').value,null);assert.match(metric(r.body,'safe_return_completion_rate').blockedBy,/2992.*3893/);}finally{await db.exec('ALTER TABLE public.layover_outcomes_metric_test RENAME TO layover_outcomes');resetSchemaCapabilityMemo();}
  assert.equal(metric((await read()).body,'safe_return_completion_rate').value,0.5);
 });
 it('M5 persistence OFF withholds outcome measurements and does not report a zero rate',async()=>{
  await db.setFlag('layover_decision_persistence_enabled',false);try{const r=await read();assert.equal(r.status,200,r.raw);assert.equal(metric(r.body,'safe_return_completion_rate').value,null);assert.match(metric(r.body,'safe_return_completion_rate').blockedBy,/OFF/);}finally{await db.setFlag('layover_decision_persistence_enabled',true);}
 });
 it('M6 malformed replan metadata does not silently produce a partial rate',async()=>{
  const id=randomUUID();await db.exec(`INSERT INTO public.layover_events(id,session_id,user_id,event_type,metadata,created_at) VALUES('${id}','${sessions[2]}','${users[2]!.id}','session_updated','{"replan":{"counts":{"replanned":"1"}}}',now()-interval '1 second')`);
  const r=await read();assert.equal(r.status,200,r.raw);assert.equal(metric(r.body,'replan_rate').value,null);assert.match(metric(r.body,'replan_rate').blockedBy,/malformed/);
 });
 it('M7 a persisted contract violation reaches the monitoring alert and exported target series',async()=>{
  const {LAYOVER_CONTRACT_MONITOR_VERSION}=await import('../../services/airport/layoverContractMonitor.js');
  const tally=JSON.stringify({contract:{monitorVersion:LAYOVER_CONTRACT_MONITOR_VERSION,checked:4,violating:1,byCheck:{HARD_RETURN_DIVERGES:1}}});
  await db.exec(`INSERT INTO public.layover_events(session_id,user_id,event_type,metadata,created_at) VALUES('${sessions[2]}','${users[2]!.id}','recommendation_generated','${tally}',now()-interval '1 second')`);
  const alerts:Array<Record<string,unknown>>=[];let exported='';
  const result=await runLayoverMetricsTick({client:db.client,capture:(_name,detail)=>{alerts.push(detail);},sink:{id:'test',async publish(x){exported=x.text;return {ok:true,value:{delivered:x.seriesCount}};}}});
  assert.equal(result.ok,true);assert.ok(alerts.some(a=>a.metric==='recommendation_contract_violation'&&a.value===1));
  assert.match(exported,/portava_layover_recommendation_contract_violation_target\{window_days="7"\} 0/);
 });

});
