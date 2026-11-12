import { getServiceClient } from './supabase.js';
let timer:ReturnType<typeof setTimeout>|null=null;
let generation=0;
let status={lastRunAt:null as string|null,lastSuccessAt:null as string|null,consecutiveFailures:0,purged:0};
export const getTripNearbyRetentionStatus=()=>({...status});
export async function runTripNearbyRetention(client:any=getServiceClient()):Promise<boolean>{
 status.lastRunAt=new Date().toISOString();
 try{
  if(!client)throw new Error('unavailable');
  let total=0;
  for(let batch=0;batch<20;batch++){
   const r=await client.rpc('purge_trip_nearby_expired',{p_limit:500}).abortSignal(AbortSignal.timeout(5000));
   // Migration not applied is inert; do not invent success for its purge.
   if(r.error||!Number.isInteger(r.data)||r.data<0||r.data>2000)throw new Error('unavailable');
   total+=r.data;if(r.data<500)break;
  }
  status={lastRunAt:status.lastRunAt,lastSuccessAt:new Date().toISOString(),consecutiveFailures:0,purged:total};return true;
 }catch{status.consecutiveFailures++;return false;}
}
export function startTripNearbyRetentionScheduler(){
 if(timer!==null)return;const own=++generation;
 const tick=()=>{void runTripNearbyRetention().finally(()=>{if(timer!==null&&own===generation){timer=setTimeout(tick,60000);timer.unref?.();}});};
 timer=setTimeout(tick,60000);timer.unref?.();
}
export function stopTripNearbyRetentionScheduler(){generation++;if(timer!==null)clearTimeout(timer);timer=null;}
