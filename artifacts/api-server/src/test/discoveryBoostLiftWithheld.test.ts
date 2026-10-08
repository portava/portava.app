/**
 * Lead ruling D-24c (2026-10-06) in the Discovery ranker (DiscoveryRankingService
 * rankItems) and the feed slot allocator (FeedSlotAllocator allocateFeedSlots):
 * "While a messaging restriction is active, the person's posts get no boost lift.
 * Their stored boost preference is kept, and the lift comes back when the
 * restriction ends. If the restriction state cannot be read, apply no boost."
 *
 * Their flags (ACTIVITY_DISCOVERY_BOOST_ENABLED, NEW_CONTRIBUTOR_BOOST_ENABLED,
 * RETURNING_USER_BOOST_ENABLED, UNDEREXPOSED_CONTENT_BOOST_ENABLED,
 * DISCOVERY_DIVERSITY_ENABLED) are seeded FALSE; this proves the withholding so
 * they can be switched on safely.
 *
 *   W1–W7  services/ranking/boostLiftWithheld.ts loadBoostLiftWithheld, over the
 *          real getRestrictionState seam: messaging-restricted withheld; a hosting
 *          restriction is not this one; an unreadable state, an absent table
 *          (degraded fail_open) and no client withhold; nobody is read for no
 *          authors; past the read cap is withheld unread; nothing is written.
 *   R1–R8  rankItems: a withheld creator's item gets none of the four boosts and
 *          every other component unchanged; another creator keeps them; the
 *          restriction is read THROUGH the client when no override is given; an
 *          unreadable state withholds; shadow mode reads nobody; only creators a
 *          boost could lift are read; the stored score is never written.
 *   S1–S4  allocateFeedSlots: a withheld author takes no reserved bucket, an
 *          unrestricted one does; no set passed = not read = no authored item takes
 *          one (authorless items still do); loadSlotLiftWithheld reads only the
 *          authors who would take a bucket.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/discoveryBoostLiftWithheld.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadBoostLiftWithheld, BOOST_LIFT_READ_CAP } from "../services/ranking/boostLiftWithheld.js";
import { rankItems, type RankingInput, type RankingOutput, type RankingViewerContext } from "../services/ranking/DiscoveryRankingService.js";
import { allocateFeedSlots, loadSlotLiftWithheld } from "../services/ranking/FeedSlotAllocator.js";
import type { PipelineResult } from "../compass/CompassPipeline.js";
import type { FeedShares } from "../services/ranking/rankingConfig.js";
import { makeFakeClient, type FakeClient, type FakeDbOptions } from "./telegraphCertificationHarness.js";

const RESTRICTED = "11111111-0000-4000-8000-0000000000aa"; // messaging-restricted
const HOSTING_ONLY = "22222222-0000-4000-8000-0000000000bb"; // restricted from hosting only
const FREE = "33333333-0000-4000-8000-0000000000cc";

const restrictionRows = [
  { user_id: RESTRICTED, restriction_type: "messaging", lifted_at: null, expires_at: null },
  { user_id: HOSTING_ONLY, restriction_type: "hosting", lifted_at: null, expires_at: null },
];
const db = (opts: FakeDbOptions = {}, rows = restrictionRows): FakeClient =>
  makeFakeClient({ trust_restrictions: rows.map((r) => ({ ...r })), ranking_config: [] }, opts);
const UNREADABLE: FakeDbOptions = { errors: { trust_restrictions: { message: "restrictions unavailable", code: "57P01", ops: ["select"] } } };
const ABSENT: FakeDbOptions = { errors: { trust_restrictions: { message: 'relation "public.trust_restrictions" does not exist', code: "42P01", ops: ["select"] } } };
const restrictionReads = (c: FakeClient) => c._observed.selects.filter((s) => s.table === "trust_restrictions").length;
const writesOutside = (c: FakeClient, allowed: string[] = []) =>
  [...c._observed.inserts, ...c._observed.updates, ...c._observed.upserts, ...c._observed.deletes]
    .map((w) => w.table).filter((t) => !allowed.includes(t));

describe("W — loadBoostLiftWithheld (the D-24c read)", () => {
  it("W1. THE POINT: a messaging-restricted author is withheld; a free author is not", async () => {
    const c = db();
    assert.deepEqual([...await loadBoostLiftWithheld(c as never, [RESTRICTED, FREE])], [RESTRICTED]);
  });
  it("W2. not more than told: a hosting restriction does not withhold a boost", async () => {
    assert.deepEqual([...await loadBoostLiftWithheld(db() as never, [HOSTING_ONLY])], []);
  });
  it("W3. an unreadable restriction state withholds (fail closed for reach)", async () => {
    assert.deepEqual([...await loadBoostLiftWithheld(db(UNREADABLE) as never, [FREE])], [FREE]);
  });
  it("W4. an absent table (degraded fail_open: the can-flags read true but nobody read it) withholds", async () => {
    assert.deepEqual([...await loadBoostLiftWithheld(db(ABSENT) as never, [FREE])], [FREE]);
  });
  it("W5. no client: every author is withheld", async () => {
    assert.deepEqual([...await loadBoostLiftWithheld(null, [FREE, RESTRICTED])].sort(), [FREE, RESTRICTED].sort());
  });
  it("W6. no authors: nobody is read", async () => {
    const c = db();
    assert.equal((await loadBoostLiftWithheld(c as never, [])).size, 0);
    assert.equal(restrictionReads(c), 0);
  });
  it("W7. past the read cap an author is withheld unread; nothing is written", async () => {
    const many = Array.from({ length: BOOST_LIFT_READ_CAP + 3 }, (_, i) => `44444444-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const c = db();
    const out = await loadBoostLiftWithheld(c as never, many);
    assert.equal(restrictionReads(c), BOOST_LIFT_READ_CAP);
    assert.deepEqual([...out].sort(), many.slice(BOOST_LIFT_READ_CAP).sort());
    assert.deepEqual(writesOutside(c), []);
  });
});

// ── rankItems ─────────────────────────────────────────────────────────────────

const ACTIVE_FLAGS = {
  ACTIVITY_DISCOVERY_BOOST_ENABLED: true, NEW_CONTRIBUTOR_BOOST_ENABLED: true,
  RETURNING_USER_BOOST_ENABLED: true, UNDEREXPOSED_CONTENT_BOOST_ENABLED: true, RANKING_EXPERIMENT_ENABLED: false,
};
const SHADOW_FLAGS = { ...ACTIVE_FLAGS, ACTIVITY_DISCOVERY_BOOST_ENABLED: false };
const NOW = Date.parse("2026-10-07T12:00:00Z");

function viewer(over: Partial<RankingViewerContext> = {}): RankingViewerContext {
  return {
    viewerId: "55555555-0000-4000-8000-0000000000dd", travelStyles: ["food"], preferredLanguages: ["en"],
    preferredCities: ["lisbon"], currentCity: "lisbon", currentCountry: "PT", lat: 38.7, lng: -9.1, viewerAge: null,
    followedCreatorIds: new Set(), mutedCreatorIds: new Set(), blockedCreatorIds: new Set(), seenItemIds: new Set(),
    sessionId: null,
    // A returning viewer (> 14 days away): the returning-user boost is live too.
    lastActiveAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    ...over,
  };
}
function item(id: string, creatorId: string | null): RankingInput {
  return {
    itemId: id, itemType: "post", creatorId, createdAt: new Date(NOW - 3_600_000).toISOString(), city: "lisbon",
    country: "PT", tags: ["food"], category: "food", languageCode: "en", hasMedia: true, completeness: 0.9,
    positiveReviewRate: 0.9, flagCount: 0, saveCount: 5, shareCount: 1, commentCount: 1, impressionCount: 50,
    uniqueViewerCount: 40, lat: 38.7, lng: -9.1, distanceKm: 1, isDeleted: false, isExpired: false, isSuspended: false,
    isModerated: false, isPrivate: false, isAgeRestricted: false, minAgeRequired: null, isGeoRestricted: false,
    geoRestrictionCountries: null, authorIsBlockedByViewer: false, authorBlocksViewer: false, authorIsMutedByViewer: false,
    viewerHasReportedItem: false, viewerHasHiddenItem: false, viewerHasHiddenCreator: false, repeatCount: null,
    expiresAt: null, accountAgeDays: 5, isUnfamiliarCategory: false, isFirstImpression: false,
  };
}
const ITEMS = () => [item("p-restricted", RESTRICTED), item("p-free", FREE)];
const baseOverrides = (flags = ACTIVE_FLAGS) => ({
  flags,
  activityScores: new Map([[RESTRICTED, { score: 80, spam_penalty: 0 }], [FREE, { score: 80, spam_penalty: 0 }]]),
  underexposureStatus: new Map([["p-restricted", "boosting"], ["p-free", "boosting"]]),
  fatiguedCreators: new Set<string>(),
});
const LIFTS = ["activityBoost", "newContributorBoost", "returningUserBoost", "underexposureBoost"] as const;
const lifts = (o: RankingOutput) => LIFTS.map((k) => o.components[k]);
const byId = <T extends { itemId: string }>(xs: T[], id: string) => xs.find((x) => x.itemId === id)!;
const OPTS = { emitPerCandidateAnalytics: false, nowMs: NOW };

describe("R — rankItems withholds the four boosts (D-24c)", () => {
  it("R1. THE POINT: a withheld creator's item gets none of the four boosts, every other component unchanged; another creator keeps all four", async () => {
    const held = await rankItems(ITEMS(), "compass", viewer(), null, { ...baseOverrides(), liftWithheld: new Set([RESTRICTED]) }, OPTS);
    const none = await rankItems(ITEMS(), "compass", viewer(), null, { ...baseOverrides(), liftWithheld: new Set() }, OPTS);
    const r = byId(held, "p-restricted"), r0 = byId(none, "p-restricted");
    assert.ok(lifts(r0).every((x) => x > 0), `vacuity guard: unwithheld, all four lift: ${lifts(r0)}`);
    assert.deepEqual(lifts(r), [0, 0, 0, 0]);
    for (const [k, v] of Object.entries(r.components)) if (!(LIFTS as readonly string[]).includes(k)) assert.equal(v, r0.components[k as keyof RankingOutput["components"]], k);
    assert.ok(r.finalScore <= r0.finalScore); // finalScore is clamped to 100, so the drop can be hidden by the clamp; the components above are the claim
    assert.deepEqual(lifts(byId(held, "p-free")), lifts(byId(none, "p-free")));
    assert.ok(lifts(byId(held, "p-free")).every((x) => x > 0));
  });
  it("R2. read through the client: a messaging-restricted creator is withheld, a free one is not, and nothing but rank_events is written", async () => {
    const c = db();
    const out = await rankItems(ITEMS(), "compass", viewer(), c as never, baseOverrides(), OPTS);
    assert.deepEqual(lifts(byId(out, "p-restricted")), [0, 0, 0, 0]);
    assert.ok(lifts(byId(out, "p-free")).every((x) => x > 0));
    assert.equal(restrictionReads(c), 2);
    assert.deepEqual(writesOutside(c, ["rank_events"]), [], "the stored score / preference is never written");
  });
  it("R3. an unreadable restriction state: no creator is lifted (fail closed); the rest of the ranking still answers", async () => {
    const out = await rankItems(ITEMS(), "compass", viewer(), db(UNREADABLE) as never, baseOverrides(), OPTS);
    assert.equal(out.length, 2);
    for (const o of out) assert.deepEqual(lifts(o), [0, 0, 0, 0]);
    assert.ok(out.every((o) => o.eligibilityPassed && o.finalScore > 0));
  });
  it("R4. no client and no override: the state was not read, so no creator is lifted", async () => {
    const out = await rankItems(ITEMS(), "compass", viewer(), null, baseOverrides(), OPTS);
    for (const o of out) assert.deepEqual(lifts(o), [0, 0, 0, 0]);
  });
  it("R5. shadow mode reads nobody's restriction (every boost is already zero there)", async () => {
    const c = db();
    await rankItems(ITEMS(), "compass", viewer(), c as never, baseOverrides(SHADOW_FLAGS), OPTS);
    assert.equal(restrictionReads(c), 0);
  });
  it("R6. only creators a boost could lift are read: an item with no creator and a creator with no possible lift cost no read", async () => {
    const c = db();
    const flags = { ...ACTIVE_FLAGS, NEW_CONTRIBUTOR_BOOST_ENABLED: false, RETURNING_USER_BOOST_ENABLED: false, UNDEREXPOSED_CONTENT_BOOST_ENABLED: false };
    const inputs = [item("p-restricted", RESTRICTED), item("p-free", FREE), item("place", null)];
    const ov = { ...baseOverrides(flags), activityScores: new Map([[RESTRICTED, { score: 80, spam_penalty: 0 }]]) };
    const out = await rankItems(inputs, "compass", viewer({ lastActiveAt: null }), c as never, ov, OPTS);
    assert.equal(restrictionReads(c), 1, "only RESTRICTED had a lift to withhold");
    assert.equal(byId(out, "p-restricted").components.activityBoost, 0);
  });
  it("R7. the returning-user boost comes from the VIEWER: a restricted creator with no standing of their own is still read and withheld when the viewer is returning", async () => {
    const c = db();
    const flags = { ...ACTIVE_FLAGS, NEW_CONTRIBUTOR_BOOST_ENABLED: false, UNDEREXPOSED_CONTENT_BOOST_ENABLED: false };
    const ov = { ...baseOverrides(flags), activityScores: new Map() }; // no activity standing for anyone
    const out = await rankItems(ITEMS(), "compass", viewer(), c as never, ov, OPTS);
    assert.ok(byId(out, "p-free").components.returningUserBoost > 0, "vacuity guard: the returning boost is live");
    assert.equal(byId(out, "p-restricted").components.returningUserBoost, 0);
    assert.equal(restrictionReads(c), 2);
  });
  it("R8. the underexposure boost alone makes a creator a candidate (verifier F4 on 1a0f6b7219): no activity standing, not a new contributor, viewer not returning — the restricted creator is still read and withheld", async () => {
    const c = db();
    const flags = { ...ACTIVE_FLAGS, NEW_CONTRIBUTOR_BOOST_ENABLED: false, RETURNING_USER_BOOST_ENABLED: false };
    const old = (id: string, creatorId: string) => ({ ...item(id, creatorId), accountAgeDays: 400 });
    const ov = { ...baseOverrides(flags), activityScores: new Map() }; // both items "boosting"; nobody has activity standing
    const out = await rankItems([old("p-restricted", RESTRICTED), old("p-free", FREE)], "compass", viewer({ lastActiveAt: null }), c as never, ov, OPTS);
    assert.ok(byId(out, "p-free").components.underexposureBoost > 0, "vacuity guard: the underexposure boost is live");
    assert.deepEqual(lifts(byId(out, "p-free")).filter((x) => x > 0).length, 1, "vacuity guard: it is the ONLY live lift");
    assert.equal(byId(out, "p-restricted").components.underexposureBoost, 0, "the restricted creator's underexposure lift is withheld");
    assert.equal(restrictionReads(c), 2, "both creators were candidates through the underexposure clause alone");
  });
});

// ── allocateFeedSlots ─────────────────────────────────────────────────────────

const SHARES: FeedShares = { relevance: 50, activeCreator: 10, underexposed: 20, newUser: 10, exploration: 10 };
function pr(id: string, authorId: string | null, over: Record<string, unknown> = {}, score = 50): PipelineResult {
  return { item: { id, type: "post", authorId: authorId ?? undefined, activeVisibilityBoost: 0, diversityScore: 0, authorJoinedAt: null, interestTags: [], ...over } as any, finalScore: score } as unknown as PipelineResult;
}
/** Ten relevance items from FREE ahead of the candidates, so a reserved bucket is visible as a jump forward. */
function pool(candidate: PipelineResult): PipelineResult[] {
  return [...Array.from({ length: 10 }, (_, i) => pr(`rel-${i}`, FREE, {}, 90 - i)), candidate];
}
const position = (xs: PipelineResult[], id: string) => xs.findIndex((x) => x.item.id === id);

