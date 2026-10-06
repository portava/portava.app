/**
 * Verifier F1 (2026-10-05, on 9df97fd9e2) — what `GET /api/nearby/reachable`
 * tells a VIEWER about the people it does not show.
 *
 * The defect: the route served per-reason refusal counts, and §44's privacy-zone
 * change added a `protected_zone` reason computed from a person's RAW position
 * before their consent or freshness. In a two-person crew, a crewmate with
 * location sharing OFF standing in a medical-facility zone came back as
 * `{ protected_zone: 1 }` instead of `{ no_presence_consent: 1 }` — the viewer
 * learned that a named person who had withheld their position was at a clinic.
 * A consenting crewmate whose position was ten days old leaked the same way.
 *
 * Pinned here, through the real route:
 *   - the response carries ONE undifferentiated `notShown` count and no reasons;
 *   - `protected_zone` appears nowhere in the response, under any name;
 *   - a person withheld for a zone is indistinguishable to the viewer from a
 *     person withheld for another reason (same body, byte for byte, but for the
 *     clock);
 *   - the verifier's two reproductions (consent off inside a zone; a 10-day-old
 *     position inside a zone).
 *
 * Run: node --import tsx/esm --test src/test/reachablePeopleZoneNoLeak.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";
import nearbyReachableRouter from "../routes/nearbyReachable.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CREWMATE = "22222222-2222-4222-8222-222222222222";
const TRIP = "33333333-3333-4333-8333-333333333333";
const LAT = 41.157944, LNG = -8.629105;
const CLAT = LAT + 0.01, CLNG = LNG + 0.01;

const AVAILABLE_UNTIL = new Date(Date.now() + 2 * 3_600_000).toISOString();
function world(opts: { zone: boolean; consent: boolean; staleDays?: number; available?: boolean }): FakeClientSpec {
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const soon = AVAILABLE_UNTIL; // one instant for every world, so two bodies can be compared byte for byte
  const crewAt = opts.staleDays ? new Date(Date.now() - opts.staleDays * 86_400_000).toISOString() : fresh;
  return {
    users: { tok: VIEWER },
    rows: {
      feature_flags: [{ flag: "nearby_reachable_enabled", enabled: true }],
      blocks: [],
      circle_memberships: [{ user_id: VIEWER, other_id: CREWMATE }],
      trip_members: [
        { trip_id: TRIP, user_id: VIEWER, status: "accepted" },
        { trip_id: TRIP, user_id: CREWMATE, status: "accepted" },
      ],
      location_preferences: [
        { user_id: VIEWER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
        { user_id: CREWMATE, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
      ],
      user_privacy_settings: [{ user_id: CREWMATE, allow_location_sharing: opts.consent }],
      profile_privacy_settings: [{ user_id: CREWMATE, allow_profile_discovery: true }],
      user_location_state: [
        { user_id: VIEWER, lat: LAT, lng: LNG, last_known_at: fresh },
        { user_id: CREWMATE, lat: CLAT, lng: CLNG, last_known_at: crewAt },
      ],
      user_availability: [{ user_id: CREWMATE, open_to_meet: opts.available === true }],
      quick_availability_status: opts.available ? [{ user_id: CREWMATE, status: "free_now", expires_at: soon }] : [],
      availability_windows: [],
      protected_zones: opts.zone
        ? [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", category: "medical_facility", action: null, privacy_floor: null,
             shape: "circle", center_lat: CLAT, center_lng: CLNG, radius_meters: 150, ring: null,
             jurisdiction: null, policy_ref: null, active: true }]
        : [],
      profiles: [{ id: CREWMATE, message_privacy: "everyone", allow_message_requests: true }],
      friendships: [],
      follows: [],
    },
  };
}

let server: Server;
let port = 0;
function app() {
  const a = express();
  a.use((req, _res, next) => {
    const n = () => {};
    (req as any).log = { info: n, warn: n, error: n, debug: n, trace: n, fatal: n, child: () => (req as any).log };
    next();
  });
  a.use("/api", nearbyReachableRouter);
  return a;
}
async function call(spec: FakeClientSpec) {
  clearProtectedZoneCache();
  _resetRateLimit();
  const db = makeFailClosedClient(spec);
  _setTestClient(db, true);
  _setTestServiceClient(db);
  const res = await fetch(`http://127.0.0.1:${port}/api/nearby/reachable`, { headers: { Authorization: "Bearer tok" } });
  return { status: res.status, body: (await res.json()) as any, raw: "" };
}
/** The response minus the clock, for byte-for-byte comparison. */
const comparable = (b: any) => JSON.stringify({ ...b, generatedAt: null });

