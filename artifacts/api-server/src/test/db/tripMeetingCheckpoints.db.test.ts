/**
 * 2794 executed: §10.4 meeting checkpoints on the real kernel.
 *
 * census-trips TR177 ("neither is a crew meeting-checkpoint with participants
 * and arrival state"), TR198 (§11.3 regroup creates a meeting operation),
 * TR329 (§17.4 Safe Return attached to a subgroup context).
 *
 * Run: LOCAL_DB_URL=... node --import tsx/esm --test src/test/db/tripMeetingCheckpoints.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2794 meeting checkpoints", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let bob = ""; let stranger = "";
  let tripId = "";

  const as = (actor: string, over: Record<string, unknown>) => kernel(command({ actor_user_id: actor, trip_id: tripId, ...over }));
  function ok(actor: string, over: Record<string, unknown>) {
    const r = as(actor, over);
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  function refused(reason: string, actor: string, over: Record<string, unknown>) {
    const r = as(actor, over);
    assert.equal(r.ok, false, `${String(over["type"])} was ACCEPTED: ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, JSON.stringify(r));
    return r;
  }
  const lastEvent = () => rows<{ type: string; payload_json: any }>(`SELECT type, payload_json FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`)[0]!;
  const parts = (cp: string) => rows<{ user_id: string; arrival_state: string; arrived: boolean }>(`SELECT user_id, arrival_state, (arrived_at IS NOT NULL) AS arrived FROM public.trip_meeting_checkpoint_participants WHERE checkpoint_id = '${cp}' ORDER BY user_id`);
  const POINT = { label: "Fountain at the plaza", lat: 10.3157, lng: 123.8854 };

  before(() => {
    owner = seedUser("cp_owner"); alice = seedUser("cp_alice"); bob = seedUser("cp_bob"); stranger = seedUser("cp_stranger");
    tripId = randomUUID();
    ok(owner, { type: "CREATE_TRIP", payload: { title: "regroup", destination_city: "Cebu", destination_country: "Philippines", visibility: "private" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: bob, role: "member" } });
  });
  after(() => { for (const u of [owner, alice, bob, stranger]) if (u) deleteUser(u); });

  it("CREATE_MEETING_CHECKPOINT: a chosen point with its explanation; every participant must be accepted crew; the whole crew by default (TR177)", () => {
    refused("TRIP_AUTH_NOT_CREW", stranger, { type: "CREATE_MEETING_CHECKPOINT", payload: POINT });
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { label: "no point" } });
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, lat: 95 } });
    refused("TRIP_COMMAND_MALFORMED", alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, purpose: "party" } });
    refused("TRIP_MEETING_PARTICIPANT_NOT_CREW", alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, participant_ids: [stranger] } });
    const r = ok(alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, explanation: { recommended: "fountain", alternatives: ["cafe"] } } });
    assert.deepEqual(new Set(r.result.participant_ids), new Set([owner, alice, bob]), "no participants named: the whole accepted crew, owner included");
    assert.equal(r.result.purpose, "regroup");
    const ev = lastEvent();
    assert.equal(ev.type, "trip.meeting_checkpoint_created");
    assert.equal(ev.payload_json.family, "meeting");
    assert.deepEqual(parts(r.result.id).map((p) => p.arrival_state), ["pending", "pending", "pending"]);
    assert.equal(scalar(`SELECT status FROM public.trip_meeting_checkpoints WHERE id = '${r.result.id}'`), "open");
    assert.equal(scalar(`SELECT explanation->>'recommended' FROM public.trip_meeting_checkpoints WHERE id = '${r.result.id}'`), "fountain");
  });

  it("SET_MEETING_ARRIVAL: a participant's own state, dated when arrived; a non-participant is refused (TR177)", () => {
    const cp = ok(alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, participant_ids: [bob] } }).result;
    assert.deepEqual(new Set(cp.participant_ids), new Set([alice, bob]), "the caller is always a participant");
    refused("TRIP_MEETING_NOT_PARTICIPANT", owner, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "arrived" } });
    refused("TRIP_COMMAND_MALFORMED", bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "teleported" } });
    refused("TRIP_MEETING_NOT_FOUND", bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: randomUUID(), arrival_state: "arrived" } });
    ok(bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "en_route" } });
    assert.deepEqual(parts(cp.id).find((p) => p.user_id === bob), { user_id: bob, arrival_state: "en_route", arrived: false });
    ok(bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "arrived" } });
    assert.deepEqual(parts(cp.id).find((p) => p.user_id === bob), { user_id: bob, arrival_state: "arrived", arrived: true });
    assert.equal(lastEvent().type, "trip.meeting_arrival_set");
    ok(bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "late" } });
    assert.deepEqual(parts(cp.id).find((p) => p.user_id === bob), { user_id: bob, arrival_state: "late", arrived: false }, "leaving arrived clears the instant (CHECK)");
  });

  it("CLOSE_MEETING_CHECKPOINT: creator or host, only from open; closing reports who arrived; arrival after close is refused", () => {
    const cp = ok(alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, participant_ids: [bob] } }).result;
    refused("TRIP_AUTH_NOT_HOST", bob, { type: "CLOSE_MEETING_CHECKPOINT", payload: { checkpoint_id: cp.id } });
    ok(bob, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "arrived" } });
    const closed = ok(owner, { type: "CLOSE_MEETING_CHECKPOINT", payload: { checkpoint_id: cp.id } });
    assert.equal(closed.result.outcome, "met"); assert.equal(closed.result.arrived, 1); assert.equal(closed.result.expected, 2);
    assert.equal(lastEvent().type, "trip.meeting_checkpoint_closed");
    assert.equal(scalar(`SELECT status FROM public.trip_meeting_checkpoints WHERE id = '${cp.id}'`), "met");
    assert.equal(scalar(`SELECT (closed_at IS NOT NULL)::text FROM public.trip_meeting_checkpoints WHERE id = '${cp.id}'`), "true");
    refused("TRIP_MEETING_INVALID_TRANSITION", owner, { type: "CLOSE_MEETING_CHECKPOINT", payload: { checkpoint_id: cp.id } });
    refused("TRIP_MEETING_INVALID_TRANSITION", alice, { type: "SET_MEETING_ARRIVAL", payload: { checkpoint_id: cp.id, arrival_state: "arrived" } });
    const cancelled = ok(alice, { type: "CREATE_MEETING_CHECKPOINT", payload: POINT }).result;
    assert.equal(ok(alice, { type: "CLOSE_MEETING_CHECKPOINT", payload: { checkpoint_id: cancelled.id, outcome: "cancelled" } }).result.outcome, "cancelled", "the creator closes their own");
  });

  it("a subgroup checkpoint: an active subgroup the actor is in; its current members by default (§9.2, TR329's context)", () => {
    const g = ok(alice, { type: "CREATE_SUBGROUP", payload: { name: "Night owls", member_ids: [bob] } }).result.id;
    refused("TRIP_SUBGROUP_NOT_FOUND", alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, subgroup_id: randomUUID() } });
    refused("TRIP_SUBGROUP_NOT_MEMBER", owner, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, subgroup_id: g } });
    const cp = ok(alice, { type: "CREATE_MEETING_CHECKPOINT", payload: { ...POINT, subgroup_id: g, purpose: "safety", meet_at: "2026-10-02T23:30:00Z" } }).result;
    assert.deepEqual(new Set(cp.participant_ids), new Set([alice, bob]), "the subgroup's members, not the owner");
    assert.equal(cp.subgroup_id, g); assert.equal(cp.purpose, "safety"); assert.equal(cp.meet_at, "2026-10-02T23:30:00Z");
    // §17.4: a Safe Return attached to the same subgroup context
    exec(`SET LOCAL ROLE service_role; INSERT INTO public.safe_return_sessions (user_id, trip_id, subgroup_id, status, notify_trip_crew_enabled) VALUES ('${bob}', '${tripId}', '${g}', 'active', true);`, { single: true });
    assert.equal(scalar(`SELECT subgroup_id FROM public.safe_return_sessions WHERE user_id = '${bob}' AND trip_id = '${tripId}'`), g);
    let threw = "";
    try { exec(`SET LOCAL ROLE service_role; INSERT INTO public.safe_return_sessions (user_id, trip_id, subgroup_id, status) VALUES ('${alice}', NULL, '${g}', 'pending');`, { single: true }); } catch (e) { threw = String((e as Error).message); }
    assert.match(threw, /safe_return_sessions_subgroup_needs_trip/, "a subgroup context without a trip is refused by the CHECK");
  });

  it("the tables have no client writer: authenticated cannot INSERT, and RLS is on", () => {
    assert.equal(scalar(`SELECT has_table_privilege('authenticated', 'public.trip_meeting_checkpoints', 'INSERT')::text`), "false");
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.trip_meeting_checkpoint_participants'::regclass`), "true");
  });
});
