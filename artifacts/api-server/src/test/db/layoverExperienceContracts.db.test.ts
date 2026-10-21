import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor, type PressedApp } from "./pressedLayoverApp.js";
import { getRecommendations } from "../../services/airport/LayoverRecommendationService.js";
import { getCandidates, compile } from "../../services/airport/LayoverExperienceService.js";
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from "../../services/airport/airportCuration.js";
import { bothDirections, measured, unmeasured, type CorridorQuery, type RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";
import { resetSchemaCapabilityMemo } from "../../lib/capability/schemaCapability.js";
import { mutateExperiencePlan } from "../../services/airport/LayoverExperiencePlans.js";
import { randomUUID } from "node:crypto";

let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser, sid: string;
let missingProvenanceCase: (() => Promise<void>) | undefined;
const realNow = Date.now; let now = Math.floor(realNow() / 60_000) * 60_000 + 10_000;
let cards: Array<{ id: string; contract: { snapshotId: string; candidateIds: string[]; itinerary: unknown[]; departBy: string; failureModes: string[] }; available: boolean; insideAirport: boolean }>;
describe("B2-RECS-B persisted executable experiences through the actual API", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    Date.now = () => now;
    db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_decision_persistence_enabled: true, layover_canonical_snapshot_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true, layover_stable_recommendation_ids: true });
    owner = await db.seedUser("experience_owner"); other = await db.seedUser("experience_other");
    app = await startPressedLayoverApp(db); sid = (await startSession(app, owner)).id;
  });
  after(async () => { Date.now = realNow; await app?.close(); await db?.close(); });
  it("GET candidates persists and serves the complete contract under the active stored snapshot", async () => {
    const r = await app.call("GET", `/api/airport/sessions/${sid}/experiences`, owner);
    assert.equal(r.status, 200, r.raw); cards = r.body.recommendations;
    const eligible = cards.filter(c => c.available);
    assert.ok(eligible.length >= 2, JSON.stringify(cards));
    const [active] = await db.query<{ active_snapshot_id: string }>(`SELECT active_snapshot_id FROM public.layover_sessions WHERE id='${sid}'`);
    for (const c of eligible) {
      assert.equal(c.contract.snapshotId, active.active_snapshot_id); assert.ok(c.contract.departBy); assert.equal(c.contract.failureModes.length, 0); assert.ok(c.contract.itinerary.length > 0);
    }
    const persisted = await getRecommendations(db.client, sid); assert.ok(persisted.ok); if (!persisted.ok) return;
    assert.deepEqual(persisted.recommendations.map(c => c.contract), cards.map(c => c.contract));
  });
  it("compile selects current cards, orders airside experiences and keeps the same citation", async () => {
    const chosen = cards.filter(c => c.available && c.insideAirport).slice(0, 2);
    const r = await app.call("POST", `/api/airport/sessions/${sid}/experiences/compile`, owner, { candidateIds: chosen.map(c => c.id) });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.contract.candidateIds, chosen.flatMap(c => c.contract.candidateIds));
    assert.equal(r.body.contract.snapshotId, chosen[0].contract.snapshotId);
    assert.equal(r.body.contract.state, "READY");
    const itinerary = r.body.contract.itinerary;
    assert.equal(itinerary.length, 2);
    assert.ok(Date.parse(itinerary[1].startsAt) >= Date.parse(itinerary[0].endsAt));
    assert.ok(Date.parse(r.body.contract.expectedAirportReturn) <= Date.parse(r.body.contract.hardReturnBy));
  });
  it("a reused canonical snapshot remains valid for recommendation assessment at the later request instant", async () => {
    const expected = cards.find(c => c.available)!.contract.snapshotId; now += 100;
    const r = await app.call("GET", `/api/airport/sessions/${sid}/experiences`, owner);
    assert.equal(r.status, 200, r.raw); assert.equal(r.body.snapshotId, expected);
    assert.ok(r.body.recommendations.some((c: { available: boolean }) => c.available), "same-decision reuse must not trip the unrelated-instant assessment guard");
    cards = r.body.recommendations;
  });
  it("foreign owners, duplicate aliases and unavailable cards cannot enter compilation", async () => {
    const chosen = cards.find(c => c.available)!;
    const foreign = await app.call("POST", `/api/airport/sessions/${sid}/experiences/compile`, other, { candidateIds: [chosen.id] });
    assert.equal(foreign.status, 404, foreign.raw);
    const duplicate = await app.call("POST", `/api/airport/sessions/${sid}/experiences/compile`, owner, { candidateIds: [chosen.id, chosen.contract.candidateIds[0]] });
    assert.equal(duplicate.status, 409, duplicate.raw);
    await db.exec(`UPDATE public.layover_recommendations SET recommendation_status='BLOCKED',risk_band='UNSAFE',status_reason='unsafe_return_risk' WHERE id='${chosen.id}'`);
    const blocked = await app.call("POST", `/api/airport/sessions/${sid}/experiences/compile`, owner, { candidateIds: [chosen.id] });
    assert.equal(blocked.status, 409, blocked.raw); assert.equal(blocked.body.reason, "candidate_unavailable");
  });
  it("a client cannot rewrite the executable contract or promote blocked availability", async () => {
    await assert.rejects(() => db.asUser(owner.id, `UPDATE public.layover_recommendations SET plan_json='{}',recommendation_status='ELIGIBLE',risk_band='LOW' WHERE session_id='${sid}' RETURNING id`), /permission denied|42501/);
  });
  it("the real-schema compiler routes airport→first→second→airport at each actual future instant", async () => {
    const traveler = await db.seedUser("experience_multi"); await seedConfirmedCorridor(db, traveler.id);
    const [airport] = await db.query<{ id: string; lat: number; lng: number; city: string }>("SELECT id,lat,lng,city FROM public.airport_profiles WHERE iata_code='SIN'");
    for (const [kind, value] of [
      ["terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }, { id: "T2", name: "Terminal 2" }], gates: [{ terminalId: "T1", label: "A1" }], checkpoints: [{ id: "security", terminalId: "T1", kind: "security" }], walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }] }],
      ["ground_transport", { modes: [{ mode: "rail", name: "Fixture rail", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] }],
      ["timing_assumptions", { domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "Explicit integration-test timing policy" }],
    ] as const) {
      const proposed = await proposeCuratedFact(db.client, { airportId: airport.id, kind, value, source: { kind: kind === "timing_assumptions" ? "curator_judgment" : "official_airport", note: "Integration-test fixture only", url: "https://example.test/airport", title: "Integration-test airport", retrievedAt: new Date().toISOString() }, proposedVia: "admin", proposedBy: traveler.id }, Date.now());
      assert.ok(proposed.ok, JSON.stringify(proposed)); if (!proposed.ok) return;
      const validated = await validateProposedFact(db.client, proposed.fact.id, traveler.id, Date.now()); assert.ok(validated.ok, JSON.stringify(validated));
      assert.ok((await publishValidatedFact(db.client, proposed.fact.id, traveler.id)).ok);
    }
    const places = await db.query<{ id: string; lat: number; lng: number }>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'", "''")}','Fixture One','cafe','active',${Number(airport.lat) + .02},${Number(airport.lng) + .02},true),('${airport.city.replaceAll("'", "''")}','Fixture Two','cafe','active',${Number(airport.lat) + .04},${Number(airport.lng) + .04},true) RETURNING id,lat,lng`);
    await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${places[0].id}',30,'venue_stated','HIGH','explicit fixture visit'),('${places[1].id}',40,'venue_stated','HIGH','explicit fixture visit')`);
    await db.setFlags({ layover_place_dwell_enabled: true });
    const multiSid = (await startSession(app, traveler, { wantsToLeave: true })).id;
    const asked: CorridorQuery[] = [];
    const provider: RouteCorridorProvider = { id: "fixture", routed: true, async corridor(q) {
      asked.push(q); const mins = q.from?.lat === Number(places[0].lat) && q.to?.lat === Number(places[1].lat) ? 37 : 12;
      return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [0, 1].map(() => ({ legs: [{ mode: q.mode ?? "drive", minutes: mins, distanceMeters: 1000, interruptibility: "interruptible" as const, transferPointId: null }], totalMinutes: mins, transferCount: 0 })), independentRouteCount: 2, reliability: measured({ spreadMinutes: 0, optionCount: 2 }, "LIVE", "MEDIUM", ["fixture"]), queueFriction: unmeasured("no feed"), weather: unmeasured("no feed"), airportReentryMinutes: unmeasured("no feed"), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), sourceClass: "LIVE", confidence: "MEDIUM", sourceRefs: ["fixture"] } };
    }, bidirectional(q) { return bothDirections(provider, q); } };
    const generated = await getCandidates(db.client, traveler.id, multiSid, Date.now(), { corridorProvider: provider });
    assert.ok(generated.ok, JSON.stringify(generated)); if (!generated.ok) return;
    now += 100;
    const refreshed = await getCandidates(db.client, traveler.id, multiSid, Date.now(), { corridorProvider: provider });
    assert.ok(refreshed.ok, JSON.stringify(refreshed)); if (!refreshed.ok) return;
    assert.equal(refreshed.snapshotId, generated.snapshotId);
    const selected = places.map(p => refreshed.recommendations.find(c => c.placeId === p.id)!);
    assert.ok(selected.every(c => c?.available === true), JSON.stringify(selected));
    assert.ok(selected.every(c => c.contract?.itinerary[0]?.startsAt === new Date(now).toISOString()), "reused citation routes from the freshly validated current instant");
    asked.length = 0;
    const result = await compile(db.client, traveler.id, multiSid, selected.map(c => c.id!), { corridorProvider: provider });
    assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return;
    assert.equal(asked.length, 3); assert.equal(asked[1].from?.lat, Number(places[0].lat)); assert.equal(asked[1].to?.lat, Number(places[1].lat));
    assert.equal(result.contract.itinerary.filter(s => s.kind === "experience").length, 2);
    assert.equal(asked[1].departAt.toISOString(), result.contract.itinerary.find(s => s.kind === "experience")?.endsAt);
    assert.ok(Date.parse(result.contract.expectedAirportReturn!) <= Date.parse(result.contract.hardReturnBy));
    assert.doesNotMatch(JSON.stringify(result), /"lat"|"lng"/);
    // L15 uses that same real routed compiler for selection and execution, with entry truth owned upstream.
    await db.setFlags({ layover_experience_execution_enabled: true, layover_lifecycle_machine_enabled: true, layover_plans_enabled: true });
    for (const card of selected) {
      const added = await app.call("POST", `/api/airport/sessions/${multiSid}/stops/from-recommendation`, traveler, { recommendationId: card.id, snapshotId: card.contract!.snapshotId });
      assert.equal(added.status, 200, added.raw);
    }
    const savedStops = await app.call("GET", `/api/airport/sessions/${multiSid}/stops`, traveler);
    const expectedStopIds = savedStops.body.stops.map((s: { id: string }) => s.id) as string[];
    const picked = await mutateExperiencePlan(db.client, traveler.id, multiSid, { requestId: randomUUID(), operation: "select", expectedStopIds }, { corridorProvider: provider });
    assert.ok(picked.ok, JSON.stringify(picked)); if (!picked.ok) return;
    assert.equal(picked.plan.contract.insideAirport, false);
    const started = await mutateExperiencePlan(db.client, traveler.id, multiSid, { requestId: randomUUID(), operation: "start", expectedStopIds, selectedPlanId: picked.plan.id }, { corridorProvider: provider });
    assert.ok(started.ok, JSON.stringify(started)); if (!started.ok) return;
    assert.equal(started.plan.phase, "executing"); assert.equal(started.plan.contract.itinerary.filter(s => s.kind === "experience").length, 2);
    const executed = await app.call("GET", `/api/airport/sessions/${multiSid}/experiences/plan`, traveler);
    assert.equal(executed.status, 200, executed.raw); assert.equal(executed.body.plan.id, started.plan.id);
    // Availability can change while future routes are in flight: the final owned read must refuse it.
    let blockedInFlight = false;
    const changingProvider: RouteCorridorProvider = { ...provider, async corridor(q) {
      if (!blockedInFlight) { blockedInFlight = true; await db.exec(`UPDATE public.layover_recommendations SET recommendation_status='BLOCKED',risk_band='UNSAFE',status_reason='unsafe_return_risk' WHERE id='${selected[0].id}'`); }
      return provider.corridor(q);
    } };
    const changed = await compile(db.client, traveler.id, multiSid, selected.map(c => c.id!), { corridorProvider: changingProvider });
    assert.deepEqual(changed, { ok: false, reason: "candidate_unavailable" });
    missingProvenanceCase = async () => {
    // Routes can be enabled before 2745 is applied. Refuse before changing cards/history.
    await db.exec("ALTER TABLE public.layover_recommendations DROP COLUMN travel_time_source");
    resetSchemaCapabilityMemo();
    const previousRows = await db.query(`SELECT * FROM public.layover_recommendations WHERE session_id='${multiSid}' ORDER BY id`);
    const previousHistory = await db.query(`SELECT * FROM public.layover_recommendation_supersessions WHERE session_id='${multiSid}' ORDER BY id`);
    const missingSchema = await getCandidates(db.client, traveler.id, multiSid, Date.now(), { corridorProvider: provider });
    assert.deepEqual(missingSchema, { ok: false, message: "Travel-time provenance is unavailable; recommendations could not be refreshed." });
    assert.deepEqual(await db.query(`SELECT * FROM public.layover_recommendations WHERE session_id='${multiSid}' ORDER BY id`), previousRows);
    assert.deepEqual(await db.query(`SELECT * FROM public.layover_recommendation_supersessions WHERE session_id='${multiSid}' ORDER BY id`), previousHistory);
    };
  });
  it("a real missing provenance column refuses before modifying cards or history", { skip: PRESSED_SKIP_REASON }, async () => {
    assert.ok(missingProvenanceCase, "routed fixture must have completed");
    await missingProvenanceCase();
  });
});
