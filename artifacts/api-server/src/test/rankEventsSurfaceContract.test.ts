/**
 * rank_events SURFACE CONTRACT — the Wall's For You page.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS PINS
 * ══════════════════════════════════════════════════════════════════════════════
 * `surface` was doing TWO jobs through one argument to rankItems():
 *
 *   1. WEIGHT PROFILE selection — SURFACE_WEIGHT_PROFILES[surface]. The Wall's
 *      For You page wants the exploration-heavy `explore` profile.
 *   2. The value PERSISTED to rank_events.surface, whose vocabulary the
 *      database constrains with `rank_events_surface_check`.
 *
 * Those two vocabularies DIVERGED. Migration 2893 retired `explore` from the
 * CHECK on the stated grounds that it has "no writer anywhere in the tree" —
 * which was false: WallRankingService wrote it on every For You request. The
 * live CHECK admits `wall` and does NOT admit `explore`, so every one of the
 * ~151 rank_events inserts a For You first page issues was rejected 23514 and
 * dropped by the fire-and-forget logger.warn in DiscoveryRankingService.
 *
 * The trap: simply renaming the constant to "wall" ALSO changes the weight
 * profile, because SURFACE_WEIGHT_PROFILES has no `wall` key and would fall
 * through to `?? {}` — the DEFAULT profile — silently re-ranking every user's
 * For You feed.
 *
 * So this suite pins BOTH halves, and neither alone would catch the other's
 * regression.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TEST-FIRST — WRITTEN AND WATCHED FAIL BEFORE THE FIX
 * ══════════════════════════════════════════════════════════════════════════════
 * This file was written before any change to DiscoveryRankingService.ts or
 * WallRankingService.ts.
 *
 * Two of its four cases name exports that did not exist yet
 * (PERSISTED_RANK_SURFACES, FOR_YOU_WEIGHT_PROFILE, FOR_YOU_ANALYTICS_SURFACE),
 * so the whole MODULE could not load against the unfixed tree — a red that
 * proves nothing about the defect. So the defect assertion was first run in
 * isolation, against the untouched source, with the same fake database and the
 * same admitted-surface list as `the persisted surface is one the live CHECK
 * admits` below. Observed, verbatim:
 *
 *       accepted: 0  rejected: 2  rejected surfaces: [ 'explore' ]
 *       AssertionError: rank_events rows REJECTED 23514; surfaces=["explore"]
 *         + [ { event_type: 'ranking_item_scored', surface: 'explore', … } ]
 *         - []
 *
 *   — every analytics row the For You page produced was rejected and none was
 *   accepted: the production defect, reproduced in-process, before the fix.
 *
 *   ✓ "For You keeps the explore weight profile" was GREEN once the fix made
 *     the module loadable, and would have been green before it too. Reported
 *     honestly rather than contrived into a red: it is the REGRESSION GUARD
 *     for the trap (renaming the profile to `wall` silently selects the
 *     DEFAULT profile), not a demonstration of the defect. M2 below is the
 *     evidence that it bites.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * MUTATION LOG — each applied ALONE to the source, suite re-run, then restored
 * ══════════════════════════════════════════════════════════════════════════════
 *   M1  WallRankingService: FOR_YOU_ANALYTICS_SURFACE "wall" → "explore"
 *       (the exact defect reintroduced)                              → RED
 *       Fails "persisted surface is one the live CHECK admits": the fake
 *       database rejects it 23514 exactly as Postgres does.
 *       NOTE: this mutation does not even typecheck once
 *       PersistedRankSurface is in force — a compile error is the stronger
 *       failure, so the mutation was applied with a cast to reach a RUNTIME
 *       red and prove the test, not just the type, holds the line.
 *
 *   M2  WallRankingService: FOR_YOU_WEIGHT_PROFILE "explore" → "compass"
 *       (the default/balanced profile — the trap)                    → RED
 *       Fails "For You keeps the explore weight profile": the corpus is
 *       engineered so the exploration-weighted order [x-unfamiliar, y-fresh]
 *       inverts to [y-fresh, x-unfamiliar] under the default profile, and
 *       fails the pinned finalScores too.
 *
 *   M3  DiscoveryRankingService: analyticsSurface resolution changed from
 *       `options.analyticsSurface ?? …` to ignore the caller's option
 *       (always derive from the weight-profile name)                 → RED
 *       Fails "persisted surface is one the live CHECK admits" — the Wall's
 *       explicit `wall` is discarded and `explore` is attempted again.
 *
 *   M4  DiscoveryRankingService: PERSISTED_RANK_SURFACES loses 'wall'  → RED
 *       Fails "the code's persisted-surface vocabulary is the one the
 *       database admits" (and stops typechecking, as intended).
 *
 *   M5  DiscoveryRankingService: default analytics surface for a weight
 *       profile the database admits changed from identity to null
 *       (i.e. `discovery` would stop writing)                        → RED
 *       Fails "a caller that does not pass analyticsSurface is unaffected".
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NO DATABASE. The CHECK is enforced in-process by `checkedRankEventsDb()`,
 * whose admitted list is written out literally below, copied from the live
 * constraint on the CI project. That literal is the independent half of the
 * assertion: it is NOT imported from the source under test, so a change to the
 * source's own vocabulary cannot move the goalposts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankItems,
  PERSISTED_RANK_SURFACES,
  type RankingInput,
  type RankingViewerContext,
} from "../services/ranking/DiscoveryRankingService.js";
import {
  rankForYou,
  FOR_YOU_WEIGHT_PROFILE,
  FOR_YOU_ANALYTICS_SURFACE,
  WALL_RANK_VERSION,
  type ForYouCursor,
  type WallRankSignals,
  type WallRankViewer,
} from "../services/wall/WallRankingService.js";
import type { WallProjection } from "../lib/wallProjection.js";

// ── The live constraint, written out ─────────────────────────────────────────
//
// Verbatim from the CHECK on the CI project after migration 2893:
//   CHECK ((surface = ANY (ARRAY['pulse','discovery','events','compass',
//     'live_pulse','living_page','watch_feed','wall'])))
//
// Deliberately a literal and not an import: this is the database's opinion, and
// the point of the test is to hold the CODE against it.
const ADMITTED_SURFACES = [
  "pulse",
  "discovery",
  "events",
  "compass",
  "live_pulse",
  "living_page",
  "watch_feed",
  "wall",
] as const;

/** Labels 2893 retired. An insert carrying one of these is a 23514. */
const RETIRED_SURFACES = [
  "search", "nearby", "story", "event", "trip", "profile", "explore",
] as const;

