/**
 * tripMembership — the role-based checks the intel group signal uses: is the actor
 * an accepted member, how many distinct members does a trip have, and is it a
 * SHARED crew (≥2). The shared-crew gate is what stops a solo trip from minting a
 * per-person crew key (which would split a crew — the leak the signal prevents).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAcceptedTripMember,
  acceptedCrewSize,
  isSharedCrewMember,
  readAcceptedTripMembership,
  readAcceptedCrewSize,
  readSharedCrewMembership,
} from "../domain/trips/invariants/tripMembership.js";

/** trips(id, owner_id) + trip_members(trip_id, user_id, role); eq / in / maybeSingle / list. */
function makeDb(cfg: { trips?: { id: string; owner_id: string }[]; members?: { trip_id: string; user_id: string; role: string }[]; error?: boolean; errorTables?: string[] }) {
  function from(table: string) {
    const failing = Boolean(cfg.error) || (cfg.errorTables ?? []).includes(table);
    const eqs: [string, any][] = [];
    const ins: [string, any[]][] = [];
    const rows = (): any[] => {
      const src = table === "trips" ? cfg.trips ?? [] : table === "trip_members" ? cfg.members ?? [] : [];
      return src.filter((r: any) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, v]) => v.includes(r[c])));
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      maybeSingle() { return Promise.resolve(failing ? { data: null, error: { message: "boom" } } : { data: rows()[0] ?? null, error: null }); },
      then(res: (r: any) => any) { return Promise.resolve(failing ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(res); },
    };
    return b;
  }
  return { from };
}

const trip = (id: string, owner: string) => ({ id, owner_id: owner });
const mem = (trip_id: string, user_id: string, role = "member") => ({ trip_id, user_id, role });

