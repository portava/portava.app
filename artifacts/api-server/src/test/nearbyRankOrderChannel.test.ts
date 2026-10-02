/**
 * T24 — `nearbyRank` over availability, relationship, intent, shared context,
 * overlap window, travel time, proximity bucket, freshness and safety — AND the
 * disclosure channel that ranking opens.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE CHANNEL THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Bucketing the NUMBER is not enough. If the list is ordered by true distance
 * then the ORDER discloses distance: the first person in a bucket is the nearest
 * person in that bucket, and a viewer who polls while walking can difference two
 * orderings into a bearing. It is the channel that gets missed because nothing
 * in the response body looks wrong.
 *
 * The assertions below are the closure:
 *
 *   1. two people in the SAME bucket at very different true distances receive
 *      the SAME rank — proven by building their projections from real coarse
 *      positions, not by passing the ranker a bucket by hand;
 *   2. swapping their true positions does not change the published order;
 *   3. the order that IS used is the per-(viewer, person) tiebreak, which is
 *      stable across polls and different for a different viewer;
 *   4. availability outranks proximity, so the surface is not a proximity radar
 *      with an availability label on it.
 *
 * Run: node --import tsx/esm --test src/test/nearbyRankOrderChannel.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coarsePointFor, proximityBucketBetween } from "../lib/proximityBuckets.js";
import { VISIBLE } from "../lib/invisibleMode.js";
import {
  nearbyRank,
  orderReachablePeople,
  projectReachablePerson,
  relationshipFrom,
  stableTiebreak,
  type NearbyRankFactors,
  type ReachablePersonInputs,
  type ReachablePersonProjection,
} from "../services/telegraph/reachablePeople.js";
import type { RelationshipContext } from "../lib/messagingPermissions.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const NEAR = "22222222-2222-4222-8222-222222222222";
const FAR_IN_BUCKET = "33333333-3333-4333-8333-333333333333";
const OTHER_VIEWER = "44444444-4444-4444-8444-444444444444";

const FRIENDS: RelationshipContext = {
  isFriend: true,
  senderFollowsRecipient: true,
  recipientFollowsSender: true,
  sharedTrip: false,
  sharedCircle: false,
};

/** Origin, and two offsets that both land inside `same_area` (<= 5 km). */
const ORIGIN = { lat: 41.15, lng: -8.61 };
const CLOSE_KM = 0.2;
const FURTHER_KM = 1.6;
const KM_PER_DEG = 111.32;

function pointAt(subjectId: string, km: number) {
  return coarsePointFor(subjectId, ORIGIN.lat + km / KM_PER_DEG, ORIGIN.lng, "neighborhood");
}

function inputsFor(personId: string, km: number): ReachablePersonInputs {
  return {
    viewerId: VIEWER,
    personId,
    viewerPoint: coarsePointFor(VIEWER, ORIGIN.lat, ORIGIN.lng, "neighborhood"),
    personPoint: pointAt(personId, km),
    relationshipContext: FRIENDS,
    relationshipDegraded: false,
    blocked: false,
    blockStateKnown: true,
    personInvisible: VISIBLE,
    viewerInvisible: VISIBLE,
    personPresenceConsent: true,
    availabilityPublished: true,
    availabilityState: "available_now",
    availabilityIntents: ["Food"],
    availabilityWindow: { startMs: 0, endMs: 3 * 3_600_000 },
    viewerWindow: { startMs: 0, endMs: 3 * 3_600_000 },
    availabilityPublishedUntil: "2026-09-22T20:00:00.000Z",
    personFreshness: "live",
    safety: "clear",
    sharedTrips: 0,
    sharedCircles: 0,
    viewerIntents: ["Food"],
  };
}

function project(personId: string, km: number): ReachablePersonProjection {
  const outcome = projectReachablePerson(inputsFor(personId, km));
  assert.equal(outcome.ok, true, `expected a projection for ${personId}`);
  return (outcome as { ok: true; person: ReachablePersonProjection }).person;
}

