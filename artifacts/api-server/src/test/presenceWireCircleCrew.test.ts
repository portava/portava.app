/**
 * THE LAST TWO OF THE FOUR: `circle_presence` and `trip_crew_location_sessions`
 * read their rung through the presence fusion layer.
 *
 * census-sensing S3 names four presence models and asks that ONE store and
 * fusion layer sit behind all four. Two of them — `locateFriendsSession` and
 * the map's three kinds — were wired by the lane that built the store;
 * `presenceFusionWiring.test.ts` tallies that. The other two could not be
 * reached from that lane's file ownership, and `sources.ts` recorded exactly
 * why, per source, in `blockedBy`.
 *
 * This file is the evidence for the remaining two. It asserts the three things
 * that separate real wiring from a call whose result is thrown away:
 *
 *   1. THE ESTIMATE IS THE STORE'S. `isFused` is true only for an object this
 *      process's store minted — a structural cast, a literal or a JSON
 *      round-trip all fail it. So an assertion about `isFused(e)` is an
 *      assertion that the rung below came from the fusion layer.
 *   2. THE RUNG IS LOAD-BEARING. What each source serves is gated on
 *      `estimate.precision`, so a source that stopped consulting the store
 *      would serve a label or a coordinate the store never admitted.
 *   3. THE GATE NARROWS, IT DOES NOT ECHO. An over-claiming crew card — one
 *      carrying exact coordinates with no live-share grant behind them — is
 *      STRIPPED here. That is the crew half of what
 *      `presenceFusionWiring.test.ts` already proves for the map ("a producer
 *      that over-claims is NARROWED by the gate"): if the gate merely re-stated
 *      what the producer decided, this case would pass through untouched.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isFused } from "../presence/fusion/store.js";
import { PRESENCE_SOURCE_CONTRACTS } from "../presence/fusion/sources.js";
import { precisionRank } from "../presence/domain/types.js";
import {
  circlePresenceEstimate,
  shapePresence,
  type CircleProfileSnippet,
} from "../lib/circleResponseShaper.js";
import {
  admitCrewPresence,
} from "../domain/trips/services/TripCrewLocationService.js";
import { buildCrewCard, type RawMemberLocation } from "../domain/trips/services/tripCrewLocation.js";

// ── circle_presence ───────────────────────────────────────────────────────────

const PROFILE: CircleProfileSnippet = {
  userId: "11111111-1111-4111-8111-111111111111",
  avatarUrl: null,
  displayName: "Target",
  username: "target",
};

function presenceRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "pres-1",
    status: "active",
    status_label: null,
    approximate_label: "Makati CBD",
    venue_label: "SM Mall",
    checked_in: false,
    is_stale: false,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

describe("circle_presence reads its rung through the fusion store", () => {
  test("the register says so, and names the module a reader can check", () => {
    const c = PRESENCE_SOURCE_CONTRACTS.circle_presence;
    assert.equal(c.readsThrough, "src/lib/circleResponseShaper.ts");
    assert.equal(c.blockedBy, null, "a wired source may not keep an excuse");
  });

  test("the shaper's rung is a SEALED estimate from the store, not a local decision", () => {
    const e = circlePresenceEstimate(PROFILE, presenceRow(), "approximate_area", false);
    assert.ok(e, "no estimate was minted for a visible circle presence row");
    assert.ok(isFused(e), "the shaper produced something the store did not mint");
    assert.equal(e.source, "circle_presence");
    assert.equal(e.precision, "venue", "a circle label occupies the `venue` rung");
    assert.equal(e.linkage, "account_scoped");
  });

  test("status_only lands BELOW the label rung, which is why it carries no label", () => {
    const e = circlePresenceEstimate(PROFILE, presenceRow(), "status_only", false);
    assert.ok(e && isFused(e));
    assert.equal(e.precision, "presence_only");
    assert.ok(
      precisionRank(e.precision) < precisionRank("venue"),
      "status_only must not reach the rung a venue/area label occupies",
    );
    const shaped = shapePresence(PROFILE, presenceRow(), "status_only", false);
    assert.equal(shaped.approximateLabel, null);
    assert.equal(shaped.venueLabel, null);
  });

  test("venue_checkin reaches the label rung only when the member is checked in", () => {
    const out = circlePresenceEstimate(PROFILE, presenceRow({ checked_in: false }), "venue_checkin", false);
    assert.equal(out?.precision, "presence_only");
    const inn = circlePresenceEstimate(PROFILE, presenceRow({ checked_in: true }), "venue_checkin", false);
    assert.equal(inn?.precision, "venue");
    assert.equal(
      shapePresence(PROFILE, presenceRow({ checked_in: true }), "venue_checkin", false).venueLabel,
      "SM Mall",
    );
  });

  test("a refusal WITHHOLDS the label — the store is in the path, not beside it", () => {
    // An empty subject is the store's `no_subject` refusal. Before the shaper
    // read through the store this row's label was served regardless, because
    // nothing between the row and the response had an opinion about the
    // subject. The label now depends on an admission that did not happen.
    const anonymous: CircleProfileSnippet = { ...PROFILE, userId: "   " };
    assert.equal(circlePresenceEstimate(anonymous, presenceRow(), "approximate_area", false), null);
    const shaped = shapePresence(anonymous, presenceRow(), "approximate_area", false);
    assert.equal(shaped.approximateLabel, null, "a label was served for a presence the store refused");
    assert.equal(shaped.venueLabel, null);
    // Everything that is NOT a location still renders: a refused location is
    // not a refused member.
    assert.equal(shaped.status, "active");
    assert.equal(shaped.presenceAbsent, false);
  });

  test("the `venue` ceiling makes a circle COORDINATE unrepresentable, not merely absent", () => {
    // `publicLat`/`publicLng` are read off the sealed estimate's position. The
    // source ceiling is `venue`, and the store retains a point only at
    // `precise`, so no future column can put a coordinate on this response
    // without the register's ceiling being raised in a reviewed diff.
    const e = circlePresenceEstimate(PROFILE, presenceRow(), "approximate_area", false);
    assert.equal(e?.position, null);
    const shaped = shapePresence(PROFILE, presenceRow(), "approximate_area", false);
    assert.equal(shaped.publicLat, null);
    assert.equal(shaped.publicLng, null);
  });

  test("an absent presence row mints nothing and still shapes the member", () => {
    assert.equal(circlePresenceEstimate(PROFILE, null, "approximate_area", false), null);
    const shaped = shapePresence(PROFILE, null, "approximate_area", false);
    assert.equal(shaped.presenceAbsent, true);
    assert.equal(shaped.approximateLabel, null);
  });
});

// ── trip_crew_location_sessions ───────────────────────────────────────────────

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const MIN = 60_000;
const POINT = { lat: 10.3273, lng: 123.9057 };

function sharer(over: Partial<RawMemberLocation> = {}): RawMemberLocation {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    name: "Sharer",
    handle: "sharer",
    avatarUrl: null,
    prefs: {
      defaultVisibility: "neighborhood",
      ghostModeEnabled: false,
      shareArrivalStatus: true,
      shareSafeReturnStatus: false,
    },
    locationState: {
      city: "Cebu City",
      district: "IT Park",
      country: "PH",
      updatedAt: new Date(NOW - MIN).toISOString(),
      lastKnownAt: new Date(NOW - MIN).toISOString(),
      source: "gps",
      accuracyMeters: 20,
      lat: POINT.lat,
      lng: POINT.lng,
    },
    hotelBlurEnabled: false,
    checkInStatus: null,
    hasSafeReturnActive: false,
    liveShare: {
      id: "sess-1",
      visibilityLevel: "nearby",
      expiresAt: new Date(NOW + 30 * MIN).toISOString(),
    },
    ...over,
  };
}

function admit(raw: RawMemberLocation, nowMs: number = NOW) {
  return admitCrewPresence(buildCrewCard(raw, nowMs), raw, nowMs);
}

describe("trip_crew_location_sessions reads its rung through the fusion store", () => {
  test("the register says so, and names the module a reader can check", () => {
    const c = PRESENCE_SOURCE_CONTRACTS.trip_crew_location_sessions;
    assert.equal(c.readsThrough, "src/domain/trips/services/TripCrewLocationService.ts");
    assert.equal(c.blockedBy, null, "a wired source may not keep an excuse");
  });

  test("an active grant over a fresh position lands on `precise`, and the coordinate comes OFF the estimate", () => {
    const r = admit(sharer());
    assert.ok(r.estimate, `refused: ${r.refusal}`);
    assert.ok(isFused(r.estimate), "the crew map produced something the store did not mint");
    assert.equal(r.estimate.source, "trip_crew_location_sessions");
    assert.equal(r.estimate.precision, "precise");
    assert.deepEqual(r.estimate.position, POINT);
    assert.deepEqual(r.card.exactCoords, POINT, "the served coordinate must be the admitted one");
  });

  test("hotel/home blur narrows the rung below `precise`, so no coordinate survives", () => {
    const r = admit(sharer({ hotelBlurEnabled: true }));
    assert.ok(r.estimate);
    assert.ok(
      precisionRank(r.estimate.precision) < precisionRank("precise"),
      `blurred member came back at ${r.estimate.precision}`,
    );
    assert.equal(r.estimate.position, null);
    assert.equal(r.card.exactCoords ?? null, null);
  });

  test("a position that may not be drawn as current cannot reach `precise`", () => {
    const stale = sharer({
      locationState: {
        ...sharer().locationState!,
        updatedAt: new Date(NOW - 120 * MIN).toISOString(),
        lastKnownAt: new Date(NOW - 120 * MIN).toISOString(),
      },
    });
    const r = admit(stale);
    // Older than the store's TTL: the store refuses outright rather than
    // minting an estimate nobody may draw.
    assert.equal(r.estimate, null);
    assert.equal(r.refusal, "expired");
    assert.equal(r.card.exactCoords ?? null, null);
  });

  test("no grant means no coordinate rung, even with a fresh point on file", () => {
    const r = admit(sharer({ liveShare: null }));
    assert.ok(r.estimate);
    assert.ok(precisionRank(r.estimate.precision) < precisionRank("precise"));
    assert.equal(r.card.exactCoords ?? null, null);
  });

  test("a ghosted member is SUPPRESSED — nothing is admitted for them at all", () => {
    const r = admit(sharer({
      prefs: { ...sharer().prefs!, ghostModeEnabled: true },
    }));
    assert.equal(r.estimate, null);
    assert.equal(r.refusal, "suppressed");
    assert.equal(r.card.ghostMode, true);
    assert.equal(r.card.statusLabel, "location_hidden");
    assert.equal(r.card.exactCoords ?? null, null);
  });

  test("A PRODUCER THAT OVER-CLAIMS IS STRIPPED — the gate narrows, it does not echo", () => {
    // A card carrying exact coordinates with NO live-share grant behind them.
    // If the gate merely re-stated the card's own decision this would survive;
    // it is the crew analogue of the map's over-claim case.
    const raw = sharer({ liveShare: null });
    const overclaimed = { ...buildCrewCard(raw, NOW), exactCoords: { ...POINT } };
    const r = admitCrewPresence(overclaimed, raw, NOW);
    assert.equal(r.card.exactCoords ?? null, null, "a coordinate with no grant behind it was served");
    assert.deepEqual(overclaimed.exactCoords, POINT, "the input card must not be mutated");
  });

  test("the crew map answers at the instant it is given, and so does its claim", () => {
    // The grant ends 30 minutes after NOW. Asked about an instant past that,
    // the grant is spent and the rung falls — the store is handed the same
    // clock the rest of the map is judged on, not a wall clock of its own.
    const raw = sharer();
    const later = NOW + 90 * MIN;
    const r = admitCrewPresence(buildCrewCard(raw, later), raw, later);
    assert.equal(r.card.exactCoords ?? null, null);
    assert.notEqual(r.estimate?.precision, "precise");
  });
});
