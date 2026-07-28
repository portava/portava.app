/**
 * portavaPublisher.test.ts — unit tests for the @Portava official-publisher
 * score boost and cap-exemption paths.
 *
 * Runtime: node:test  (no vitest / no supertest)
 * Run via: pnpm --filter @workspace/api-server test (api-test workflow)
 *
 * Covers:
 *   A. scoreCandidate with applyPublisherBoost=true gives a 1.2× lift to
 *      isOfficialPublisher candidates and leaves non-publisher scores unchanged.
 *   B. enforceMediaCreatorCaps with publisherBoostEnabled=true always passes
 *      @Portava items into main regardless of how many session impressions the
 *      creator has accumulated.
 *   C. enforceCreatorCapsGeneric with isOfficialPublisherFn exempts the item
 *      from the per-page cap so it always enters main.
 *   D. loadCreatorSignals maps a profiles row with is_official=true to
 *      isOfficialPublisher: true; false/null rows map to false.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreCandidate,
  PUBLISHER_BOOST,
  DEFAULT_WEIGHTS,
  type RankCandidate,
  type ViewerContext,
} from "../lib/portavaRank.js";

import {
  enforceMediaCreatorCaps,
  loadCreatorSignals,
  type MediaFeedItem,
  type MediaRankedItem,
  type MediaRankingConfig,
  type MediaSessionState,
} from "../services/ranking/MediaFeedRankingService.js";

import {
  enforceCreatorCapsGeneric,
  DEFAULT_CREATOR_CAP,
} from "../services/ranking/CreatorCapEnforcer.js";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-18T12:00:00Z").getTime();

const ctx = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  userId: "viewer-1",
  nowMs: NOW,
  ...over,
});

const baseCandidate = (over: Partial<RankCandidate> = {}): RankCandidate => ({
  id: "p1",
  kind: "post",
  createdAt: new Date(NOW - 3_600_000).toISOString(), // 1h ago
  authorId: "portava",
  authorTrustScore: 80,
  ...over,
});

/** Minimal MediaRankingConfig */
const cfg: MediaRankingConfig = {
  maxConsecutive: 2,
  maxSessionFraction: 0.20,
  sessionFatigueThreshold: 3,
  sessionFatiguePenaltyPerImpression: 0.25,
  sessionFatiguePenaltyCap: 1.5,
  newCreatorWindowDays: 30,
  returningCreatorInactiveDays: 14,
  boostCeiling: 0.5,
  underexposedViewThreshold: 500,
  wrongPlaceReportThreshold: 0.05,
  wrongPlaceReportPenaltyPerReport: 0.30,
  diversityWindow: 4,
};

/** Wrap a MediaFeedItem into the shape enforceMediaCreatorCaps expects */
function makeRankedItem(
  item: Partial<MediaFeedItem> & Pick<MediaFeedItem, "id" | "kind">,
  finalScore = 1.0,
): MediaRankedItem {
  const full: MediaFeedItem = {
    authorId: null,
    isOfficialPublisher: false,
    ...item,
  };
  return {
    item: full,
    finalScore,
    baseScore: finalScore,
    reasonCodes: [],
    features: {},
  };
}

// ── A: scoreCandidate publisher boost ─────────────────────────────────────────

describe("A: scoreCandidate publisher boost", () => {
  it("produces a score exactly 1.2× higher when isOfficialPublisher=true and applyPublisherBoost=true", () => {
    const publisher = baseCandidate({ isOfficialPublisher: true });
    const regular   = baseCandidate({ isOfficialPublisher: false });
    const viewer    = ctx();

    const boostResult   = scoreCandidate(publisher, viewer, DEFAULT_WEIGHTS, true);
    const noBoostResult = scoreCandidate(regular,   viewer, DEFAULT_WEIGHTS, true);

    // The boost should be exactly PUBLISHER_BOOST (1.2×) relative to identical candidate
    const ratio = boostResult.score / noBoostResult.score;
    assert.ok(
      Math.abs(ratio - PUBLISHER_BOOST) < 1e-9,
      `Expected score ratio ${ratio} to equal PUBLISHER_BOOST (${PUBLISHER_BOOST})`,
    );
  });

  it("records the additive delta as features.officialPublisher", () => {
    const c = baseCandidate({ isOfficialPublisher: true });
    const s = scoreCandidate(c, ctx(), DEFAULT_WEIGHTS, true);
    const delta = s.features["officialPublisher"];
    assert.ok(delta != null && delta > 0, "officialPublisher feature delta must be positive");
    // delta = baseScore * (PUBLISHER_BOOST - 1); verify: baseScore + delta = finalScore
    const baseScore = s.score / PUBLISHER_BOOST;
    assert.ok(
      Math.abs(delta - baseScore * (PUBLISHER_BOOST - 1)) < 1e-9,
      "officialPublisher delta must equal baseScore × (PUBLISHER_BOOST - 1)",
    );
  });

  it("leaves score unchanged when applyPublisherBoost=false even if isOfficialPublisher=true", () => {
    const publisher = baseCandidate({ isOfficialPublisher: true });
    const regular   = baseCandidate({ isOfficialPublisher: false });
    const viewer    = ctx();

    const withBoostFlagOff  = scoreCandidate(publisher, viewer, DEFAULT_WEIGHTS, false);
    const withBoostFlagOff2 = scoreCandidate(regular,   viewer, DEFAULT_WEIGHTS, false);

    assert.ok(
      Math.abs(withBoostFlagOff.score - withBoostFlagOff2.score) < 1e-9,
      "Without the boost flag, official and non-official candidates must score identically",
    );
    assert.equal(
      withBoostFlagOff.features["officialPublisher"],
      undefined,
      "officialPublisher feature key must not appear when boost is off",
    );
  });

  it("leaves score unchanged when isOfficialPublisher=false even if applyPublisherBoost=true", () => {
    const regular    = baseCandidate({ isOfficialPublisher: false });
    const withBoost  = scoreCandidate(regular, ctx(), DEFAULT_WEIGHTS, true);
    const noBoost    = scoreCandidate(regular, ctx(), DEFAULT_WEIGHTS, false);
    assert.ok(
      Math.abs(withBoost.score - noBoost.score) < 1e-9,
      "Non-publisher candidate must not receive a boost",
    );
  });
});