describe("the projection carries nothing finer than a bucket", () => {
  it("no coordinate, no distance, no ETA and no fine-grained number anywhere in the payload", () => {
    const person = project(NEAR, CLOSE_KM);

    // Keys, not a substring scan: "relationship" contains "lat", and a test
    // that cannot tell those apart is a test that will be deleted as noise.
    const keys: string[] = [];
    const numbers: number[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) { keys.push(k); walk(v); }
        return;
      }
      if (typeof node === "number") numbers.push(node);
    };
    walk(person);

    const FORBIDDEN = new Set([
      "lat", "lng", "latitude", "longitude", "distanceKm", "distance",
      "etaMinutes", "eta", "accuracyMeters", "coords", "point", "geo",
      "lastSeenAt", "lastKnownAt", "observedAt",
    ]);
    const leaked = keys.filter((k) => FORBIDDEN.has(k));
    assert.deepEqual(leaked, [], `the projection published ${leaked.join(", ")}`);

    // A coordinate that slipped through under another name would still be a
    // number with several decimal places. Ranks and counts are integers.
    const fractional = numbers.filter((n) => !Number.isInteger(n));
    assert.deepEqual(fractional, [], `non-integer values in a bucketed payload: ${fractional.join(", ")}`);

    assert.equal(person.proximity.precision, "bucket");
    assert.equal(person.privacy.preciseShared, false);
  });

  it("the published expiry is the window's own, not a position timestamp", () => {
    const person = project(NEAR, CLOSE_KM);
    assert.equal(person.availability.publishedUntil, "2026-09-22T20:00:00.000Z");
    assert.equal(person.proximity.freshness, "live", "freshness is a bucket, not an instant");
  });
});

describe("ranking order does not disclose sub-bucket distance", () => {
  it("precondition: both people really are in the same bucket at different true distances", () => {
    const viewerPoint = coarsePointFor(VIEWER, ORIGIN.lat, ORIGIN.lng, "neighborhood");
    const a = proximityBucketBetween(viewerPoint, pointAt(NEAR, CLOSE_KM));
    const b = proximityBucketBetween(viewerPoint, pointAt(FAR_IN_BUCKET, FURTHER_KM));
    assert.equal(a, "same_area");
    assert.equal(b, "same_area");
    assert.notEqual(CLOSE_KM, FURTHER_KM);
  });

  it("same bucket ⇒ same rank, however different the true distance", () => {
    const near = project(NEAR, CLOSE_KM);
    const further = project(FAR_IN_BUCKET, FURTHER_KM);
    assert.equal(
      near.rank,
      further.rank,
      "rank moved with true distance — the ranker is seeing something finer than the bucket",
    );
  });

  it("SWAPPING the two people's true positions does not change the published order", () => {
    const asBuilt = orderReachablePeople(VIEWER, [
      project(NEAR, CLOSE_KM),
      project(FAR_IN_BUCKET, FURTHER_KM),
    ]).map((p) => p.personId);

    // Same two people, positions exchanged. Both remain inside `same_area`.
    const swapped = orderReachablePeople(VIEWER, [
      project(NEAR, FURTHER_KM),
      project(FAR_IN_BUCKET, CLOSE_KM),
    ]).map((p) => p.personId);

    assert.deepEqual(
      swapped,
      asBuilt,
      "the ORDER changed when only the sub-bucket distance changed — the order is disclosing distance",
    );
  });

  it("the order is the per-(viewer, person) tiebreak, and it is stable across polls", () => {
    const people = [project(NEAR, CLOSE_KM), project(FAR_IN_BUCKET, FURTHER_KM)];
    const first = orderReachablePeople(VIEWER, people).map((p) => p.personId);
    const second = orderReachablePeople(VIEWER, [...people].reverse()).map((p) => p.personId);
    assert.deepEqual(second, first, "the list shuffled under the viewer's thumb");

    const expected = [...people]
      .sort((a, b) => stableTiebreak(VIEWER, a.personId) - stableTiebreak(VIEWER, b.personId))
      .map((p) => p.personId);
    assert.deepEqual(first, expected);
  });

  it("a different viewer gets a different tiebreak, so two viewers cannot triangulate", () => {
    const pairs = [NEAR, FAR_IN_BUCKET].map((id) => [
      stableTiebreak(VIEWER, id),
      stableTiebreak(OTHER_VIEWER, id),
    ]);
    assert.notDeepEqual(pairs[0], pairs[1]);
    assert.ok(
      pairs.some(([mine, theirs]) => mine !== theirs),
      "the tiebreak is viewer-independent, so it is a shared ordering of people",
    );
  });

  it("a genuinely further bucket DOES rank lower — the ladder still works", () => {
    const near = project(NEAR, CLOSE_KM);
    const far = project(FAR_IN_BUCKET, 120);
    assert.ok(far.rank < near.rank, "bucket must still be an input, just the only positional one");
    assert.equal(far.proximity.bucket, "same_region");
  });
});