// ── A Supabase double that enforces rank_events_surface_check ────────────────

interface RankEventRow { event_type?: string; surface?: string }

/**
 * Fake client that behaves like PostgREST in the one way that matters here: a
 * CHECK violation RESOLVES with `{ error }` rather than throwing, which is
 * exactly how the production rejection stayed invisible.
 */
function checkedRankEventsDb() {
  const accepted: RankEventRow[] = [];
  const rejected: RankEventRow[] = [];
  const client: any = {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q, in: () => q, gte: () => q, like: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: (row: RankEventRow) => {
          if (table === "rank_events") {
            const ok = (ADMITTED_SURFACES as readonly string[]).includes(row?.surface ?? "");
            if (ok) accepted.push(row);
            else rejected.push(row);
            const result = ok
              ? { data: null, error: null }
              : {
                  data: null,
                  error: {
                    code: "23514",
                    message:
                      `new row for relation "rank_events" violates check constraint ` +
                      `"rank_events_surface_check" (surface=${JSON.stringify(row?.surface)})`,
                  },
                };
            return { then: (ok2: any) => Promise.resolve(result).then(ok2) };
          }
          return { then: (ok2: any) => Promise.resolve({ data: null, error: null }).then(ok2) };
        },
        then: (ok2: any) => Promise.resolve({ data: [], error: null }).then(ok2),
      };
      return q;
    },
  };
  return { client, accepted, rejected };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VIEWER: WallRankViewer = { viewerId: "wall-viewer-1" };

