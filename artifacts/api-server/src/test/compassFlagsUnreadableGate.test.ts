/**
 * census-discovery §103 (DV-83, W11-X2 round 7; D-W11X2-49): a Compass batch gated by
 * the FAIL-SAFE flag map is said to be one, never passed off as Compass's answer.
 *
 * When the COMPASS_% read resolves an error, `fetchCompassFlags` answers
 * FAILSAFE_COMPASS_FLAGS, in which every `COMPASS_<TYPE>_SAFETY_BLOCK` is engaged, so
 * every candidate of those types is blocked. Discovery's For You page (3455 on: the gate;
 * 3455 off: the Compass order) and the For You tab's picks section served that as an
 * empty answer. The posture (fail-closed) is Compass's and is kept; the silence goes:
 *   R1  runPipeline reports `flagsUnreadable` when the fail-safe map gated the batch
 *   R2  rankItemsForDiscovery throws CompassFlagsUnreadableError instead of an empty ranking
 *   R3  buildSection throws it too (the section route answers compass_flags_unreadable)
 *   R4  compassEligibleForDiscovery carries it to the Discovery gate
 *   C1  CONTROL: a healthy read — no key, the summary is unchanged in shape
 *   C2  CONTROL: a THROWN read (not a PostgREST builder) keeps its historical empty map: no key
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../compass/CompassPipeline.js";
import { rankItemsForDiscovery, buildSection, compassEligibleForDiscovery, CompassFlagsUnreadableError } from "../compass/CompassFeedBuilder.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

const USER = "ad000000-0000-4000-a000-000000000001";
const profile: CompassProfile = {
  userId: USER, preferredCities: [], preferredLanguages: ["en"], budgetStyle: null, travelStyles: [], socialStyle: null,
  safetyPreference: "standard", visibilityPreference: "semi_private", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [],
  blockCount: 0, blockerCount: 0, trustScore: 75, trustLevel: "trusted_traveler", activeUserScore: null, hasActiveTrip: false,
  hasActiveBooking: false, upcomingTripWithin48h: false, hasFutureTripScheduled: false, currentCity: "Miami", currentCountry: "US",
  safeReturnActive: false, categoryWeights: null, ignoredItemIds: [], mutedHashtags: [], computedAt: new Date().toISOString(),
};
const context: CompassContext = {
  contextState: "exploring_now",
  signals: { hourUtc: 14, safeReturnActive: false, activeBooking: false, upcomingTripWithin48h: false, activeTripNow: false, hasPendingDelayedPosts: false, hasFutureTripScheduled: false },
  computedAt: new Date().toISOString(),
} as CompassContext;
const items: CompassItem[] = [1, 2, 3].map((n) => ({ id: `discovery:p${n}`, type: "suggestion", contentBody: `Place ${n}`, interestTags: ["food"], visibility: "public" } as unknown as CompassItem));

/** Every read resolves empty; the COMPASS_% flag read resolves `flags` (an error, or rows), or THROWS. */
function db(flags: "error" | "throw" | Array<{ flag: string; enabled: boolean }>): any {
  const empty = { data: [], error: null };
  const builder = (table: string): any => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (f: any, r: any) => Promise.resolve(empty).then(f, r);
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null });
      if (prop === "like" && table === "feature_flags") {
        return () => {
          if (flags === "throw") throw new TypeError("not a PostgREST builder");
          const answer = flags === "error" ? { data: null, error: { code: "57014", message: "statement timeout" } } : { data: flags, error: null };
          return { then: (f: any, r: any) => Promise.resolve(answer).then(f, r) };
        };
      }
      return () => builder(table);
    },
  });
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve(empty) };
}

describe("§103 a batch gated by the fail-safe Compass flag map is said to be one (D-W11X2-49)", () => {
  it("R1 runPipeline: the flag read resolves an error → flagsUnreadable, and every suggestion is blocked", async () => {
    const s = await runPipeline(items, profile, context, db("error"));
    assert.equal(s.flagsUnreadable, true);
    assert.equal(s.results.length, 0);
    assert.equal(s.blockedCount, 3);
  });

  it("R2 rankItemsForDiscovery throws CompassFlagsUnreadableError instead of answering an empty ranking", async () => {
    await assert.rejects(rankItemsForDiscovery(items, profile, context, db("error"), { skipActiveRewards: true, skipFairExposure: true } as never), CompassFlagsUnreadableError);
  });

  it("R3 buildSection throws it too", async () => {
    await assert.rejects(buildSection("compass_picks" as never, items, profile, context, db("error"), null, { placeAffinities: {} } as never), CompassFlagsUnreadableError);
  });

  it("R4 compassEligibleForDiscovery carries flagsUnreadable to the Discovery gate", async () => {
    const g = await compassEligibleForDiscovery(items, profile, context, db("error"));
    assert.equal(g.flagsUnreadable, true);
    assert.equal(g.eligibleIds.size, 0);
  });

  it("C1 CONTROL: a healthy read — no flagsUnreadable key anywhere, candidates pass", async () => {
    const s = await runPipeline(items, profile, context, db([]));
    assert.equal("flagsUnreadable" in s, false);
    assert.equal(s.results.length, 3);
    const g = await compassEligibleForDiscovery(items, profile, context, db([]));
    assert.equal("flagsUnreadable" in g, false);
    assert.equal(g.eligibleIds.size, 3);
  });

  it("C2 CONTROL: a THROWN flag read keeps its historical empty map — nothing blocked, no key", async () => {
    const s = await runPipeline(items, profile, context, db("throw"));
    assert.equal("flagsUnreadable" in s, false);
    assert.equal(s.results.length, 3);
  });
});
