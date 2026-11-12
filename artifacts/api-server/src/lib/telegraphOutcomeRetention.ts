import { boundedServiceFetch } from './boundedServiceFetch.js';
import {getServiceClient} from './supabase.js';
import {logger} from './logger.js';
const state={lastAttemptAt:null as string|null,lastSuccessAt:null as string|null,consecutiveFailures:0,deleted:0,backlog:false};
export function getOutcomeRetentionStatus(){return {...state};}
let timer:ReturnType<typeof setTimeout>|null=null,generation=0;
export async function runOutcomeRetentionTick(sc=getServiceClient(boundedServiceFetch())){
 state.lastAttemptAt=new Date().toISOString();state.deleted=0;
 try{
  if(!sc)throw new Error('Service unavailable');
  for(let i=0;i<20;i++){
   const result=await sc.rpc('telegraph_purge_outcome_feedback');
   if(result.error||!Number.isInteger(result.data)||result.data<0||result.data>1000)throw new Error('Outcome purge unavailable');
   state.deleted+=result.data;state.backlog=result.data===1000;if(!state.backlog)break;
  }
  state.lastSuccessAt=new Date().toISOString();state.consecutiveFailures=0;
 }catch(err){state.consecutiveFailures++;logger.warn({err},'Telegraph outcome feedback retention failed');}
 return {...state};
}
export function startOutcomeRetention(){
 if(timer)return;const gen=++generation;
 const tick=()=>{void runOutcomeRetentionTick().finally(()=>{if(gen===generation){timer=setTimeout(tick,60*60_000);timer.unref?.();}});};
 timer=setTimeout(tick,120_000);timer.unref?.();
}
export function stopOutcomeRetention(){generation++;if(timer)clearTimeout(timer);timer=null;}
