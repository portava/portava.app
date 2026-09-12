/**
 * §20.1 durable outcomes on the real kernel (2763's trip_outcomes, written
 * only by RECORD_OUTCOME). census-trips TR382 ("durable post-trip projections
 * are based on meaningful outcomes"), TR385 (an answer is recorded), TR388
 * (the closeout's outcome per done plan is keyed and never doubled).
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/tripCloseoutOutcomes.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";
import { latestOutcomeByPlan } from "../../services/trips/TripPostTripProjections.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("§20.1 outcomes are durable, keyed and append-only", { skip: SKIP }, () => {
  let owner = ""; let tripId = ""; let stageId = ""; let planId = "";
  const as = (actor: string, over: Record<string, unknown>) => kernel(command({ actor_user_id: actor, trip_id: tripId, ...over }));
  function ok(actor: string, over: Record<string, unknown>) {
    const r = as(actor, over);
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  const outcomes = () => rows<{ id: string; plan_id: string | null; outcome_type: string; occurred_at: string; created_at: string; evidence_json: any }>(
    `SELECT id, plan_id, outcome_type, occurred_at, created_at, evidence_json FROM public.trip_outcomes WHERE trip_id = '${tripId}' ORDER BY created_at, id`);

  before(() => {
    owner = seedUser("po_owner");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "post-trip", destination_city: "Lisbon", destination_country: "Portugal", visibility: "private" } });
    stageId = ok(owner, { type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }).result.id;
    planId = ok(owner, { type: "ADD_PLAN", payload: { title: "Belém", stage_id: stageId, day_date: "2026-10-02", starts_at: "2026-10-02T09:00:00Z", ends_at: "2026-10-02T11:00:00Z" } }).result.id;
    ok(owner, { type: "UPDATE_PLAN", payload: { item_id: planId, patch: { status: "done" } } });
  });
  after(() => { if (owner) deleteUser(owner); });

  it("the closeout's outcome for a done plan is recorded once: the same key again is a duplicate receipt, not a second row (TR388)", () => {
    const key = `closeout:outcome:${planId}`;
    const payload = { outcome_type: "completed", plan_id: planId, occurred_at: "2026-10-02T11:00:00Z", evidence_json: { source: "closeout", plan_status: "done", title: "Belém" } };
    const first = ok(owner, { type: "RECORD_OUTCOME", idempotency_key: key, payload });
    assert.equal(first.duplicate, false);
    const again = ok(owner, { type: "RECORD_OUTCOME", idempotency_key: key, payload });
    assert.equal(again.duplicate, true, JSON.stringify(again));
    assert.equal(again.result.id, first.result.id);
    assert.deepEqual(outcomes().map((o) => [o.plan_id, o.outcome_type, o.evidence_json.source]), [[planId, "completed", "closeout"]]);
    assert.equal(scalar(`SELECT type FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`), "trip.outcome_recorded");
  });

  it("a §20.3 answer that corrects it is a new row, never an edit, and the newest row is the crew's last word (TR385, TR382)", () => {
    const r = ok(owner, { type: "RECORD_OUTCOME", idempotency_key: `closeout:answer:${planId}:skipped`, payload: { outcome_type: "skipped", plan_id: planId, occurred_at: "2026-10-02T11:00:00Z", evidence_json: { source: "closeout_answer", question: "Did you make it to Belém?", answered_by: owner } } });
    assert.equal(r.duplicate, false);
    const all = outcomes();
    assert.equal(all.length, 2, "corrections are rows, not updates");
    const latest = latestOutcomeByPlan(all.map((o) => ({ id: o.id, planId: o.plan_id, stageId: null, outcomeType: o.outcome_type, occurredAt: new Date(o.occurred_at).toISOString(), createdAt: new Date(o.created_at).toISOString(), evidence: o.evidence_json })));
    assert.equal(latest.get(planId)?.outcomeType, "skipped");
    assert.equal(latest.get(planId)?.evidence.question, "Did you make it to Belém?");
  });

  it("an outcome outlives the plan it happened in: REMOVE_PLAN leaves both rows, plan_id intact (TR382 — durable)", () => {
    ok(owner, { type: "REMOVE_PLAN", payload: { item_id: planId } });
    assert.notEqual(scalar(`SELECT removed_at::text FROM public.trip_plan_items WHERE id = '${planId}'`), null);
    assert.deepEqual(outcomes().map((o) => [o.plan_id, o.outcome_type]), [[planId, "completed"], [planId, "skipped"]]);
    const malformed = as(owner, { type: "RECORD_OUTCOME", payload: { outcome_type: "teleported", plan_id: planId } });
    assert.equal(malformed.ok, false); assert.equal(malformed.reason, "TRIP_COMMAND_MALFORMED");
  });
});
