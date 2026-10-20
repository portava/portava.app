/** Restricted geometry is response-only through the real migrated recommendation writer. */
import { before, after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateExperiencePlan, type ExperiencePlan } from '../../services/airport/LayoverExperiencePlans.js';
import { readExperienceGeometry } from '../../services/airport/LayoverExperienceGeometry.js';
import { LAYOVER_RETURN_CORRIDOR_PROVIDER } from '../../services/airport/LayoverReturnCorridor.js';
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor, type PressedApp } from './pressedLayoverApp.js';
import { getCandidates } from '../../services/airport/LayoverExperienceService.js';
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from '../../services/airport/airportCuration.js';
import { bothDirections, measured, unmeasured, type RouteCorridorProvider } from '../../lib/providers/routeCorridorProvider.js';
import { googleRouteGeometry } from '../../lib/providers/providerMapGeometry.js';
let db: PressedDb, app: PressedApp, owner: PressedUser, sid: string;let placeIds:string[]=[];let selected:ExperiencePlan;let other:PressedUser;let expectedStopIds:string[]=[];let calls=0;let hook:(()=>Promise<void>)|undefined;const routedDescriptor=Object.getOwnPropertyDescriptor(LAYOVER_RETURN_CORRIDOR_PROVIDER,'routed')!;
const provider: RouteCorridorProvider = { id: 'google-geometry-fixture', routed: true, async corridor(q) { calls++;if(hook){const fn=hook;hook=undefined;await fn();}
  return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [0,1].map(() => ({ legs: [{ mode: q.mode ?? 'drive', minutes: 12, distanceMeters: 1000, interruptibility: 'interruptible' as const, transferPointId: null }], totalMinutes: 12, transferCount: 0,
    geometry: googleRouteGeometry({ type: 'LineString', coordinates: [[q.from!.lng,q.from!.lat],[q.to!.lng,q.to!.lat]] }) })), independentRouteCount: 2,
    reliability: measured({spreadMinutes:0,optionCount:2},'LIVE','MEDIUM',['fixture']), queueFriction: unmeasured('no feed'), weather: unmeasured('no feed'), airportReentryMinutes: unmeasured('no feed'), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+300000).toISOString(), sourceClass: 'LIVE', confidence: 'MEDIUM', sourceRefs: ['google:routes.v2:fixture'] } };
}, bidirectional(q) { return bothDirections(provider,q); } };
describe('L270 exact selected-plan transient geometry through migrated API', { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_experience_execution_enabled:true,layover_lifecycle_machine_enabled:true,layover_plans_enabled:true,layover_stable_recommendation_ids_enabled:true, layover_place_dwell_enabled:true, layover_decision_persistence_enabled:true, layover_canonical_snapshot_enabled:true, layover_recommendation_snapshot_enabled:true, layover_recommendation_status_enabled:true });
    owner = await db.seedUser('map_geometry_owner');other=await db.seedUser('map_geometry_other');Object.defineProperty(LAYOVER_RETURN_CORRIDOR_PROVIDER,'routed',{...routedDescriptor,value:true});mock.method(LAYOVER_RETURN_CORRIDOR_PROVIDER,'corridor',provider.corridor.bind(provider)); const curator = await db.seedUser('map_geometry_curator'); await seedConfirmedCorridor(db,owner.id);
    app = await startPressedLayoverApp(db); sid = (await startSession(app,owner,{wantsToLeave:true},{arrivedHAgo:-1,departsInH:12})).id;
    const [airport] = await db.query<{id:string;city:string;lat:number;lng:number}>("SELECT id,city,lat,lng FROM public.airport_profiles WHERE iata_code='SIN'"); assert.ok(airport);
    for (const [kind,value] of [
      ['terminal_topology',{terminals:[{id:'T1',name:'Terminal 1'},{id:'T2',name:'Terminal 2'}],gates:[{terminalId:'T1',label:'A1'}],checkpoints:[{id:'security',terminalId:'T1',kind:'security'}],walkingLinks:[{fromTerminalId:'T1',toTerminalId:'T2',minutes:12,mode:'train'}]}],
      ['ground_transport',{modes:[{mode:'rail',name:'Fixture rail',toCity:'City centre',journeyMinutes:{min:25,max:35},terminalIds:['T1']}]}],
      ['timing_assumptions',{domesticBufferMin:60,domesticBufferMax:90,internationalBufferMin:120,internationalBufferMax:180,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20,rationale:'Integration fixture timing policy'}],
    ] as const) {
      const p = await proposeCuratedFact(db.client,{airportId:airport.id,kind,value,source:{kind:kind==='timing_assumptions'?'curator_judgment':'official_airport',note:'Integration fixture only',url:'https://example.test/airport',title:'Fixture',retrievedAt:new Date().toISOString()},proposedVia:'admin',proposedBy:curator.id},Date.now());
      assert.ok(p.ok,JSON.stringify(p)); if (!p.ok) return;
      assert.ok((await validateProposedFact(db.client,p.fact.id,curator.id,Date.now())).ok); assert.ok((await publishValidatedFact(db.client,p.fact.id,curator.id)).ok);
    }
    for(let i=0;i<2;i++){
      const [place]=await db.query<{id:string}>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'","''")}','Ordered Geometry ${i}','cafe','active',${Number(airport.lat)+.02+i*.01},${Number(airport.lng)+.02+i*.01},true) RETURNING id`);assert.ok(place);placeIds.push(place.id);
      await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${place.id}',30,'venue_stated','HIGH','explicit visit')`);
    }
    const candidates=await getCandidates(db.client,owner.id,sid,Date.now(),{corridorProvider:provider});assert.ok(candidates.ok,JSON.stringify(candidates));if(!candidates.ok)return;
    for(const placeId of placeIds){const c=candidates.recommendations.find(c=>c.placeId===placeId);assert.ok(c?.available,JSON.stringify(c));const r=await app.call('POST',`/api/airport/sessions/${sid}/stops/from-recommendation`,owner,{recommendationId:c.id,snapshotId:c.contract!.snapshotId});assert.equal(r.status,200,r.raw);}
    const stops=await app.call('GET',`/api/airport/sessions/${sid}/stops`,owner);expectedStopIds=stops.body.stops.map((s:{id:string})=>s.id);
    const result=await mutateExperiencePlan(db.client,owner.id,sid,{requestId:randomUUID(),operation:'select',expectedStopIds},{corridorProvider:provider});assert.ok(result.ok,JSON.stringify(result));if(result.ok)selected=result.plan;

  });
  after(async()=>{mock.restoreAll();Object.defineProperty(LAYOVER_RETURN_CORRIDOR_PROVIDER,'routed',routedDescriptor);await app?.close();await db?.close();});
  const endpoint=()=>`/api/airport/sessions/${sid}/experiences/plan/map?planId=${selected.id}&version=${selected.version}`;
  it('actual route emits ordered outbound/between-stop/return geometry and never stores it',async()=>{
    const before=await db.query(`SELECT row_to_json(p) AS record FROM public.layover_experience_plans p WHERE session_id='${sid}'`);
    const response=await app.call('GET',endpoint(),owner);assert.equal(response.status,200,response.raw);
    assert.match(selected.contract.routeInputHash??'',/^[0-9a-f]{64}$/);const map=response.body.map;assert.equal(map.planId,selected.id);assert.deepEqual(map.stopIds,expectedStopIds);assert.deepEqual(map.hops.map((h:{direction:string})=>h.direction),['outbound','between_stops','return']);assert.equal(map.hops[1].fromKey,map.hops[0].toKey);assert.equal(map.hops[2].toKey,'airport');assert.equal(map.cachePolicy,'no_store');
    assert.deepEqual(await db.query(`SELECT row_to_json(p) AS record FROM public.layover_experience_plans p WHERE session_id='${sid}'`),before);
    for(const table of ['layover_experience_plans','layover_recommendations','layover_certified_computations','layover_events']){const rows=await db.query(`SELECT row_to_json(t) AS record FROM public.${table} t WHERE session_id='${sid}'`);assert.doesNotMatch(JSON.stringify(rows),/LineString|no_store|google_map_only/);}
    const r=await fetch(app.base+endpoint(),{headers:{authorization:`Bearer ${owner.token}`}});assert.match(r.headers.get('cache-control')??'',/no-store/);
  });
  it('foreign, stale version, disabled and expired selections make no provider calls',async()=>{
    for(const [who,url,status] of [[other,endpoint(),404],[owner,endpoint().replace(`version=${selected.version}`,`version=${selected.version+1}`),409]] as const){const n=calls;const r=await app.call('GET',url,who);assert.equal(r.status,status,r.raw);assert.equal(calls,n);}
    const n=calls;await db.setFlag('layover_experience_execution_enabled',false);assert.equal((await app.call('GET',endpoint(),owner)).status,404);assert.equal(calls,n);await db.setFlag('layover_experience_execution_enabled',true);
    const expired=await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{nowMs:Date.parse(selected.contract.expiresAt!)+1,corridorProvider:provider});assert.deepEqual(expired,{ok:false,reason:'plan_expired'});assert.equal(calls,n);
  });
  it('changed stop order during the provider call refuses the whole map',async()=>{
    hook=async()=>{await db.exec(`UPDATE public.layover_plan_stops SET stop_order=10-stop_order WHERE session_id='${sid}'`);};
    try{const result=await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:provider});assert.deepEqual(result,{ok:false,reason:'selected_plan_changed'});}finally{await db.exec(`UPDATE public.layover_plan_stops SET stop_order=10-stop_order WHERE session_id='${sid}'`);}
  });
  it('changed timing, wrong provider endpoint, and absent geometry never fall back to another card route',async()=>{
    for(const kind of ['slow','wrong','missing'] as const){const altered:RouteCorridorProvider={...provider,async corridor(q){const r=await provider.corridor(q);assert.ok(r.ok);if(!r.ok)return r;return {...r,value:{...r.value,...(kind==='wrong'?{to:{lat:0,lng:0}}:{}),routes:r.value.routes.map(route=>({...route,...(kind==='slow'?{totalMinutes:1000}:{}),...(kind==='missing'?{geometry:null}:{})}))}};}};
      const r=await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:altered});assert.equal(r.ok,false);if(!r.ok)assert.equal(r.reason,kind==='slow'?'plan_route_terms_changed':kind==='wrong'?'PROVIDER_MALFORMED':'route_geometry_unavailable');}
  });
  it('a moved place refuses geometry for the timetable reviewed at the old position, before and during routing',async()=>{
    const move=(d:number)=>db.exec(`UPDATE public.discovery_places SET lat=lat+(${d}) WHERE id='${placeIds[1]}'`);
    const n=calls;await move(0.001);
    try{assert.deepEqual(await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:provider}),{ok:false,reason:'candidate_changed'});assert.equal(calls,n);}finally{await move(-0.001);}
    hook=async()=>{await move(0.001);};
    try{assert.deepEqual(await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:provider}),{ok:false,reason:'candidate_changed'});}finally{hook=undefined;await move(-0.001);}
    assert.equal((await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:provider})).ok,true);
  });
  it('a stored plan compiled before the input binding is asked for review, never routed',async()=>{
    const id=randomUUID(),version=selected.version+1,n=calls;
    await db.exec(`INSERT INTO public.layover_experience_plans(id,session_id,user_id,version,operation,phase,previous_plan_id,snapshot_id,stops,contract) SELECT '${id}',session_id,user_id,${version},operation,phase,previous_plan_id,snapshot_id,stops,contract-'routeInputHash' FROM public.layover_experience_plans WHERE id='${selected.id}'`);
    try{assert.deepEqual(await readExperienceGeometry(db.client,owner.id,sid,{planId:id,version},{corridorProvider:provider}),{ok:false,reason:'plan_review_required'});assert.equal(calls,n);}finally{await db.exec(`DELETE FROM public.layover_experience_plans WHERE id='${id}'`);}
  });
  it('a canonical change during routing refuses geometry for the prior plan',async()=>{
    hook=async()=>{await db.exec(`UPDATE public.layover_sessions SET departure_time=departure_time-interval '30 minutes',updated_at=clock_timestamp() WHERE id='${sid}'`);};
    const r=await readExperienceGeometry(db.client,owner.id,sid,{planId:selected.id,version:selected.version},{corridorProvider:provider});assert.equal(r.ok,false);if(!r.ok)assert.equal(r.reason,'snapshot_changed');
  });
});