before(() => new Promise<void>((r) => {
  server = createServer(app());
  server.listen(0, "127.0.0.1", () => { port = (server.address() as { port: number }).port; r(); });
}));
after(() => new Promise<void>((r) => { _setTestClient(null, false); _setTestServiceClient(null); server.close(() => r()); }));
beforeEach(() => clearProtectedZoneCache());

describe("F1 — the viewer is never told WHY a person is not shown", () => {
  it("the response carries one undifferentiated notShown count and no per-reason refusals", async () => {
    const { status, body } = await call(world({ zone: false, consent: false }));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.people.length, 0);
    assert.equal(body.notShown, 1);
    assert.equal("refusals" in body, false, "per-reason counts reached the viewer");
  });

  it("REPRODUCTION 1: consent OFF inside a medical-facility zone — the same body as consent off outside it", async () => {
    const outside = await call(world({ zone: false, consent: false }));
    const inside = await call(world({ zone: true, consent: false }));
    assert.equal(JSON.stringify(inside.body).includes("protected_zone"), false);
    assert.equal(comparable(inside.body), comparable(outside.body));
  });

  it("REPRODUCTION 2: a 10-day-old position inside a zone — the same body as outside it", async () => {
    const outside = await call(world({ zone: false, consent: true, staleDays: 10 }));
    const inside = await call(world({ zone: true, consent: true, staleDays: 10 }));
    assert.equal(JSON.stringify(inside.body).includes("protected_zone"), false);
    assert.equal(comparable(inside.body), comparable(outside.body));
  });

  it("a consenting, fresh crewmate inside a zone is withheld — and the viewer cannot tell why", async () => {
    const zoned = await call(world({ zone: true, consent: true }));
    const declined = await call(world({ zone: false, consent: false }));
    assert.equal(zoned.body.people.length, 0, "a person in a protected zone was published");
    assert.equal(JSON.stringify(zoned.body).includes("protected_zone"), false);
    assert.equal(comparable(zoned.body), comparable(declined.body));
  });

  // Re-verification (2026-10-06, on b3d14e8494): every case above has the
  // crewmate publishing NO availability, so a zone always ended in "not shown".
  // With availability published the person IS shown (as available, without a
  // bucket) — and then the CARD must not tell a zone from sharing-off. The
  // mutant "keep freshness live in a zone" (`reachablePeople.ts`, the
  // `freshness` line) survived all 45 Nearby tests because nothing compared
  // those two cards; these do.
  for (const staleDays of [undefined, 10]) {
    const age = staleDays ? "a 10-day-old position" : "a fresh position";
    it(`AVAILABLE, ${age} inside a zone: the same card as an available crewmate sharing no location`, async () => {
      const zoned = await call(world({ zone: true, consent: true, available: true, staleDays }));
      const off = await call(world({ zone: false, consent: false, available: true }));
      assert.equal(zoned.status, 200, JSON.stringify(zoned.body));
      assert.equal(zoned.body.people.length, 1, "an available person in a zone is still shown as available");
      assert.equal(JSON.stringify(zoned.body).includes("protected_zone"), false);
      assert.equal(comparable(zoned.body), comparable(off.body));
    });
  }

  it("CONTROL: an available crewmate sharing a fresh position outside any zone gets a bucket — the card above is not the only card", async () => {
    const shared = await call(world({ zone: false, consent: true, available: true }));
    const off = await call(world({ zone: false, consent: false, available: true }));
    assert.equal(shared.body.people.length, 1);
    assert.notEqual(comparable(shared.body), comparable(off.body));
  });

  it("CONTROL: a consenting, fresh crewmate outside any zone is published with a bucket", async () => {
    const { body } = await call(world({ zone: false, consent: true }));
    assert.equal(body.people.length, 1);
    assert.equal(body.notShown, 0);
  });
});
