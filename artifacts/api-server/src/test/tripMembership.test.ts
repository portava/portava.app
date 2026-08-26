/**
 * tripMembership — the role-based checks the intel group signal uses: is the actor
 * an accepted member, how many distinct members does a trip have, and is it a
 * SHARED crew (≥2). The shared-crew gate is what stops a solo trip from minting a
 * per-person crew key (which would split a crew — the leak the signal prevents).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptedTripMember, acceptedCrewSize, isSharedCrewMember } from "../lib/tripMembership.js";

/** trips(id, owner_id) + trip_members(trip_id, user_id, role); eq / in / maybeSingle / list. */
function makeDb(cfg: { trips?: { id: string; owner_id: string }[]; members?: { trip_id: string; user_id: string; role: string }[]; error?: boolean }) {
  function from(table: string) {
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
      maybeSingle() { return Promise.resolve(cfg.error ? { data: null, error: { message: "boom" } } : { data: rows()[0] ?? null, error: null }); },
      then(res: (r: any) => any) { return Promise.resolve(cfg.error ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(res); },
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
