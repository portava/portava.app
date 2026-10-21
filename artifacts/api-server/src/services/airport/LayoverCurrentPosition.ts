/** One explicit location request. Coordinates live only in this request and the provider call, never in a saved plan. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LayoverFeasibilityRecord } from './LayoverFeasibility.js';
import { loadCompilationCandidates } from './LayoverExperienceService.js';
import { airportPoint, layoverRoutesGuardedCorridor, withLayoverRoutesBudget } from './LayoverTravelTime.js';
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, routedLegOf, type RoutedLeg, type RoutedLegs } from './LayoverReturnCorridor.js';
import { conservativeReturnMinutes, robustnessOf, LAYOVER_ROUTED_POLICY } from './LayoverRoutedFeasibility.js';
import type { RouteCorridorProvider, RouteCorridor } from '../../lib/providers/routeCorridorProvider.js';
import type { GeoPoint } from '../../domain/trips/contracts/TravelTimeProvider.js';
import { worstTravelConfidence, type TravelConfidence } from '../../lib/travelEstimate.js';
import { computeFreedomWindows, type EngineCommitment } from '../../domain/temporal/TemporalFreedomEngine.js';
import { constrainFreedomWindow } from '../../domain/temporal/TemporalFreedomPolicy.js';
import { logger } from '../../lib/logger.js';

export const currentPositionRequestSchema=z.object({requestId:z.string().uuid(),candidateId:z.string().min(1).max(200),snapshotId:z.string().min(1).max(200),origin:z.object({lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),accuracyMeters:z.number().finite().min(0).max(1000),observedAt:z.string().datetime(),mode:z.enum(['walk','drive'])}).strict()}).strict();
type Request=z.infer<typeof currentPositionRequestSchema>;
type Binding={actor:string;session:string;snapshot:string;request:string;record:LayoverFeasibilityRecord;created:number;expires:number;origin:Request['origin']};
export interface CurrentPositionProof { readonly requestId:string }
const PROOFS=new WeakMap<CurrentPositionProof,Binding>();
/** No coordinate-derived key is persisted or exposed; copying the public identity does not copy this authority. */
export function bindCurrentPosition(actor:string,session:string,snapshot:string,record:LayoverFeasibilityRecord,input:Request,nowMs:number):CurrentPositionProof|null {
  const parsed=currentPositionRequestSchema.safeParse(input);if(!parsed.success||input.snapshotId!==snapshot||!actor||!session||!Number.isFinite(nowMs))return null;
  const observed=Date.parse(parsed.data.origin.observedAt);if(observed>nowMs||nowMs-observed>=120000)return null;
  const proof=Object.freeze({requestId:input.requestId});PROOFS.set(proof,{actor,session,snapshot,request:input.requestId,record,created:nowMs,expires:observed+120000,origin:parsed.data.origin});return proof;
}
export function currentPositionBinding(proof:CurrentPositionProof,actor:string,session:string,snapshot:string,record:LayoverFeasibilityRecord,nowMs:number):Readonly<Binding>|null {
  const b=PROOFS.get(proof);return b&&b.actor===actor&&b.session===session&&b.snapshot===snapshot&&b.record===record&&b.request===proof.requestId&&nowMs>=b.created&&nowMs<b.expires?b:null;
}
export function currentPositionFreedom(record:LayoverFeasibilityRecord,origin:GeoPoint,airport:GeoPoint,nowMs:number,returnMinutes:number,confidence:TravelConfidence){
  const hard=record.deadline.hardReturnTime.getTime();if(!Number.isFinite(returnMinutes)||returnMinutes<0||!Number.isFinite(hard))return null;
  const fixed={flexibility:'fixed',prepMinutes:0,latenessToleranceMinutes:0,hardConstraints:[{kind:'NO_LATE_ARRIVAL' as const,detail:'Flight deadline cannot move'}],confidence};
  const commitments:EngineCommitment[]=[{...fixed,id:'current-position',type:'current_position',startsAt:new Date(nowMs),requiredArrivalAt:new Date(nowMs),endsAt:new Date(nowMs),place:{placeId:null,point:origin}},{...fixed,id:'airport-return',type:'airport_return',startsAt:new Date(hard),requiredArrivalAt:new Date(hard),endsAt:null,place:{placeId:record.inputs.airport.id,point:airport}}];
  const result=computeFreedomWindows({commitments,hops:[{travelMinutes:returnMinutes,confidence,routed:true,unknownReason:null}],participants:[],horizonStart:null,horizonEnd:null}),window=result.windows[0];if(!window)return null;
  const policy=record.envelope.freedomWindow;
  return constrainFreedomWindow({...window,usableMinutes:Math.min(window.durationMinutes,policy?.usableMinutes??record.envelope.usableMinutes)},{maxLatenessMinutes:0,unsafeActionsPermitted:false,uncertaintyShare:policy?.uncertaintyBudget?.share??0,softConstraints:policy?.softConstraints??[]},nowMs);
}
type Refusal={ok:false;reason:string};
interface Leg {departAt:string;arrivesAt:string;minutes:number;conservativeMinutes:number;expiresAt:string;confidence:TravelConfidence;mode:'walk'|'drive'}
const same=(a:GeoPoint,b:GeoPoint)=>a.lat===b.lat&&a.lng===b.lng;
/** Stored confidence is free text; anything but a known routed grade is the weakest grade. */
export const travelConfidenceOf=(value:string|null|undefined):TravelConfidence=>value==='HIGH'||value==='MEDIUM'||value==='LOW'?value:'INSUFFICIENT';
/** A request mode is not evidence of the returned mode. Validate source times and every offered leg. */
export function currentPositionCorridorMatches(c:RouteCorridor,from:GeoPoint,to:GeoPoint,depart:number,mode:'walk'|'drive',nowMs:number):boolean {
  const observed=Date.parse(c.observedAt),expiry=Date.parse(c.expiresAt);
  return same(c.from,from)&&same(c.to,to)&&Date.parse(c.departAt)===depart&&Number.isFinite(observed)&&observed<=nowMs&&Number.isFinite(expiry)&&expiry>nowMs&&expiry>observed&&['HIGH','MEDIUM','LOW'].includes(c.confidence)&&c.sourceRefs.length>0&&c.routes.length>0&&c.routes.every(r=>Number.isFinite(r.totalMinutes)&&r.totalMinutes>=0&&r.legs.length>0&&r.legs.every(l=>l.mode===mode&&Number.isFinite(l.minutes)&&l.minutes>=0&&(l.distanceMeters===null||Number.isFinite(l.distanceMeters)&&l.distanceMeters>=0))&&r.totalMinutes+0.000001>=r.legs.reduce((sum,l)=>sum+l.minutes,0));
}
/** This preview is never an executable-plan write, and cannot substitute for a fresh Start experience check. */
export async function previewCurrentPosition(db:SupabaseClient,actor:string,sessionId:string,raw:unknown,opts:{provider?:RouteCorridorProvider;clock?:()=>number}={}){
  const clock=opts.clock??Date.now,started=clock(),request=currentPositionRequestSchema.safeParse(raw);if(!request.success)return {ok:false as const,reason:'invalid_origin'};
  const input=request.data;
  try {
    const loaded=await loadCompilationCandidates(db,actor,sessionId,[input.candidateId],started);if(!loaded.ok)return loaded;
    if(input.snapshotId!==loaded.snapshotId)return {ok:false as const,reason:'snapshot_changed'};
    const candidate=loaded.candidates[0]!,destination=airportPoint(loaded.airport);if(candidate.insideAirport||!candidate.point||!destination)return {ok:false as const,reason:'outside_candidate_required'};
    const proof=bindCurrentPosition(actor,sessionId,loaded.snapshotId,loaded.record,input,started);if(!proof)return {ok:false as const,reason:'origin_stale_or_inaccurate'};
    const read=()=>currentPositionBinding(proof,actor,sessionId,loaded.snapshotId,loaded.record,clock());
    const provider=layoverRoutesGuardedCorridor(opts.provider??LAYOVER_RETURN_CORRIDOR_PROVIDER);if(!provider.routed)return {ok:false as const,reason:'PROVIDER_UNBOUND'};
    const confidence=travelConfidenceOf(loaded.record.confidence);
    const route=async(from:GeoPoint,to:GeoPoint,depart:number):Promise<{ok:true;leg:Leg}|Refusal>=>{
      if(!read())return {ok:false,reason:'position_check_expired'};let timer:ReturnType<typeof setTimeout>|undefined;
      try {const response=await Promise.race([provider.corridor({from,to,departAt:new Date(depart),mode:input.origin.mode,wantAlternatives:true,cachePolicy:'no_store'}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('route_timeout')),3500);})]);
        if(!response.ok)return {ok:false,reason:response.reason};const c=response.value;
        if(!currentPositionCorridorMatches(c,from,to,depart,input.origin.mode,clock()))return {ok:false,reason:'PROVIDER_MALFORMED'};
        const leg=routedLegOf({...c,routes:[...c.routes].sort((a,b)=>a.totalMinutes-b.totalMinutes)},input.origin.mode);if(!leg.forecast)return {ok:false,reason:'return_forecast_unavailable'};
        const conf=worstTravelConfidence(confidence,leg.confidence),conservative=conservativeReturnMinutes(leg.minutes,conf,robustnessOf({returnLeg:leg} as RoutedLegs));if(!conservative)return {ok:false,reason:'confidence_insufficient'};
        return {ok:true,leg:{departAt:c.departAt,arrivesAt:new Date(depart+conservative.minutes*60000).toISOString(),minutes:leg.minutes,conservativeMinutes:conservative.minutes,expiresAt:c.expiresAt,confidence:conf,mode:input.origin.mode}};
      }catch(err){logger.warn({err:{code:'PROVIDER_UNAVAILABLE',kind:typeof err}},'current-position route unavailable');return {ok:false,reason:'PROVIDER_UNAVAILABLE'};}finally{if(timer)clearTimeout(timer);}
    };
    return await withLayoverRoutesBudget(loaded.session,async()=>{
      const b=read();if(!b)return {ok:false as const,reason:'position_check_expired'};
      const originPoint={lat:b.origin.lat,lng:b.origin.lng},currentReturn=await route(originPoint,destination,started);if(!currentReturn.ok)return currentReturn;
      const window=currentPositionFreedom(loaded.record,originPoint,destination,started,currentReturn.leg.conservativeMinutes,currentReturn.leg.confidence);if(!window)return {ok:false as const,reason:'return_deadline_exceeded'};
      const outbound=await route(originPoint,candidate.point!,started);if(!outbound.ok)return outbound;
      const back=await route(candidate.point!,destination,Date.parse(outbound.leg.arrivesAt)+candidate.activityTimeMin*60000);if(!back.ok)return back;
      const total=outbound.leg.conservativeMinutes+candidate.activityTimeMin+back.leg.conservativeMinutes,additionalTravel=Math.max(0,outbound.leg.conservativeMinutes+back.leg.conservativeMinutes-currentReturn.leg.conservativeMinutes);
      if(Date.parse(back.leg.arrivesAt)>loaded.record.deadline.hardReturnTime.getTime()||total>Math.min(loaded.record.envelope.usableMinutes,Math.floor((loaded.record.deadline.hardReturnTime.getTime()-started)/60000))||additionalTravel+candidate.activityTimeMin>(window.usableMinutes??0))return {ok:false as const,reason:'return_deadline_exceeded'};
      const final=await loadCompilationCandidates(db,actor,sessionId,[input.candidateId],clock());if(!final.ok)return final;
      if(final.snapshotId!==loaded.snapshotId||JSON.stringify(final.candidates)!==JSON.stringify(loaded.candidates))return {ok:false as const,reason:'snapshot_changed'};
      const valid=read();if(!valid)return {ok:false as const,reason:'position_check_expired'};
      const expiry=Math.min(valid.expires,Date.parse(candidate.contract.expiresAt!),Date.parse(outbound.leg.expiresAt),Date.parse(back.leg.expiresAt),Date.parse(currentReturn.leg.expiresAt));if(expiry<=clock())return {ok:false as const,reason:'position_check_expired'};
      const previewConfidence=worstTravelConfidence(worstTravelConfidence(window.confidence,outbound.leg.confidence),worstTravelConfidence(back.leg.confidence,travelConfidenceOf(candidate.contract.confidence)));if(previewConfidence==='INSUFFICIENT')return {ok:false as const,reason:'confidence_insufficient'};
      const slack=(loaded.record.deadline.hardReturnTime.getTime()-Date.parse(back.leg.arrivesAt))/60000;
      const riskBand=previewConfidence==='LOW'||candidate.contract.riskBand==='HIGH'?'HIGH':slack<LAYOVER_ROUTED_POLICY.tightSlackMinutes||candidate.contract.riskBand==='MODERATE'?'MODERATE':candidate.contract.riskBand;
      return {ok:true as const,preview:{requestId:input.requestId,sessionId,snapshotId:loaded.snapshotId,candidateId:input.candidateId,previewOnly:true as const,expiresAt:new Date(expiry).toISOString(),hardReturnBy:loaded.record.deadline.hardReturnTime.toISOString(),riskBand,reasonCodes:[...candidate.contract.reasonCodes],activityCommitment:candidate.activityCommitment??null,window:{beginsAt:window.beginsAt,endsAt:window.endsAt,usableMinutes:window.usableMinutes??0,confidence:previewConfidence},outbound:outbound.leg,activityMinutes:candidate.activityTimeMin,returnRoute:back.leg,currentReturn:currentReturn.leg,disclosure:'This is a temporary check from your current location. Saved experiences still start at the airport; this preview does not start or update a plan.'}};
    });
  }catch(err){logger.warn({err:{code:'POSITION_CHECK_UNAVAILABLE',kind:typeof err}},'current-position preview unavailable');return {ok:false as const,reason:'position_check_unavailable'};}
}
