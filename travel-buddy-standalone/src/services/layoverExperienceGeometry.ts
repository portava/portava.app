import { freshToken } from './apiToken.ts';
import type { ExperiencePlan } from './layoverExperiencePlans.ts';
import { currentExperienceGeometry, experienceGeometrySchema, type ExperienceGeometry } from '../lib/layoverExperienceGeometryBinding.ts';
export { currentExperienceGeometry, experienceGeometrySchema, type ExperienceGeometry };
export async function getExperienceGeometry(sessionId:string,plan:ExperiencePlan,signal?:AbortSignal):Promise<{ok:true;map:ExperienceGeometry}|{ok:false;reason:string}>{
 try{
  const token=await freshToken();
  const url=`${process.env.EXPO_PUBLIC_API_BASE_URL??''}/api/airport/sessions/${encodeURIComponent(sessionId)}/experiences/plan/map?planId=${encodeURIComponent(plan.id)}&version=${plan.version}`;
  const res=await fetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{},cache:'no-store',signal}),body=await res.json();
  if(!res.ok||body?.ok!==true)return {ok:false,reason:body?.reason??'route_geometry_unavailable'};
  const parsed=experienceGeometrySchema.safeParse(body.map);
  if(!parsed.success||parsed.data.sessionId!==sessionId||!currentExperienceGeometry(parsed.data,plan,Date.now()))return {ok:false,reason:'route_geometry_stale'};
  return {ok:true,map:parsed.data};
 }catch{return {ok:false,reason:'route_geometry_unavailable'};}
}