describe("S — allocateFeedSlots gives a withheld author no reserved bucket (D-24c)", () => {
  const underexposed = new Set(["cand"]);
  it("S1. THE POINT: a withheld author's underexposed item stays last (relevance); with the author not withheld it is lifted forward", async () => {
    const lifted = allocateFeedSlots(pool(pr("cand", RESTRICTED, {}, 10)), SHARES, { surface: "compass", underexposedItemIds: underexposed, liftWithheldAuthorIds: new Set() });
    const held = allocateFeedSlots(pool(pr("cand", RESTRICTED, {}, 10)), SHARES, { surface: "compass", underexposedItemIds: underexposed, liftWithheldAuthorIds: new Set([RESTRICTED]) });
    assert.ok(position(lifted, "cand") < 10, `vacuity guard: the bucket lifts it (at ${position(lifted, "cand")})`);
    assert.equal(position(held, "cand"), 10);
  });
  it("S2. every reserved bucket is withheld for that author: active-creator, new-user and exploration items stay in relevance order", async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (const over of [{ activeVisibilityBoost: 5 }, { authorJoinedAt: recent }, { diversityScore: 0.9 }]) {
      const lifted = allocateFeedSlots(pool(pr("cand", RESTRICTED, over, 10)), SHARES, { surface: "compass", liftWithheldAuthorIds: new Set() });
      const held = allocateFeedSlots(pool(pr("cand", RESTRICTED, over, 10)), SHARES, { surface: "compass", liftWithheldAuthorIds: new Set([RESTRICTED]) });
      assert.ok(position(lifted, "cand") < 10, `vacuity guard ${JSON.stringify(over)}`);
      assert.equal(position(held, "cand"), 10, JSON.stringify(over));
    }
  });
  it("S3. no set passed (the state was not read): no AUTHORED item takes a reserved bucket; an authorless item still does", async () => {
    const authored = allocateFeedSlots(pool(pr("cand", FREE, {}, 10)), SHARES, { surface: "compass", underexposedItemIds: underexposed });
    const authorless = allocateFeedSlots(pool(pr("cand", null, {}, 10)), SHARES, { surface: "compass", underexposedItemIds: underexposed });
    assert.equal(position(authored, "cand"), 10);
    assert.ok(position(authorless, "cand") < 10);
  });
  it("S4. loadSlotLiftWithheld reads only the authors who would take a bucket, and withholds the restricted one", async () => {
    const c = db();
    const items = [...pool(pr("cand", RESTRICTED, {}, 10)), pr("plain", HOSTING_ONLY, {}, 5)];
    const withheld = await loadSlotLiftWithheld(c as never, items, underexposed);
    assert.deepEqual([...withheld], [RESTRICTED]);
    assert.equal(restrictionReads(c), 1, "FREE's and HOSTING_ONLY's plain items take no bucket, so they are not read");
    const out = allocateFeedSlots(items, SHARES, { surface: "compass", underexposedItemIds: underexposed, liftWithheldAuthorIds: withheld });
    assert.equal(position(out, "cand"), 10);
    assert.deepEqual(writesOutside(c), []);
  });
});
