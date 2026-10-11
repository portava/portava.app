/**
 * Telegraph §30A.1 — relationship origins and states (census T380).
 *
 * The derivation is pure (domain/telegraph/contracts/telegraphRelationship.ts);
 * the facts come from existing data (services/telegraph/telegraphRelationship.ts)
 * and the route is GET /api/users/:userId/telegraph-relationship behind
 * telegraph_relationship_context_enabled (3662, seeded OFF).
 *
 * MUTANTS (each alone, each red, each reverted):
 *   R1 BLOCKED not decided first (an origin wins over a block) .................... red
 *   R2 a blocked relationship still lists its origins ............................. red
 *   R3 an ended event counted as live ............................................ red
 *   R4 a failed read published as a floor instead of 503 ........................ red
 *   R5 BUMP / NEARBY produced from anything ....................................... red
 *   R6 a cancelled Rent-a-Buddy booking counted as an origin ...................... red
 *
 * Run: node --import tsx/esm --test src/test/telegraphRelationship.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import telegraphGroupsRouter from "../routes/telegraphGroups.js";
import {
  RELATIONSHIP_ORIGINS,
  RELATIONSHIP_STATES,
  UNPRODUCED_ORIGINS,
  deriveTelegraphRelationship,
  type RelationshipFacts,
} from "../domain/telegraph/contracts/telegraphRelationship.js";
import { call, makeFakeClient, startRouter, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const EV_LIVE = "e1000000-0000-4000-8000-000000000001";
const EV_DONE = "e1000000-0000-4000-8000-000000000002";
const BP_B = "b1000000-0000-4000-8000-000000000001"; // B's buddy profile
const MEET = "m1000000-0000-4000-8000-000000000001";

const none: RelationshipFacts = {
  blocked: false, viewerMessagingRestricted: false, isFriend: false, viewerFollows: false, otherFollows: false,
  sharedCircle: false, sharedTrip: false, acceptedRequest: false,
  events: { live: 0, ended: 0 }, buddy: { live: 0, ended: 0 }, plans: { live: 0, ended: 0 },
};

describe("§30A.1 vocabulary — the spec's ten origins and six states, verbatim", () => {
  it("names every origin and state", () => {
    assert.deepEqual([...RELATIONSHIP_ORIGINS], ["FOLLOW", "MUTUAL_FOLLOW", "TRIP", "CREW", "EVENT", "BUMP", "NEARBY", "BUDDY", "PLAN", "MANUAL"]);
    assert.deepEqual([...RELATIONSHIP_STATES], ["REQUEST_ONLY", "ACTIVE", "TEMPORARY", "RESTRICTED", "BLOCKED", "EXPIRED"]);
  });
  it("BUMP and NEARBY are declared with a reason and produced by NO combination of facts", () => {
    assert.deepEqual(Object.keys(UNPRODUCED_ORIGINS).sort(), ["BUMP", "NEARBY"]);
    const everything: RelationshipFacts = {
      blocked: false, viewerMessagingRestricted: false, isFriend: true, viewerFollows: true, otherFollows: true,
      sharedCircle: true, sharedTrip: true, acceptedRequest: true,
      events: { live: 1, ended: 1 }, buddy: { live: 1, ended: 1 }, plans: { live: 1, ended: 1 },
    };
    const r = deriveTelegraphRelationship(everything);
    assert.ok(!r.origins.includes("BUMP") && !r.origins.includes("NEARBY"));
  });
});

describe("§30A.1 derivation — states in order", () => {
  it("BLOCKED beats every origin and states nothing about the relationship", () => {
    const r = deriveTelegraphRelationship({ ...none, blocked: true, isFriend: true, sharedTrip: true });
    assert.equal(r.state, "BLOCKED");
    assert.deepEqual(r.origins, []);
    assert.deepEqual(r.expiredOrigins, []);
  });
  it("RESTRICTED when the viewer is under a messaging restriction", () => {
    assert.equal(deriveTelegraphRelationship({ ...none, viewerMessagingRestricted: true, isFriend: true }).state, "RESTRICTED");
  });
  it("ACTIVE from a durable origin; a friendship reads as MUTUAL_FOLLOW; one-way follow is FOLLOW", () => {
    assert.deepEqual(deriveTelegraphRelationship({ ...none, isFriend: true }), { state: "ACTIVE", origins: ["MUTUAL_FOLLOW"], expiredOrigins: [] });
    assert.deepEqual(deriveTelegraphRelationship({ ...none, otherFollows: true }).origins, ["FOLLOW"]);
    assert.equal(deriveTelegraphRelationship({ ...none, acceptedRequest: true }).state, "ACTIVE");
    assert.equal(deriveTelegraphRelationship({ ...none, sharedCircle: true }).state, "ACTIVE");
  });
  it("TEMPORARY from live time-bound origins only", () => {
    for (const f of [{ sharedTrip: true }, { events: { live: 1, ended: 0 } }, { buddy: { live: 1, ended: 0 } }, { plans: { live: 1, ended: 0 } }]) {
      assert.equal(deriveTelegraphRelationship({ ...none, ...f }).state, "TEMPORARY", JSON.stringify(f));
    }
  });
  it("EXPIRED when every time-bound origin has ended; REQUEST_ONLY with no origin", () => {
    const r = deriveTelegraphRelationship({ ...none, events: { live: 0, ended: 2 }, buddy: { live: 0, ended: 1 } });
    assert.equal(r.state, "EXPIRED");
    assert.deepEqual(r.expiredOrigins, ["EVENT", "BUDDY"]);
    assert.equal(deriveTelegraphRelationship(none).state, "REQUEST_ONLY");
  });
});

// ── The route, over existing data ─────────────────────────────────────────────

function seed(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_relationship_context_enabled", enabled: true }],
    blocks: [], user_message_settings: [], user_friendships: [], user_follows: [], trip_members: [], circle_memberships: [],
    trust_restrictions: [], trust_profiles: [], user_restrictions: [], user_mutes: [],
    message_requests: [], event_attendees: [], events: [], rent_buddy_profiles: [], rent_buddy_bookings: [],
    meetups: [], meetup_invites: [],
    profiles: [A, B].map((id) => ({ id, handle: id.slice(0, 4), is_private: false })),
    ...over,
  };
}

let harness: RouterHarness;
before(async () => {
  const r = express.Router();
  r.use(telegraphGroupsRouter);
  harness = await startRouter(r);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});
function use(over: Partial<Record<string, any[]>> = {}, opts: FakeDbOptions = {}) {
  const c = makeFakeClient(seed(over), opts);
  _setTestClient(c, true);
  return c;
}
const rel = (as = A, other = B) => call(harness.base, "GET", `/users/${other}/telegraph-relationship`, as);

describe("GET /users/:id/telegraph-relationship — derived from data that exists", () => {
  it("strangers: REQUEST_ONLY", async () => {
    use();
    const r = await rel();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "REQUEST_ONLY");
  });
  it("mutual follow: ACTIVE / MUTUAL_FOLLOW", async () => {
    use({ user_follows: [{ follower_id: A, following_id: B, status: "accepted" }, { follower_id: B, following_id: A, status: "accepted" }] });
    const r = await rel();
    assert.equal(r.body.state, "ACTIVE", JSON.stringify(r.body));
    assert.ok(r.body.origins.includes("MUTUAL_FOLLOW"));
  });
  it("an accepted message request: ACTIVE / MANUAL", async () => {
    use({ message_requests: [{ id: "r1", sender_id: B, recipient_id: A, status: "accepted" }] });
    assert.deepEqual((await rel()).body.origins, ["MANUAL"]);
  });
  it("a shared live event: TEMPORARY / EVENT; a shared finished one: EXPIRED", async () => {
    use({ event_attendees: [{ event_id: EV_LIVE, user_id: A }, { event_id: EV_LIVE, user_id: B }], events: [{ id: EV_LIVE, state: "open" }] });
    assert.deepEqual([(await rel()).body.state, (await rel()).body.origins], ["TEMPORARY", ["EVENT"]]);
    use({ event_attendees: [{ event_id: EV_DONE, user_id: A }, { event_id: EV_DONE, user_id: B }], events: [{ id: EV_DONE, state: "completed" }] });
    const r = await rel();
    assert.equal(r.body.state, "EXPIRED");
    assert.deepEqual(r.body.expiredOrigins, ["EVENT"]);
  });
  it("a confirmed Rent-a-Buddy booking (B the buddy): TEMPORARY / BUDDY; a cancelled one is no origin", async () => {
    use({ rent_buddy_profiles: [{ id: BP_B, user_id: B }], rent_buddy_bookings: [{ id: "k1", buddy_id: BP_B, traveler_id: A, status: "confirmed" }] });
    assert.deepEqual((await rel()).body.origins, ["BUDDY"]);
    use({ rent_buddy_profiles: [{ id: BP_B, user_id: B }], rent_buddy_bookings: [{ id: "k1", buddy_id: BP_B, traveler_id: A, status: "cancelled" }] });
    assert.equal((await rel()).body.state, "REQUEST_ONLY");
  });
  it("an accepted shared meetup still ahead: TEMPORARY / PLAN", async () => {
    use({
      meetups: [{ id: MEET, creator_id: A, status: "active", starts_at: "2099-01-01T00:00:00.000Z", ends_at: null }],
      meetup_invites: [{ meetup_id: MEET, user_id: B, status: "going" }],
    });
    assert.deepEqual((await rel()).body.origins, ["PLAN"]);
  });
  it("a block in either direction: BLOCKED, with no origins, whatever else is true", async () => {
    use({ blocks: [{ blocker_id: B, blocked_id: A }], message_requests: [{ id: "r1", sender_id: B, recipient_id: A, status: "accepted" }] });
    const r = await rel();
    assert.equal(r.body.state, "BLOCKED", JSON.stringify(r.body));
    assert.deepEqual(r.body.origins, []);
  });
  it("a messaging restriction on the viewer: RESTRICTED", async () => {
    use({ trust_restrictions: [{ id: "t1", user_id: A, restriction_type: "messaging", lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z" }] });
    assert.equal((await rel()).body.state, "RESTRICTED");
  });
  it("a failed read is a 503, never a floor", async () => {
    use({}, { errors: { event_attendees: { message: "connection reset" } } });
    assert.equal((await rel()).status, 503);
    use({}, { errors: { blocks: { message: "connection reset" } } });
    assert.equal((await rel()).status, 503);
  });
  it("flag OFF: feature_disabled; unreadable flag: 503", async () => {
    use({ feature_flags: [{ flag: "telegraph_relationship_context_enabled", enabled: false }] });
    assert.equal((await rel()).body.error, "feature_disabled");
    use({}, { errors: { feature_flags: { message: "x" } } });
    assert.equal((await rel()).status, 503);
  });
});