describe("nearbyRank covers §4.3's factors, availability first", () => {
  const base: NearbyRankFactors = {
    availability: "unknown",
    relationship: "none",
    intentOverlap: 0,
    sharedContextCount: 0,
    overlap: "unknown",
    travel: "unknown",
    proximity: "unknown",
    freshness: "stale",
    safety: "clear",
  };

  it("every named factor moves the score", () => {
    const moves: Array<[string, Partial<NearbyRankFactors>]> = [
      ["availability", { availability: "available_now" }],
      ["relationship", { relationship: "crew" }],
      ["intent", { intentOverlap: 2 }],
      ["shared context", { sharedContextCount: 2 }],
      ["overlap window", { overlap: "evening_plus" }],
      ["travel time", { travel: "walkable" }],
      ["proximity bucket", { proximity: "same_area" }],
      ["freshness", { freshness: "live" }],
      ["safety", { safety: "caution" }],
    ];
    for (const [name, patch] of moves) {
      assert.notEqual(nearbyRank({ ...base, ...patch }), nearbyRank(base), `${name} did not move the rank`);
    }
  });

  it("availability outranks proximity: available-and-far beats unavailable-and-close", () => {
    const availableFar = nearbyRank({ ...base, availability: "available_now", proximity: "far" });
    const unavailableClose = nearbyRank({
      ...base,
      availability: "unavailable",
      proximity: "same_area",
      travel: "walkable",
    });
    assert.ok(availableFar > unavailableClose);
  });

  it("a safety caution costs more than a full relationship tier", () => {
    const clear: NearbyRankFactors = { ...base, availability: "available_now", relationship: "friend" };
    const flagged: NearbyRankFactors = { ...clear, safety: "caution" };
    const oneTierWeaker: NearbyRankFactors = { ...clear, relationship: "shared_context" };
    assert.ok(nearbyRank(flagged) < nearbyRank(clear), "a caution must demote");
    assert.ok(
      nearbyRank(clear) - nearbyRank(flagged) > nearbyRank(clear) - nearbyRank(oneTierWeaker),
      "a caution must cost more than being one relationship tier further away",
    );
  });

  it("count-shaped inputs are capped, so one dimension cannot dominate", () => {
    const capped = nearbyRank({ ...base, sharedContextCount: 4 });
    assert.equal(nearbyRank({ ...base, sharedContextCount: 400 }), capped);
    assert.equal(nearbyRank({ ...base, sharedContextCount: -5 }), nearbyRank(base));
  });

  it("the score is an integer — no continuous tail to invert", () => {
    assert.equal(Number.isInteger(nearbyRank({ ...base, availability: "available_now" })), true);
  });
});

describe("relationshipFrom projects the canonical resolver and invents nothing", () => {
  it("origins and tier come from the context alone", () => {
    assert.deepEqual(relationshipFrom(FRIENDS), { tier: "friend", origins: ["FRIEND", "MUTUAL_FOLLOW"] });
    assert.deepEqual(
      relationshipFrom({ ...FRIENDS, isFriend: false, sharedCircle: true }),
      { tier: "crew", origins: ["CREW", "MUTUAL_FOLLOW"] },
    );
    assert.deepEqual(
      relationshipFrom({
        isFriend: false,
        senderFollowsRecipient: true,
        recipientFollowsSender: false,
        sharedTrip: false,
        sharedCircle: false,
      }),
      { tier: "follow", origins: ["FOLLOW"] },
    );
    assert.deepEqual(
      relationshipFrom({
        isFriend: false,
        senderFollowsRecipient: false,
        recipientFollowsSender: false,
        sharedTrip: false,
        sharedCircle: false,
      }),
      { tier: "none", origins: [] },
    );
  });
});
