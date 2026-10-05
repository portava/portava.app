/**
 * Telegraph §4.3 — "Privacy zones can suppress discovery around home, lodging
 * or user-defined sensitive places" — on the Nearby & Available read layer.
 *
 * census-telegraph T31 recorded that `lib/protectedLocations.ts` was consulted
 * by nothing in Telegraph: "a bucket computed from a coarse point near a
 * protected place is still a bucket near a protected place." The read layer now
 * asks the §24 policy (through its one reader, `lib/protectedZoneStore.ts`)
 * about every RAW position before any coarse point is made from it.
 *
 * What each case pins, and the state it reads back (the projection the route
 * would serialise, not a return code):
 *   - a person inside a zone is never given a bucket, whatever they consented to;
 *   - with nothing else to say they are refused BY NAME (`protected_zone`), so the
 *     response's counts explain the short list;
 *   - with availability published they are still shown — availability is not a
 *     position — but their proximity is `unknown`;
 *   - a COARSEN-class zone (medical facility) withholds too: the bucket is
 *     already the coarsest rung, so there is nothing coarser to give;
 *   - a malformed zone row withholds rather than being skipped;
 *   - a viewer inside a zone measures from nowhere;
 *   - an unreadable policy REFUSES the whole answer — never "nobody is inside a
 *     zone".
 *
 * Run: node --import tsx/esm --test src/test/reachablePeopleProtectedZones.test.ts
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  loadReachablePeople,
  positionInProtectedZone,
} from "../services/telegraph/reachablePeopleQuery.js";
import { clearProtectedZoneCache } from "../lib/protectedZoneStore.js";
import type { MessagePermissionVerdict } from "../lib/messagingPermissions.js";
import type { ProtectedZone } from "../lib/protectedLocations.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CREWMATE = "22222222-2222-4222-8222-222222222222";
const TRIP = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-09-22T18:00:00.000Z");
const SOON = new Date(NOW + 2 * 3_600_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

const VIEWER_AT = { lat: 41.15, lng: -8.61 };
const CREWMATE_AT = { lat: 41.152, lng: -8.613 };

const CREW_VERDICT: MessagePermissionVerdict = {
  allowed: true,
  verdict: "allowed",
  relationship_context: {
    isFriend: false,
    senderFollowsRecipient: false,
    recipientFollowsSender: false,
    sharedTrip: true,
    sharedCircle: true,
  },
};

function zoneRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    category: "private_residence",
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: CREWMATE_AT.lat,
    center_lng: CREWMATE_AT.lng,
    radius_meters: 150,
    ring: null,
    jurisdiction: null,
    policy_ref: null,
    active: true,
    ...over,
  };
}

/** One consented, fresh crewmate. `available` controls whether they published availability. */
function world(opts: { available: boolean; zones?: Record<string, unknown>[] }) {
  return {
    feature_flags: [],
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
    user_privacy_settings: [{ user_id: CREWMATE, allow_location_sharing: true }],
    profile_privacy_settings: [{ user_id: CREWMATE, allow_profile_discovery: true }],
    user_location_state: [
      { user_id: VIEWER, ...VIEWER_AT, last_known_at: FRESH },
      { user_id: CREWMATE, ...CREWMATE_AT, last_known_at: FRESH },
    ],
    user_availability: [{ user_id: CREWMATE, open_to_meet: opts.available }],
    quick_availability_status: opts.available
      ? [
          { user_id: CREWMATE, status: "free_now", expires_at: SOON },
          { user_id: VIEWER, status: "free_now", expires_at: SOON },
        ]
      : [],
    availability_windows: [],
    protected_zones: opts.zones ?? [],
  };
}

async function load(spec: Parameters<typeof makeFailClosedClient>[0]) {
  const db = makeFailClosedClient(spec);
  return loadReachablePeople(db, {
    viewerId: VIEWER,
    nowMs: NOW,
    resolveRelationship: async () => CREW_VERDICT,
  });
}

beforeEach(() => clearProtectedZoneCache());

describe("CONTROL: with no zone covering anyone, a consented crewmate is bucketed", () => {
  it("no zones at all — published with a bucket", async () => {
    const result = await load({ rows: world({ available: false }) });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]!.proximity.bucket, "same_area");
  });

  it("a zone elsewhere in the city does not touch the crewmate", async () => {
    const result = await load({
      rows: world({ available: false, zones: [zoneRow({ center_lat: 41.2, center_lng: -8.7 })] }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]!.privacy.proximityPublished, true);
  });
});

describe("a person inside a zone is never given a bucket", () => {
  it("inside a private-residence zone with nothing else published: refused BY NAME, nothing serialised", async () => {
    const result = await load({ rows: world({ available: false, zones: [zoneRow()] }) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0, "a person at a protected place was published on Nearby");
    assert.equal(result.telemetry.refusals["protected_zone"], 1);
    assert.equal(result.telemetry.refusals["no_availability_consent"], undefined);
  });

  it("inside a zone WITH availability published: shown as available, proximity withheld", async () => {
    const result = await load({ rows: world({ available: true, zones: [zoneRow()] }) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 1);
    const person = result.people[0]!;
    assert.equal(person.availability.state, "available_now");
    assert.equal(person.proximity.bucket, "unknown");
    assert.equal(person.privacy.proximityPublished, false);
  });

  it("a COARSEN-class zone (medical facility) withholds too — a bucket is already the coarsest rung", async () => {
    const result = await load({
      rows: world({ available: false, zones: [zoneRow({ category: "medical_facility" })] }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0);
    assert.equal(result.telemetry.refusals["protected_zone"], 1);
  });

  it("a zone whose geometry cannot be parsed withholds rather than being skipped", async () => {
    const result = await load({
      rows: world({
        available: false,
        zones: [zoneRow({ shape: "polygon", center_lat: null, center_lng: null, radius_meters: null, ring: "not a ring" })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 0, "a malformed policy row became no policy at all");
  });
});

describe("a viewer inside a zone measures from nowhere", () => {
  it("the crewmate is still shown as available, but no bucket is computed from the viewer's protected position", async () => {
    const result = await load({
      rows: world({
        available: true,
        zones: [zoneRow({ center_lat: VIEWER_AT.lat, center_lng: VIEWER_AT.lng, radius_meters: 100 })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0]!.proximity.bucket, "unknown");
  });
});

describe("an unreadable policy is not an absent policy", () => {
  it("a failed protected_zones read REFUSES the answer (stage protected_zones)", async () => {
    const result = await load({
      rows: world({ available: true }),
      failOn: (ctx) => (ctx.table === "protected_zones" ? { message: "connection reset", code: "57P01" } : null),
    });
    assert.equal(result.ok, false, "a list was published although no position could be checked against the policy");
    if (result.ok) return;
    assert.equal(result.stage, "protected_zones");
  });
});

describe("positionInProtectedZone", () => {
  const zone: ProtectedZone = {
    id: "z",
    category: "shelter",
    shape: "circle",
    center: { lat: 10, lng: 10 },
    radiusMeters: 500,
  } as ProtectedZone;

  it("inside → true; outside → false", () => {
    assert.equal(positionInProtectedZone(10, 10, [zone]), true);
    assert.equal(positionInProtectedZone(11, 11, [zone]), false);
  });

  it("no coordinate has nothing to ask a zone about", () => {
    assert.equal(positionInProtectedZone(null, null, [zone]), false);
    assert.equal(positionInProtectedZone(Number.NaN, 10, [zone]), false);
  });

  it("no zones covers nothing", () => {
    assert.equal(positionInProtectedZone(10, 10, []), false);
  });
});
