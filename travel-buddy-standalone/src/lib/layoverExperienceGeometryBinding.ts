/** Pure binding of fresh provider geometry to one exact reviewed plan. No transport, so the map module stays loadable outside the app. */
import { z } from 'zod';
import type { ExperiencePlan } from '../services/layoverExperiencePlans.ts';
const instant=z.string().refine(v=>Number.isFinite(Date.parse(v)));
const point=z.tuple([z.number().finite().min(-180).max(180),z.number().finite().min(-90).max(90)]);
const geometry=z.object({provider:z.literal('google_maps'),displayPolicy:z.literal('google_map_only'),cachePolicy:z.literal('no_store'),geometry:z.object({type:z.literal('LineString'),coordinates:z.array(point).min(2).max(20000)})});
export const experienceGeometrySchema=z.object({provider:z.literal('google_maps'),displayPolicy:z.literal('google_map_only'),cachePolicy:z.literal('no_store'),sessionId:z.string().uuid(),planId:z.string().uuid(),planVersion:z.number().int().positive(),snapshotId:z.string().min(1),stopIds:z.array(z.string().uuid()).min(1).max(6),expiresAt:instant,airport:z.object({lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),iataCode:z.string()}),hops:z.array(z.object({fromKey:z.string(),toKey:z.string(),direction:z.enum(['outbound','between_stops','return']),forecastAt:instant,startsAt:instant,endsAt:instant,geometry})).min(1).max(7)});
export type ExperienceGeometry=z.infer<typeof experienceGeometrySchema>;
export function currentExperienceGeometry(map:ExperienceGeometry|null|undefined,plan:ExperiencePlan,nowMs:number):map is ExperienceGeometry {
 if(!map||map.planId!==plan.id||map.planVersion!==plan.version||map.snapshotId!==plan.contract.snapshotId||JSON.stringify(map.stopIds)!==JSON.stringify(plan.stopIds)||Date.parse(map.expiresAt)<=nowMs||Date.parse(plan.contract.expiresAt)<=nowMs)return false;
 const steps=plan.contract.itinerary.filter(s=>s.kind!=='experience');
 return steps.length===map.hops.length&&map.hops.every((h,i)=>h.startsAt===steps[i]?.startsAt&&h.endsAt===steps[i]?.endsAt&&h.toKey===steps[i]?.candidateId&&h.fromKey===(i===0?'airport':map.hops[i-1]?.toKey)&&Date.parse(h.forecastAt)>=Date.parse(h.startsAt)&&Date.parse(h.forecastAt)<Date.parse(h.endsAt))&&map.hops.at(-1)?.direction==='return'&&map.hops.at(-1)?.toKey==='airport';
}
