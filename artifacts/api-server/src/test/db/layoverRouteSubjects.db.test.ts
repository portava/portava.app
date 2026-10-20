/** L259: actual measured-route producer, private retained watches and external replan. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, seedConfirmedCorridor, type PressedApp } from "./pressedLayoverApp.js";
import { proposeCuratedFact, validateProposedFact, publishValidatedFact } from "../../services/airport/airportCuration.js";
import { bothDirections, measured, unmeasured, type RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";
import { getCandidates } from "../../services/airport/LayoverExperienceService.js";
import { activeLayoverRouteSessions, routeSubjectPublicationGate } from "../../services/airport/LayoverRouteSubjects.js";
import { normalizeEvent } from "../../services/airport/LayoverEventReplanner.js";
import { replanExternalEvent, layoverExternalReplanPort } from "../../services/airport/LayoverExternalReplanPort.js";

let db: PressedDb, app: PressedApp, a: PressedUser, b: PressedUser, other: PressedUser;
let sidA: string, sidB: string, sidOther: string, routeRefs: string[] = [];
const originalKey = process.env["LAYOVER_ROUTE_SUBJECT_HMAC_SECRET"];
const provider: RouteCorridorProvider = { id: "route-dependency-test", routed: true, async corridor(q) {
  return { ok: true, value: { from: q.from!, to: q.to!, departAt: q.departAt.toISOString(), routes: [0, 1].map(() => ({ legs: [{ mode: q.mode ?? "drive", minutes: 12, distanceMeters: 1000, interruptibility: "interruptible" as const, transferPointId: null }], totalMinutes: 12, transferCount: 0 })), independentRouteCount: 2, reliability: measured({ spreadMinutes: 0, optionCount: 2 }, "LIVE", "MEDIUM", ["fixture"]), queueFriction: unmeasured("no fixture feed"), weather: unmeasured("no fixture feed"), airportReentryMinutes: unmeasured("no fixture feed"), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), sourceClass: "LIVE", confidence: "MEDIUM", sourceRefs: ["fixture"] } };
}, bidirectional(q) { return bothDirections(provider, q); } };
async function generate(user: PressedUser, id: string) {
  const result = await getCandidates(db.client, user.id, id, Date.now(), { corridorProvider: provider });
  assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) throw Error(JSON.stringify(result));
  return result;
}
function event(refs = routeRefs) {
  const now = Date.now(); const e = normalizeEvent({ eventId: randomUUID(), eventType: "mobility.route_degraded", source: "route-test", sourceEventId: randomUUID(), occurredAt: new Date(now - 1000).toISOString(), subjectRefs: refs.map(ref => ({ kind: "route", ref })), payload: { extraMinutes: 20 }, confidence: "HIGH" }, { receivedAtMs: now });
  assert.ok(e.ok, JSON.stringify(e)); return e.event;
}
describe("L259 migrated route dependency fanout", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    process.env["LAYOVER_ROUTE_SUBJECT_HMAC_SECRET"] = "local-fixture-route-reference-secret-over-32-characters";
    db = await openPressedLayoverDb(); assert.equal(await db.flag("layover_route_subjects_enabled"), false); await productionBaseFlags(db);
    await db.setFlags({ layover_decision_persistence_enabled: true, layover_canonical_snapshot_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true, layover_stable_recommendation_ids_enabled: true, layover_place_dwell_enabled: true, layover_plans_enabled:true, layover_event_ingest_enabled:true, layover_route_subjects_enabled: true, layover_route_fanout_enabled:true });
    a = await db.seedUser("route_a"); b = await db.seedUser("route_b"); other = await db.seedUser("route_other");
    app = await startPressedLayoverApp(db); sidOther = (await startSession(app, other)).id;
    await seedConfirmedCorridor(db, a.id); await seedConfirmedCorridor(db, b.id);
    const [airport] = await db.query<{ id: string; lat: number; lng: number; city: string }>("SELECT id,lat,lng,city FROM public.airport_profiles WHERE iata_code='SIN'");
    for (const [kind, value] of [
      ["terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }, { id: "T2", name: "Terminal 2" }], gates: [{ terminalId: "T1", label: "A1" }], checkpoints: [{ id: "security", terminalId: "T1", kind: "security" }], walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }] }],
      ["ground_transport", { modes: [{ mode: "rail", name: "Fixture rail", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] }],
      ["timing_assumptions", { domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "Explicit route fanout integration-test policy" }],
    ] as const) {
      const p = await proposeCuratedFact(db.client, { airportId: airport.id, kind, value, source: { kind: kind === "timing_assumptions" ? "curator_judgment" : "official_airport", note: "Test fixture, not actual airport data", url: "https://example.test/airport", title: "Fixture airport", retrievedAt: new Date().toISOString() }, proposedVia: "admin", proposedBy: a.id }, Date.now());
      assert.ok(p.ok, JSON.stringify(p)); if (!p.ok) throw Error("curation fixture");
      assert.ok((await validateProposedFact(db.client, p.fact.id, a.id, Date.now())).ok); assert.ok((await publishValidatedFact(db.client, p.fact.id, a.id)).ok);
    }
    const [place] = await db.query<{ id: string }>(`INSERT INTO public.discovery_places(city,name,place_type,status,lat,lng,verified) VALUES ('${airport.city.replaceAll("'", "''")}','Route fixture','cafe','active',${Number(airport.lat) + .02},${Number(airport.lng) + .02},true) RETURNING id`);
    await db.exec(`INSERT INTO public.layover_place_dwell(place_id,activity_min,source_class,confidence,evidence) VALUES ('${place.id}',30,'venue_stated','HIGH','explicit route test fixture')`);
    sidA = (await startSession(app, a, { wantsToLeave: true })).id; sidB = (await startSession(app, b, { wantsToLeave: true })).id;
  });
  after(async () => { if (originalKey === undefined) delete process.env["LAYOVER_ROUTE_SUBJECT_HMAC_SECRET"]; else process.env["LAYOVER_ROUTE_SUBJECT_HMAC_SECRET"] = originalKey; await app?.close(); await db?.close(); });
  it("real recommendation generation indexes the two measured directions and exposes only opaque references", async () => {
    const first = await generate(a, sidA); await generate(b, sidB);
    const routed = first.recommendations.find(c => c.available && c.routing?.routeSubjectRefs?.length === 2); assert.ok(routed, JSON.stringify(first));
    routeRefs = routed.routing!.routeSubjectRefs!; assert.equal(new Set(routeRefs).size, 2);
    const rows = await db.query<{ route_ref: string; snapshot_id: string }>(`SELECT route_ref,snapshot_id FROM public.layover_route_subjects WHERE session_id='${sidA}' ORDER BY route_ref`);
    assert.deepEqual(rows.map(r => r.route_ref), [...routeRefs].sort()); assert.ok(rows.every(r => r.snapshot_id === first.snapshotId));
    const active = await activeLayoverRouteSessions(db.client, routeRefs, Date.now(), 200); assert.ok(active.ok); if (active.ok) assert.deepEqual(active.rows.map(r => r.session.id).sort(), [sidA, sidB].sort());
  });
  it("private index rejects direct writers and a recommendation cannot be rebound to another session", async () => {
    const [row]=await db.query<{recommendation_id:string;snapshot_id:string}>(`SELECT recommendation_id,snapshot_id FROM public.layover_route_subjects WHERE session_id='${sidA}' LIMIT 1`);
    const wrong=await db.client.from('layover_recommendations').update({session_id:sidOther}).eq('id',row.recommendation_id);assert.equal(wrong.error?.code,'LY452');
    const [otherSnapshot]=await db.query<{snapshot_id:string}>(`SELECT snapshot_id FROM public.layover_route_subjects WHERE session_id='${sidB}' LIMIT 1`);const stale=await db.client.from('layover_recommendations').update({snapshot_id:otherSnapshot.snapshot_id}).eq('id',row.recommendation_id);assert.equal(stale.error?.code,'LY452');
    const direct=await db.client.from('layover_route_subjects').insert({session_id:sidA,user_id:a.id,snapshot_id:row.snapshot_id,recommendation_id:row.recommendation_id,route_ref:routeRefs[0]});assert.equal(direct.error?.code,'42501');
    await assert.rejects(db.asUser(a.id,'SELECT * FROM public.layover_route_subjects'),/permission denied|42501/);
    await assert.rejects(db.asUser(a.id,`SELECT public.layover_active_sessions_by_routes(ARRAY['${routeRefs[0]}'],now(),200)`),/permission denied|42501/);
    assert.equal((await db.query(`SELECT id FROM public.layover_route_subjects WHERE session_id='${sidA}'`)).length,2);
  });
  it("a bounded route page remains unprocessed until every dependent checkpoint completes",async()=>{
    const e=event();assert.equal((await ingestExternalEvent(db.client,e,Date.now())).ok,true);
    const drain=(limit:number)=>drainPendingExternalEvents(db.client,layoverExternalReplanPort(db.client,{nowMs:Date.now(),sessionLimit:limit}),{nowMs:Date.now(),limit:20});
    const first=await drain(1);assert.deepEqual(first.failedAfterClaim,[]);assert.equal(first.routeFanout?.done,1,JSON.stringify(first));assert.equal(first.routeFanout?.leased,1);
    assert.equal((await db.query<{processed_at:string|null}>(`SELECT processed_at FROM public.layover_external_events WHERE event_id='${e.eventId}'`))[0].processed_at,null);
    const second=await drain(1);assert.equal(second.routeFanout?.done,1,JSON.stringify(second));
    const third=await drain(1);assert.equal(third.routeFanout?.leased,0);assert.ok((await db.query<{processed_at:string|null}>(`SELECT processed_at FROM public.layover_external_events WHERE event_id='${e.eventId}'`))[0].processed_at);
    assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE metadata->'replan'->'event'->>'eventId'='${e.eventId}'`)).length,2);
  });
  it("OFF performs no new schema read and missing rollout prerequisites or schema refuse before publication",async()=>{
    assert.deepEqual(await activeLayoverRouteSessions(db.client,['invented-road'],Date.now(),200),{ok:false,reason:'route_subject_invalid'});
    await db.setFlag('layover_route_subjects_enabled',false);resetSchemaCapabilityMemo();await db.exec('ALTER TABLE public.layover_route_subjects RENAME TO route_subjects_fault');
    try {assert.deepEqual(await routeSubjectPublicationGate(db.client,true),{ok:true,required:false});await db.setFlag('layover_route_subjects_enabled',true);assert.deepEqual(await routeSubjectPublicationGate(db.client,true),{ok:false,reason:'route_subject_schema_unavailable'});assert.deepEqual(await activeLayoverRouteSessions(db.client,routeRefs,Date.now(),200),{ok:false,reason:'route_subject_sessions_unreadable'});}finally{await db.exec('ALTER TABLE public.route_subjects_fault RENAME TO layover_route_subjects');resetSchemaCapabilityMemo();}
    await db.setFlag('layover_recommendation_status_enabled',false);try{assert.deepEqual(await routeSubjectPublicationGate(db.client,true),{ok:false,reason:'route_subject_prerequisites_unavailable'});}finally{await db.setFlag('layover_recommendation_status_enabled',true);}
    assert.deepEqual(await routeSubjectPublicationGate(db.client,false),{ok:false,reason:'route_subject_prerequisites_unavailable'});
  });
  it("a watch write failure rolls back the recommendation transaction and makes generation refuse without a pairing event",async()=>{
    const before=await db.query(`SELECT id,plan_json FROM public.layover_recommendations WHERE session_id='${sidA}' ORDER BY id`);const events=(await db.query<{n:number}>(`SELECT count(*)::int n FROM public.layover_events WHERE session_id='${sidA}' AND event_type='recommendation_generated'`))[0].n;
    await db.exec(`CREATE FUNCTION public.route_watch_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture route watch failure'; END $$;CREATE TRIGGER route_watch_fault BEFORE INSERT ON public.layover_route_subjects FOR EACH ROW EXECUTE FUNCTION public.route_watch_fault()`);
    try{const failed=await getCandidates(db.client,a.id,sidA,Date.now(),{corridorProvider:provider});assert.equal(failed.ok,false,JSON.stringify(failed));assert.deepEqual(await db.query(`SELECT id,plan_json FROM public.layover_recommendations WHERE session_id='${sidA}' ORDER BY id`),before);assert.equal((await db.query<{n:number}>(`SELECT count(*)::int n FROM public.layover_events WHERE session_id='${sidA}' AND event_type='recommendation_generated'`))[0].n,events);}finally{await db.exec('DROP TRIGGER route_watch_fault ON public.layover_route_subjects;DROP FUNCTION public.route_watch_fault()');}
  });
  it("actual ingress and consumer replan route dependants once; subsequent events still reach changed snapshots and returning sessions",async()=>{
    const e=event();const first=await ingestExternalEvent(db.client,e,Date.now());assert.ok(first.ok);const duplicate=await ingestExternalEvent(db.client,e,Date.now());assert.ok(duplicate.ok&&duplicate.duplicate);
    const drain=()=>drainPendingExternalEvents(db.client,layoverExternalReplanPort(db.client,{nowMs:Date.now()}),{limit:20,nowMs:Date.now()});
    const a1=await drain();assert.deepEqual(a1.failedAfterClaim,[]);assert.equal(a1.drained.length,1);assert.equal(a1.drained[0].impacted,2);assert.equal((await drain()).drained.length,0);
    await db.exec(`UPDATE public.layover_sessions SET status='returning' WHERE id='${sidB}'`);
    const returningEvent=event();assert.ok((await ingestExternalEvent(db.client,returningEvent,Date.now())).ok);const a2=await drain();assert.deepEqual(a2.failedAfterClaim,[]);assert.equal(a2.drained[0].impacted,2);const settled=await db.query<{session_id:string;persisted:boolean}>(`SELECT session_id,(metadata->'replan'->>'snapshotPersisted')::boolean persisted FROM public.layover_events WHERE metadata->'replan'->'event'->>'eventId'='${returningEvent.eventId}'`);assert.equal(settled.length,2);assert.ok(settled.every(row=>row.persisted),JSON.stringify(settled));
    await db.exec(`UPDATE public.layover_sessions SET status='completed' WHERE id='${sidB}'`);assert.ok((await ingestExternalEvent(db.client,event(),Date.now())).ok);const a3=await drain();assert.equal(a3.drained[0].impacted,1);
  });
  it("a copied stop watch survives route regeneration, stale-card deletion and source snapshot compaction, then expires with its stop",async()=>{
    const generated=await generate(a,sidA);const rec=generated.recommendations.find(c=>c.available&&c.routing?.routeSubjectRefs?.length===2);assert.ok(rec?.id);const originalRefs=rec.routing!.routeSubjectRefs!;const originalSnapshot=generated.snapshotId;
    const add=await app.call('POST',`/api/airport/sessions/${sidA}/stops/from-recommendation`,a,{recommendationId:rec.id,snapshotId:generated.snapshotId});assert.equal(add.status,200,add.raw);
    const [stop]=await db.query<{id:string}>(`SELECT id FROM public.layover_plan_stops WHERE session_id='${sidA}' AND recommendation_id='${rec.id}'`);assert.ok(stop);
    assert.equal((await db.query(`SELECT id FROM public.layover_route_subjects WHERE stop_id='${stop.id}'`)).length,2);
    await db.exec(`UPDATE public.discovery_places SET lat=lat+0.01,lng=lng+0.01 WHERE id=(SELECT place_id FROM public.layover_recommendations WHERE id='${rec.id}')`);const regenerated=await generate(a,sidA);const replacement=regenerated.recommendations.find(c=>c.id===rec.id);assert.ok(replacement?.routing?.routeSubjectRefs?.length);assert.notDeepEqual(replacement.routing.routeSubjectRefs,originalRefs);
    assert.deepEqual((await db.query<{route_ref:string}>(`SELECT route_ref FROM public.layover_route_subjects WHERE stop_id='${stop.id}' ORDER BY route_ref`)).map(r=>r.route_ref),[...originalRefs].sort());
    const changed=await app.call('PATCH',`/api/airport/sessions/${sidA}`,a,{wantsToLeave:false});assert.equal(changed.status,200,changed.raw);await generate(a,sidA);
    assert.equal((await db.query(`SELECT id FROM public.layover_recommendations WHERE id='${rec.id}'`)).length,0);assert.equal((await db.query<{recommendation_id:string|null}>(`SELECT recommendation_id FROM public.layover_plan_stops WHERE id='${stop.id}'`))[0].recommendation_id,null);
    await db.exec(`DELETE FROM public.layover_certified_computations WHERE snapshot_id='${originalSnapshot}'`);const active=await activeLayoverRouteSessions(db.client,originalRefs,Date.now(),200);assert.ok(active.ok);if(active.ok)assert.deepEqual(active.rows.map(r=>r.session.id),[sidA]);
    await db.exec(`DELETE FROM public.layover_plan_stops WHERE id='${stop.id}'`);assert.equal((await db.query(`SELECT id FROM public.layover_route_subjects WHERE stop_id='${stop.id}'`)).length,0);const cleared=await activeLayoverRouteSessions(db.client,originalRefs,Date.now(),200);assert.ok(cleared.ok);if(cleared.ok)assert.equal(cleared.rows.length,0);
  });
  it("the database rejects unbounded page sizes and invalid retry reasons",async()=>{
    for(const size of [null,0,-1,201]){const result=await db.client.rpc('layover_route_fanout_claim',{p_limit:size});assert.ok(result.error,JSON.stringify({size,result}));}
    const result=await db.client.rpc('layover_route_fanout_retry',{p_event:'no-event',p_session:sidA,p_token:randomUUID(),p_reason:null});assert.ok(result.error);
  });
  it("201 matching sessions finish over bounded pages with one atomic decision per event/session",async()=>{
    const fixture=await cohort(201);const e=event([fixture.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);
    const one=await routeDrain(200);assert.equal(one.routeFanout?.scanned,200);assert.equal(one.routeFanout?.leased,200);assert.equal(one.routeFanout?.done,200,JSON.stringify(one.routeFanout));
    assert.equal((await eventRow(e.eventId)).processed_at,null);
    const two=await routeDrain(200);assert.equal(two.routeFanout?.leased,1);assert.equal(two.routeFanout?.done,1,JSON.stringify(two.routeFanout));
    await routeDrain(200);assert.ok((await eventRow(e.eventId)).processed_at);
    const work=await db.query<{state:string}>(`SELECT state FROM public.layover_route_work WHERE event_id='${e.eventId}'`);assert.equal(work.length,201);assert.ok(work.every(x=>x.state==='done'));
    assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE metadata->'replan'->'event'->>'eventId'='${e.eventId}'`)).length,201);
    assert.equal((await routeDrain(200)).routeFanout?.leased,0);
  });
  it("millisecond ingress precision and regenerated watches retain existing matching sessions",async()=>{
    const f=await cohort(1);const [created]=await db.query<{stamp:string}>(`SELECT date_trunc('milliseconds',created_at)::text stamp FROM public.layover_sessions WHERE id='${f.ids[0]}'`);const raw=event([f.ref]);const received=Date.parse(created.stamp);const normalized=normalizeEvent({...raw,occurredAt:new Date(received-1000).toISOString()},{receivedAtMs:received});assert.ok(normalized.ok);if(!normalized.ok)return;
    assert.ok((await ingestExternalEvent(db.client,normalized.event,received)).ok);
    // Regeneration replaces watch rows later than the event without changing its route.
    await db.exec(`UPDATE public.layover_route_subjects SET created_at=clock_timestamp()+interval '1 second',snapshot_id='regenerated-same-route' WHERE session_id='${f.ids[0]}'`);
    const pass=await routeDrain(200);assert.equal(pass.routeFanout?.done,1,JSON.stringify(pass));await routeDrain(200);assert.ok((await eventRow(normalized.event.eventId)).processed_at);
  });
  it("concurrent claims lease distinct work, and concurrent settlement publishes one ledger record",async()=>{
    const f=await cohort(2);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);
    const claims=await Promise.all([claimRoute(1),claimRoute(1)]);const tasks=claims.flatMap(c=>c.tasks);assert.ok(tasks.length>=1&&tasks.length<=2);if(tasks.length===1)tasks.push(...(await claimRoute(1)).tasks);assert.equal(tasks.length,2);assert.equal(new Set(tasks.map(t=>t.workId)).size,2);
    const payload=await prepareTask(tasks[0]);const results=await Promise.all([settleTask(tasks[0],payload),settleTask(tasks[0],payload)]);assert.ok(results.every(r=>r.data?.state==='done'),JSON.stringify(results));
    assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE id='${tasks[0].workId}'`)).length,1);
    assert.equal((await settleTask(tasks[1],await prepareTask(tasks[1]))).data?.state,'done');await routeDrain(200);
  });
  it("a crash after snapshot writes rolls the entire settlement back and the same lease can retry",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const task=(await claimRoute(1)).tasks[0];const payload=await prepareTask(task);
    await db.exec(`CREATE FUNCTION public.route_fanout_ledger_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${task.workId}' THEN RAISE EXCEPTION 'fixture atomic ledger failure';END IF;RETURN NEW; END $$;CREATE TRIGGER route_fanout_ledger_fault BEFORE INSERT ON public.layover_events FOR EACH ROW EXECUTE FUNCTION public.route_fanout_ledger_fault()`);
    try{const failed=await settleTask(task,payload);assert.ok(failed.error);assert.equal((await db.query(`SELECT id FROM public.layover_certified_computations WHERE session_id='${task.session.id}'`)).length,0);assert.equal((await db.query<{state:string}>(`SELECT state FROM public.layover_route_work WHERE id='${task.workId}'`))[0].state,'leased');assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE id='${task.workId}'`)).length,0);}finally{await db.exec('DROP TRIGGER route_fanout_ledger_fault ON public.layover_events;DROP FUNCTION public.route_fanout_ledger_fault()');}
    const recovered=await settleTask(task,payload);assert.equal(recovered.data?.state,'done',JSON.stringify(recovered));await routeDrain(200);assert.ok((await eventRow(e.eventId)).processed_at);
  });
  it("expired leases recover after a crash and stale lease tokens cannot publish",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const old=(await claimRoute(1)).tasks[0];const payload=await prepareTask(old);
    await db.exec(`UPDATE public.layover_route_work SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${old.workId}'`);
    const next=(await claimRoute(1)).tasks[0];assert.equal(next.workId,old.workId);assert.notEqual(next.token,old.token);
    assert.equal((await settleTask(old,payload)).data?.state,'lease_lost');assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE id='${old.workId}'`)).length,0);
    assert.equal((await settleTask(next,await prepareTask(next))).data?.state,'done');assert.equal((await db.query<{attempts:number}>(`SELECT attempts FROM public.layover_route_work WHERE id='${old.workId}'`))[0].attempts,2);await routeDrain(200);
  });
  it("changed session or route revisions refuse stale publication and retry with bounded backoff",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const task=(await claimRoute(1)).tasks[0];const payload=await prepareTask(task);
    await db.exec(`UPDATE public.layover_sessions SET departure_time=departure_time-interval '10 minutes' WHERE id='${task.session.id}'`);
    assert.equal((await settleTask(task,payload)).data?.state,'revision_changed');assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE id='${task.workId}'`)).length,0);
    const retry=await db.client.rpc('layover_route_fanout_retry',{p_event:e.eventId,p_session:task.session.id,p_token:task.token,p_reason:'route_revision_changed'});assert.equal(retry.data,true);
    assert.equal((await claimRoute(1)).tasks.length,0,'backoff must prevent immediate retry');
    await db.exec(`UPDATE public.layover_route_work SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id='${task.workId}'`);
    const next=(await claimRoute(1)).tasks[0];const prepared=await prepareTask(next);await db.exec(`UPDATE public.layover_route_subjects SET snapshot_id='changed-fixture-provenance' WHERE session_id='${task.session.id}'`);assert.equal((await settleTask(next,prepared)).data?.state,'revision_changed');
    await db.client.rpc('layover_route_fanout_retry',{p_event:e.eventId,p_session:next.session.id,p_token:next.token,p_reason:'route_revision_changed'});await db.exec(`UPDATE public.layover_route_work SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id='${task.workId}'`);
    const done=await routeDrain(200);assert.equal(done.routeFanout?.done,1,JSON.stringify(done));await routeDrain(200);
  });
  it("closed and changed-owner leased work becomes explicitly obsolete without publishing",async()=>{
    const f=await cohort(2);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const tasks=(await claimRoute(2)).tasks;assert.equal(tasks.length,2);
    const payloads=await Promise.all(tasks.map(prepareTask));await db.exec(`UPDATE public.layover_sessions SET status='completed' WHERE id='${tasks[0].session.id}';UPDATE public.layover_sessions SET user_id='${other.id}' WHERE id='${tasks[1].session.id}'`);
    const settled=await Promise.all(tasks.map((t,i)=>settleTask(t,payloads[i])));assert.deepEqual(settled.map(r=>[r.data?.state,r.data?.reason]),[['obsolete','session_closed'],['obsolete','owner_changed']]);
    assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE metadata->'replan'->'event'->>'eventId'='${e.eventId}'`)).length,0);await routeDrain(200);assert.ok((await eventRow(e.eventId)).processed_at);
  });
  it("transient settlement failure retries automatically, preserving the bound timer in the same transaction",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const [timer]=await db.query<{id:string}>(`INSERT INTO public.safe_return_sessions(user_id,timer_end_at) VALUES('${a.id}',clock_timestamp()+interval '12 hours') RETURNING id`);
    await db.exec(`INSERT INTO public.layover_safe_return_links(layover_session_id,safe_return_session_id,user_id,certified_deadline,certification) SELECT '${f.ids[0]}',id,user_id,timer_end_at,'{}' FROM public.safe_return_sessions WHERE id='${timer.id}'`);await db.setFlag('layover_safe_return_product_enabled',true);
    const fault=(q:{target:string})=>q.target==='rpc/layover_route_fanout_settle'?{status:400,body:{code:'XX000',message:'fixture settlement unavailable'}}:null;db.bridge.faults.push(fault);
    try{
      const failed=await routeDrain(200);assert.equal(failed.routeFanout?.retrying,1,JSON.stringify(failed));assert.equal((await eventRow(e.eventId)).processed_at,null);assert.equal((await db.query(`SELECT id FROM public.layover_events WHERE metadata->'replan'->'event'->>'eventId'='${e.eventId}'`)).length,0);
    }finally{db.bridge.faults.splice(db.bridge.faults.indexOf(fault),1);}
    try{
      await db.exec(`UPDATE public.layover_route_work SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id='${e.eventId}'`);const retried=await routeDrain(200);assert.equal(retried.routeFanout?.done,1,JSON.stringify(retried));
      const [bound]=await db.query<{certified_deadline:string;timer_end_at:string;hard_return_time:string;input_hash:string;certification:{inputHash:string}}>(`SELECT l.certified_deadline,l.certification,t.timer_end_at,c.hard_return_time,c.input_hash FROM public.layover_safe_return_links l JOIN public.safe_return_sessions t ON t.id=l.safe_return_session_id JOIN public.layover_sessions s ON s.id=l.layover_session_id JOIN public.layover_certified_computations c ON c.snapshot_id=s.active_snapshot_id WHERE l.layover_session_id='${f.ids[0]}'`);
      assert.equal(Date.parse(bound.certified_deadline),Date.parse(bound.hard_return_time));assert.equal(Date.parse(bound.timer_end_at),Date.parse(bound.hard_return_time));assert.equal(bound.certification.inputHash,bound.input_hash);await routeDrain(200);
    }finally{await db.setFlag('layover_safe_return_product_enabled',false);}
  });
  it("account erasure cascades private work and clears a paging cursor without losing another traveller",async()=>{
    const u1=await db.seedUser('fanout_delete'),u2=await db.seedUser('fanout_survivor');const first=await cohort(1,u1.id),second=await cohort(1,u2.id);
    await db.exec(`UPDATE public.layover_route_subjects SET route_ref='${first.ref}' WHERE session_id='${second.ids[0]}'`);const e=event([first.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const task=(await claimRoute(1)).tasks[0];const deleted=task.session.user_id,survivor=deleted===u1.id?u2.id:u1.id;
    assert.equal((await db.query<{after_session_id:string|null}>(`SELECT after_session_id FROM public.layover_route_dispatches WHERE event_id='${e.eventId}'`))[0].after_session_id,task.session.id);
    await db.exec(`DELETE FROM auth.users WHERE id='${deleted}'`);assert.equal((await db.query(`SELECT id FROM public.layover_route_work WHERE user_id='${deleted}'`)).length,0);assert.equal((await db.query<{after_session_id:string|null}>(`SELECT after_session_id FROM public.layover_route_dispatches WHERE event_id='${e.eventId}'`))[0].after_session_id,null);
    const pass=await routeDrain(1);assert.equal(pass.routeFanout?.done,1,JSON.stringify(pass));await routeDrain(200);
    const remaining=await db.query<{user_id:string;state:string}>(`SELECT user_id,state FROM public.layover_route_work WHERE event_id='${e.eventId}'`);assert.deepEqual(remaining,[{user_id:survivor,state:'done'}]);assert.ok((await eventRow(e.eventId)).processed_at);
  });
  it("mixed subject envelopes stay unclaimed and authenticated clients cannot read or execute private work",async()=>{
    const f=await cohort(1);const raw=event([f.ref]);const mixed=normalizeEvent({...raw,subjectRefs:[...raw.subjectRefs,{kind:'airport',ref:'SIN'}]},{receivedAtMs:Date.parse(raw.receivedAt)});assert.ok(mixed.ok);if(!mixed.ok)return;
    assert.ok((await ingestExternalEvent(db.client,mixed.event,Date.now())).ok);const pass=await routeDrain(200);assert.ok(pass.routeRefused?.some(x=>x.eventId===mixed.event.eventId&&x.reason==='route_subject_union_unsupported'));assert.equal((await eventRow(mixed.event.eventId)).processed_at,null);assert.equal((await db.query(`SELECT id FROM public.layover_route_work WHERE event_id='${mixed.event.eventId}'`)).length,0);
    await assert.rejects(db.asUser(a.id,'SELECT * FROM public.layover_route_work'),/permission denied/);await assert.rejects(db.asUser(a.id,'SELECT public.layover_route_fanout_claim(1)'),/permission denied/);
    const write=await db.client.from('layover_route_work').insert({event_id:mixed.event.eventId,session_id:f.ids[0],user_id:a.id});assert.equal(write.error?.code,'42501');
  });
  it("replanning preserves named traveller preferences in the canonical input evidence",async()=>{
    const f=await cohort(1);await db.exec(`UPDATE public.layover_sessions SET comfort_level='safe_only',vibe_chips=ARRAY['culture','quiet'] WHERE id='${f.ids[0]}'`);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);const pass=await routeDrain(200);assert.equal(pass.routeFanout?.done,1,JSON.stringify(pass));
    const [row]=await db.query<{inputs:{freedomPolicy:{softConstraints:Array<{key:string;value:string}>}}}>(`SELECT c.inputs FROM public.layover_sessions s JOIN public.layover_certified_computations c ON c.snapshot_id=s.active_snapshot_id WHERE s.id='${f.ids[0]}'`);assert.deepEqual(row.inputs.freedomPolicy.softConstraints,[{key:'comfortLevel',value:'safe_only'},{key:'vibe',value:'culture'},{key:'vibe',value:'quiet'}]);await routeDrain(200);
  });
  it("malformed stored route subjects are explicitly refused without a perpetually hot backlog",async()=>{
    const e=event();assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);await db.exec(`UPDATE public.layover_external_events SET subject_refs='[{"kind":"route","ref":"invented-road"}]' WHERE event_id='${e.eventId}'`);const pass=await routeDrain(200);assert.equal(pass.routeFanout?.hasMore,false,JSON.stringify(pass));assert.equal((await eventRow(e.eventId)).processed_at,null);assert.ok(pass.routeRefused?.some(x=>x.eventId===e.eventId&&x.reason==='route_subject_invalid'));
  });
  it("the actual scheduler supplies trusted audit scope to every atomic route write",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);await db.setFlag('layover_service_write_audit_enabled',true);
    try{
      const unscoped=await db.client.rpc('layover_route_fanout_claim',{p_limit:1});assert.equal(unscoped.error?.code,'42501');
      const result=await runLayoverExternalEventDrain({client:db.client,nowMs:Date.now(),limit:200});assert.equal(result.drained,1,JSON.stringify(result));assert.equal(result.routeFailed,0);await runLayoverExternalEventDrain({client:db.client,nowMs:Date.now(),limit:200});assert.ok((await eventRow(e.eventId)).processed_at);
      const rows=await db.query<{system_actor:string;table_name:string}>(`SELECT system_actor,table_name FROM public.layover_service_write_audit WHERE table_name IN('layover_route_work','layover_route_dispatches')`);assert.ok(rows.length>=3);assert.ok(rows.every(r=>r.system_actor==='layover:external-events'));
    }finally{await db.setFlag('layover_service_write_audit_enabled',false);}
  });
  it("fanout OFF touches no new schema and never falls through to the legacy route claim",async()=>{
    const f=await cohort(1);const e=event([f.ref]);assert.ok((await ingestExternalEvent(db.client,e,Date.now())).ok);await db.setFlag('layover_route_fanout_enabled',false);await db.exec('ALTER TABLE public.layover_route_work RENAME TO route_work_unavailable');
    try{const pass=await routeDrain(200);assert.equal(pass.routeFanout?.enabled,false);assert.equal((await eventRow(e.eventId)).processed_at,null);assert.deepEqual(await routeSubjectPublicationGate(db.client,true),{ok:false,reason:'route_subject_prerequisites_unavailable'});}finally{await db.exec('ALTER TABLE public.route_work_unavailable RENAME TO layover_route_work');await db.setFlag('layover_route_fanout_enabled',true);}
    assert.equal((await routeDrain(200)).routeFanout?.done,1);await routeDrain(200);
  });

});

import { ingestExternalEvent } from '../../services/layover/LayoverExternalEventService.js';
import { drainPendingExternalEvents } from '../../services/layover/layoverExternalEventConsumer.js';
import { resetSchemaCapabilityMemo } from '../../lib/capability/schemaCapability.js';

import {prepareDurableRouteWork} from '../../services/airport/LayoverExternalReplanPort.js';
import {rowToEnvelope} from '../../services/layover/LayoverExternalEventService.js';
async function routeDrain(limit:number){return drainPendingExternalEvents(db.client,layoverExternalReplanPort(db.client,{nowMs:Date.now()}),{limit,nowMs:Date.now()});}
async function eventRow(id:string){return (await db.query<{processed_at:string|null}>(`SELECT processed_at FROM public.layover_external_events WHERE event_id='${id}'`))[0];}
async function claimRoute(limit:number){const r=await db.client.rpc('layover_route_fanout_claim',{p_limit:limit});assert.ifError(r.error);return r.data as {scanned:number;tasks:any[]};}
async function prepareTask(task:any){const event=rowToEnvelope(task.event);assert.ok(event);const p=await prepareDurableRouteWork(db.client,event,task.session,task.routeRefs,Date.now());assert.ok(p.ok,JSON.stringify(p));return p.payload;}
async function settleTask(task:any,payload:unknown){return db.client.rpc('layover_route_fanout_settle',{p_event:task.event.event_id,p_session:task.session.id,p_token:task.token,p_session_revision:task.sessionRevision,p_route_revision:task.routeRevision,p_payload:payload});}
/** Stress-only fixtures: real measured publication is proved above. These private
 * watch rows represent already published stopped journeys; no provider is called. */