/** Pinned evaluation instant — every score below is computed AT this moment. */
const NOW_ISO = "2026-09-20T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** offset-0 cursor purely to pin `snapshotAt`, hence the ranker's `nowMs`. */
const PINNED_CURSOR: ForYouCursor = {
  session: "11111111-2222-4333-8444-555555555555",
  version: WALL_RANK_VERSION,
  offset: 0,
  snapshotAt: NOW_ISO,
};

const RANK_OVERRIDES = {
  flags: { ACTIVITY_DISCOVERY_BOOST_ENABLED: true },
  activityScores: new Map(),
  fatiguedCreators: new Set<string>(),
};

function proj(id: string, publishedAt: string): WallProjection {
  return {
    projectionId: "proj_" + id,
    objectType: "social_post",
    canonicalObjectId: id,
    publishedAt,
    visibility: "public",
    actions: [],
  } as WallProjection;
}

/**
 * THE ENGINEERED CORPUS — its whole job is to make the weight profile visible
 * in the ORDER, not merely in a score digit.
 *
 * Two items differing on exactly two axes that the two profiles weight
 * differently in opposite directions:
 *
 *   x-unfamiliar  isUnfamiliarCategory = true  → explorationBoost = wExploration
 *   y-fresh       isUnfamiliarCategory = false → explorationBoost = wExploration/2
 *                 but published 2.1 days later, worth ~3.75 freshness points.
 *
 * weights.exploration = 5 (no DB rows → defaults).
 *   explore profile (×2.0): the exploration gap is 10 − 5 = 5.00 > 3.755 → x wins
 *   default profile (×1.0): the gap is 5 − 2.5 = 2.50 < 3.755 → y wins
 *
 * So the order INVERTS the moment the profile falls through to `?? {}`.
 * Everything else about the two items is identical, and every other weight
 * multiplier is the same in both profiles, so nothing else can move the order.
 */
const X_PUBLISHED = new Date(NOW_MS - 2.1 * 86_400_000).toISOString();
const Y_PUBLISHED = NOW_ISO;

function corpus(): WallProjection[] {
  return [proj("y-fresh", Y_PUBLISHED), proj("x-unfamiliar", X_PUBLISHED)];
}

function signals(): Map<string, WallRankSignals> {
  return new Map<string, WallRankSignals>([
    ["x-unfamiliar", { isUnfamiliarCategory: true }],
    ["y-fresh", { isUnfamiliarCategory: false }],
  ]);
}

/**
 * Mirror of WallRankingService's private `toRankingInput`, used ONLY to drive
 * rankItems directly so the two profiles can be compared head to head and the
 * finalScores pinned. The primary order assertions all run through the real
 * rankForYou path; this mirror never stands in for it.
 */
function mirrorInput(p: WallProjection, s: WallRankSignals): RankingInput {
  return {
    itemId: p.canonicalObjectId,
    itemType: p.objectType,
    creatorId: null,
    createdAt: p.publishedAt,
    city: null, country: null, tags: [], category: null, languageCode: null,
    hasMedia: false, completeness: 0.4, positiveReviewRate: null,
    flagCount: 0, saveCount: 0, shareCount: 0, commentCount: 0,
    impressionCount: 0, uniqueViewerCount: 0,
    lat: null, lng: null, distanceKm: null,
    isDeleted: false, isExpired: false, isSuspended: false, isModerated: false,
    isPrivate: false, isAgeRestricted: false, minAgeRequired: null,
    isGeoRestricted: false, geoRestrictionCountries: null,
    authorIsBlockedByViewer: false, authorBlocksViewer: false,
    authorIsMutedByViewer: false, viewerHasReportedItem: false,
    viewerHasHiddenItem: false, viewerHasHiddenCreator: false,
    repeatCount: null, expiresAt: null, accountAgeDays: null,
    isUnfamiliarCategory: s.isUnfamiliarCategory ?? false,
    isFirstImpression: true,
  };
}

