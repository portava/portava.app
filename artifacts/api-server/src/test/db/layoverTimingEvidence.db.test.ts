import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from '../../services/airport/airportCuration.js';
import { airportRowToProfile } from '../../services/airport/AirportProfileService.js';
import { certifySessionFeasibility } from '../../services/airport/LayoverFeasibility.js';
import { publishObjectiveFact } from '../../services/airport/LayoverObjectiveEvidenceStore.js';
import { readActivityCommitments } from '../../services/airport/layoverActivityCommitment.js';
import { getCandidates, compile } from '../../services/airport/LayoverExperienceService.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor } from './pressedLayoverApp.js';
import { bothDirections, measured, unmeasured, type RouteCorridorProvider } from '../../lib/providers/routeCorridorProvider.js';
describe('sourced timing and activity schemas apply in the full migrated database', {skip:PRESSED_SKIP_REASON}, ()=>{it('sourced timing and activity schemas apply in the full migrated database', async()=>{
  const db=await openPressedLayoverDb();
  try {
    const [r]=await db.query<{ready:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.airport_profiles'::regclass AND attname='curated_timing_evidence' AND NOT attisdropped) AS ready");
    assert.equal(r?.ready,true);
    const [f]=await db.query<{enabled:boolean}>("SELECT enabled FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled'");assert.equal(f?.enabled,false);
  }finally{await db.close();}
});});
describe('published observed timing reaches every row mapper and actual certification; direct projection forgery is refused',{skip:PRESSED_SKIP_REASON},()=>{it('published observed timing reaches every row mapper and actual certification; direct projection forgery is refused',async()=>{
 const db=await openPressedLayoverDb();try{
  const curator=await db.seedUser('timing_curator'),now=Date.now(),iso=(n:number)=>new Date(n).toISOString(); await db.exec("INSERT INTO public.airport_profiles(iata_code,name,city,country,country_code,timezone,lat,lng) VALUES('SIN','Timing fixture','Singapore','Singapore','SG','UTC',1.3,103.9)");
  const [row]=await db.query<Record<string,unknown>>("SELECT * FROM public.airport_profiles WHERE iata_code='SIN'");assert.ok(row);
  const timing={domesticBufferMin:60,domesticBufferMax:90,internationalBufferMin:120,internationalBufferMax:180,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20,rationale:'Fixture observed timing and conservative airport policy',timingEvidence:{context:{flightType:'international',immigrationRequired:true,checkedBags:false},observedAt:iso(now-60000),expiresAt:iso(now+3600000),confidence:'MEDIUM',sourceRefs:['https://example.test/observed-anonymous-stage-data'],stages:[{stage:'deplane',samplesMinutes:Array(20).fill(35)},{stage:'security_reentry',samplesMinutes:Array(20).fill(190)}],journeys:[]}};
  for(const kind of ['curator_judgment','official_airport'] as const){
   const p=await proposeCuratedFact(db.client,{airportId:String(row.id),kind:'timing_assumptions',value:timing,source:{kind,url:'https://example.test/timing',title:'Fixture airport timing evidence',note:'Source-backed anonymous observations',retrievedAt:iso(now)},proposedVia:'admin',proposedBy:curator.id},now);assert.ok(p.ok,JSON.stringify(p));if(!p.ok)continue;
   const v=await validateProposedFact(db.client,p.fact.id,curator.id,now);if(kind==='curator_judgment'){assert.equal(v.ok,false);continue;}
   assert.ok(v.ok,JSON.stringify(v));assert.ok((await publishValidatedFact(db.client,p.fact.id,curator.id)).ok);
  }
  const [published]=await db.query<Record<string,unknown>>("SELECT * FROM public.airport_profiles WHERE iata_code='SIN'");assert.ok(published);const profile=airportRowToProfile(published);assert.ok(profile.timingEvidence);assert.equal(profile.timingEvidenceUnavailable,false);
  const session={id:'fixture',arrivalTime:iso(now-60000),departureTime:iso(now+10*3600000),boardingTime:null,flightType:'international' as const,immigrationRequired:true,checkedBags:false,wantsToLeave:true};
  const current=certifySessionFeasibility(profile,session,{nowMs:now}),base=certifySessionFeasibility({...profile,timingEvidence:null},session,{nowMs:now});
  assert.equal(current.estimates.deplane.p90Minutes,35);assert.ok(current.envelope.exitDelayMin>base.envelope.exitDelayMin);assert.ok(current.deadline.hardReturnTime<base.deadline.hardReturnTime);
  await assert.rejects(db.exec("UPDATE public.airport_profiles SET curated_timing_evidence='{}' WHERE iata_code='SIN'"),/not directly writable/);
  const expired=airportRowToProfile({...published,curated_timing_evidence:{...(published.curated_timing_evidence as object),evidence:{...timing.timingEvidence,expiresAt:iso(now-1)}}});assert.equal(expired.timingEvidenceUnavailable,true);assert.ok(certifySessionFeasibility(expired,session,{nowMs:now}).landsideGate.closedBy.includes('timing_evidence_unavailable'));
 }finally{await db.close();}
});});
const provider:RouteCorridorProvider={id:'fixture-sourced-activity',routed:true,async corridor(q){return {ok:true,value:{from:q.from!,to:q.to!,departAt:q.departAt.toISOString(),routes:[0,1].map(()=>({legs:[{mode:q.mode??'drive',minutes:12,distanceMeters:1000,interruptibility:'interruptible' as const,transferPointId:null}],totalMinutes:12,transferCount:0})),independentRouteCount:2,reliability:measured({spreadMinutes:0,optionCount:2},'LIVE','MEDIUM',['fixture']),queueFriction:unmeasured('no feed'),weather:unmeasured('no feed'),airportReentryMinutes:unmeasured('no feed'),observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),sourceClass:'LIVE',confidence:'MEDIUM',sourceRefs:['fixture']}};},bidirectional(q){return bothDirections(provider,q);}};
describe('actual generation and compilation require sourced activity commitment and include its minimum plus exit delay',{skip:PRESSED_SKIP_REASON},()=>{it('actual generation and compilation require sourced activity commitment and include its minimum plus exit delay',async()=>{
 const db=await openPressedLayoverDb();let app:Awaited<ReturnType<typeof startPressedLayoverApp>>|undefined;try{
  await productionBaseFlags(db);await db.setFlags({layover_stable_recommendation_ids_enabled:true,layover_objective_evidence_enabled:true,layover_activity_commitment_enabled:true,layover_place_dwell_enabled:true,layover_decision_persistence_enabled:true,layover_canonical_snapshot_enabled:true,layover_recommendation_snapshot_enabled:true,layover_recommendation_status_enabled:true});
  const owner=await db.seedUser('activity_owner'),curator=await db.seedUser('activity_curator');await seedConfirmedCorridor(db,owner.id);app=await startPressedLayoverApp(db);const sid=(await startSession(app,owner,{wantsToLeave:true})).id;
  const [airport]=await db.query<{id:string;city:string;lat:string;lng:string}>("SELECT id,city,lat,lng FROM public.airport_profiles WHERE iata_code='SIN'");assert.ok(airport);
  for(const [kind,value] of [
   ['terminal_topology',{terminals:[{id:'T1',name:'Terminal1'},{id:'T2',name:'Terminal2'}],gates:[{terminalId:'T1',label:'A1'}],checkpoints:[{id:'sec',terminalId:'T1',kind:'security'}],walkingLinks:[{fromTerminalId:'T1',toTerminalId:'T2',minutes:12,mode:'train'}]}],
   ['ground_transport',{modes:[{mode:'rail',name:'Fixture rail',toCity:'City centre',journeyMinutes:{min:25,max:35},terminalIds:['T1']}]}],
   ['timing_assumptions',{domesticBufferMin:60,domesticBufferMax:90,internationalBufferMin:120,internationalBufferMax:180,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20,rationale:'Fixture timing policy'}],
  ] as const){const p=await proposeCuratedFact(db.client,{airportId:airport.id,kind,value,source:{kind:kind==='timing_assumptions'?'curator_judgment':'official_airport',note:'Fixture source evidence only',url:'https://example.test/airport',title:'Fixture',retrievedAt:new Date().toISOString()},proposedVia:'admin',proposedBy:curator.id},Date.now());assert.ok(p.ok,JSON.stringify(p));if(!p.ok)continue;assert.ok((await validateProposedFact(db.client,p.fact.id,curator.id,Date.now())).ok);assert.ok((await publishValidatedFact(db.client,p.fact.id,curator.id)).ok);}
  const [place]=await db.query<{id:string}>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'","''")}','Commitment fixture venue','cafe','active',${Number(airport.lat)+.02},${Number(airport.lng)+.02},true) RETURNING id`);assert.ok(place);
  await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${place.id}',30,'venue_stated','HIGH','stated visit duration')`);
  const missing=await getCandidates(db.client,owner.id,sid,Date.now(),{corridorProvider:provider});assert.ok(missing.ok,JSON.stringify(missing));if(!missing.ok)return;assert.notEqual(missing.recommendations.find(c=>c.placeId===place.id)?.available,true);
  const value={fact:{kind:'activity_commitment',value:{interruptibility:'committed',minimumCommitmentMinutes:60,exitDelayMinutes:12}},source:{sourceClass:'venue_operator',sourceUrl:'https://example.test/venue-commitment',sourceNote:'The programme requires an hour and a twelve minute exit',observedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),confirmedSource:true}};
  const p=await publishObjectiveFact(db.client,curator.id,airport.id,place.id,value);assert.ok(p.ok,JSON.stringify(p));
  const facts=await readActivityCommitments(db.client,airport.id,[place.id],Date.now());assert.equal(facts.state,'read');if(facts.state==='read')assert.ok(facts.byPlace.get(place.id),'published source is read as a current commitment');
  const generated=await getCandidates(db.client,owner.id,sid,Date.now(),{corridorProvider:provider});assert.ok(generated.ok,JSON.stringify(generated));if(!generated.ok)return;
  const card=generated.recommendations.find(c=>c.placeId===place.id);assert.ok(card);assert.ok(card.id);assert.equal(card.available,true,JSON.stringify(card));assert.equal(card.routing?.minExperienceMin,72);assert.equal(card.routing?.activityCommitment?.interruptibility,'committed');assert.equal(card.routing?.band,'TIGHT');
  const compiled=await compile(db.client,owner.id,sid,[card.id],{corridorProvider:provider});assert.ok(compiled.ok,JSON.stringify(compiled));if(compiled.ok){assert.equal(compiled.contract.minExperienceMinutes,72);assert.notEqual(compiled.contract.riskBand,'LOW');}
  assert.ok(p.ok);assert.ok(card.contract?.snapshotId);if(p.ok)await assertTransientCurrentPosition(db,app,owner,sid,card.id,card.contract.snapshotId,p.fact.id);
  const gone=await compile(db.client,owner.id,sid,[card.id],{corridorProvider:provider});assert.equal(gone.ok,false,'stored card cannot bypass freshly withdrawn commitment');
 }finally{await app?.close();await db.close();}
});});
import {randomUUID} from 'node:crypto';
import {LAYOVER_RETURN_CORRIDOR_PROVIDER} from '../../services/airport/LayoverReturnCorridor.js';
async function assertTransientCurrentPosition(db:Awaited<ReturnType<typeof openPressedLayoverDb>>,app:Awaited<ReturnType<typeof startPressedLayoverApp>>,owner:Awaited<ReturnType<Awaited<ReturnType<typeof openPressedLayoverDb>>['seedUser']>>,sid:string,candidateId:string,snapshotId:string,factId:string){
  const queries:Array<Parameters<RouteCorridorProvider['corridor']>[0]>=[],original=LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor;
  let withdraw=false;LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor=async q=>{queries.push(q);if(withdraw&&queries.length===2)await db.exec(`UPDATE public.layover_objective_facts SET retracted_at=now() WHERE id='${factId}'`);return provider.corridor(q);};
  const origin={lat:1.31987654,lng:103.89876543,accuracyMeters:20,observedAt:new Date().toISOString(),mode:'drive'},input={requestId:randomUUID(),candidateId,snapshotId,origin};
  try {
    const reply=await app.call('POST',`/api/airport/sessions/${sid}/current-position-check`,owner,input);assert.equal(reply.status,200,reply.raw);const preview=reply.body.preview;assert.equal(preview.previewOnly,true);assert.equal(preview.snapshotId,snapshotId);assert.equal(preview.activityMinutes,72);assert.equal(queries.length,3);assert.ok(queries.every(q=>q.cachePolicy==='no_store'));assert.deepEqual(queries[0]!.from,{lat:origin.lat,lng:origin.lng});assert.equal(queries[1]!.from!.lat,origin.lat);assert.ok(queries[2]!.departAt>queries[1]!.departAt,'actual return is forecast after arrival and commitment');assert.ok(Date.parse(preview.returnRoute.arrivesAt)<=Date.parse(preview.hardReturnBy));assert.equal(reply.raw.includes(String(origin.lat)),false);assert.equal(reply.raw.includes(String(origin.lng)),false);
    const saved=await db.query<Record<string,unknown>>(`SELECT inputs AS value FROM public.layover_certified_computations WHERE session_id='${sid}' UNION ALL SELECT metadata FROM public.layover_events WHERE session_id='${sid}' UNION ALL SELECT plan_json FROM public.layover_recommendations WHERE session_id='${sid}'`);assert.equal(JSON.stringify(saved).includes(String(origin.lat)),false);assert.equal(JSON.stringify(saved).includes(String(origin.lng)),false);
    queries.length=0;for(const body of [{...input,snapshotId:'copied-old-snapshot'},{...input,origin:{...origin,observedAt:new Date(Date.now()-180000).toISOString()}}])assert.equal((await app.call('POST',`/api/airport/sessions/${sid}/current-position-check`,owner,body)).status,409);assert.equal(queries.length,0);
    const foreign=await db.seedUser('position-foreign');assert.equal((await app.call('POST',`/api/airport/sessions/${sid}/current-position-check`,foreign,input)).status,404);assert.equal(queries.length,0);
    withdraw=true;const changed=await app.call('POST',`/api/airport/sessions/${sid}/current-position-check`,owner,{...input,requestId:randomUUID()});assert.equal(changed.status,409,changed.raw);assert.equal(changed.body.reason,'activity_commitment_unavailable','source withdrawal during routing refuses final preview');
  }finally{LAYOVER_RETURN_CORRIDOR_PROVIDER.corridor=original;}
}
