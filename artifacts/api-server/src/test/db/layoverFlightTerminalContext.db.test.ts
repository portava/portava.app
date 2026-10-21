import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPressedLayoverDb, PRESSED_SKIP_REASON, type PressedDb } from './pressedLayoverDb.js';
import { productionBaseFlags } from './pressedLayoverApp.js';
import { executeTripCommand, type TripCommandType } from '../../domain/trips/commands/tripKernel.js';
import { addFlightSegmentPayload } from '../../domain/trips/services/TripFlightSegments.js';
import { startConnectionSession } from '../../services/airport/LayoverConnectionDetection.js';
import { getSession, getActiveSession, listSessions, readSessionsByIds, updateSession } from '../../services/airport/LayoverSessionService.js';
import { applyFlightStatusUpdate } from '../../services/airport/LayoverFlightStatus.js';
import { certifySessionFeasibility } from '../../services/airport/LayoverFeasibility.js';
import { consumerLayoverRecord } from '../../services/airport/LayoverSnapshot.js';
import { airportRowToProfile } from '../../services/airport/AirportProfileService.js';
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from '../../services/airport/airportCuration.js';

async function fixture(db:PressedDb){
 await productionBaseFlags(db);await db.setFlags({trip_flight_segments_enabled:true,layover_flight_connections_enabled:true,layover_canonical_snapshot_enabled:true,layover_decision_persistence_enabled:true,layover_recommendation_snapshot_enabled:true,layover_recommendation_status_enabled:true});
 const owner=await db.seedUser('terminal_owner'),other=await db.seedUser('terminal_other'),tripId=randomUUID(),now=Math.floor(Date.now()/60000)*60000,iso=(ms:number)=>new Date(ms).toISOString();
 const command=async(type:TripCommandType,payload:Record<string,unknown>)=>{const r=await executeTripCommand(db.client,{tripId,actorUserId:owner.id,actorRole:'user',commandId:randomUUID(),idempotencyKey:randomUUID(),type,payload});assert.ok(r.ok,JSON.stringify(r));return r.ok?r.result:null;};
 await command('CREATE_TRIP',{title:'Terminal source fixture',destination_city:'Singapore',destination_country:'SG'});
 const inbound=await command('ADD_TRANSPORT_SEGMENT',addFlightSegmentPayload({carrierCode:'SQ',flightNumber:'31',departureAirport:'SFO',arrivalAirport:'SIN',scheduledDepartureAt:iso(now-12*3600000),scheduledArrivalAt:iso(now+3600000),arrivalTerminal:' t1 ',bookingRef:'TERM'}));
 const onward=await command('ADD_TRANSPORT_SEGMENT',addFlightSegmentPayload({carrierCode:'SQ',flightNumber:'322',departureAirport:'SIN',arrivalAirport:'LHR',scheduledDepartureAt:iso(now+10*3600000),scheduledArrivalAt:iso(now+20*3600000),departureTerminal:' t2 ',bookingRef:'TERM'}));
 assert.ok(inbound&&onward);const arrivalId=String(inbound.id),departureId=String(onward.id);
 const started=await startConnectionSession(db.client,{userId:owner.id,tripId,arrivalSegmentId:arrivalId,departureSegmentId:departureId,nowMs:now});assert.ok(started.ok,JSON.stringify(started));if(!started.ok)throw Error('fixture');
 return {owner,other,tripId,arrivalId,departureId,now,iso,session:started.session};
}
function flightReadClient(db:PressedDb,fail=false){
 let reads=0;
 const client=new Proxy(db.client,{get(target,key){if(key==='from')return (table:string)=>{const builder=target.from(table);if(table!=='trip_transport_segments')return builder;reads++;if(!fail)return builder;const wrap=(q:any):any=>new Proxy(q,{get(target,k){if(k==='then')return (resolve:(x:unknown)=>unknown)=>Promise.resolve(resolve({data:null,error:{code:'42501',message:'injected flight read denied'}}));const value=target[k];return typeof value==='function'?(...args:unknown[])=>wrap(value.apply(target,args)):value;}});return wrap(builder);};const v=target[key];return typeof v==='function'?v.bind(target):v;}});
 return {client,reads:()=>reads};
}
test('owned connection terminal projection reaches creation and all readers; missing, unowned and unreadable stay unknown; OFF makes no flight read',{skip:PRESSED_SKIP_REASON},async()=>{
 const db=await openPressedLayoverDb();try{
  const f=await fixture(db);assert.equal(f.session.arrivalTerminalId,'T1');assert.equal(f.session.departureTerminalId,'T2');
  const again=await startConnectionSession(db.client,{userId:f.owner.id,tripId:f.tripId,arrivalSegmentId:f.arrivalId,departureSegmentId:f.departureId,nowMs:f.now});assert.ok(again.ok);if(again.ok){assert.equal(again.existed,true);assert.equal(again.session.arrivalTerminalId,'T1');}
  const read=await getSession(db.client,f.session.id,f.owner.id),active=await getActiveSession(db.client,f.owner.id),list=await listSessions(db.client,f.owner.id),batch=await readSessionsByIds(db.client,[f.session.id]);
  for(const r of [read,active]){assert.ok(r.ok&&r.session);if(r.ok)assert.equal(r.session?.departureTerminalId,'T2');}for(const r of [list,batch]){assert.ok(r.ok);if(r.ok)assert.equal(r.sessions[0]?.arrivalTerminalId,'T1');}
  const forged=await updateSession(db.client,f.session.id,f.owner.id,{arrivalTerminalId:'FORGED',departureTerminalId:'FORGED'} as never);assert.ok(forged.ok);if(forged.ok)assert.equal(forged.session?.arrivalTerminalId,'T1');
  const spy=flightReadClient(db);const foreign=await getSession(spy.client,f.session.id,f.other.id);assert.deepEqual(foreign,{ok:true,session:null});assert.equal(spy.reads(),0);
  const denied=flightReadClient(db,true),unreadable=await getSession(denied.client,f.session.id,f.owner.id);assert.ok(unreadable.ok&&unreadable.session);if(unreadable.ok){assert.equal(unreadable.session?.arrivalTerminalId,null);assert.equal(unreadable.session?.departureTerminalId,null);}assert.equal(denied.reads(),1);
  await db.exec(`UPDATE public.trip_transport_segments SET created_by='${f.other.id}' WHERE id='${f.departureId}'`);const unowned=await getSession(db.client,f.session.id,f.owner.id);assert.ok(unowned.ok);if(unowned.ok){assert.equal(unowned.session?.arrivalTerminalId,'T1');assert.equal(unowned.session?.departureTerminalId,null);}
  for(const state of [false,'absent'] as const){await db.setFlag('layover_flight_connections_enabled',state);const off=flightReadClient(db),result=await getSession(off.client,f.session.id,f.owner.id);assert.ok(result.ok);if(result.ok){assert.equal(Object.hasOwn(result.session!,'arrivalTerminalId'),false);assert.equal(Object.hasOwn(result.session!,'departureTerminalId'),false);}assert.equal(off.reads(),0);}
 }finally{await db.close();}
});
test('terminal-only kernel observation changes immutable canonical identity and invalidates mismatched scoped timing; withdrawal is unknown',{skip:PRESSED_SKIP_REASON},async()=>{
 const db=await openPressedLayoverDb();try{
  const f=await fixture(db);const [airport]=await db.query<Record<string,unknown>>(`SELECT * FROM public.airport_profiles WHERE id='${f.session.airportId}'`);assert.ok(airport);
  const timing={domesticBufferMin:60,domesticBufferMax:90,internationalBufferMin:120,internationalBufferMax:180,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20,rationale:'Observed terminal-specific processing floor',timingEvidence:{context:{flightType:'international',immigrationRequired:true,checkedBags:true,arrivalTerminalId:'T1',departureTerminalId:'T2'},observedAt:f.iso(f.now-60000),expiresAt:f.iso(f.now+3600000),confidence:'MEDIUM',sourceRefs:['https://example.test/terminal-timing'],stages:[{stage:'deplane',samplesMinutes:Array(20).fill(35)},{stage:'security_reentry',samplesMinutes:Array(20).fill(190)}],journeys:[]}};
  const p=await proposeCuratedFact(db.client,{airportId:String(airport.id),kind:'timing_assumptions',value:timing,source:{kind:'official_airport',url:'https://example.test/terminal-timing',title:'Observed terminal timing',note:'Anonymous processing observations for the named terminals',retrievedAt:f.iso(f.now)},proposedVia:'admin',proposedBy:f.owner.id},f.now);assert.ok(p.ok,JSON.stringify(p));if(!p.ok)return;
  assert.ok((await validateProposedFact(db.client,p.fact.id,f.owner.id,f.now)).ok);assert.ok((await publishValidatedFact(db.client,p.fact.id,f.owner.id)).ok);
  const [published]=await db.query<Record<string,unknown>>(`SELECT * FROM public.airport_profiles WHERE id='${f.session.airportId}'`);assert.ok(published);const profile=airportRowToProfile(published);
  const initial=await getSession(db.client,f.session.id,f.owner.id);assert.ok(initial.ok&&initial.session);if(!initial.ok||!initial.session)return;
  const before=await consumerLayoverRecord(db.client,profile,initial.session,f.now);assert.ok(before);assert.ok(!before.landsideGate.closedBy.includes('timing_evidence_unavailable'));
  const failedRead=await getSession(flightReadClient(db,true).client,f.session.id,f.owner.id);assert.ok(failedRead.ok&&failedRead.session);if(failedRead.ok&&failedRead.session)assert.ok(certifySessionFeasibility(profile,failedRead.session,{nowMs:f.now}).landsideGate.closedBy.includes('timing_evidence_unavailable'),'unreadable linked source cannot retain matching scoped timing');
  const [{id:oldId}]=await db.query<{id:string}>(`SELECT active_snapshot_id AS id FROM public.layover_sessions WHERE id='${f.session.id}'`);assert.ok(oldId);
  const moved=await applyFlightStatusUpdate(db.client,{source:'traveller',actorUserId:f.owner.id,segmentId:f.departureId,observedAt:f.iso(f.now+1000),observation:{departureTerminal:'T3'}},{nowMs:f.now+1000});assert.ok(moved.ok,JSON.stringify(moved));if(moved.ok){assert.equal(moved.segments[0]?.recorded,true);assert.equal(moved.segments[0]?.sessions[0]?.terminalChange?.to,'T3');}
  const [{id:newId}]=await db.query<{id:string}>(`SELECT active_snapshot_id AS id FROM public.layover_sessions WHERE id='${f.session.id}'`);assert.notEqual(newId,oldId,'terminal-only adapter refresh publishes a new canonical identity');
  const current=await getSession(db.client,f.session.id,f.owner.id);assert.ok(current.ok&&current.session);if(!current.ok||!current.session)return;assert.equal(current.session.departureTerminalId,'T3');
  const after=await consumerLayoverRecord(db.client,profile,current.session,f.now+1000);assert.ok(after);assert.notEqual(after.inputHash,before.inputHash);assert.ok(after.landsideGate.closedBy.includes('timing_evidence_unavailable'));
  const [{count}]=await db.query<{count:string}>(`SELECT count(*)::text AS count FROM public.layover_certified_computations WHERE snapshot_id='${oldId}'`);assert.equal(count,'1','old certificate remains immutable history');
  await applyFlightStatusUpdate(db.client,{source:'traveller',actorUserId:f.owner.id,segmentId:f.departureId,observedAt:f.iso(f.now+2000),observation:{departureTerminal:null}},{nowMs:f.now+2000});
  const withdrawn=await getSession(db.client,f.session.id,f.owner.id);assert.ok(withdrawn.ok&&withdrawn.session);if(withdrawn.ok&&withdrawn.session){assert.equal(withdrawn.session.departureTerminalId,null);const record=await consumerLayoverRecord(db.client,profile,withdrawn.session,f.now+2000);assert.ok(record?.landsideGate.closedBy.includes('timing_evidence_unavailable'));}
 }finally{await db.close();}
});
