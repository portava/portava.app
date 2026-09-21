/**
 * 2779 executed: §3.3's IN_PROGRESS / MOVED / SKIPPED, §7.2 refused AT THE
 * WRITE with the override recorded, and §4.2's stage_started — on the real
 * kernel, not on a reading of it.
 *
 * census-trips TR46 ("four stored states of nine"), TR55 ("validates dependent
 * commitments — N"), TR61/TR62 ("stage_started has zero occurrences"), TR129
 * ("no override path") and TR194 ("START_PLAN → IN_PROGRESS needs a kernel
 * migration this environment cannot run"). Each assertion below is one of
 * those sentences made false or kept true by executing the command.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2779 plan lifecycle, MOVED, the §7.2 write-time guard and stage lifecycle", { skip: SKIP }, () => {
  let owner = "";
  let tripId = "";
  let stageId = "";

  function ok(over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, trip_id: tripId, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  function refused(reason: string, over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, trip_id: tripId, ...over }));
    assert.equal(r.ok, false, `${String(over["type"])} was ACCEPTED: ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, JSON.stringify(r));
    return r;
  }
  function addPlan(title: string, status: string, startsAt?: string, endsAt?: string): string {
    const r = ok({ type: "ADD_PLAN", payload: { title, stage_id: stageId, day_date: "2026-10-02", status, starts_at: startsAt ?? null, ends_at: endsAt ?? null } });
    return r.result.id;
  }
  function planRow(id: string) {
    return rows<{ status: string; version: number }>(`SELECT status, version::int FROM public.trip_plan_items WHERE id = '${id}'`)[0]!;
  }
  function lastEvent() {
    return rows<{ type: string; payload_json: any }>(`SELECT type, payload_json FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
  }

  before(() => {
    owner = seedUser("lifecycle_owner");
    tripId = randomUUID();
    kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: tripId, payload: { title: "lifecycle", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } }));
    stageId = ok({ type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }).result.id;
  });
  after(() => { if (owner) deleteUser(owner); });

  it("START_PLAN: confirmed → in_progress, event trip.plan_started, plan version bumped (TR194)", () => {
    const id = addPlan("Museum", "confirmed");
    const v0 = planRow(id).version;
    const r = ok({ type: "START_PLAN", payload: { item_id: id } });
    assert.equal(r.result.status, "in_progress");
    assert.deepEqual(planRow(id), { status: "in_progress", version: v0 + 1 });
    assert.equal(lastEvent().type, "trip.plan_started");
    // and on to COMPLETED through the existing command
    ok({ type: "COMPLETE_ACTIVITY", payload: { item_id: id, patch: { status: "done" } } });
    assert.equal(planRow(id).status, "done");
  });

  it("START_PLAN out of a terminal state is TRIP_PLAN_INVALID_TRANSITION; the plan version does not move", () => {
    const id = addPlan("Finished", "done");
    const v0 = planRow(id).version;
    refused("TRIP_PLAN_INVALID_TRANSITION", { type: "START_PLAN", payload: { item_id: id } });
    assert.equal(planRow(id).version, v0);
  });

  it("SKIP_PLAN: tentative → skipped with trip.plan_skipped; skipped is terminal (a second SKIP and a START are both refused)", () => {
    const id = addPlan("Maybe", "tentative");
    ok({ type: "SKIP_PLAN", payload: { item_id: id } });
    assert.equal(planRow(id).status, "skipped");
    assert.equal(lastEvent().type, "trip.plan_skipped");
    refused("TRIP_PLAN_INVALID_TRANSITION", { type: "SKIP_PLAN", payload: { item_id: id } });
    refused("TRIP_PLAN_INVALID_TRANSITION", { type: "START_PLAN", payload: { item_id: id } });
    // and 2772's plan-level optimistic concurrency applies to the new commands too
    const id2 = addPlan("Versioned", "tentative");
    refused("TRIP_PLAN_VERSION_CONFLICT", { type: "SKIP_PLAN", payload: { item_id: id2, expected_plan_version: 99 } });
  });

  it("MOVE_PLAN leaves a CONFIRMED plan MOVED and a tentative one tentative (TR46)", () => {
    const confirmed = addPlan("Dinner", "confirmed", "2026-10-02T18:00:00Z", "2026-10-02T19:00:00Z");
    ok({ type: "MOVE_PLAN", payload: { item_id: confirmed, patch: { starts_at: "2026-10-02T20:00:00Z", ends_at: "2026-10-02T21:00:00Z" } } });
    assert.equal(planRow(confirmed).status, "moved");
    assert.equal(lastEvent().type, "trip.plan_moved");
    ok({ type: "CONFIRM_PLAN", payload: { item_id: confirmed, patch: { status: "confirmed" } } });
    assert.equal(planRow(confirmed).status, "confirmed", "a moved plan can be confirmed again");
    const tentative = addPlan("Walk", "tentative", "2026-10-02T10:00:00Z", "2026-10-02T11:00:00Z");
    ok({ type: "MOVE_PLAN", payload: { item_id: tentative, patch: { starts_at: "2026-10-02T12:00:00Z", ends_at: "2026-10-02T13:00:00Z" } } });
    assert.equal(planRow(tentative).status, "tentative");
    // Moving only starts_at past ends_at inverts the interval. The first draft of
    // 2779's guard THREW on that (tstzrange refuses an inverted range) — the
    // harness found it — so the guard must survive it and the plan's own
    // interval CHECK must be what refuses, as TRIP_COMMAND_MALFORMED.
    refused("TRIP_COMMAND_MALFORMED", { type: "MOVE_PLAN", payload: { item_id: tentative, patch: { starts_at: "2026-10-02T14:00:00Z" } } });
    assert.equal(scalar(`SELECT starts_at::text FROM public.trip_plan_items WHERE id = '${tentative}'`), "2026-10-02 12:00:00+00");
  });

  it("§7.2 at the write: a move into a commitment's approach window is TRIP_TEMPORAL_CONFLICT naming the commitment; nothing changes (TR55)", () => {
    // Train at 19:00, be there by 18:45, 30 min of prep: approach window 18:15–19:00.
    const commitment = ok({ type: "ADD_COMMITMENT", payload: { type: "transport", stage_id: stageId, starts_at: "2026-10-02T19:00:00Z", required_arrival_at: "2026-10-02T18:45:00Z", prep_duration: "30 minutes", lateness_tolerance: "0 minutes" } }).result.id;
    const plan = addPlan("Coffee", "confirmed", "2026-10-02T15:00:00Z", "2026-10-02T15:30:00Z");
    const r = refused("TRIP_TEMPORAL_CONFLICT", { type: "MOVE_PLAN", payload: { item_id: plan, patch: { starts_at: "2026-10-02T18:30:00Z", ends_at: "2026-10-02T18:50:00Z" } } });
    assert.equal(r.commitment_id, commitment);
    assert.equal(scalar(`SELECT starts_at::text FROM public.trip_plan_items WHERE id = '${plan}'`), "2026-10-02 15:00:00+00");
    // A move that ends before the window opens is fine.
    ok({ type: "MOVE_PLAN", payload: { item_id: plan, patch: { starts_at: "2026-10-02T17:30:00Z", ends_at: "2026-10-02T18:10:00Z" } } });
  });

  it("§7.2 override: override_conflicts: true applies the move and the EVENT records the commitment and overridden: true (TR129)", () => {
    const commitment = ok({ type: "ADD_COMMITMENT", payload: { type: "event", stage_id: stageId, starts_at: "2026-10-03T21:00:00Z", required_arrival_at: "2026-10-03T20:45:00Z", prep_duration: "15 minutes" } }).result.id;
    const plan = addPlan("Drinks", "tentative", "2026-10-03T17:00:00Z", "2026-10-03T18:00:00Z");
    const r = ok({ type: "MOVE_PLAN", override_conflicts: true, payload: { item_id: plan, patch: { starts_at: "2026-10-03T20:30:00Z", ends_at: "2026-10-03T21:30:00Z" }, override_conflicts: true } });
    assert.deepEqual(r.result.temporal_conflict, { commitment_id: commitment, overridden: true, reason: "TRIP_TEMPORAL_CONFLICT" });
    const ev = lastEvent();
    assert.equal(ev.type, "trip.plan_moved");
    assert.equal(ev.payload_json.result.temporal_conflict.overridden, true, "the override is not on the event");
    assert.equal(ev.payload_json.result.temporal_conflict.commitment_id, commitment);
  });

  it("START_STAGE / COMPLETE_STAGE: planned → active → completed with trip.stage_started / trip.stage_completed; out-of-order is TRIP_STAGE_INVALID_TRANSITION (TR61/TR62)", () => {
    const stage = ok({ type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 2, starts_at: "2026-10-04T08:00:00Z", ends_at: "2026-10-05T20:00:00Z" } }).result.id;
    refused("TRIP_STAGE_INVALID_TRANSITION", { type: "COMPLETE_STAGE", payload: { stage_id: stage } });
    ok({ type: "START_STAGE", payload: { stage_id: stage } });
    assert.equal(scalar(`SELECT state FROM public.trip_stages WHERE id = '${stage}'`), "active");
    const ev = lastEvent();
    assert.equal(ev.type, "trip.stage_started");
    assert.equal(ev.payload_json.family, "stage", "a stage event filed under the wrong family");
    refused("TRIP_STAGE_INVALID_TRANSITION", { type: "START_STAGE", payload: { stage_id: stage } });
    ok({ type: "COMPLETE_STAGE", payload: { stage_id: stage } });
    assert.equal(scalar(`SELECT state FROM public.trip_stages WHERE id = '${stage}'`), "completed");
    assert.equal(lastEvent().type, "trip.stage_completed");
    refused("TRIP_STAGE_NOT_FOUND", { type: "START_STAGE", payload: { stage_id: randomUUID() } });
  });

  it("the §3.3 vocabulary is a validated CHECK: a status outside it cannot be stored by any writer", () => {
    const id = addPlan("Guarded", "tentative");
    let threw = "";
    try { exec(`SET LOCAL ROLE service_role; UPDATE public.trip_plan_items SET status = 'bogus' WHERE id = '${id}';`, { single: true }); }
    catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /trip_plan_items_status_known/);
    assert.equal(planRow(id).status, "tentative");
  });
});
