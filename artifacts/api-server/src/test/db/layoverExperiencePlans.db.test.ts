/** L15 travels through real API, compiled contracts and immutable migrated storage. */
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
let db: PressedDb, app: PressedApp, owner: PressedUser, other: PressedUser;
async function readySession() {
  const sid = (await startSession(app, owner, { wantsToLeave: false })).id as string;
  const candidates = await app.call("GET", `/api/airport/sessions/${sid}/experiences`, owner);
  assert.equal(candidates.status, 200, candidates.raw);
  const chosen = candidates.body.recommendations.filter((c: { available: boolean; insideAirport: boolean }) => c.available && c.insideAirport).slice(0, 2);
  assert.equal(chosen.length, 2, candidates.raw);
  for (const c of chosen) {
    const added = await app.call("POST", `/api/airport/sessions/${sid}/stops/from-recommendation`, owner, { recommendationId: c.id, snapshotId: c.contract.snapshotId });
    assert.equal(added.status, 200, added.raw);
  }
  const stops = await app.call("GET", `/api/airport/sessions/${sid}/stops`, owner);
  assert.equal(stops.status, 200, stops.raw);
  return { sid, expectedStopIds: stops.body.stops.map((s: { id: string }) => s.id) as string[], chosen };
}
describe("L15 persistent selected/start contracts on the real migrated API", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb(); await productionBaseFlags(db);
    await db.setFlags({ layover_stable_recommendation_ids_enabled: true, layover_experience_execution_enabled: true, layover_lifecycle_machine_enabled: true, layover_plans_enabled: true, layover_decision_persistence_enabled: true, layover_canonical_snapshot_enabled: true, layover_recommendation_snapshot_enabled: true, layover_recommendation_status_enabled: true, layover_stable_recommendation_ids: true });
    owner = await db.seedUser("experience_plan_owner"); other = await db.seedUser("experience_plan_other"); app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });
  it("selection and explicit start create immutable ordered versions and survive a later read", async () => {
    const fixture = await readySession(), requestId = randomUUID();
    const selected = await app.call("POST", `/api/airport/sessions/${fixture.sid}/experiences/plan/select`, owner, { requestId, expectedStopIds: fixture.expectedStopIds });
    assert.equal(selected.status, 200, selected.raw); assert.equal(selected.body.plan.phase, "selected");
    assert.equal((await db.query(`SELECT state FROM public.layover_sessions WHERE id='${fixture.sid}'`))[0].state, "PLAN_SELECTED");
    assert.deepEqual(selected.body.plan.stopIds, fixture.expectedStopIds);
    const replay = await app.call("POST", `/api/airport/sessions/${fixture.sid}/experiences/plan/select`, owner, { requestId, expectedStopIds: fixture.expectedStopIds });
    assert.equal(replay.body.duplicate, true); assert.deepEqual(replay.body.plan, selected.body.plan);
    const startRequest = { requestId: randomUUID(), expectedStopIds: fixture.expectedStopIds, selectedPlanId: selected.body.plan.id, confirmed: true };
    const started = await app.call("POST", `/api/airport/sessions/${fixture.sid}/experiences/plan/start`, owner, startRequest);
    assert.equal(started.status, 200, started.raw); assert.equal(started.body.plan.phase, "executing"); assert.equal(started.body.plan.version, 2);
    assert.equal((await db.query(`SELECT state FROM public.layover_sessions WHERE id='${fixture.sid}'`))[0].state, "EXECUTING");
    const again = await app.call("POST", `/api/airport/sessions/${fixture.sid}/experiences/plan/start`, owner, startRequest);
    assert.equal(again.body.duplicate, true); assert.deepEqual(again.body.plan, started.body.plan);
    const read = await app.call("GET", `/api/airport/sessions/${fixture.sid}/experiences/plan`, owner);
    assert.equal(read.status, 200, read.raw); assert.equal(read.body.usable, true); assert.deepEqual(read.body.plan, started.body.plan);
    const overview = await app.call("GET", `/api/airport/sessions/${fixture.sid}/overview`, owner); assert.equal(overview.status, 200, overview.raw);
    assert.equal((await db.query(`SELECT state FROM public.layover_sessions WHERE id='${fixture.sid}'`))[0].state, "EXECUTING", "overview must not turn explicit start back into a draft");
    assert.equal((await db.query(`SELECT id FROM public.layover_experience_plans WHERE session_id='${fixture.sid}'`)).length, 2);
    await assert.rejects(db.exec(`UPDATE public.layover_experience_plans SET contract='{}' WHERE id='${requestId}'`), /immutable/);
    assert.equal((await db.query(`SELECT checkpoint_type FROM public.layover_checkpoints WHERE session_id='${fixture.sid}' AND checkpoint_type='LANDSIDE_EXIT'`)).length, 0, "start must not invent airport exit");
  });
  it("foreign owners, unconfirmed starts and client-supplied contract claims are refused", async () => {
    const f = await readySession();
    assert.equal((await app.call("GET", `/api/airport/sessions/${f.sid}/experiences/plan`, other)).status, 404);
    assert.equal((await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, other, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds })).status, 404);
    assert.equal((await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds, contract: { riskBand: "LOW" } })).status, 400);
    assert.equal((await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/start`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds, selectedPlanId: randomUUID() })).status, 400);
    await assert.rejects(db.asUser(owner.id, "SELECT * FROM public.layover_experience_plans"), /permission denied/);
  });
  it("edited stop order refuses start, preserves the chosen version and records the refusal", async () => {
    const f = await readySession();
    const select = await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds });
    assert.equal(select.status, 200, select.raw);
    const original = await db.query(`SELECT * FROM public.layover_experience_plans WHERE id='${select.body.plan.id}'`);
    await db.exec(`UPDATE public.layover_plan_stops SET stop_order=10-stop_order WHERE session_id='${f.sid}'`);
    const request = { requestId: randomUUID(), expectedStopIds: f.expectedStopIds, selectedPlanId: select.body.plan.id, confirmed: true };
    const refused = await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/start`, owner, request);
    assert.equal(refused.status, 409, refused.raw); assert.equal(refused.body.reason, "plan_stops_changed");
    assert.deepEqual(await db.query(`SELECT * FROM public.layover_experience_plans WHERE id='${select.body.plan.id}'`), original);
    assert.equal((await db.query(`SELECT phase FROM public.layover_experience_plans WHERE id='${request.requestId}'`))[0].phase, "refused");
    const read = await app.call("GET", `/api/airport/sessions/${f.sid}/experiences/plan`, owner); assert.equal(read.body.usable, false);
    assert.equal(read.body.reason, "plan_stops_changed");
  });
  it("manual stops cannot be promoted into a compiler-certified plan", async () => {
    const sid = (await startSession(app, owner, { wantsToLeave: false })).id;
    const added = await app.call("POST", `/api/airport/sessions/${sid}/stops`, owner, { title: "Unverified custom stop", durationMin: 30, insideAirport: true, travelMin: 0 });
    assert.equal(added.status, 200, added.raw);
    const selected = await app.call("POST", `/api/airport/sessions/${sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: added.body.stops.map((s: { id: string }) => s.id) });
    assert.equal(selected.status, 409, selected.raw); assert.equal(selected.body.reason, "recommendation_choices_required");
  });
  it("changed canonical facts and expired review refuse an actual start", async () => {
    const f = await readySession();
    const selected = await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds });
    assert.equal(selected.status, 200, selected.raw);
    await db.exec(`UPDATE public.layover_sessions SET departure_time=departure_time-interval '30 minutes',updated_at=clock_timestamp() WHERE id='${f.sid}'`);
    const started = await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/start`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds, selectedPlanId: selected.body.plan.id, confirmed: true });
    assert.equal(started.status, 409, started.raw); assert.equal(started.body.reason, "snapshot_changed");
    assert.equal((await db.query(`SELECT id FROM public.layover_experience_plans WHERE session_id='${f.sid}' AND phase='executing'`)).length, 0);
    const fresh = await readySession();
    const offer = await app.call("POST", `/api/airport/sessions/${fresh.sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: fresh.expectedStopIds });
    assert.equal(offer.status, 200, offer.raw);
    const realNow = Date.now;
    try {
      Date.now = () => Date.parse(offer.body.plan.contract.expiresAt) + 1;
      const expired = await app.call("POST", `/api/airport/sessions/${fresh.sid}/experiences/plan/start`, owner, { requestId: randomUUID(), expectedStopIds: fresh.expectedStopIds, selectedPlanId: offer.body.plan.id, confirmed: true });
      assert.equal(expired.status, 409, expired.raw); assert.equal(expired.body.reason, "plan_expired");
    } finally { Date.now = realNow; }
  });
  it("simultaneous duplicate starts publish only one execution version", async () => {
    const f = await readySession();
    const offer = await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, { requestId: randomUUID(), expectedStopIds: f.expectedStopIds });
    assert.equal(offer.status, 200, offer.raw);
    const body = { requestId: randomUUID(), expectedStopIds: f.expectedStopIds, selectedPlanId: offer.body.plan.id, confirmed: true };
    const outcomes = await Promise.all([0, 1].map(() => app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/start`, owner, body)));
    for (const out of outcomes) assert.equal(out.status, 200, out.raw);
    assert.deepEqual(outcomes[0].body.plan, outcomes[1].body.plan);
    assert.equal((await db.query(`SELECT id FROM public.layover_experience_plans WHERE session_id='${f.sid}' AND phase='executing'`)).length, 1);
  });
  it("FALSE and absent execution flags issue no selection write", async () => {
    const f = await readySession(), body = { requestId: randomUUID(), expectedStopIds: f.expectedStopIds };
    await db.setFlag("layover_experience_execution_enabled", false);
    assert.equal((await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, body)).status, 404);
    await db.exec("DELETE FROM public.feature_flags WHERE flag='layover_experience_execution_enabled'");
    assert.equal((await app.call("POST", `/api/airport/sessions/${f.sid}/experiences/plan/select`, owner, body)).status, 404);
    assert.equal((await db.query(`SELECT id FROM public.layover_experience_plans WHERE session_id='${f.sid}'`)).length, 0);
    await db.exec("INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_experience_execution_enabled',true)");
  });
});
