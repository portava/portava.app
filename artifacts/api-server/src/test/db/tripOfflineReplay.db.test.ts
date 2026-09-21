/**
 * Trips spec §18.2 / §18.3 / §22.4 on a REAL database — the §23 "offline
 * member for 6h" scenario's server half (census-trips TR421) and "a
 * duplicate command with the same idempotency key cannot produce a duplicate
 * state transition" (TR417).
 *
 *   a member back online replays JOIN_PLAN with the key the queue carried:
 *   one transition, one event, one attendance row; the same operation sent
 *   again returns the receipt (duplicate: true), the version does not move
 *   and no second event exists;
 *   an edit queued against a version the trip has moved past is refused
 *   TRIP_VERSION_CONFLICT and the row it would have overwritten is untouched
 *   — never destructive last-write-wins;
 *   a queue replayed twice in full is idempotent.
 *
 * The HTTP classification (replay / revalidate / reject) is
 * tripOfflineRoute.test.ts; this file is the kernel's half, executed.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("§18 offline replay on the real kernel", { skip: SKIP }, () => {
  let owner = ""; let bob = ""; let tripId = ""; let stageId = ""; let planId = "";
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
  const eventCount = () => Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`));
  const attendance = () => rows<{ attendance_state: string }>(`SELECT attendance_state FROM public.trip_plan_participants WHERE plan_id = '${planId}' AND user_id = '${bob}'`);

  before(() => {
    owner = seedUser("offline_owner"); bob = seedUser("offline_member");
    tripId = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: tripId, payload: { title: "offline", destination_city: "Lisbon", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    stageId = kernel(command({ actor_user_id: owner, trip_id: tripId, type: "ADD_STAGE", payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" } })).result.id;
    planId = kernel(command({ actor_user_id: owner, trip_id: tripId, type: "ADD_PLAN", payload: { title: "Museum", stage_id: stageId, day_date: "2026-10-02", status: "confirmed", starts_at: "2026-10-02T10:00:00Z", ends_at: "2026-10-02T12:00:00Z" } })).result.id;
    assert.equal(kernel(command({ actor_user_id: owner, type: "INVITE_PARTICIPANT", trip_id: tripId, payload: { user_id: bob } })).ok, true);
    assert.equal(kernel(command({ actor_user_id: bob, type: "ACCEPT_INVITE", trip_id: tripId, payload: {} })).ok, true);
  });
  after(() => { for (const u of [owner, bob]) if (u) deleteUser(u); });

  it("TR417: the queued JOIN_PLAN replayed twice with its key is one transition — same version, one event, duplicate: true the second time", () => {
    const key = `queue:${randomUUID()}`;
    const v0 = version(); const e0 = eventCount();
    const first = kernel(command({ actor_user_id: bob, trip_id: tripId, idempotency_key: key, type: "JOIN_PLAN", payload: { plan_id: planId } }));
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.duplicate, false);
    assert.equal(version(), v0 + 1); assert.equal(eventCount(), e0 + 1);
    assert.equal(attendance()[0]?.attendance_state, "going");
    const again = kernel(command({ actor_user_id: bob, trip_id: tripId, idempotency_key: key, type: "JOIN_PLAN", payload: { plan_id: planId } }));
    assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.duplicate, true);
    assert.equal(again.version, first.version, "the receipt's version, not a new one");
    assert.equal(version(), v0 + 1, "the trip did not move"); assert.equal(eventCount(), e0 + 1, "no second event");
  });

  it("TR421: an edit queued against a version the trip has moved past is a conflict and touches nothing", () => {
    // Bob went offline knowing the trip at v_old; the owner moved it on.
    const vOld = version();
    assert.equal(kernel(command({ actor_user_id: owner, trip_id: tripId, type: "UPDATE_TRIP", payload: { title: "offline — renamed while Bob was away" } })).ok, true);
    assert.equal(version(), vOld + 1);
    const stale = kernel(command({ actor_user_id: bob, trip_id: tripId, idempotency_key: `queue:${randomUUID()}`, expected_trip_version: vOld, type: "SET_PLAN_ATTENDANCE", payload: { plan_id: planId, attendance_state: "cant_go" } }));
    assert.equal(stale.ok, false); assert.equal(stale.reason, "TRIP_VERSION_CONFLICT", JSON.stringify(stale));
    assert.equal(stale.current_version, vOld + 1); assert.equal(stale.expected_version, vOld);
    assert.equal(attendance()[0]?.attendance_state, "going", "the stale write overwrote nothing");
    assert.equal(version(), vOld + 1, "and the version did not move");
    // Revalidated against the current version, the same edit lands.
    const fresh = kernel(command({ actor_user_id: bob, trip_id: tripId, idempotency_key: `queue:${randomUUID()}`, expected_trip_version: vOld + 1, type: "SET_PLAN_ATTENDANCE", payload: { plan_id: planId, attendance_state: "cant_go" } }));
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(attendance()[0]?.attendance_state, "cant_go");
  });
});
