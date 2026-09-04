/**
 * Wall For You — ranker viewer signals (spec §13/§14).
 *
 * loadViewerContext resolves the viewer's interests and preferred/home cities,
 * but the For You rank viewer used to be built inline WITHOUT them, so
 * WallRankingService.toViewerContext fed the ranker empty travelStyles /
 * preferredCities and InterestFit (viewerRelevance) + DestinationFit
 * (contentRelevance) collapsed to their neutral floor on every request.
 *
 * Proves (a) buildForYouRankViewer maps interests → travelStyles and
 * preferred cities → preferredCities, and (b) those signals actually DRIVE For
 * You ordering: flipping the viewer's interest flips which of two otherwise-
 * identical items ranks first — impossible if travelStyles were empty.
 *
 * Runs with sc = null + injected ranking-flag overrides, so no DB is touched.
 *
 * Run: node --import tsx/esm --test src/test/wallRankViewerSignals.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildForYouRankViewer, type WallViewerContext } from "../routes/wall.js";
import { rankForYou, type WallRankSignals } from "../services/wall/WallRankingService.js";
import type { WallProjection } from "../lib/wallProjection.js";

const RANK_OVERRIDES = { flags: { ACTIVITY_DISCOVERY_BOOST_ENABLED: false } };
const AT = "2026-09-01T00:00:00.000Z";

function ctx(opts: { interests?: string[]; preferredCities?: string[] } = {}): WallViewerContext {
  return {
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
    currentCity: null,
    currentCountry: null,
    mutualFollowedAuthorIds: new Set<string>(),
    upcomingTripCities: new Set<string>(),
    preferredCities: new Set(opts.preferredCities ?? []),
    interests: new Set(opts.interests ?? []),
  };
}

function proj(id: string): WallProjection {
  return {
    projectionId: "p_" + id,
    objectType: "social_post",
    canonicalObjectId: id,
    publishedAt: AT, // identical publish time ⇒ freshness cannot be the differentiator
    visibility: "public",
    actions: [],
  };
}

// Two otherwise-identical items whose ONLY difference is category/tags.
const SIGNALS = new Map<string, WallRankSignals>([
  ["night", { tags: ["nightlife"], category: "nightlife", isFirstImpression: true }],
  ["muse", { tags: ["museum"], category: "museum", isFirstImpression: true }],
]);
const INPUT = [proj("muse"), proj("night")]; // museum first in input order

describe("buildForYouRankViewer — the §14 viewer signals reach the ranker", () => {
  it("maps interests → travelStyles and preferred cities → preferredCities", () => {
    const rv = buildForYouRankViewer(
      ctx({ interests: ["nightlife", "food"], preferredCities: ["bangkok"] }),
      "viewer-1",
    );
    assert.deepEqual([...(rv.travelStyles ?? [])].sort(), ["food", "nightlife"]);
    assert.deepEqual(rv.preferredCities, ["bangkok"]);
    assert.equal(rv.viewerId, "viewer-1");
  });

  it("carries an EMPTY set through when the viewer has no interests (no crash, honest floor)", () => {
    const rv = buildForYouRankViewer(ctx(), "viewer-1");
    assert.deepEqual(rv.travelStyles, []);
    assert.deepEqual(rv.preferredCities, []);
  });

  it("interests DRIVE For You ordering — flipping the interest flips the winner", async () => {
    const wantsNightlife = await rankForYou(
      null,
      INPUT,
      buildForYouRankViewer(ctx({ interests: ["nightlife"] }), "viewer-1"),
      { limit: 10, signals: SIGNALS, rankOverrides: RANK_OVERRIDES },
    );
    assert.equal(
      wantsNightlife.items[0].canonicalObjectId,
      "night",
      "the nightlife item outranks the museum item for a nightlife-interested viewer",
    );

    const wantsMuseums = await rankForYou(
      null,
      INPUT,
      buildForYouRankViewer(ctx({ interests: ["museum"] }), "viewer-1"),
      { limit: 10, signals: SIGNALS, rankOverrides: RANK_OVERRIDES },
    );
    assert.equal(
      wantsMuseums.items[0].canonicalObjectId,
      "muse",
      "flipping the viewer's interest flips the top item — proving travelStyles is not empty",
    );
  });
});