async function cohort(count:number,owner=a.id){
 const ref='layover-route:v1:'+randomUUID().replaceAll('-','').repeat(2),tag=randomUUID();
 await db.exec(`DO $fixture$ DECLARE sid uuid;stop uuid;BEGIN FOR n IN 1..${count} LOOP
 INSERT INTO public.layover_sessions(user_id,airport_id,arrival_time,departure_time,wants_to_leave,manual_airport_name) SELECT '${owner}',airport_id,clock_timestamp()-interval '30 minutes',clock_timestamp()+interval '10 hours',false,'${tag}' FROM public.layover_sessions WHERE id='${sidA}' RETURNING id INTO sid;
 INSERT INTO public.layover_plan_stops(session_id,title,inside_airport,duration_min) VALUES(sid,'Fixture terminal stop',true,10) RETURNING id INTO stop;
 INSERT INTO public.layover_route_subjects(session_id,user_id,snapshot_id,stop_id,route_ref) VALUES(sid,'${owner}','fixture-retained-provenance',stop,'${ref}');
 END LOOP;END $fixture$;`);
 const rows=await db.query<{id:string}>(`SELECT id FROM public.layover_sessions WHERE manual_airport_name='${tag}' ORDER BY id`);assert.equal(rows.length,count);return{ref,ids:rows.map(r=>r.id)};
}

import {runLayoverExternalEventDrain} from '../../lib/layoverExternalEventScheduler.js';
