/**
 * T382 (§30A.2) — the server-built `ReachablePersonProjection`, and the consent
 * rules it must fail closed on.
 *
 * Nothing about a person is published unless they affirmatively granted it:
 *
 *   block state unknown         → refused (not "probably fine")
 *   relationship read degraded  → refused (not published at a floor)
 *   person invisible            → refused from Nearby entirely
 *   no presence consent         → no proximity bucket, ever
 *   no availability consent     → no availability state, ever
 *   nothing left to say         → refused, rather than a name on a presence
 *                                 surface with no stated reason
 *
 * And the §4.4 pair: a viewer in invisible mode loses proximity (they publish no
 * point, so there is nothing to measure from) but keeps availability and their
 * private map.
 *
 * Run: node --import tsx/esm --test src/test/reachablePersonProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coarsePointFor } from "../lib/proximityBuckets.js";
import { VISIBLE, resolveInvisibleMode } from "../lib/invisibleMode.js";
import {
  countSharedIntents,
  projectReachablePerson,
  reachableTelemetry,
  viewerMayUsePrivateMap,
  type ProjectionOutcome,
  type ReachablePersonInputs,
  type ReachablePersonProjection,
} from "../services/telegraph/reachablePeople.js";
import type { RelationshipContext } from "../lib/messagingPermissions.js";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

const CREW: RelationshipContext = {
  isFriend: false,
  senderFollowsRecipient: false,
  recipientFollowsSender: false,
  sharedTrip: false,
  sharedCircle: true,
};

const INVISIBLE = resolveInvisibleMode({ prefs: { sharing_paused: true }, prefsError: null });
const UNREADABLE = resolveInvisibleMode({ prefs: null, prefsError: { message: "boom" } });

function base(overrides: Partial<ReachablePersonInputs> = {}): ReachablePersonInputs {
  return {
    viewerId: VIEWER,
    personId: PERSON,
    viewerPoint: coarsePointFor(VIEWER, 41.15, -8.61, "neighborhood"),
    personPoint: coarsePointFor(PERSON, 41.152, -8.612, "neighborhood"),
    relationshipContext: CREW,
    relationshipDegraded: false,
    blocked: false,
    blockStateKnown: true,
    personInvisible: VISIBLE,
    viewerInvisible: VISIBLE,
    personPresenceConsent: true,
    availabilityPublished: true,
    availabilityState: "available_now",
    availabilityIntents: ["Food", "Drinks"],
    availabilityWindow: { startMs: 0, endMs: 2 * 3_600_000 },
    viewerWindow: { startMs: 0, endMs: 2 * 3_600_000 },
    availabilityPublishedUntil: "2026-09-22T22:00:00.000Z",
    personFreshness: "live",
    safety: "clear",
    sharedTrips: 1,
    sharedCircles: 1,
    viewerIntents: ["Food"],
    ...overrides,
  };
}

function refusalOf(outcome: ProjectionOutcome): string {
  assert.equal(outcome.ok, false, "expected a refusal");
  return (outcome as { ok: false; refusal: string }).refusal;
}

function personOf(outcome: ProjectionOutcome): ReachablePersonProjection {
  assert.equal(outcome.ok, true, "expected a projection");
  return (outcome as { ok: true; person: ReachablePersonProjection }).person;
}

describe("the happy path builds the whole §30A.2 shape", () => {
  it("relationship, availability, permitted proximity, shared context, privacy and safety", () => {
    const person = personOf(projectReachablePerson(base()));
    assert.equal(person.relationship.tier, "crew");
    assert.deepEqual([...person.relationship.origins], ["CREW"]);
    assert.equal(person.availability.state, "available_now");
    assert.deepEqual([...person.availability.intents], ["Food", "Drinks"]);
    assert.equal(person.availability.overlap, "hour_plus");
    assert.equal(person.proximity.bucket, "same_area");
    assert.equal(person.proximity.precision, "bucket");
    assert.equal(person.proximity.travel, "walkable");
    assert.deepEqual([...person.sharedContext.kinds].sort(), ["circle", "trip"]);
    assert.equal(person.privacy.availabilityPublished, true);
    assert.equal(person.privacy.proximityPublished, true);
    assert.equal(person.privacy.preciseShared, false);
    assert.equal(person.safety.state, "clear");
    assert.ok(person.rank > 0);
  });
});

describe("safety and identity refusals", () => {
  it("self is refused", () => {
    assert.equal(refusalOf(projectReachablePerson(base({ personId: VIEWER }))), "self");
  });

  it("a block refuses", () => {
    assert.equal(refusalOf(projectReachablePerson(base({ blocked: true }))), "blocked");
  });

  it("BLOCK STATE UNKNOWN refuses — it is not the same as 'not blocked'", () => {
    assert.equal(
      refusalOf(projectReachablePerson(base({ blockStateKnown: false, blocked: false }))),
      "blocked",
    );
  });

  it("a DEGRADED relationship read refuses rather than publishing a floor", () => {
    assert.equal(
      refusalOf(projectReachablePerson(base({ relationshipDegraded: true }))),
      "relationship_unknown",
    );
  });

  it("an absent relationship context refuses", () => {
    assert.equal(
      refusalOf(projectReachablePerson(base({ relationshipContext: null }))),
      "relationship_unknown",
    );
  });
});

describe("consent refusals", () => {
  it("an invisible PERSON is removed from Nearby entirely, availability and all", () => {
    assert.equal(refusalOf(projectReachablePerson(base({ personInvisible: INVISIBLE }))), "invisible");
  });

  it("a person whose preferences could not be read is invisible, so also refused", () => {
    assert.equal(refusalOf(projectReachablePerson(base({ personInvisible: UNREADABLE }))), "invisible");
  });

  it("no presence consent → no bucket; availability alone still publishes", () => {
    const person = personOf(projectReachablePerson(base({ personPresenceConsent: false })));
    assert.equal(person.proximity.bucket, "unknown");
    assert.equal(person.privacy.proximityPublished, false);
    assert.equal(person.proximity.travel, "unknown");
    assert.equal(person.availability.state, "available_now");
  });

  it("no availability consent → no state; proximity alone still publishes", () => {
    const person = personOf(projectReachablePerson(base({ availabilityPublished: false })));
    assert.equal(person.availability.state, "unknown");
    assert.deepEqual([...person.availability.intents], []);
    assert.equal(person.availability.publishedUntil, null);
    assert.equal(person.availability.overlap, "unknown");
    assert.equal(person.proximity.bucket, "same_area");
  });

  it("a person invisible for public availability keeps no availability even if a window says otherwise", () => {
    // Invisible mode suppresses `public_availability` as well as `nearby`, so a
    // published window cannot re-open the surface a person closed.
    const outcome = projectReachablePerson(
      base({ personInvisible: INVISIBLE, availabilityPublished: true }),
    );
    assert.equal(refusalOf(outcome), "invisible");
  });

  it("neither consent → refused, not an empty card with a name on it", () => {
    assert.equal(
      refusalOf(
        projectReachablePerson(base({ personPresenceConsent: false, availabilityPublished: false })),
      ),
      "no_presence_consent",
    );
    assert.equal(
      refusalOf(
        projectReachablePerson(base({ availabilityPublished: false, personPoint: null })),
      ),
      "no_availability_consent",
    );
  });

  it("a stale position with nothing else to say is refused", () => {
    const outcome = projectReachablePerson(
      base({ personFreshness: "stale", availabilityPublished: false }),
    );
    assert.equal(refusalOf(outcome), "stale");
  });
});

describe("§4.4 both halves, from the viewer's side", () => {
  it("an INVISIBLE VIEWER loses proximity — there is no point to measure from", () => {
    const person = personOf(projectReachablePerson(base({ viewerInvisible: INVISIBLE })));
    assert.equal(person.proximity.bucket, "unknown");
    assert.equal(person.privacy.proximityPublished, false);
  });

  it("…but keeps availability, and keeps the private map", () => {
    const person = personOf(projectReachablePerson(base({ viewerInvisible: INVISIBLE })));
    assert.equal(person.availability.state, "available_now");
    assert.equal(viewerMayUsePrivateMap(INVISIBLE), true);
    assert.equal(viewerMayUsePrivateMap(UNREADABLE), true);
  });

  it("a viewer with no position of their own gets no buckets — reciprocity, as arithmetic", () => {
    const person = personOf(projectReachablePerson(base({ viewerPoint: null })));
    assert.equal(person.proximity.bucket, "unknown");
  });
});

describe("intent overlap", () => {
  it("counts shared intents case-insensitively and nothing else", () => {
    assert.equal(countSharedIntents(["Food", "Drinks"], ["drinks", "Nightlife"]), 1);
    assert.equal(countSharedIntents([], ["Food"]), 0);
    assert.equal(countSharedIntents(["Food"], []), 0);
    assert.equal(countSharedIntents(["Food"], ["Food", "Food"]), 2);
  });

  it("intent overlap is zero when availability was not published", () => {
    const withIntent = personOf(projectReachablePerson(base()));
    const withoutAvailability = personOf(projectReachablePerson(base({ availabilityPublished: false })));
    assert.ok(withIntent.rank > withoutAvailability.rank);
  });
});

describe("telemetry is countable and carries no person", () => {
  it("counts by bucket and by refusal reason, and no ids", () => {
    const person = personOf(projectReachablePerson(base()));
    const t = reachableTelemetry([person], ["blocked", "blocked", "invisible"], {
      viewerInvisible: false,
      degraded: false,
    });
    assert.equal(t.published, 1);
    assert.deepEqual(t.refusals, { blocked: 2, invisible: 1 });
    assert.deepEqual(t.buckets, { same_area: 1 });
    const serialised = JSON.stringify(t);
    assert.equal(serialised.includes(PERSON), false, "telemetry named a person");
    assert.equal(serialised.includes(VIEWER), false, "telemetry named the viewer");
  });
});
