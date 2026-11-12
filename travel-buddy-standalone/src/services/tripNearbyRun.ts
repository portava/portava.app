import type { MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { nearbyCommand, nearbyRssiBucket, parseNearbyResult, NEARBY_CONSENT_VERSION, type NearbyPeer } from './tripNearby.ts';
import { tripNearbyNative, type NearbyNative } from './tripNearbyNative.ts';
export type NearbyRunState='starting'|'active'|'stopped'|'unavailable';
let currentRun:{stop():Promise<void>}|null=null;
let acquisitionGeneration=0;
let radioRelease:Promise<void>=Promise.resolve();
/** Foreground owner/session-bounded controller. Native code independently bounds every radio lease. */
export function createTripNearbyRun(options:{tripId:string;sessionId:string;owner:MessagingOwnerRequest;durationMinutes:5|15;onState:(state:NearbyRunState,message?:string)=>void;onPeers:(peers:NearbyPeer[])=>void},native:NearbyNative|null=tripNearbyNative,command=nearbyCommand){
 let active=false;let startedOnce=false;let generation=0;let poll:ReturnType<typeof setInterval>|undefined;let rotate:ReturnType<typeof setTimeout>|undefined;
 let deadline=0;let offset=0;let reading=false;let observing=false;let lastRead=0;
 let displayed:Array<{peer:NearbyPeer;expires:number}>=[];
 const abort=new AbortController();const subscriptions:Array<{remove():void}>=[];const seen=new Map<string,number>();
 const context=()=>({owner:options.owner,signal:abort.signal,isCurrent:()=>active&&options.owner.isCurrent()});
 const valid=()=>active&&options.owner.isCurrent()&&Date.now()<deadline;
 function updatePeers(peers:NearbyPeer[],serverNow:number,requestedAt:number){
  displayed=peers.map(peer=>({peer,expires:requestedAt+Date.parse(peer.expiresAt)-serverNow})).filter(p=>p.expires>Date.now());
  options.onPeers(displayed.map(p=>p.peer));
 }
 async function stop(message?:string){
  const ownsRadio=currentRun===run;
  active=false;generation++;abort.abort();if(poll)clearInterval(poll);if(rotate)clearTimeout(rotate);
  subscriptions.splice(0).forEach(s=>s.remove());seen.clear();displayed=[];options.onPeers([]);
  options.onState(message?'unavailable':'stopped',message);
  if(ownsRadio)currentRun=null;
  // Start/permission callbacks are fenced by the native stop even when a
  // network response is still in flight. Revocation cannot wait for the API.
  const release=ownsRadio?Promise.resolve().then(()=>native?.stop()).then(()=>undefined,()=>undefined):Promise.resolve();
  if(ownsRadio)radioRelease=release;
  await Promise.allSettled([release,options.owner.isCurrent()?command(options.tripId,'stop',{sessionId:options.sessionId},{owner:options.owner}):Promise.resolve()]);
 }
 async function refreshLease(action:'start'|'renew'){
  const own=++generation;const requestedAt=Date.now();
  const result=parseNearbyResult(await command(options.tripId,action,{sessionId:options.sessionId,...(action==='start'?{consentVersion:NEARBY_CONSENT_VERSION,durationMinutes:options.durationMinutes}:{})},context()));
  if(!active||own!==generation||!options.owner.isCurrent())return;
  if(result.state!=='active'||result.sessionId!==options.sessionId||!result.lease)throw new Error('Nearby sharing is no longer available.');
  const serverNow=Date.parse(result.serverNow);offset=serverNow-requestedAt;
  deadline=Math.min(deadline,requestedAt+Date.parse(result.expiresAt)-serverNow);
  if(!valid())return stop();
  const end=requestedAt+Date.parse(result.lease.expiresAt)-serverNow-500;
  updatePeers(result.peers,serverNow,requestedAt);
  const renew=()=>{if(!valid()){void stop();return;}void native!.stop().then(()=>refreshLease('renew')).catch(()=>stop('Nearby checkpoints stopped. Try again.'));};
  // Starting a permission prompt in the last seconds of an epoch would hand
  // the module an already expired lease. Wait for the next rotating epoch.
  if(end-Date.now()<9000){rotate=setTimeout(renew,Math.max(100,end-Date.now()+600));return;}
  await native!.start({...result.lease,expiresAtMs:end});
  if(!valid()||own!==generation){if(currentRun===run)await native!.stop();return;}
  options.onState('active');
  rotate=setTimeout(renew,Math.max(100,end-Date.now()+600));
 }
 async function read(){
  if(!valid()){void stop();return;}if(reading)return;reading=true;
  const requestedAt=Date.now();lastRead=requestedAt;
  try{
   const result=parseNearbyResult(await command(options.tripId,'read',{sessionId:options.sessionId},context()));
   if(!valid())return;
   if(result.state!=='active'||result.sessionId!==options.sessionId)throw new Error('Nearby sharing ended.');
   updatePeers(result.peers,Date.parse(result.serverNow),requestedAt);
  }catch{if(active)void stop('Nearby checkpoints stopped because the connection could not be checked.');}
  finally{reading=false;}
 }
 const run={stop:()=>stop(),async start(){
  if(startedOnce||abort.signal.aborted)return;startedOnce=true;
  const acquisition=++acquisitionGeneration;
  if(currentRun&&currentRun!==run)await currentRun.stop();
  await radioRelease;
  if(acquisition!==acquisitionGeneration||abort.signal.aborted)return;
  if(!native||!options.owner.isCurrent())throw new Error('Nearby Bluetooth is unavailable on this device.');
  currentRun=run;active=true;deadline=Date.now()+options.durationMinutes*60000;options.onState('starting');
  subscriptions.push(native.addListener('onState',value=>{if(active&&value?.state==='unavailable')void stop('Bluetooth is unavailable. Check permission and try again.');}));
  subscriptions.push(native.addListener('onCheckpoint',value=>{
   if(!valid()||observing||!/^[a-f0-9]{64}$/.test(value?.token)||!Number.isFinite(value.observedAtMs)||Math.abs(Date.now()-value.observedAtMs)>10000)return;
   const proximity=nearbyRssiBucket(value.rssi);if(!proximity)return;
   if(Date.now()-(seen.get(value.token)??0)<5000)return;
   if(seen.size>=64)seen.delete(seen.keys().next().value!);seen.set(value.token,Date.now());observing=true;
   void command(options.tripId,'observe',{sessionId:options.sessionId,token:value.token,proximity,observedAt:new Date(value.observedAtMs+offset).toISOString()},context())
    .catch(()=>{if(active)void stop('Nearby checkpoint delivery failed. Try again.');}).finally(()=>{observing=false;});
  }));
  try{await refreshLease('start');lastRead=Date.now();if(active)poll=setInterval(()=>{
   if(!valid()){void stop();return;}
   const fresh=displayed.filter(p=>p.expires>Date.now());if(fresh.length!==displayed.length){displayed=fresh;options.onPeers(fresh.map(p=>p.peer));}
   if(Date.now()-lastRead>=5000)void read();
  },1000);}
  catch{await stop('Nearby checkpoints could not start. Check Bluetooth permission and try again.');}
 }};
 return run;
}
