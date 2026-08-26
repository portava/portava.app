/**
 * tripMembership.isAcceptedTripMember — the role-based membership check the intel
 * group signal uses to validate a client-supplied Trip Crew (partyId). Proves it
 * accepts the owner and accepted members, rejects pending invites / non-members,
 * and fails closed on a missing client or a DB error.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptedTripMember } from "../lib/tripMembership.js";

/** Minimal Supabase-shaped fake: trips(owner_id) + trip_members(role) with an optional forced error. */
function makeDb(cfg: { ownerId?: string; members?: { user_id: string; role: string }[]; error?: boolean }) {
  function from(table: string) {
    const eqs: [string, any][] = [];
    let roleIn: string[] | null = null;
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(_c: string, v: string[]) { roleIn = v; return b; },
      maybeSingle() {
        if (cfg.error) return Promise.resolve({ data: null, error: { message: "boom" } });
        if (table === "trips") {
          return Promise.resolve({ data: cfg.ownerId ? { owner_id: cfg.ownerId } : null, error: null });
        }
        // trip_members
        const uid = eqs.find(([c]) => c === "user_id")?.[1];
        const hit = (cfg.members ?? []).find(
          (m) => m.user_id === uid && (!roleIn || roleIn.includes(m.role)),
        );
        return Promise.resolve({ data: hit ? { role: hit.role } : null, error: null });
      },
    };
    return b;
  }
  return { from };
}

describe("tripMembership.isAcceptedTripMember", () => {
  it("accepts the trip owner", async () => {
    const db = makeDb({ ownerId: "u1" });
    assert.equal(await isAcceptedTripMember(db, "trip-1", "u1"), true);
  });

  it("accepts an accepted member (role member)", async () => {
    const db = makeDb({ ownerId: "owner", members: [{ user_id: "u2", role: "member" }] });
    assert.equal(await isAcceptedTripMember(db, "trip-1", "u2"), true);
  });

  it("rejects a pending invite (role invited)", async () => {
    const db = makeDb({ ownerId: "owner", members: [{ user_id: "u3", role: "invited" }] });
    assert.equal(await isAcceptedTripMember(db, "trip-1", "u3"), false);
  });

  it("rejects a non-member", async () => {
    const db = makeDb({ ownerId: "owner", members: [] });
    assert.equal(await isAcceptedTripMember(db, "trip-1", "stranger"), false);
  });

  it("fails closed on a DB error and on a missing client", async () => {
    assert.equal(await isAcceptedTripMember(makeDb({ error: true }), "trip-1", "u1"), false);
    assert.equal(await isAcceptedTripMember(null, "trip-1", "u1"), false);
    assert.equal(await isAcceptedTripMember(makeDb({}), "", "u1"), false);
  });
});
