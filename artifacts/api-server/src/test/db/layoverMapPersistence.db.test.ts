/** Restricted geometry is response-only through the real migrated recommendation writer. */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from './pressedLayoverDb.js';
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor, type PressedApp } from './pressedLayoverApp.js';
import { getCandidates } from '../../services/airport/LayoverExperienceService.js';
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from '../../services/airport/airportCuration.js';
import { bothDirections, measured, unmeasured, type RouteCorridorProvider } from '../../lib/providers/routeCorridorProvider.js';
import { googleRouteGeometry } from '../../lib/providers/providerMapGeometry.js';
let db: PressedDb, app: PressedApp, owner: PressedUser, sid: string, placeId: string;
const provider: RouteCorridorProvider = { id: 'google-geometry-fixture', routed: true, async corridor(q) {
  return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [0,1].map(() => ({ legs: [{ mode: q.mode ?? 'drive', minutes: 12, distanceMeters: 1000, interruptibility: 'interruptible' as const, transferPointId: null }], totalMinutes: 12, transferCount: 0,
    geometry: googleRouteGeometry({ type: 'LineString', coordinates: [[q.from!.lng,q.from!.lat],[q.to!.lng,q.to!.lat]] }) })), independentRouteCount: 2,
    reliability: measured({spreadMinutes:0,optionCount:2},'LIVE','MEDIUM',['fixture']), queueFriction: unmeasured('no feed'), weather: unmeasured('no feed'), airportReentryMinutes: unmeasured('no feed'), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+300000).toISOString(), sourceClass: 'LIVE', confidence: 'MEDIUM', sourceRefs: ['google:routes.v2:fixture'] } };
}, bidirectional(q) { return bothDirections(provider,q); } };
describe('provider geometry response versus database persistence', { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_place_dwell_enabled:true, layover_decision_persistence_enabled:true, layover_canonical_snapshot_enabled:true, layover_recommendation_snapshot_enabled:true, layover_recommendation_status_enabled:true, layover_stable_recommendation_ids_enabled:true }); // getCandidates' cutover prerequisite (a0f8754f3)
    owner = await db.seedUser('map_geometry_owner'); const curator = await db.seedUser('map_geometry_curator'); await seedConfirmedCorridor(db,owner.id);
    app = await startPressedLayoverApp(db); sid = (await startSession(app,owner,{wantsToLeave:true})).id;
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
    const [place] = await db.query<{id:string}>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'","''")}','Map Geometry Fixture','cafe','active',${Number(airport.lat)+.02},${Number(airport.lng)+.02},true) RETURNING id`); assert.ok(place); placeId=place.id;
    await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${placeId}',30,'venue_stated','HIGH','explicit fixture visit')`);
  });
  after(async()=>{await app?.close();await db?.close();});
  it('fresh returned geometry is present while stored plan, audit and canonical replay rows have none',async()=>{
    const result=await getCandidates(db.client,owner.id,sid,Date.now(),{corridorProvider:provider}); assert.ok(result.ok,JSON.stringify(result)); if(!result.ok)return;
    const card=result.recommendations.find(c=>c.placeId===placeId); assert.ok(card); assert.equal(card.available,true,JSON.stringify(card));
    assert.equal(card.routing?.geometry?.returnLeg?.geometry.type,'LineString');
    const rows=await db.query<{plan_json:unknown}>(`SELECT plan_json FROM public.layover_recommendations WHERE session_id='${sid}'`); assert.ok(rows.length);
    const audits=await db.query(`SELECT metadata FROM public.layover_events WHERE session_id='${sid}'`);
    const snapshots=await db.query(`SELECT row_to_json(c) AS record FROM public.layover_certified_computations c WHERE session_id='${sid}'`); assert.ok(snapshots.length);
    for(const value of [rows,audits,snapshots]) assert.doesNotMatch(JSON.stringify(value),/LineString|MultiPolygon|no_store/);
  });
});
