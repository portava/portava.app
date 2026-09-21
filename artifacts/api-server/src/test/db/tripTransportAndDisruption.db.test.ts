/**
 * 2782 + 2785 executed: §15.1 TransportSegment with its state machine, §17.2
 * disruptions, §8.4 at-risk commitments and the §4.2 derived events —
 * commitment_at_risk, free_window_created, trip_disrupted — on the real kernel.
 *
 * census-trips TR18, TR61/TR62/TR65/TR66, TR283–TR287, TR302, TR420, TR448.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2782 transport segments and 2785 disruptions / derived events", { skip: SKIP }, () => {
  let owner = ""; let stranger = ""; let tripId = ""; let stageId = ""; let commitmentId = "";
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
  const lastEvent = () => rows<{ type: string; payload_json: any; aggregate_version: number }>(`SELECT type, payload_json, aggregate_version::int FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
  const eventTypes = () => rows<{ type: string }>(`SELECT type FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version`).map((e) => e.type);

  before(() => {
    owner = seedUser("tx_owner"); stranger = seedUser("tx_stranger");
    tripId = randomUUID();
    ok({ type: "CREATE_TRIP", payload: { title: "transit", destination_city: "Zürich", destination_country: "Switzerland", visibility: "private" } });
    stageId = ok({ type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Zurich", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } }).result.id;
    commitmentId = ok({ type: "ADD_COMMITMENT", payload: { type: "transport", stage_id: stageId, starts_at: "2026-10-02T19:00:00Z", required_arrival_at: "2026-10-02T18:40:00Z" } }).result.id;
  });
  after(() => { for (const u of [owner, stranger]) if (u) deleteUser(u); });

  it("ADD_TRANSPORT_SEGMENT: mode, the planned pair, party size, reliability, cost (TR18, TR283, TR286, TR287)", () => {
    refused("TRIP_COMMAND_MALFORMED", { type: "ADD_TRANSPORT_SEGMENT", payload: { planned_departure_at: "2026-10-02T17:00:00Z" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "teleport" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", planned_departure_at: "2026-10-02T17:00:00Z", planned_arrival_at: "2026-10-02T16:00:00Z" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", reliability: 1.5 } });
    refused("TRIP_STAGE_NOT_FOUND", { type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", stage_id: randomUUID() } });
    const r = ok({ type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", stage_id: stageId, from_label: "Zürich HB", to_label: "Bern", planned_departure_at: "2026-10-02T17:02:00Z", planned_arrival_at: "2026-10-02T17:58:00Z", party_size: 4, reliability: 0.93, cost_minor: 5200, currency: "CHF", booking_ref: "SBB-1" } });
    assert.equal(r.result.state, "planned");
    assert.equal(r.result.party_size, 4);
    assert.equal(Number(r.result.reliability), 0.93);
    assert.equal(lastEvent().type, "trip.transport_segment_added");
    assert.equal(lastEvent().payload_json.family, "transport");
  });

  it("SET_TRANSPORT_STATE: the §15.1 machine — planned → booked → waiting → in_progress → completed; illegal arrows refused by name (TR284)", () => {
    const seg = ok({ type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "bus", from_label: "A", to_label: "B" } }).result.id;
    refused("TRIP_TRANSPORT_INVALID_TRANSITION", { type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: "completed" } });
    refused("TRIP_TRANSPORT_NOT_FOUND", { type: "SET_TRANSPORT_STATE", payload: { segment_id: randomUUID(), state: "booked" } });
    for (const [to, field] of [["booked", null], ["waiting", null], ["in_progress", "actual_departure_at"], ["completed", "actual_arrival_at"]] as const) {
      const r = ok({ type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: to } });
      assert.equal(r.result.state, to);
      if (field) assert.ok(r.result[field], `${to} did not stamp ${field}`);
      assert.equal(lastEvent().type, "trip.transport_segment_state_changed");
    }
    refused("TRIP_TRANSPORT_INVALID_TRANSITION", { type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: "disrupted" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "UPDATE_TRANSPORT_SEGMENT", payload: { segment_id: seg, patch: { state: "planned" } } });
  });

  it("DISRUPTED from any non-terminal state, then a fallback segment stands in (TR285, TR302)", () => {
    const seg = ok({ type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "flight", from_label: "ZRH", to_label: "LIS", reliability: 0.8 } }).result.id;
    ok({ type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: "booked" } });
    const d = ok({ type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: "disrupted", note: "cancelled by carrier" } });
    assert.equal(d.result.disruption_note, "cancelled by carrier");
    assert.equal(d.result.from, "booked");
    const fallback = ok({ type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", from_label: "ZRH", to_label: "LIS", fallback_of: seg } }).result;
    assert.equal(fallback.fallback_of, seg);
    refused("TRIP_TRANSPORT_NOT_FOUND", { type: "ADD_TRANSPORT_SEGMENT", payload: { mode: "train", fallback_of: randomUUID() } });
    ok({ type: "SET_TRANSPORT_STATE", payload: { segment_id: seg, state: "cancelled" } });
    ok({ type: "REMOVE_TRANSPORT_SEGMENT", payload: { segment_id: seg } });
    assert.equal(scalar(`SELECT fallback_of::text FROM public.trip_transport_segments WHERE id = '${fallback.id}'`), null, "removing the original leaves the fallback standing, unlinked");
    assert.equal(lastEvent().type, "trip.transport_segment_removed");
  });

  it("DECLARE_DISRUPTION → trip.trip_disrupted; RESOLVE_DISRUPTION → trip.disruption_resolved; resolving twice is TRIP_DISRUPTION_NOT_ACTIVE (TR66, TR448)", () => {
    refused("TRIP_COMMAND_MALFORMED", { type: "DECLARE_DISRUPTION", payload: { kind: "weather" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "DECLARE_DISRUPTION", payload: { kind: "volcano", severity: "major" } });
    const r = ok({ type: "DECLARE_DISRUPTION", payload: { kind: "transport", severity: "critical", note: "rail strike", affected: [commitmentId] } });
    assert.equal(lastEvent().type, "trip.trip_disrupted");
    assert.equal(lastEvent().payload_json.family, "disruption");
    assert.deepEqual(lastEvent().payload_json.result.affected, [commitmentId]);
    assert.equal(scalar(`SELECT state FROM public.trip_disruptions WHERE id = '${r.result.id}'`), "active");
    refused("TRIP_DISRUPTION_NOT_FOUND", { type: "RESOLVE_DISRUPTION", payload: { disruption_id: randomUUID() } });
    ok({ type: "RESOLVE_DISRUPTION", payload: { disruption_id: r.result.id, note: "trains running" } });
    assert.equal(lastEvent().type, "trip.disruption_resolved");
    assert.equal(scalar(`SELECT state || '/' || note FROM public.trip_disruptions WHERE id = '${r.result.id}'`), "resolved/trains running");
    refused("TRIP_DISRUPTION_NOT_ACTIVE", { type: "RESOLVE_DISRUPTION", payload: { disruption_id: r.result.id } });
    const stranger_r = kernel(command({ actor_user_id: stranger, trip_id: tripId, type: "DECLARE_DISRUPTION", payload: { kind: "safety", severity: "minor" } }));
    assert.equal(stranger_r.reason, "TRIP_AUTH_NOT_CREW");
  });

  it("MARK_COMMITMENT_AT_RISK → trip.commitment_at_risk carried on the row; CLEAR → trip.commitment_risk_cleared; a repeat mark by key is a duplicate (TR61, TR65)", () => {
    refused("TRIP_COMMITMENT_NOT_FOUND", { type: "MARK_COMMITMENT_AT_RISK", payload: { commitment_id: randomUUID(), reason: "TRIP_TEMPORAL_CONFLICT" } });
    refused("TRIP_COMMAND_MALFORMED", { type: "MARK_COMMITMENT_AT_RISK", payload: { commitment_id: commitmentId } });
    const key = `at-risk:${commitmentId}:TRIP_TEMPORAL_CONFLICT`;
    const first = ok({ type: "MARK_COMMITMENT_AT_RISK", idempotency_key: key, payload: { commitment_id: commitmentId, reason: "TRIP_TEMPORAL_CONFLICT", shortfall_minutes: 12, source: "TripHealth" } });
    assert.equal(lastEvent().type, "trip.commitment_at_risk");
    assert.equal(lastEvent().payload_json.family, "commitment");
    assert.equal(lastEvent().payload_json.result.shortfall_minutes, 12);
    assert.equal(scalar(`SELECT at_risk_reason || '/' || at_risk_shortfall_minutes FROM public.trip_commitments WHERE id = '${commitmentId}'`), "TRIP_TEMPORAL_CONFLICT/12");
    const again = ok({ type: "MARK_COMMITMENT_AT_RISK", idempotency_key: key, payload: { commitment_id: commitmentId, reason: "TRIP_TEMPORAL_CONFLICT", shortfall_minutes: 12 } });
    assert.equal(again.duplicate, true);
    assert.equal(again.version, first.version, "re-detection by the same key must not churn the aggregate");
    ok({ type: "CLEAR_COMMITMENT_RISK", payload: { commitment_id: commitmentId } });
    assert.equal(lastEvent().type, "trip.commitment_risk_cleared");
    assert.equal(scalar(`SELECT at_risk_reason FROM public.trip_commitments WHERE id = '${commitmentId}'`), null);
  });

  it("OPEN_FREE_WINDOW is an event whose identity is its key: trip.free_window_created once, a duplicate on re-detection, an inverted window refused (TR62)", () => {
    const key = `free-window:${tripId}:2026-10-02T13:00:00Z`;
    const r = ok({ type: "OPEN_FREE_WINDOW", idempotency_key: key, payload: { window_id: "w-1", begins_at: "2026-10-02T13:00:00Z", ends_at: "2026-10-02T16:00:00Z", duration_minutes: 180, position: "between", certified: false } });
    assert.equal(lastEvent().type, "trip.free_window_created");
    assert.equal(lastEvent().payload_json.family, "freedom");
    assert.equal(lastEvent().payload_json.result.duration_minutes, 180);
    const again = ok({ type: "OPEN_FREE_WINDOW", idempotency_key: key, payload: { window_id: "w-1", begins_at: "2026-10-02T13:00:00Z", ends_at: "2026-10-02T16:00:00Z" } });
    assert.equal(again.duplicate, true);
    assert.equal(again.event_id, r.event_id);
    refused("TRIP_TEMPORAL_RANGE_INVERTED", { type: "OPEN_FREE_WINDOW", payload: { begins_at: "2026-10-02T16:00:00Z", ends_at: "2026-10-02T13:00:00Z" } });
    const types = eventTypes();
    for (const t of ["trip.trip_disrupted", "trip.commitment_at_risk", "trip.free_window_created", "trip.transport_segment_state_changed"]) {
      assert.ok(types.includes(t), `${t} was never emitted in this trip's history`);
    }
  });

  it("the engine capability: actor_role 'system' with no user may MARK / CLEAR / OPEN (recorded with a null actor); it may not DECLARE a disruption or add a plan", () => {
    const sys = (over: Record<string, unknown>) => kernel(command({ actor_user_id: null, actor_role: "system", trip_id: tripId, ...over }));
    const r = sys({ type: "MARK_COMMITMENT_AT_RISK", idempotency_key: `engine:${commitmentId}:FEASIBILITY_INFEASIBLE`, payload: { commitment_id: commitmentId, reason: "FEASIBILITY_INFEASIBLE", shortfall_minutes: 5, source: "TripHealth" } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const ev = rows<{ type: string; actor_user_id: string | null; actor_role: string }>(`SELECT type, actor_user_id, actor_role FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
    assert.deepEqual(ev, { type: "trip.commitment_at_risk", actor_user_id: null, actor_role: "system" });
    assert.equal(sys({ type: "CLEAR_COMMITMENT_RISK", payload: { commitment_id: commitmentId } }).ok, true);
    assert.equal(sys({ type: "OPEN_FREE_WINDOW", payload: { begins_at: "2026-10-03T09:00:00Z", ends_at: "2026-10-03T11:00:00Z" } }).ok, true);
    assert.equal(sys({ type: "DECLARE_DISRUPTION", payload: { kind: "weather", severity: "minor" } }).reason, "TRIP_AUTH_ROLE_NOT_PERMITTED");
    assert.equal(sys({ type: "ADD_PLAN", payload: { title: "no", stage_id: stageId, day_date: "2026-10-02" } }).reason, "TRIP_AUTH_ROLE_NOT_PERMITTED");
    // a stranger under the user role is still not crew for an engine command
    const stranger_r = kernel(command({ actor_user_id: stranger, trip_id: tripId, type: "OPEN_FREE_WINDOW", payload: { begins_at: "2026-10-03T09:00:00Z", ends_at: "2026-10-03T11:00:00Z" } }));
    assert.equal(stranger_r.reason, "TRIP_AUTH_NOT_CREW");
  });

  it("RLS: crew read segments and disruptions; a stranger reads none", () => {
    assert.ok(Number(asUser(owner, `SELECT count(*) FROM public.trip_transport_segments WHERE trip_id = '${tripId}';`)[0]) >= 1);
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_transport_segments WHERE trip_id = '${tripId}';`)[0]), 0);
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_disruptions WHERE trip_id = '${tripId}';`)[0]), 0);
    assert.ok(Number(asUser(owner, `SELECT count(*) FROM public.trip_disruptions WHERE trip_id = '${tripId}';`)[0]) >= 1);
  });
});
