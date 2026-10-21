import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindCurrentPosition,currentPositionBinding,currentPositionFreedom,currentPositionCorridorMatches,travelConfidenceOf} from '../services/airport/LayoverCurrentPosition.js';
import {certifySessionFeasibility} from '../services/airport/LayoverFeasibility.js';
import {memoisedCorridor} from '../lib/providers/googleRoutesCorridorProvider.js';
import {unmeasured,type CorridorResult,type RouteCorridor} from '../lib/providers/routeCorridorProvider.js';
const now=Date.parse('2030-06-14T09:00:00Z'),iso=(ms:number)=>new Date(ms).toISOString();
const airport={id:'a',iataCode:'ZZZ',timezone:'UTC',verified:true,domesticBufferMin:60,internationalBufferMin:120,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20};
const record=()=>certifySessionFeasibility(airport,{id:'s',arrivalTime:iso(now-3600000),departureTime:iso(now+9*3600000),boardingTime:null,flightType:'domestic',immigrationRequired:false,checkedBags:false,wantsToLeave:true},{nowMs:now,entry:{state:'permitted',status:'visa_free',corridor:{passportCountry:'US',destinationCountry:'SG'}}});
const request=()=>({requestId:'11111111-1111-4111-8111-111111111111',snapshotId:'snapshot',candidateId:'candidate',origin:{lat:1.31987654,lng:103.89876543,accuracyMeters:20,observedAt:iso(now),mode:'drive' as const}});
test('transient authority binds exact actor/session/record/snapshot/request and refuses copies and stale origin',()=>{
 const r=record(),input=request(),p=bindCurrentPosition('actor','s','snapshot',r,input,now)!;assert.ok(p);assert.ok(currentPositionBinding(p,'actor','s','snapshot',r,now));assert.deepEqual(JSON.parse(JSON.stringify(p)),{requestId:input.requestId});
 for(const args of [[{...p},'actor','s','snapshot',r,now],[p,'foreign','s','snapshot',r,now],[p,'actor','other','snapshot',r,now],[p,'actor','s','other',r,now],[p,'actor','s','snapshot',structuredClone(r),now],[p,'actor','s','snapshot',r,now+120000]] as const)assert.equal(currentPositionBinding(args[0],args[1],args[2],args[3],args[4],args[5]),null);
 for(const origin of [{...input.origin,lat:91},{...input.origin,accuracyMeters:1001},{...input.origin,observedAt:iso(now-120000)},{...input.origin,observedAt:iso(now+1)}])assert.equal(bindCurrentPosition('actor','s','snapshot',r,{...input,origin},now),null);
});
test('real measured origin enters the Temporal Freedom Engine and actual return duration can only shrink its window',()=>{
 const r=record(),origin={lat:1.31,lng:103.8},airportPoint={lat:1.35,lng:103.98};const short=currentPositionFreedom(r,origin,airportPoint,now,15,'MEDIUM')!,long=currentPositionFreedom(r,origin,airportPoint,now,100,'MEDIUM')!;
 assert.deepEqual(short.origin?.point,origin);assert.deepEqual(short.requiredDestination?.point,airportPoint);assert.ok(!short.hardConstraints.some(c=>c.kind==='NO_ORIGIN'||c.kind==='TRAVEL_UNKNOWN'));assert.equal(Date.parse(short.endsAt),r.deadline.hardReturnTime.getTime()-15*60000);assert.ok(Date.parse(long.endsAt)<Date.parse(short.endsAt));assert.ok(long.usableMinutes!<=short.usableMinutes!);assert.ok(short.usableMinutes!<=r.envelope.freedomWindow!.usableMinutes!);assert.equal(currentPositionFreedom(r,origin,airportPoint,now,2000,'MEDIUM'),null);assert.equal(JSON.stringify(r).includes('103.8'),false);
});
test('no_store precise-origin requests bypass every shared and in-flight corridor memo',async()=>{
 let calls=0;const inner=async()=>{calls++;return {ok:true,value:{expiresAt:iso(now+300000)}} as CorridorResult;},memo=memoisedCorridor(inner,()=>new Date(now));const q={from:request().origin,to:{lat:1.35,lng:103.98},departAt:new Date(now),mode:'drive' as const};
 await memo(q);await memo(q);assert.equal(calls,1);await Promise.all([memo({...q,cachePolicy:'no_store'}),memo({...q,cachePolicy:'no_store'})]);assert.equal(calls,3);await memo({...q,cachePolicy:'no_store'});assert.equal(calls,4);await memo(q);assert.equal(calls,4,'normal public corridor caching remains intact');
});
test('mode, expiry, observation and leg-total contradictions are refused at the provider boundary',()=>{
 const from={lat:1.3,lng:103.8},to={lat:1.35,lng:103.98},c:RouteCorridor={from,to,departAt:iso(now),observedAt:iso(now),expiresAt:iso(now+120000),sourceClass:'LIVE',confidence:'MEDIUM',sourceRefs:['fixture'],independentRouteCount:1,reliability:unmeasured('fixture'),weather:unmeasured('fixture'),queueFriction:unmeasured('fixture'),airportReentryMinutes:unmeasured('fixture'),routes:[{totalMinutes:12,transferCount:0,legs:[{mode:'drive',minutes:12,distanceMeters:1000,interruptibility:'interruptible',transferPointId:null}]}]};assert.equal(currentPositionCorridorMatches(c,from,to,now,'drive',now),true);
 for(const bad of [{...c,observedAt:iso(now+1)},{...c,expiresAt:'NaN'},{...c,expiresAt:iso(now)},{...c,departAt:iso(now+1)},{...c,from:to},{...c,routes:[{...c.routes[0]!,totalMinutes:5}]},{...c,routes:[{...c.routes[0]!,legs:[{...c.routes[0]!.legs[0]!,mode:'walk' as const}]}]},{...c,routes:[{...c.routes[0]!,legs:[{...c.routes[0]!.legs[0]!,minutes:NaN}]}]}])assert.equal(currentPositionCorridorMatches(bad,from,to,now,'drive',now),false);
});
test('stored contract confidence is narrowed to a routed grade; anything else is the weakest grade, never a pass-through',()=>{
 for(const grade of ['HIGH','MEDIUM','LOW'] as const)assert.equal(travelConfidenceOf(grade),grade);
 for(const other of ['INSUFFICIENT','UNSAFE','high','',null,undefined])assert.equal(travelConfidenceOf(other),'INSUFFICIENT');
});
