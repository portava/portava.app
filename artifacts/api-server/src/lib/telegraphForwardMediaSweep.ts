import { boundedServiceFetch } from './boundedServiceFetch.js';
import { sweepForwardMedia } from '../services/telegraph/forwardAttachments.js';
import { getServiceClient } from './supabase.js';
import { logger } from './logger.js';
const state={lastAttemptAt:null as string|null,lastSuccessAt:null as string|null,consecutiveFailures:0,removed:0};
export function getForwardMediaSweepStatus(){return {...state};}
let timer:ReturnType<typeof setTimeout>|null=null;
let generation=0;
export async function runForwardMediaSweepTick(sc=getServiceClient(boundedServiceFetch())){
 state.lastAttemptAt=new Date().toISOString();
 try{if(!sc)throw new Error('Service unavailable');state.removed=await sweepForwardMedia(sc);state.lastSuccessAt=new Date().toISOString();state.consecutiveFailures=0;}
 catch(err){state.consecutiveFailures++;logger.warn({err},'Telegraph forwarded-media cleanup failed');}
 return {...state};
}
export function startForwardMediaSweep(){
 if(timer)return;
 const gen=++generation;
 const tick=()=>{void runForwardMediaSweepTick().finally(()=>{if(gen===generation){timer=setTimeout(tick,60*60_000);timer.unref?.();}});};
 timer=setTimeout(tick,120_000);timer.unref?.();
}
export function stopForwardMediaSweep(){generation++;if(timer)clearTimeout(timer);timer=null;}