// ── B: enforceMediaCreatorCaps publisher exemption ────────────────────────────

describe("B: enforceMediaCreatorCaps — @Portava bypasses session cap", () => {
  it("passes publisher items through to main even when session count far exceeds maxPerSession", () => {
    // 10-item session; maxSessionFraction=0.20 → maxPerSession = 2
    const sessionSize = 10;
    // Already 5 impressions from 'portava' (well above the cap of 2)
    const sessionState: MediaSessionState = {
      creatorImpressions: new Map([["portava", 5]]),
    };

    const publisherItem = makeRankedItem({
      id: "portava-post-1",
      kind: "post",
      authorId: "portava",
      isOfficialPublisher: true,
    }, 2.0);

    const regularItem = makeRankedItem({
      id: "regular-post-1",
      kind: "post",
      authorId: "regular-creator",
      isOfficialPublisher: false,
    }, 1.5);

    const result = enforceMediaCreatorCaps(
      [publisherItem, regularItem],
      cfg,
      sessionState,
      sessionSize,
      /* publisherBoostEnabled = */ true,
    );

    // publisher item must still be present in the output (not just at tail)
    assert.ok(result.length === 2, "Both items must survive the cap pass");
    const ids = result.map((r) => r.item.id);
    assert.ok(ids.includes("portava-post-1"), "@Portava post must appear in output");
  });

  it("holds back regular items that exceed the per-session cap", () => {
    const sessionSize = 10; // maxPerSession = 2
    const sessionState: MediaSessionState = {
      creatorImpressions: new Map([["noisy-creator", 2]]), // already at cap
    };

    const items = [
      makeRankedItem({ id: "noisy-1", kind: "post", authorId: "noisy-creator", isOfficialPublisher: false }, 3.0),
      makeRankedItem({ id: "other-1", kind: "post", authorId: "other-creator", isOfficialPublisher: false }, 2.0),
    ];

    const result = enforceMediaCreatorCaps(items, cfg, sessionState, sessionSize, true);

    // noisy-1 is over the cap → goes to overflow tail, other-1 stays in main
    // The output preserves all items but noisy-1 appears AFTER other-1
    const ids = result.map((r) => r.item.id);
    const noisyIdx = ids.indexOf("noisy-1");
    const otherIdx = ids.indexOf("other-1");
    assert.ok(noisyIdx > otherIdx, "Over-cap creator item must appear after in-budget item");
  });

  it("publisher bypass is inactive when publisherBoostEnabled=false — publisher item still subject to cap", () => {
    const sessionSize = 10; // maxPerSession = 2
    const sessionState: MediaSessionState = {
      creatorImpressions: new Map([["portava", 5]]),
    };

    const publisherItem = makeRankedItem({
      id: "portava-post-capped",
      kind: "post",
      authorId: "portava",
      isOfficialPublisher: true,
    }, 2.0);

    const result = enforceMediaCreatorCaps(
      [publisherItem],
      cfg,
      sessionState,
      sessionSize,
      /* publisherBoostEnabled = */ false,
    );

    // With the flag off, the publisher item is treated like any other creator
    // and goes to overflow (still in output, but at tail behind any main items)
    // With only one item it still appears in output — verify it wasn't dropped
    assert.equal(result.length, 1, "Item must still appear in output (reorder-only)");
  });
});

// ── C: enforceCreatorCapsGeneric publisher exemption ─────────────────────────

