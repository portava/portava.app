/** Sourced activity commitment is independent of category, exertion and transport interruptibility. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readFlagState } from '../../lib/featureFlags.js';
import { logger } from '../../lib/logger.js';
import { objectiveFactInputSchema } from './layoverObjectiveEvidence.js';
export interface ActivityCommitment { state:'known'; interruptibility:'interruptible'|'committed'; minimumCommitmentMinutes:number; exitDelayMinutes:number; factIds:string[]; observedAt:string; expiresAt:string; sourceRefs:string[] }
export type ActivityCommitmentRead = {state:'disabled'}|{state:'read';byPlace:ReadonlyMap<string,ActivityCommitment>}|{state:'unavailable';reason:string};
const observedInstant=(v:unknown)=>{const ms=typeof v==='string'||v instanceof Date?new Date(v).getTime():NaN;return Number.isFinite(ms)?new Date(ms).toISOString():null;};
export function activityCommitmentFromRows(rows:readonly Record<string,unknown>[],nowMs:number): ActivityCommitment | null {
  const facts=rows.flatMap(r=>{ const p=objectiveFactInputSchema.safeParse({fact:{kind:r.kind,value:r.value},source:{sourceClass:r.source_class,sourceUrl:r.source_url,sourceNote:r.source_note,observedAt:observedInstant(r.observed_at),expiresAt:observedInstant(r.expires_at),confirmedSource:true}});return p.success&&p.data.fact.kind==='activity_commitment'&&Date.parse(p.data.source.observedAt)<=nowMs&&Date.parse(p.data.source.expiresAt)>nowMs&&typeof r.id==='string'?[{id:r.id,value:p.data.fact.value,source:p.data.source}]:[]; });
  if(!facts.length||facts.length!==rows.length||new Set(facts.map(f=>JSON.stringify(f.value))).size!==1)return null;
  return {state:'known',...facts[0]!.value,factIds:facts.map(f=>f.id).sort(),observedAt:new Date(Math.max(...facts.map(f=>Date.parse(f.source.observedAt)))).toISOString(),expiresAt:new Date(Math.min(...facts.map(f=>Date.parse(f.source.expiresAt)))).toISOString(),sourceRefs:facts.map(f=>`${f.source.sourceClass}:${f.source.sourceUrl}`).sort()};
}
export async function readActivityCommitments(db:SupabaseClient,airportId:string|null,placeIds:readonly string[],nowMs:number): Promise<ActivityCommitmentRead> {
  try {
    const flag=await readFlagState(db,'layover_activity_commitment_enabled'); if(flag==='unknown'){logger.warn({reason:'activity_capability_unreadable',airportId},'activity commitment flag unavailable');return {state:'unavailable',reason:'activity_capability_unreadable'};} if(flag==='off')return {state:'disabled'};
    if(!airportId)return {state:'unavailable',reason:'airport_unavailable'};
    const ids=[...new Set(placeIds)]; if(!ids.length)return {state:'read',byPlace:new Map()};
    const {data,error}=await db.from('layover_objective_facts').select('id,place_id,kind,value,source_class,source_url,source_note,observed_at,expires_at').eq('airport_id',airportId).eq('kind','activity_commitment').in('place_id',ids).is('retracted_at',null).gt('expires_at',new Date(nowMs).toISOString()).lte('observed_at',new Date(nowMs).toISOString()).limit(501);
    if(error||!Array.isArray(data)||data.length>500){logger.warn({err:error,airportId},'activity commitment evidence unavailable');return {state:'unavailable',reason:'activity_evidence_unreadable'};}
    return {state:'read',byPlace:new Map(ids.flatMap(id=>{const value=activityCommitmentFromRows(data.filter(r=>r.place_id===id),nowMs);return value?[[id,value] as const]:[];}))};
  }catch(err){logger.warn({err,airportId},'activity commitment evidence read failed');return {state:'unavailable',reason:'activity_evidence_unreadable'};}
}
export function requiredActivityMinutes(stated:number|null,commitment:ActivityCommitment|null):number|null {
  return stated===null||!Number.isFinite(stated)||stated<=0||!commitment?null:Math.max(stated,commitment.minimumCommitmentMinutes)+commitment.exitDelayMinutes;
}
export async function applyActivityCommitments<T extends {placeId:string|null;activityTimeMin:number|null}>(db:SupabaseClient,airportId:string|null,candidates:readonly T[],nowMs:number):Promise<T[]> {
  const read=await readActivityCommitments(db,airportId,candidates.flatMap(c=>c.placeId?[c.placeId]:[]),nowMs);
  return read.state==='disabled'?[...candidates]:candidates.map(c=>({...c,activityTimeMin:requiredActivityMinutes(c.activityTimeMin,read.state==='read'&&c.placeId?read.byPlace.get(c.placeId)??null:null)}));
}
