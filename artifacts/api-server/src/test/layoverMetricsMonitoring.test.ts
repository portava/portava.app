import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { runLayoverMetricsTick, resetLayoverMetricAlertsForTests } from '../lib/layoverMetricsScheduler.js';
import { readLayoverMetricsReport } from '../services/airport/LayoverMetricsReport.js';
import { renderPrometheusText, createPushgatewaySink } from '../lib/providers/metricsExporter.js';
import type { LayoverMetricValue } from '../services/airport/layoverObservability.js';
const value=(name:string,n:number|null,target:number|null=0):LayoverMetricValue=>({name,kind:'counter',value:n,target,status:n===null?'UNPRODUCIBLE':'OK',blockedBy:n===null?'source unavailable':null,sampleSize:10});
const report=(metrics:LayoverMetricValue[])=>async()=>({ok:true,window:{from:'2026-10-18T00:00:00Z',to:'2026-10-19T00:00:00Z',days:7},metrics}) as Awaited<ReturnType<typeof readLayoverMetricsReport>>;
afterEach(resetLayoverMetricAlertsForTests);
describe('Layover operational monitoring',()=>{
 it('exports actual values, withholds unavailable values, and sends target alerts through the monitoring sink',async()=>{
  const captures:Array<Record<string,unknown>>=[];let body='';
  const result=await runLayoverMetricsTick({client:{} as any,nowMs:1_000_000,read:report([value('layover_sessions_detected',7,null),value('recommendation_contract_violation',2),value('decision_replay_mismatch',null)]),capture:(_name,detail)=>{captures.push(detail);},sink:{id:'test',async publish(r){body=r.text;return {ok:true,value:{delivered:r.seriesCount}};}}});
  assert.equal(result.ok,true);assert.deepEqual(captures.map(c=>c.metric),['recommendation_contract_violation']);
  assert.match(body,/portava_layover_layover_sessions_detected\{window_days="7"\} 7/);
  assert.match(body,/# TYPE portava_layover_layover_sessions_detected gauge/);
  assert.doesNotMatch(body,/^portava_layover_decision_replay_mismatch\{/m);
  assert.match(body,/decision_replay_mismatch_unproducible/);
  assert.doesNotMatch(body,/session_id|user_id|latitude|longitude/);
 });
 it('deduplicates repeated target alerts but alerts again after the cooldown',async()=>{
  let alerts=0;const options={client:{} as any,read:report([value('recommendation_contract_violation',1)]),capture:()=>{alerts++;},sink:null};
  await runLayoverMetricsTick({...options,nowMs:1_000_000});await runLayoverMetricsTick({...options,nowMs:1_000_001});assert.equal(alerts,1);
  await runLayoverMetricsTick({...options,nowMs:1_000_000+16*60_000});assert.equal(alerts,2);
 });
 it('a healthy zero does not alert and absent Pushgateway is disclosed',async()=>{
  const result=await runLayoverMetricsTick({client:{} as any,read:report([value('recommendation_contract_violation',0)]),capture:()=>assert.fail('healthy zero alerted'),sink:null});
  assert.equal(result.ok,true);if(result.ok)assert.equal(result.delivery,'not_configured');
 });
 it('failed collection or delivery alerts without claiming a successful export',async()=>{
  const failures:string[]=[];const capture=(_name:string,d:Record<string,unknown>)=>{failures.push(String(d.metric));};
  const bad=await runLayoverMetricsTick({client:{} as any,read:async()=>({ok:false,message:'layover_events failed'}),capture,sink:null});assert.equal(bad.ok,false);
  const delivery=await runLayoverMetricsTick({client:{} as any,read:report([value('layover_sessions_detected',3,null)]),capture,sink:{id:'test',async publish(){throw new Error('sink down');}}});assert.equal(delivery.ok,false);
  assert.deepEqual(failures,['collection_failed','collection_threw']);
 });
 it('replaces Pushgateway snapshots so previously available series cannot survive an unavailable measurement',async()=>{
  const requests:Array<{method:unknown;body:unknown}>=[];
  const sink=createPushgatewaySink({replace:true,readEnv:()=> 'https://monitoring.example.test',fetchImpl:(async(_url,init)=>{requests.push({method:init?.method,body:init?.body});return {ok:true,status:200} as Response;}) as typeof fetch});
  await sink.publish(renderPrometheusText([value('replan_rate',0)],{windowed:true}));
  await sink.publish(renderPrometheusText([value('replan_rate',null)],{windowed:true}));
  assert.deepEqual(requests.map(r=>r.method),['PUT','PUT']);assert.doesNotMatch(String(requests[1].body),/^replan_rate /m);
 });
});