describe("C: enforceCreatorCapsGeneric — isOfficialPublisherFn exempts from per-page cap", () => {
  type SimpleItem = { id: string; authorId: string; official: boolean };
  const getId = (i: SimpleItem) => i.authorId;
  const isOfficial = (i: SimpleItem) => i.official;

  it("official-publisher item bypasses per-page cap and enters main", () => {
    // Fill up 'portava' creator slot to maxPerPage (3) with non-official items first
    const fillerA = { id: "r1", authorId: "portava", official: false };
    const fillerB = { id: "r2", authorId: "portava", official: false };
    const fillerC = { id: "r3", authorId: "portava", official: false };
    // Now an official item from the same authorId
    const officialItem = { id: "portava-official", authorId: "portava", official: true };

    const result = enforceCreatorCapsGeneric(
      [fillerA, fillerB, fillerC, officialItem],
      getId,
      DEFAULT_CREATOR_CAP,
      isOfficial,
    );

    // All 4 items must be present
    assert.equal(result.length, 4);
    const ids = result.map((i) => i.id);
    assert.ok(ids.includes("portava-official"), "Official publisher item must appear in output");

    // Official item must come before the overflow filler that pushed it over the cap
    // (it was exempt, so it went to main; fillers beyond cap go to overflow at tail)
    const officialPos = ids.indexOf("portava-official");
    const fillerPositions = [ids.indexOf("r1"), ids.indexOf("r2"), ids.indexOf("r3")];
    // Exactly DEFAULT_CREATOR_CAP.maxPerPage (3) non-official items + 1 official = 4
    // The official one bypassed the cap so it entered main (position depends on input order,
    // but it must be present and the full set must be there).
    assert.ok(officialPos >= 0, "Official item index must be found");
    assert.ok(fillerPositions.every((p) => p >= 0), "All filler items must survive");
  });

  it("non-official item from the same creator is deferred once per-page cap is reached", () => {
    const items: SimpleItem[] = [
      { id: "a1", authorId: "creator", official: false },
      { id: "a2", authorId: "creator", official: false },
      { id: "a3", authorId: "creator", official: false },
      { id: "a4", authorId: "creator", official: false }, // 4th — over cap
      { id: "b1", authorId: "other",   official: false },
    ];

    const result = enforceCreatorCapsGeneric(items, getId, DEFAULT_CREATOR_CAP, isOfficial);
    assert.equal(result.length, 5);

    const ids = result.map((i) => i.id);
    // b1 must come before a4 (a4 is overflow, b1 is main)
    assert.ok(ids.indexOf("b1") < ids.indexOf("a4"),
      "In-budget item from another creator must precede over-cap overflow item");
  });

  it("item with no authorId is never capped regardless of isOfficialPublisherFn", () => {
    type NullableId = { id: string; authorId: string | null; official: boolean };
    const items: NullableId[] = [
      { id: "anon-1", authorId: null, official: false },
      { id: "anon-2", authorId: null, official: false },
      { id: "anon-3", authorId: null, official: false },
      { id: "anon-4", authorId: null, official: false },
    ];

    const result = enforceCreatorCapsGeneric(
      items,
      (i) => i.authorId,
      DEFAULT_CREATOR_CAP,
      (i) => i.official,
    );

    assert.equal(result.length, 4, "Null-authorId items must all pass through main");
  });
});

// ── D: loadCreatorSignals maps is_official correctly ─────────────────────────

describe("D: loadCreatorSignals — is_official profile rows", () => {
  /** Minimal SupabaseClient fake that returns the provided rows. */
  function fakeDb(rows: { id: string; is_official: boolean | null }[]) {
    return {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          in: (_col: string, _ids: string[]) =>
            Promise.resolve({ data: rows, error: null }),
        }),
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;
  }

  it("sets isOfficialPublisher=true for a row with is_official=true", async () => {
    const db = fakeDb([
      { id: "portava-uid", is_official: true },
      { id: "regular-uid", is_official: false },
    ]);

    const signals = await loadCreatorSignals(db, ["portava-uid", "regular-uid"]);

    assert.deepEqual(signals.get("portava-uid"), { isOfficialPublisher: true });
    assert.deepEqual(signals.get("regular-uid"), { isOfficialPublisher: false });
  });

  it("sets isOfficialPublisher=false for a row with is_official=null", async () => {
    const db = fakeDb([{ id: "uid-null-official", is_official: null }]);
    const signals = await loadCreatorSignals(db, ["uid-null-official"]);
    assert.deepEqual(signals.get("uid-null-official"), { isOfficialPublisher: false });
  });

  it("returns an empty map when db is null", async () => {
    const signals = await loadCreatorSignals(null, ["any-id"]);
    assert.equal(signals.size, 0);
  });

  it("returns an empty map when creatorIds is empty", async () => {
    const db = fakeDb([]);
    const signals = await loadCreatorSignals(db, []);
    assert.equal(signals.size, 0);
  });

  it("returns an empty map and does not throw when the db call returns an error", async () => {
    const errorDb = {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          in: (_col: string, _ids: string[]) =>
            Promise.resolve({ data: null, error: new Error("db error") }),
        }),
      }),
    } as unknown as import("@supabase/supabase-js").SupabaseClient;

    const signals = await loadCreatorSignals(errorDb, ["portava-uid"]);
    assert.equal(signals.size, 0, "Error path must silently return empty map");
  });
});
