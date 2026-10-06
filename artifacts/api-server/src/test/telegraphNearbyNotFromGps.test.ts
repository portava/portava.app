/**
 * census-telegraph T367 — §29: "No Nearby exposure merely because GPS indicates
 * physical proximity."
 *
 * The row was graded N `∅` when there was no Nearby at all. There is one now —
 * `services/telegraph/reachablePeople.ts` + `reachablePeopleQuery.ts`, served by
 * `routes/nearbyReachable.ts` (dark: `nearby_reachable_enabled` is seeded FALSE)
 * — and the prohibition is a property of the CODE, which holds whatever the flag
 * says. This suite asserts it on both of the doors GPS could come through:
 *
 *   1. CANDIDACY. A stranger standing next to the viewer, fresh fix, discoverable
 *      to "everyone" and open to meet, is never a candidate: the candidate set is
 *      the viewer's circle and accepted trip crew, and no query answers "who is
 *      near this point". The stranger is not refused — they are never considered,
 *      which is stronger.
 *   2. PUBLICATION. A crewmate at ZERO distance is published only on an
 *      affirmative consent. Every combination of the two consents is enumerated
 *      with the two points identical: no presence consent → no bucket, whatever
 *      the GPS says; neither consent → refused outright.
 *   3. SHAPE. Neither the loader nor the route accepts a position, a radius or a
 *      precision from the caller.
 *
 * SHOWN RED (recorded in the T2 lane report): making `projectReachablePerson` use
 * `input.personPoint` without `personPresenceConsent` turns test 2 red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphNearbyNotFromGps.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { loadReachablePeople } from "../services/telegraph/reachablePeopleQuery.js";
import { projectReachablePerson, type ReachablePersonInputs } from "../services/telegraph/reachablePeople.js";
import { coarsePointFor } from "../lib/proximityBuckets.js";
import type { InvisibleModeState } from "../lib/invisibleMode.js";
import type { MessagePermissionVerdict } from "../lib/messagingPermissions.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CREWMATE = "22222222-2222-4222-8222-222222222222";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const TRIP = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-09-22T18:00:00.000Z");
const SOON = new Date(NOW + 2 * 3_600_000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();

/** Allows EVERYONE — so a stranger's absence cannot be blamed on the relationship read. */
const ALLOW_ANYONE: MessagePermissionVerdict = {
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

function world(): Record<string, Record<string, unknown>[]> {
  const sameSpot = { lat: 41.15, lng: -8.61, last_known_at: FRESH };
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
      // The stranger has made themselves as discoverable as the schema allows.
      { user_id: STRANGER, location_mode: "nearby", sharing_paused: false, discovery_visibility: "everyone" },
    ],
    user_privacy_settings: [
      { user_id: CREWMATE, allow_location_sharing: true },
      { user_id: STRANGER, allow_location_sharing: true },
    ],
    profile_privacy_settings: [
      { user_id: CREWMATE, allow_profile_discovery: true },
      { user_id: STRANGER, allow_profile_discovery: true },
    ],
    // All three at the SAME coordinates, all fresh.
    user_location_state: [
      { user_id: VIEWER, ...sameSpot },
      { user_id: CREWMATE, ...sameSpot },
      { user_id: STRANGER, ...sameSpot },
    ],
    user_availability: [
      { user_id: CREWMATE, open_to_meet: true },
      { user_id: STRANGER, open_to_meet: true },
    ],
    quick_availability_status: [
      { user_id: CREWMATE, status: "free_now", expires_at: SOON },
      { user_id: STRANGER, status: "free_now", expires_at: SOON },
      { user_id: VIEWER, status: "free_now", expires_at: SOON },
    ],
    availability_windows: [],
  };
}

describe("T367 — candidacy: GPS proximity never makes someone a candidate", () => {
  it("a stranger at the viewer's exact position, discoverable and open to meet, is never considered", async () => {
    const seen: string[] = [];
    const db = makeFailClosedClient({ rows: world() });
    const result = await loadReachablePeople(db, {
      viewerId: VIEWER,
      nowMs: NOW,
      resolveRelationship: async (_db, _v, personId) => {
        seen.push(personId);
        return ALLOW_ANYONE;
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const ids = result.people.map((p) => p.personId);
    assert.ok(ids.includes(CREWMATE), "the consented crewmate is the control: the world is live");
    assert.ok(!ids.includes(STRANGER), "a co-located stranger was published");
    assert.ok(!seen.includes(STRANGER), "a co-located stranger was even considered as a candidate");
  });
});

describe("T367 — publication: zero distance publishes nothing without affirmative consent", () => {
  // The SAME coarse cell for both people: zero distance at every precision.
  const point = coarsePointFor(VIEWER, 41.15, -8.61, "everyone");
  const visible: InvisibleModeState = { invisible: false, reasons: [], degraded: false };
  function inputs(presence: boolean, availability: boolean): ReachablePersonInputs {
    return {
      viewerId: VIEWER,
      personId: CREWMATE,
      viewerPoint: point,
      personPoint: point,
      relationshipContext: ALLOW_ANYONE.relationship_context!,
      relationshipDegraded: false,
      blocked: false,
      blockStateKnown: true,
      personInvisible: visible,
      viewerInvisible: visible,
      personPresenceConsent: presence,
      // Not in a §24 protected zone: the input every production caller supplies
      // since lane T1's T31 work (reachablePeopleQuery.ts) — this case is about
      // consent, so a zone must not be what withholds the point.
      personInProtectedZone: false,
      availabilityPublished: availability,
      availabilityState: availability ? "available_now" : "unknown",
      availabilityIntents: [],
      availabilityWindow: null,
      viewerWindow: null,
      availabilityPublishedUntil: null,
      personFreshness: "live",
      safety: "clear",
      sharedTrips: 1,
      sharedCircles: 1,
      viewerIntents: [],
    };
  }

  it("the control: with presence consent, identical points publish a bucket", () => {
    const r = projectReachablePerson(inputs(true, false));
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.person.proximity.bucket !== "unknown");
  });

  for (const availability of [false, true]) {
    it(`no presence consent (availability ${availability ? "published" : "not published"}) → GPS discloses nothing`, () => {
      const r = projectReachablePerson(inputs(false, availability));
      if (!availability) {
        assert.equal(r.ok, false, "neither consent, zero distance: must be refused, not published");
        assert.equal(!r.ok && r.refusal, "no_presence_consent");
      } else {
        assert.equal(r.ok, true, "availability alone still publishes the person");
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.equal(r.person.proximity.bucket, "unknown", "the GPS fix leaked into the bucket without consent");
        assert.equal(r.person.privacy.proximityPublished, false);
      }
    });
  }
});

describe("T367 — shape: no caller-supplied position, radius or precision", () => {
  it("the loader's options carry no position and the route reads none from the request", () => {
    const query = readFileSync(new URL("../services/telegraph/reachablePeopleQuery.ts", import.meta.url), "utf8");
    const opts = /export interface ReachableLoadOptions \{([\s\S]*?)\n\}/.exec(query)?.[1] ?? "";
    assert.ok(opts.length > 0, "ReachableLoadOptions not found");
    for (const forbidden of ["lat", "lng", "radius", "precision", "point"]) {
      assert.ok(!new RegExp(`\\b${forbidden}\\w*\\??:`, "i").test(opts), `ReachableLoadOptions accepts ${forbidden}`);
    }
    const route = readFileSync(new URL("../routes/nearbyReachable.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/req\.query\.(lat|lng|radius|precision)/.test(route));
    assert.ok(!/req\.body/.test(route), "the route reads a body");
  });
});
