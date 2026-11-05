import { fetchOwnedApi, type OwnedApiContext } from './ownedApiRequest.ts';
export const NEARBY_CONSENT_VERSION='trip-nearby-v1';
export const NEARBY_CHARACTERISTIC='8c541bd6-c12b-4f73-8f4f-568b374daf25';
export type NearbyProximity='very_close'|'nearby'|'within_area'|'weak';
export interface NearbyPeer {userId:string;handle:string|null;proximity:NearbyProximity;observedAt:string;expiresAt:string}
export interface NearbyActive {state:'active';sessionId:string;expiresAt:string;serverNow:string;peers:NearbyPeer[];lease?:{serviceUuid:string;characteristicUuid:string;token:string;expiresAt:string}}
export type NearbyResult=NearbyActive|{state:'disabled'|'unavailable'|'stopped'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validTime=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function parseNearbyResult(value:unknown):NearbyResult{
 if(!value||typeof value!=='object'||!('state'in value))throw new Error('Nearby checkpoints are unavailable.');
 const v=value as Record<string,any>;
 if(['disabled','unavailable','stopped'].includes(v.state))return{state:v.state};
 if(v.state!=='active'||!uuid.test(v.sessionId)||!validTime(v.expiresAt)||!validTime(v.serverNow)||!Array.isArray(v.peers)||v.peers.length>64)throw new Error('Invalid nearby checkpoint response.');
 const peers=v.peers.map((p:any)=>{
  if(!p||!uuid.test(p.userId)||!(p.handle===null||typeof p.handle==='string')||!['very_close','nearby','within_area','weak'].includes(p.proximity)||!validTime(p.observedAt)||!validTime(p.expiresAt))throw new Error('Invalid nearby peer.');
  return{userId:p.userId,handle:p.handle,proximity:p.proximity,observedAt:p.observedAt,expiresAt:p.expiresAt};
 });
 let lease:NearbyActive['lease'];
 if(v.lease){
  const l=v.lease;
  if(!uuid.test(l.serviceUuid)||l.characteristicUuid!==NEARBY_CHARACTERISTIC||!/^[a-f0-9]{64}$/.test(l.token)||!validTime(l.expiresAt)||Date.parse(l.expiresAt)>Date.parse(v.serverNow)+60000||Date.parse(l.expiresAt)>Date.parse(v.expiresAt))throw new Error('Invalid nearby radio lease.');
  lease={serviceUuid:l.serviceUuid,characteristicUuid:l.characteristicUuid,token:l.token,expiresAt:l.expiresAt};
 }
 return{state:'active',sessionId:v.sessionId,expiresAt:v.expiresAt,serverNow:v.serverNow,peers,...(lease?{lease}:{})};
}
export async function nearbyAvailable(tripId:string,context:OwnedApiContext={}){
 if(!uuid.test(tripId))throw new Error('Invalid trip.');
 const r=await fetchOwnedApi(`/api/trips/${tripId}/nearby`,context);
 if(!r.ok)throw new Error('Nearby checkpoints could not be checked.');
 const v=await r.json() as any;
 if(typeof v?.available!=='boolean'||v.consentVersion!==NEARBY_CONSENT_VERSION)throw new Error('Nearby checkpoints are unavailable.');
 return v.available as boolean;
}
export async function nearbyCommand(tripId:string,action:'start'|'renew'|'read'|'observe'|'stop',body:object,context:OwnedApiContext={}){
 if(!uuid.test(tripId))throw new Error('Invalid trip.');
 const r=await fetchOwnedApi(`/api/trips/${tripId}/nearby/${action}`,{...context,method:'POST',body});
 if(!r.ok)throw new Error('Nearby checkpoints could not be confirmed.');
 const value=await r.json();
 if(action==='observe'){
  if((value as any)?.state!=='active'||typeof(value as any).accepted!=='boolean')throw new Error('Nearby checkpoint was refused.');
  return value as{state:'active';accepted:boolean};
 }
 return parseNearbyResult(value);
}
/** RSSI is noisy; labels are buckets, never an asserted distance or position. */
export function nearbyRssiBucket(rssi:number):NearbyProximity|null{
 if(!Number.isFinite(rssi)||rssi>=0||rssi< -127)return null;
 return rssi>=-55?'very_close':rssi>=-70?'nearby':rssi>=-85?'within_area':'weak';
}