function mirrorViewer(): RankingViewerContext {
  return {
    viewerId: VIEWER.viewerId,
    travelStyles: [], preferredLanguages: [], preferredCities: [],
    currentCity: null, currentCountry: null, lat: null, lng: null,
    viewerAge: null,
    followedCreatorIds: new Set(), mutedCreatorIds: new Set(),
    blockedCreatorIds: new Set(), seenItemIds: new Set(),
    sessionId: PINNED_CURSOR.session, lastActiveAt: null,
  };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }

// ═════════════════════════════════════════════════════════════════════════════

describe("rank_events surface contract — Wall For You", () => {
  // ── HALF ONE: what gets PERSISTED ──────────────────────────────────────────

  it("the persisted surface is one the live CHECK admits", async () => {
    const { client, accepted, rejected } = checkedRankEventsDb();

    const res = await rankForYou(client, corpus(), VIEWER, {
      limit: 10,
      cursor: PINNED_CURSOR,
      signals: signals(),
      rankOverrides: RANK_OVERRIDES,
    });
    assert.equal(res.items.length, 2, "both candidates are served");

    assert.ok(
      accepted.length > 0,
      "For You must actually write rank_events rows — a suite that asserts " +
        "nothing was rejected while nothing was written proves nothing",
    );

    assert.deepEqual(
      rejected,
      [],
      `rank_events rows were REJECTED 23514 by rank_events_surface_check. ` +
        `Rejected surfaces: ${JSON.stringify([...new Set(rejected.map((r) => r.surface))])}. ` +
        `Admitted: ${ADMITTED_SURFACES.join(", ")}`,
    );

    const surfaces = [...new Set(accepted.map((r) => r.surface))];
    assert.deepEqual(
      surfaces, ["wall"],
      "the Wall's For You page persists exactly one surface, and it is `wall` " +
        "(routes/wall.ts:163 already writes that label; migration 2893 cites it)",
    );

    for (const s of surfaces) {
      assert.ok(
        (ADMITTED_SURFACES as readonly string[]).includes(s!),
        `surface=${JSON.stringify(s)} is not in the live CHECK vocabulary`,
      );
      assert.ok(
        !(RETIRED_SURFACES as readonly string[]).includes(s!),
        `surface=${JSON.stringify(s)} was RETIRED by migration 2893`,
      );
    }

    assert.equal(
      FOR_YOU_ANALYTICS_SURFACE, "wall",
      "the analytics surface constant itself is pinned, so a rename cannot " +
        "quietly reintroduce the divergence",
    );
  });

  it("the code's persisted-surface vocabulary is the one the database admits", () => {
    // The whole point of expressing the vocabulary ONCE in code: this is the
    // single place the code's opinion and the constraint are compared, and
    // anything outside the code's set is a TYPE error rather than a 23514.
    assert.deepEqual(
      [...PERSISTED_RANK_SURFACES].slice().sort(),
      [...ADMITTED_SURFACES].slice().sort(),
      "PERSISTED_RANK_SURFACES has drifted from rank_events_surface_check",
    );
    for (const retired of RETIRED_SURFACES) {
      assert.ok(
        !(PERSISTED_RANK_SURFACES as readonly string[]).includes(retired),
        `${retired} was retired by 2893 and must not be expressible as a persisted surface`,
      );
    }
  });

  it("a caller that does not pass analyticsSurface is unaffected", async () => {
    // The fix must be opt-in. Every other caller of the ranker keeps writing
    // exactly the label it wrote before — proven on a weight-profile name that
    // is ALSO an admitted persisted surface, which is the case for all of them.
    const { client, accepted, rejected } = checkedRankEventsDb();
    await rankItems(
      [mirrorInput(proj("d-1", NOW_ISO), {}), mirrorInput(proj("d-2", NOW_ISO), {})],
      "discovery",
      mirrorViewer(),
      client,
      RANK_OVERRIDES,
      { nowMs: NOW_MS },
    );
    assert.deepEqual(rejected, [], "discovery is admitted and must not be rejected");
    assert.deepEqual(
      [...new Set(accepted.map((r) => r.surface))], ["discovery"],
      "an un-opted-in caller still persists its own surface name",
    );
  });

  // ── HALF TWO: ranking is UNCHANGED ─────────────────────────────────────────

  it("For You keeps the explore weight profile — order and score unchanged", async () => {
    assert.equal(
      FOR_YOU_WEIGHT_PROFILE, "explore",
      "For You ranks on the exploration-heavy profile; the persisted surface " +
        "is a separate concept and must not drag this with it",
    );

    // (1) The real path. Engineered so this order is only produced by the
    //     exploration-weighted profile.
    const { client } = checkedRankEventsDb();
    const res = await rankForYou(client, corpus(), VIEWER, {
      limit: 10,
      cursor: PINNED_CURSOR,
      signals: signals(),
      rankOverrides: RANK_OVERRIDES,
    });
    assert.deepEqual(
      res.items.map((i) => i.canonicalObjectId),
      ["x-unfamiliar", "y-fresh"],
      "the exploration-heavy profile puts the unfamiliar-category item first " +
        "despite it being 2.1 days older — this inverts under the default profile",
    );

    // (2) Head to head: explore vs the DEFAULT profile on identical inputs.
    //     `compass` is the empty profile `{}`, i.e. exactly what
    //     SURFACE_WEIGHT_PROFILES[surface] ?? {} yields for an unknown key.
    const inputs = [
      mirrorInput(proj("y-fresh", Y_PUBLISHED), { isUnfamiliarCategory: false }),
      mirrorInput(proj("x-unfamiliar", X_PUBLISHED), { isUnfamiliarCategory: true }),
    ];
    const asExplore = await rankItems(inputs, "explore", mirrorViewer(), null, RANK_OVERRIDES, { nowMs: NOW_MS });
    const asDefault = await rankItems(inputs, "compass", mirrorViewer(), null, RANK_OVERRIDES, { nowMs: NOW_MS });

    assert.deepEqual(
      asExplore.map((o) => o.itemId), ["x-unfamiliar", "y-fresh"],
      "explore profile order",
    );
    assert.deepEqual(
      asDefault.map((o) => o.itemId), ["y-fresh", "x-unfamiliar"],
      "THE DISCRIMINATING ASSERTION: the default profile produces the OPPOSITE " +
        "order on this corpus. If this ever matches the explore order the " +
        "corpus has stopped discriminating and the profile assertion above is " +
        "no longer proving anything.",
    );
    assert.deepEqual(
      res.items.map((i) => i.canonicalObjectId),
      asExplore.map((o) => o.itemId),
      "rankForYou reproduces the explore profile's order exactly",
    );

    // (3) Pinned finalScores — byte-identical ranking, not merely the same
    //     order. Computed at NOW_MS with default ranking_config weights
    //     (relevance 35, freshness 20, quality 15, exploration 5).
    assert.deepEqual(
      asExplore.map((o) => [o.itemId, round4(o.finalScore)]),
      [
        ["x-unfamiliar", 57.265],
        ["y-fresh", 56.02],
      ],
      "explore-profile finalScores are pinned. The default profile gives " +
        "51.47 / 52.725 on the same inputs — different numbers AND the " +
        "opposite order — so this fails loudly if the profile slips.",
    );
  });
});
