/** L78 authorized HTTP producers and the actual migrated recommendation generator. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor, type PressedApp } from "./pressedLayoverApp.js";
import { getCandidates } from "../../services/airport/LayoverExperienceService.js";
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from "../../services/airport/airportCuration.js";
import { bothDirections, measured, unmeasured, type RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";
import { emptyObjectiveIntent, statedObjectiveTerms, type ObjectiveIntent } from "../../services/airport/layoverObjectiveEvidence.js";
import { loadObjectiveEvidence } from "../../services/airport/LayoverObjectiveEvidenceStore.js";
let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser, admin: PressedUser, sid: string;
let airport: { id: string; city: string; lat: number; lng: number }, places: Array<{ id: string; lat: number; lng: number }>;
let intent: ObjectiveIntent;
const source = () => ({ sourceClass: "venue_operator", sourceUrl: "https://example.test/fixture", sourceNote: "Explicit integration fixture only", observedAt: new Date(Date.now()-60000).toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(), confirmedSource: true });
const provider: RouteCorridorProvider = { id: "fixture", routed: true, async corridor(q) {
 return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [0,1].map(() => ({ legs: [{ mode: q.mode??"drive", minutes: 12, distanceMeters: 1000, interruptibility: "interruptible" as const, transferPointId: null }], totalMinutes: 12, transferCount: 0 })), independentRouteCount: 2, reliability: measured({spreadMinutes:0,optionCount:2},"LIVE","MEDIUM",["fixture"]), queueFriction: unmeasured("no feed"), weather: unmeasured("no feed"), airportReentryMinutes: unmeasured("no feed"), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+300000).toISOString(), sourceClass: "LIVE", confidence: "MEDIUM", sourceRefs: ["fixture"] } };
}, bidirectional(q) { return bothDirections(provider,q); } };
async function refresh() {
 const generated = await getCandidates(db.client, owner.id, sid, Date.now(), { corridorProvider: provider });
 assert.ok(generated.ok, JSON.stringify(generated)); if (!generated.ok) throw new Error("generation failed");
 return generated.recommendations;
}
async function terms(placeId: string) {
 const [r] = await db.query<{plan_json: {objective: {terms: Record<string,{state:string;value?:number;provenance?:string}>}},utility_score:number}>(`SELECT plan_json,utility_score FROM public.layover_recommendations WHERE session_id='${sid}' AND place_id='${placeId}' AND recommendation_status<>'SUPERSEDED'`);
 assert.ok(r); return r.plan_json.objective.terms;
}
async function publish(placeId: string, kind: string, value: unknown) {
 const r=await app.call("POST",`/api/admin/airport/profiles/${airport.id}/places/${placeId}/objective-evidence`,admin,{fact:{kind,value},source:source()});
 assert.equal(r.status,201,r.raw); return r.body.fact.id as string;
}
describe("L78 real authorized sources feed the objective, never eligibility",{skip:PRESSED_SKIP_REASON},()=>{
 before(async()=>{
  db=await openPressedLayoverDb(); await productionBaseFlags(db);
  await db.setFlags({layover_objective_evidence_enabled:true,layover_place_dwell_enabled:true,layover_decision_persistence_enabled:true,layover_canonical_snapshot_enabled:true,layover_recommendation_snapshot_enabled:true,layover_recommendation_status_enabled:true});
  owner=await db.seedUser("objective_owner");other=await db.seedUser("objective_other");admin=await db.seedUser("objective_curator");
  await db.exec(`UPDATE public.profiles SET role='admin' WHERE id='${admin.id}'`); await seedConfirmedCorridor(db,owner.id);
  app=await startPressedLayoverApp(db); sid=(await startSession(app,owner,{wantsToLeave:true})).id;
  [airport]=await db.query<typeof airport>("SELECT id,city,lat,lng FROM public.airport_profiles WHERE iata_code='SIN'");
    for (const [kind, value] of [
      ["terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }, { id: "T2", name: "Terminal 2" }], gates: [{ terminalId: "T1", label: "A1" }], checkpoints: [{ id: "security", terminalId: "T1", kind: "security" }], walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }] }],
      ["ground_transport", { modes: [{ mode: "rail", name: "Fixture rail", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] }],
      ["timing_assumptions", { domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "Explicit integration-test timing policy" }],
    ] as const) {
      const proposed = await proposeCuratedFact(db.client, { airportId: airport.id, kind, value, source: { kind: kind === "timing_assumptions" ? "curator_judgment" : "official_airport", note: "Integration-test fixture only", url: "https://example.test/airport", title: "Integration-test airport", retrievedAt: new Date().toISOString() }, proposedVia: "admin", proposedBy: admin.id }, Date.now());
      assert.ok(proposed.ok, JSON.stringify(proposed)); if (!proposed.ok) return;
      const validated = await validateProposedFact(db.client, proposed.fact.id, admin.id, Date.now()); assert.ok(validated.ok, JSON.stringify(validated));
      assert.ok((await publishValidatedFact(db.client, proposed.fact.id, admin.id)).ok);
    }
  places=await db.query<typeof places[number]>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'","''")}','Objective One','cafe','active',${Number(airport.lat)+.02},${Number(airport.lng)+.02},true),('${airport.city.replaceAll("'","''")}','Objective Two','cafe','active',${Number(airport.lat)+.04},${Number(airport.lng)+.04},true) RETURNING id,lat,lng`);
  for (const p of places) await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${p.id}',30,'venue_stated','HIGH','explicit fixture visit')`);
  intent={socialPreference:"social",availableEnergy:"high",budget:{currency:"SGD",amountMinor:5000},meaningfulPlaces:[{placeId:places[1]!.id,importance:"high"}]};
  await db.setFlag("layover_ranking_mode",true,{mode:"on",cohort:{kind:"all"}});
 });
 after(async()=>{await app?.close();await db?.close();});
 it("owner-only intent and admin-only sourced facts are actual HTTP writers, and direct clients are denied",async()=>{
  assert.equal((await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,other,intent)).status,404);
  assert.equal((await app.call("POST",`/api/admin/airport/profiles/${airport.id}/places/${places[0]!.id}/objective-evidence`,owner,{fact:{kind:"exertion",value:{level:"light"}},source:source()})).status,403);
  assert.equal((await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,owner,{...intent,commission:99})).status,400);
  const saved=await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,owner,intent); assert.equal(saved.status,200,saved.raw);
  assert.deepEqual((await app.call("GET",`/api/airport/sessions/${sid}/objective-intent`,owner)).body.intent,intent);
  await assert.rejects(db.asUser(owner.id,"SELECT * FROM public.layover_objective_intents"),/permission denied|42501/);
  await assert.rejects(db.asUser(owner.id,"SELECT * FROM public.layover_objective_facts"),/permission denied|42501/);
 });
 it("all five new terms become known from authorized producers and reorder only the same safety partition",async()=>{
  const baseline=await refresh(); const target=places[1]!.id;
  assert.ok(baseline.find(c=>c.placeId===target)?.available);
  const empty=await terms(target); assert.equal(empty.local_uniqueness.state,"UNKNOWN"); assert.equal(empty.monetary_cost.state,"UNKNOWN");
  await publish(target,"local_distinctiveness",{extent:"city_only"}); await publish(target,"social_format",{format:"interactive"}); await publish(target,"exertion",{level:"light"});
  await publish(target,"quoted_cost",{currency:"SGD",venueMinor:1000,roundTripTransportMinor:1000,otherRequiredMinor:0,transportMode:"drive",complete:true});
  const after=await refresh(), observed=await terms(target);
  for (const name of ["local_uniqueness","social_value","memory_value","monetary_cost","energy_cost"]) assert.equal(observed[name]!.state,"KNOWN",JSON.stringify(observed));
  const safety=(rows:typeof after)=>rows.map(c=>[c.placeId??c.title,c.safetyRating,c.available]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(safety(after),safety(baseline));
  assert.match(observed.memory_value.provenance!,/not a past memory/); assert.match(observed.monetary_cost.provenance!,/cost=2000 minor SGD/);
  assert.ok(after.findIndex(c=>c.placeId===target)<after.findIndex(c=>c.placeId===places[0]!.id),JSON.stringify(after.map(c=>({placeId:c.placeId,rating:c.safetyRating}))));
 });
 it("edited intent, currency mismatch, retraction and conflicting evidence become unknown",async()=>{
  const target=places[1]!.id;
  assert.equal((await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,owner,{...emptyObjectiveIntent(),budget:{currency:"USD",amountMinor:5000}})).status,200);
  await refresh();let actual=await terms(target);
  for(const name of ["social_value","memory_value","energy_cost","monetary_cost"])assert.equal(actual[name]!.state,"UNKNOWN");
  const conflicting=await publish(target,"local_distinctiveness",{extent:"widely_available"});await refresh();assert.equal((await terms(target)).local_uniqueness.state,"UNKNOWN");
  assert.equal((await app.call("POST",`/api/admin/airport/objective-evidence/${conflicting}/retract`,admin,{})).status,200);
  await refresh();assert.equal((await terms(target)).local_uniqueness.state,"KNOWN");
  const sourceRows=await db.query<{id:string}>(`SELECT id FROM public.layover_objective_facts WHERE place_id='${target}' AND retracted_at IS NULL`);
  for(const row of sourceRows)assert.equal((await app.call("POST",`/api/admin/airport/objective-evidence/${row.id}/retract`,admin,{})).status,200);
  await refresh();assert.equal((await terms(target)).local_uniqueness.state,"UNKNOWN");
 });
 it("stored source expiry, foreign scope and actual read failures cannot manufacture available terms",async()=>{
  const target=places[0]!.id, card={placeId:target}, cards=[card], session={id:sid,userId:owner.id};
  assert.equal((await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,owner,intent)).status,200);
  await publish(target,"local_distinctiveness",{extent:"city_only"});
  const current=await loadObjectiveEvidence(db.client,session,airport.id,cards,c=>c.placeId,Date.now());
  assert.equal(statedObjectiveTerms(target,false,current.get(target)).local_uniqueness.state,"KNOWN");
  const expired=await loadObjectiveEvidence(db.client,session,airport.id,cards,c=>c.placeId,Date.now()+2*3600000);
  assert.equal(statedObjectiveTerms(target,false,expired.get(target)).local_uniqueness.state,"UNKNOWN");
  const foreign=await loadObjectiveEvidence(db.client,session,"00000000-0000-4000-8000-000000000001",cards,c=>c.placeId,Date.now());
  assert.equal(statedObjectiveTerms(target,false,foreign.get(target)).local_uniqueness.state,"UNKNOWN");
  for(const table of ["layover_objective_facts","layover_objective_intents"]){
   const fault=new Proxy(db.client,{get(client,key){if(key!=="from")return Reflect.get(client,key);return(name:string)=>{
    if(name!==table)return client.from(name);
    const chain:Record<string,unknown>={};for(const method of ["select","eq","in","is","gt","lte","limit","maybeSingle"])chain[method]=()=>chain;
    chain.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:null,error:{code:"XX000",message:"planted source read failure"}}).then(resolve);return chain;
   };}});
   const degraded=await loadObjectiveEvidence(fault,session,airport.id,cards,c=>c.placeId,Date.now());
   assert.equal(degraded.get(target)?.state,"unreadable");assert.ok(Object.values(statedObjectiveTerms(target,false,degraded.get(target))).every(term=>term.state==="UNKNOWN"));
  }
 });
 it("future or expired sources are refused and capability FALSE writes nothing",async()=>{
  for(const expiry of [new Date(Date.now()-1).toISOString(),new Date(Date.now()+100*86400000).toISOString()]){
   const r=await app.call("POST",`/api/admin/airport/profiles/${airport.id}/places/${places[0]!.id}/objective-evidence`,admin,{fact:{kind:"exertion",value:{level:"light"}},source:{...source(),expiresAt:expiry}});assert.equal(r.status,400,r.raw);
  }
  const before=await db.query(`SELECT * FROM public.layover_objective_intents WHERE session_id='${sid}'`);await db.setFlag("layover_objective_evidence_enabled",false);
  assert.equal((await app.call("PUT",`/api/airport/sessions/${sid}/objective-intent`,owner,intent)).status,404);
  assert.deepEqual(await db.query(`SELECT * FROM public.layover_objective_intents WHERE session_id='${sid}'`),before);
 });
});
