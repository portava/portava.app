/** Fresh Google geometry for one exact reviewed plan. Provider content never enters a stored contract. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { readExperiencePlan } from './LayoverExperiencePlans.js';
import { loadCompilationCandidates, routeInputHashOf } from './LayoverExperienceService.js';
import { airportPoint, layoverRoutesGuardedCorridor, withLayoverRoutesBudget } from './LayoverTravelTime.js';
import { LAYOVER_RETURN_CORRIDOR_PROVIDER, routedLegOf } from './LayoverReturnCorridor.js';
import { conservativeReturnMinutes, robustnessOf } from './LayoverRoutedFeasibility.js';
import type { RoutedLegs } from './LayoverReturnCorridor.js';
import { googleRouteGeometry, type ProviderRouteGeometry } from '../../lib/providers/providerMapGeometry.js';
import type { RouteCorridorProvider } from '../../lib/providers/routeCorridorProvider.js';
import type { GeoPoint } from '../../domain/trips/contracts/TravelTimeProvider.js';

export interface ExperienceGeometry {
 provider:'google_maps';displayPolicy:'google_map_only';cachePolicy:'no_store';sessionId:string;planId:string;planVersion:number;snapshotId:string;stopIds:string[];expiresAt:string;
 airport:{lat:number;lng:number;iataCode:string};
 hops:Array<{fromKey:string;toKey:string;direction:'outbound'|'between_stops'|'return';forecastAt:string;startsAt:string;endsAt:string;geometry:ProviderRouteGeometry}>;
}
type Refusal={ok:false;reason:string};
const refuse=(reason:string):Refusal=>({ok:false,reason});
const samePoint=(a:GeoPoint|null|undefined,b:GeoPoint|null|undefined)=>!!a&&!!b&&a.lat===b.lat&&a.lng===b.lng;
const savedStops=z.array(z.object({id:z.string(),inside_airport:z.boolean()}));

export async function readExperienceGeometry(db:SupabaseClient,userId:string,sessionId:string,expected:{planId:string;version:number},opts:{nowMs?:number;corridorProvider?:RouteCorridorProvider}={}):Promise<{ok:true;map:ExperienceGeometry}|Refusal>{
 const nowMs=opts.nowMs??Date.now();
 try{
  const read=await readExperiencePlan(db,userId,sessionId);if(!read.ok)return read;
  if(!read.plan||read.plan.id!==expected.planId||read.plan.version!==expected.version)return refuse('selected_plan_changed');
  if(!read.usable)return refuse(read.reason??'plan_unavailable');
  const plan=read.plan,contract=plan.contract;
  if(!contract.snapshotId||!contract.expiresAt||Date.parse(contract.expiresAt)<=nowMs)return refuse('plan_expired');
  if(contract.insideAirport)return refuse('indoor_geometry_unavailable');
  if(!contract.routeInputHash)return refuse('plan_review_required');
  const loaded=await loadCompilationCandidates(db,userId,sessionId,contract.candidateIds,nowMs);if(!loaded.ok)return loaded;
  if(loaded.snapshotId!==contract.snapshotId)return refuse('snapshot_changed');
  if(routeInputHashOf(loaded.candidates)!==contract.routeInputHash)return refuse('candidate_changed');
  const airport=airportPoint(loaded.airport);if(!airport)return refuse('airport_position_unavailable');
  const {data,error}=await db.from('layover_plan_stops').select('id,inside_airport').eq('session_id',sessionId).order('stop_order').order('id');
  if(error){logger.warn({err:error,sessionId},'Experience geometry stop positions unreadable');return refuse('plan_stops_unreadable');}
  const parsed=savedStops.safeParse(data);if(!parsed.success)return refuse('plan_stops_unreadable');
  if(parsed.data.length!==plan.stopIds.length||parsed.data.some((s,i)=>s.id!==plan.stopIds[i]||s.inside_airport!==loaded.candidates[i]?.insideAirport))return refuse('plan_stops_changed');
  const provider=layoverRoutesGuardedCorridor(opts.corridorProvider??LAYOVER_RETURN_CORRIDOR_PROVIDER);
  if(!provider.routed)return refuse('PROVIDER_UNBOUND');
  const points=new Map(loaded.candidates.map(c=>[c.key,c.point]));points.set('airport',airport);
  let fromKey='airport',origin=airport,expiresMs=Date.parse(contract.expiresAt);const hops:ExperienceGeometry['hops']=[];
  const routing=await withLayoverRoutesBudget(loaded.session,async():Promise<Refusal|null>=>{
   for(const step of contract.itinerary){
    if(step.kind==='experience')continue;
    const toKey=step.candidateId,destination=toKey?points.get(toKey):null;
    if(!toKey||!destination||!['walk','drive','transit'].includes(step.mode??''))return refuse('plan_route_unavailable');
    const started=Date.parse(step.startsAt),ends=Date.parse(step.endsAt),forecastMs=Math.max(started,nowMs+1000);
    if(!Number.isFinite(started)||!Number.isFinite(ends)||forecastMs>=ends)return refuse('plan_route_expired');
    const mode=step.mode as 'walk'|'drive'|'transit';
    const response=await provider.corridor({from:origin,to:destination,mode,departAt:new Date(forecastMs),wantAlternatives:true,cachePolicy:'no_store'});
    if(!response.ok)return refuse(response.reason);
    const c=response.value,expiry=Date.parse(c.expiresAt);
    if(!samePoint(c.from,origin)||!samePoint(c.to,destination)||Date.parse(c.departAt)!==forecastMs||!Number.isFinite(expiry)||expiry<=nowMs||!c.routes.length||c.routes.some(r=>!Number.isFinite(r.totalMinutes)||r.totalMinutes<0||!r.legs.length||r.legs.some(l=>!Number.isFinite(l.minutes)||l.minutes<0)))return refuse('PROVIDER_MALFORMED');
    const leg=routedLegOf({...c,routes:[...c.routes].sort((a,b)=>a.totalMinutes-b.totalMinutes)},mode);
    const conservative=conservativeReturnMinutes(leg.minutes,leg.confidence,robustnessOf({returnLeg:leg} as RoutedLegs));
    if(!leg.forecast||!conservative||forecastMs+conservative.minutes*60000>ends)return refuse('plan_route_terms_changed');
    const geometry=leg.geometry?.provider==='google_maps'&&leg.geometry.displayPolicy==='google_map_only'&&leg.geometry.cachePolicy==='no_store'?googleRouteGeometry(leg.geometry.geometry):null;
    if(!geometry)return refuse('route_geometry_unavailable');
    hops.push({fromKey,toKey,direction:step.kind==='return'?'return':fromKey==='airport'?'outbound':'between_stops',forecastAt:new Date(forecastMs).toISOString(),startsAt:step.startsAt,endsAt:step.endsAt,geometry});
    expiresMs=Math.min(expiresMs,expiry);fromKey=toKey;origin=destination;
   }
   return null;
  });
  if(routing)return routing;
  if(!hops.length||hops.at(-1)?.toKey!=='airport'||hops.at(-1)?.direction!=='return')return refuse('plan_return_geometry_unavailable');
  const finalNow=Math.max(nowMs,Date.now());if(expiresMs<=finalNow)return refuse('route_expired');
  // Recompute first: a canonical change is only recorded on the session by this evaluation, and its reason outranks the stale card it leaves.
  const final=await loadCompilationCandidates(db,userId,sessionId,contract.candidateIds,finalNow);
  const current=await readExperiencePlan(db,userId,sessionId);if(!current.ok)return current;
  if(current.reason==='snapshot_changed'||final.ok&&final.snapshotId!==loaded.snapshotId)return refuse('snapshot_changed');
  if(!current.usable||!current.plan||current.plan.id!==plan.id||current.plan.version!==plan.version||JSON.stringify(current.plan)!==JSON.stringify(plan))return refuse('selected_plan_changed');
  if(!final.ok)return final;
  if(routeInputHashOf(final.candidates)!==contract.routeInputHash)return refuse('candidate_changed');
  return {ok:true,map:{provider:'google_maps',displayPolicy:'google_map_only',cachePolicy:'no_store',sessionId,planId:plan.id,planVersion:plan.version,snapshotId:contract.snapshotId,stopIds:[...plan.stopIds],expiresAt:new Date(expiresMs).toISOString(),airport:{...airport,iataCode:loaded.airport.iataCode},hops}};
 }catch(err){logger.warn({err:{name:err instanceof Error?err.name:'UnknownError'},sessionId},'Experience geometry unavailable');return refuse('route_geometry_unavailable');}
}
