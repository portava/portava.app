/**
 * GET /api/trips/:tripId/members/:userId/passport — the TABLE 22 Trips consumer.
 *
 * Passport spec §21/§33: a Trip surface asks the ONE projection system for the
 * `trips` VARIANT rather than the full §29 aggregate. These tests pin the three
 * things that makes it safe:
 *
 *   1. Membership is required on BOTH sides — caller and target must be accepted
 *      members of THIS trip, so the resolved viewer relationship is genuine.
 *   2. The served body is the narrow variant, not the aggregate: none of the
 *      full projection's stamps / memories / plans / availability / shared
 *      context / numeric trust ever appears on the wire.
 *   3. A blocked relationship still collapses to the restricted shape (§24).
 *
 * Run: node --import tsx/esm --test src/test/tripsPassportProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripsRouter from "../routes/trips.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const ALICE = "aaaaaaaa-0000-0000-0000-000000000001"; // caller (crew)
const BOB = "bbbbbbbb-0000-0000-0000-000000000002";   // target (trip owner/host)
const CAROL = "cccccccc-0000-0000-0000-000000000003"; // not on the trip
const TRIP = "33333333-0000-0000-0000-000000000001";

function serviceStore(opts: { blocked?: boolean; carolOnTrip?: boolean } = {}) {
  return makePassportDb({
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "owner", status: "accepted" },
      ...(opts.carolOnTrip
        ? [{ trip_id: TRIP, user_id: CAROL, role: "member", status: "accepted" }]
        : []),
    ],
    trips: [{ id: TRIP, owner_id: BOB }],
    profiles: [
      {
        id: BOB, handle: "bob", name: "Bob Traveler", display_name: "Bob Traveler",
        avatar_url: "https://x/bob.png", cover_photo_url: "https://x/cover.png",
        verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
        home_city: "Hanoi", home_country: "Vietnam", current_city: "Da Nang",
        is_official: false, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true,
        interests: ["Nightlife"], spoken_languages: ["English", "Vietnamese"],
        travel_pace: "packed", planning_style: "planner", budget_style: "budget",
        travel_group_style: ["social"], open_to_meet: true, created_at: "2023-01-01",
      },
      { id: ALICE, handle: "alice", name: "Alice", created_at: "2023-01-01" },
      // Carol is NOT on the trip, but she IS a real, projectable traveler. Without
      // this row the projection would return null and the handler would 404 from
      // its "User not found" branch — which would make the target-membership test
      // below pass for the wrong reason (it stayed green with the gate deleted).
      {
        id: CAROL, handle: "carol", name: "Carol Outsider", display_name: "Carol Outsider",
        avatar_url: "https://x/carol.png", verified: false,
        is_official: false, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true,
        interests: ["Hiking"], spoken_languages: ["English"],
        travel_pace: "slow", planning_style: "spontaneous",
        open_to_meet: true, created_at: "2023-01-01",
      },
    ],
    trust_profiles: [{
      user_id: BOB, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
    }],
    // A block from the caller's side collapses the projection (§24). The fake
    // client's `.or()` does not narrow, so staging the row at all is the block.
    blocks: opts.blocked ? [{ blocker_id: ALICE, blocked_id: BOB }] : [],
    passport_visibility_preferences: [{ user_id: BOB, stamps_visible: "public", memories_visible: "public" }],
  });
}

/** Auth client: resolves bearer tokens and answers the membership check. */
function authClient(store: any, tokens: Record<string, string>) {
  return {
    from: (t: string) => store.from(t),
    auth: {
      getUser: async (token: string) => {
        const id = tokens[token];
        if (!id) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id } }, error: null };
      },
    },
  };
}

