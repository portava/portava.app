/** 3908: bounded resumable route work. Preparing a result sends no notifications;
 * settlement publishes its certified rows, decision ledger and checkpoint atomically. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readFlagState } from '../../lib/featureFlags.js';
import { rowToEnvelope } from '../layover/LayoverExternalEventService.js';
import type { LayoverEventEnvelope } from './LayoverEventReplanner.js';
import { validLayoverRouteSubject } from '../../lib/layoverRouteSubjectRef.js';

export interface RouteFanoutReport {
 enabled:boolean; scanned:number; leased:number; done:number; obsolete:number; retrying:number;
 lost:number; failed:number; hasMore:boolean; reasons:string[];
 completed:Array<{eventId:string;eventType:string;impacted:number;notifications:number}>;
}
type Prepare=(db:SupabaseClient,event:LayoverEventEnvelope,row:Record<string,any>,refs:string[],nowMs:number)=>Promise<{ok:true;payload:Record<string,unknown>;notifications:number}|{ok:false;reason:string}>;
export async function drainDurableRouteWork(db:SupabaseClient,limit:number,prepare:Prepare):Promise<RouteFanoutReport>{
 const report:RouteFanoutReport={enabled:false,scanned:0,leased:0,done:0,obsolete:0,retrying:0,lost:0,failed:0,hasMore:false,reasons:[],completed:[]};
 const fail=(reason:string)=>{report.failed++;if(!report.reasons.includes(reason))report.reasons.push(reason);};
 try {
  const flag=await readFlagState(db,'layover_route_fanout_enabled');
  if(flag==='off')return report;
  if(flag!=='on'){fail('route_fanout_flags_unreadable');return report;}
  report.enabled=true;
  const bounded=Number.isFinite(limit)?Math.min(200,Math.max(1,Math.floor(limit))):200;
  const claim=await db.rpc('layover_route_fanout_claim',{p_limit:bounded});
  if(claim.error||!claim.data||!Array.isArray(claim.data.tasks)||claim.data.tasks.length>bounded){fail('route_fanout_claim_failed');return report;}
  report.scanned=claim.data.scanned;report.leased=claim.data.tasks.length;report.hasMore=claim.data.hasMore===true;
  const tasks:unknown[]=claim.data.tasks;let next=0;
  const run=async()=>{while(next<tasks.length){const task=tasks[next++] as any;
   if(!task||typeof task.event?.event_id!=='string'||typeof task.session?.id!=='string'||typeof task.token!=='string'||typeof task.sessionRevision!=='string'||typeof task.routeRevision!=='string'||!Array.isArray(task.routeRefs)||!task.routeRefs.every(validLayoverRouteSubject)){fail('route_fanout_task_invalid');continue;}
   const retry=async(reason:string)=>{
    const code=/^[a-z][a-z0-9_]{1,100}$/.test(reason)?reason:'route_prepare_failed';
    const result=await db.rpc('layover_route_fanout_retry',{p_event:task.event.event_id,p_session:task.session.id,p_token:task.token,p_reason:code});
    if(result.error){fail('route_fanout_retry_failed');return;}
    if(result.data===true){report.retrying++;if(!report.reasons.includes(code))report.reasons.push(code);}else report.lost++;
   };
   try {
    const event=rowToEnvelope(task.event);
    if(!event||event.eventType!=='mobility.route_degraded'||event.subjectRefs.some(s=>s.kind!=='route')){await retry('route_envelope_invalid');continue;}
    const prepared=await prepare(db,event,task.session,task.routeRefs,Date.now());
    if(!prepared.ok){await retry(prepared.reason);continue;}
    const settled=await db.rpc('layover_route_fanout_settle',{p_event:event.eventId,p_session:task.session.id,p_token:task.token,p_session_revision:task.sessionRevision,p_route_revision:task.routeRevision,p_payload:prepared.payload});
    if(settled.error){await retry('route_settlement_failed');continue;}
    if(settled.data?.state==='done'){
     report.done++;
     const previous=report.completed.find(x=>x.eventId===event.eventId);
     if(previous){previous.impacted++;previous.notifications+=prepared.notifications;}
     else report.completed.push({eventId:event.eventId,eventType:event.eventType,impacted:1,notifications:prepared.notifications});
    }else if(settled.data?.state==='obsolete')report.obsolete++;
    else if(settled.data?.state==='lease_lost')report.lost++;
    else await retry(settled.data?.state==='revision_changed'?'route_revision_changed':'route_settlement_failed');
   }catch{try{await retry('route_worker_threw');}catch{fail('route_fanout_retry_failed');}}
  }};
  // Four in flight; every tick still performs at most bounded (never >200) preparations.
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},run));
 }catch{fail('route_fanout_unavailable');}
 return report;
}