describe("tripMembership.isAcceptedTripMember", () => {
  it("accepts owner and accepted member; rejects invitee, non-member, error, missing", async () => {
    assert.equal(await isAcceptedTripMember(makeDb({ trips: [trip("t", "u1")] }), "t", "u1"), true);
    assert.equal(await isAcceptedTripMember(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u2")] }), "t", "u2"), true);
    assert.equal(await isAcceptedTripMember(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u3", "invited")] }), "t", "u3"), false);
    assert.equal(await isAcceptedTripMember(makeDb({ trips: [trip("t", "o")], members: [] }), "t", "stranger"), false);
    assert.equal(await isAcceptedTripMember(makeDb({ error: true }), "t", "u1"), false);
    assert.equal(await isAcceptedTripMember(null, "t", "u1"), false);
  });
});

describe("tripMembership.acceptedCrewSize", () => {
  it("counts DISTINCT accepted members (owner + role owner/member), ignoring invitees", async () => {
    assert.equal(await acceptedCrewSize(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u2")] }), "t"), 2);
    assert.equal(await acceptedCrewSize(makeDb({ trips: [trip("t", "o")], members: [] }), "t"), 1, "owner alone");
    assert.equal(await acceptedCrewSize(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u3", "invited")] }), "t"), 1, "invitee not counted");
    assert.equal(await acceptedCrewSize(makeDb({ trips: [trip("t", "o")], members: [mem("t", "o", "owner")] }), "t"), 1, "owner not double-counted");
    assert.equal(await acceptedCrewSize(makeDb({ error: true }), "t"), 0);
  });
});

describe("tripMembership.isSharedCrewMember", () => {
  it("true only for a member of a SHARED (≥2-member) crew", async () => {
    const shared = makeDb({ trips: [trip("t", "o")], members: [mem("t", "u2")] });
    assert.equal(await isSharedCrewMember(shared, "t", "o"), true, "owner of a 2-member crew");
    assert.equal(await isSharedCrewMember(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u2")] }), "t", "u2"), true, "the member");
    assert.equal(await isSharedCrewMember(makeDb({ trips: [trip("solo", "u1")], members: [] }), "solo", "u1"), false, "solo trip is not a crew");
    assert.equal(await isSharedCrewMember(makeDb({ trips: [trip("t", "o")], members: [mem("t", "u2")] }), "t", "stranger"), false, "non-member");
  });
});

// ── DENY IS NOT UNKNOWN (census-trips §70.6) ────────────────────────────────
//
// These booleans answered `false` both to "not a member" and to "the roster
// could not be read", because supabase-js RESOLVES on a database error and
// `const { data } = await ...` discarded it. The booleans STILL answer false on
// an unread roster — fail-closed is right about authorization and is not what
// changed — but the distinction now exists for a caller that needs it, and the
// crew-token caller is exactly such a caller: this file's own header says a
// wrong `false` there is "a SPLIT, i.e. the exact leak the crew signal exists
// to prevent".
describe("tripMembership — an unreadable roster is not a finding", () => {
  const CREW = { trips: [trip("t", "o")], members: [mem("t", "u2")] };

  it("readAcceptedTripMembership separates 'not a member' from 'could not tell'", async () => {
    // CONTROLS FIRST: both of these are readable, and one of them is false.
    assert.deepEqual(
      await readAcceptedTripMembership(makeDb(CREW), "t", "u2"),
      { readable: true, member: true },
    );
    assert.deepEqual(
      await readAcceptedTripMembership(makeDb(CREW), "t", "stranger"),
      { readable: true, member: false },
      "a read roster that does not list you is a finding",
    );
    // The two failure shapes, separately: the owner read and the member read.
    assert.deepEqual(
      await readAcceptedTripMembership(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t", "u2"),
      { readable: false, member: false },
    );
    assert.deepEqual(
      await readAcceptedTripMembership(makeDb({ ...CREW, errorTables: ["trips"] }), "t", "u2"),
      { readable: false, member: false },
      "an unread owner row is half the answer, and the half that was read cannot stand alone",
    );
  });

  it("readAcceptedCrewSize never reports a fail-closed zero as a measurement", async () => {
    assert.deepEqual(await readAcceptedCrewSize(makeDb(CREW), "t"), { readable: true, size: 2 });
    assert.deepEqual(
      await readAcceptedCrewSize(makeDb({ trips: [trip("solo", "u1")], members: [] }), "solo"),
      { readable: true, size: 1 },
      "a genuinely solo trip is a measured 1",
    );
    assert.deepEqual(await readAcceptedCrewSize(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t"), { readable: false, size: 0 });
    assert.deepEqual(
      await readAcceptedCrewSize(makeDb({ ...CREW, errorTables: ["trips"] }), "t"),
      { readable: false, size: 0 },
      "an unread trips row silently dropped the OWNER from the set, so a 2-crew counted 1",
    );
  });

  it("readSharedCrewMembership tells a solo trip from a crew nobody could read", async () => {
    // The two answers the intel signal must treat differently. Both are
    // `member: false`; only one of them is a fact about the trip.
    const solo = await readSharedCrewMembership(makeDb({ trips: [trip("solo", "u1")], members: [] }), "solo", "u1");
    assert.deepEqual(solo, { readable: true, member: false }, "a solo trip is a MEASURED non-crew");

    const unread = await readSharedCrewMembership(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t", "u2");
    assert.deepEqual(unread, { readable: false, member: false }, "an unreadable crew is not a solo trip");
    assert.notEqual(unread.readable, solo.readable, "the two must not be the same answer");

    assert.deepEqual(
      await readSharedCrewMembership(makeDb(CREW), "t", "u2"),
      { readable: true, member: true },
      "CONTROL — a readable two-person crew still honours the token",
    );
  });

  it("the OWNER path reaches the crew-size read, and an unread size is not a size", async () => {
    // WHY THIS CASE EXISTS, STATED RATHER THAN IMPLIED. Mutation Q4 — delete
    // the `crew.readable` check in readSharedCrewMembership — SURVIVED the test
    // above: a non-owner's membership read hits `trip_members` first and
    // short-circuits, so the second read's guard was never exercised. An OWNER
    // is resolved from `trips.owner_id` alone, which is the only shape where
    // the crew-SIZE read is the one that fails. Without the guard a fail-closed
    // 0 is compared against the >= 2 threshold and reported as a MEASURED
    // "this is not a shared crew" — the owner of a real crew, told their trip
    // is solo, out of a query that never answered.
    const r = await readSharedCrewMembership(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t", "o");
    assert.equal(r.member, false, "still fail-closed");
    assert.equal(r.readable, false, "and the false is a default, not a measurement");

    // CONTROL — the same owner on a readable roster is a shared crew.
    const ok = await readSharedCrewMembership(makeDb(CREW), "t", "o");
    assert.deepEqual(ok, { readable: true, member: true });
    // CONTROL — an owner of a genuinely solo trip is a MEASURED non-crew.
    const solo = await readSharedCrewMembership(makeDb({ trips: [trip("solo", "u1")], members: [] }), "solo", "u1");
    assert.deepEqual(solo, { readable: true, member: false });
  });

  it("the booleans stay fail-closed, and delegate — the wrapper is not a second implementation", async () => {
    assert.equal(await isAcceptedTripMember(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t", "u2"), false);
    assert.equal(await acceptedCrewSize(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t"), 0);
    assert.equal(await isSharedCrewMember(makeDb({ ...CREW, errorTables: ["trip_members"] }), "t", "u2"), false);
    // CONTROL — the readable answers are unchanged by the refactor.
    assert.equal(await isAcceptedTripMember(makeDb(CREW), "t", "u2"), true);
    assert.equal(await acceptedCrewSize(makeDb(CREW), "t"), 2);
    assert.equal(await isSharedCrewMember(makeDb(CREW), "t", "u2"), true);
  });
});