async function startServer(store: any) {
  _setTestServiceClient(store as any);
  _setTestClient(
    authClient(store, { "alice-tok": ALICE, "bob-tok": BOB, "carol-tok": CAROL }) as any,
    true,
  );
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", tripsRouter);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("GET /api/trips/:tripId/members/:userId/passport", () => {
  it("serves the narrow trips variant to a fellow crew member", async () => {
    const { port, close } = await startServer(serviceStore());
    const r = await get(port, `/api/trips/${TRIP}/members/${BOB}/passport`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const p = r.body.passport;
    assert.equal(p.variant, "trips");
    assert.equal(p.identity.handle, "bob");
    // The REAL relationship resolver runs here: Alice and Bob share TRIP and Bob
    // owns it, so the viewer context resolves to trip_host — the narrowing
    // reports that as the host/guest context rather than re-querying membership.
    assert.equal(p.viewerContext, "trip_host");
    assert.equal(p.hostGuestContext, "host");
    // These must be genuinely POPULATED here, otherwise the blocked test's
    // `deepEqual(…, [])` assertions below would be passing on an empty fixture
    // rather than on the §24 collapse.
    assert.deepEqual(p.languages, ["English", "Vietnamese"]);
    assert.ok(p.travelStyle.length > 0, "the unblocked fixture carries travel style");
    assert.ok(p.trustDomains.length > 0, "the unblocked fixture carries trust domains");
    // The aggregate's heavy sections must never reach a crew list.
    for (const k of ["stamps", "memories", "upcomingPlans", "featuredJourney",
                     "availability", "intent", "sharedContext", "credentials", "stats", "trust"]) {
      assert.ok(!(k in p), `trips endpoint leaked the full-projection field: ${k}`);
    }
    assert.ok(!JSON.stringify(p).includes("cover_photo_url"), "no raw profile columns on the wire");
    assert.ok(!("homeCountry" in p.identity), "TABLE 24 home country must not ride a crew card");
  });

  it("collapses to the restricted shape when the relationship is blocked (§24)", async () => {
    const { port, close } = await startServer(serviceStore({ blocked: true }));
    const r = await get(port, `/api/trips/${TRIP}/members/${BOB}/passport`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const p = r.body.passport;
    assert.ok(p.restricted, "a blocked relationship must still be restricted inside a shared trip");
    assert.deepEqual(p.trustDomains, []);
    assert.deepEqual(p.languages, []);
    assert.deepEqual(p.travelStyle, []);
    assert.equal(p.hostGuestContext, "none");
    assert.equal(p.actions.can_message, false);
  });

  it("rejects a caller who is not on the trip", async () => {
    const { port, close } = await startServer(serviceStore());
    const r = await get(port, `/api/trips/${TRIP}/members/${BOB}/passport`, "carol-tok");
    await close();
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("404s when the TARGET is not on the trip (not a general passport lookup)", async () => {
    const { port, close } = await startServer(serviceStore());
    const r = await get(port, `/api/trips/${TRIP}/members/${CAROL}/passport`, "alice-tok");
    await close();
    assert.equal(r.status, 404);

    // CONTROL: the 404 above must come from the TARGET-membership gate, not from
    // Carol being unprojectable. Put the SAME Carol on the trip and the SAME
    // request succeeds — so deleting the gate really does turn this test red.
    const s2 = await startServer(serviceStore({ carolOnTrip: true }));
    const ok = await get(s2.port, `/api/trips/${TRIP}/members/${CAROL}/passport`, "alice-tok");
    await s2.close();
    assert.equal(ok.status, 200, "Carol is projectable — the 404 above is the membership gate");
    assert.equal(ok.body.passport.identity.handle, "carol");
  });

  it("400s on a malformed trip or user id", async () => {
    const { port, close } = await startServer(serviceStore());
    const bad1 = await get(port, `/api/trips/not-a-uuid/members/${BOB}/passport`, "alice-tok");
    const bad2 = await get(port, `/api/trips/${TRIP}/members/nope/passport`, "alice-tok");
    await close();
    assert.equal(bad1.status, 400);
    assert.equal(bad2.status, 400);
  });

  it("requires authentication", async () => {
    const { port, close } = await startServer(serviceStore());
    const r = await get(port, `/api/trips/${TRIP}/members/${BOB}/passport`);
    await close();
    assert.equal(r.status, 401);
  });
});
