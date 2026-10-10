/**
 * Lead ruling D-24c (docs/ops/lead-rulings-20261006.md), applied to the MEDIA
 * Watch feed's creator boosts.
 *
 *   "While a messaging restriction is active, the person's posts get no boost
 *    lift. Their stored boost preference is kept, and the lift comes back when
 *    the restriction ends. If the restriction state cannot be read, apply no
 *    boost: this is fail-closed for reach amplification, and it refuses nothing
 *    the person does."
 *
 * Lane L built it for Compass (wave 6). The Media ranker
 * (services/ranking/MediaFeedRankingService.rankMediaFeed) has six lifts —
 * publisher, active-creator, new-creator, returning-creator, featured-by-Portava
 * and underexposed — and none of them read a restriction.
 *
 *   A. rankMediaFeed: a withheld author's item gets NONE of the six lifts and
 *      keeps every other term; an unrestricted author keeps them; an ABSENT set
 *      (nobody's state read) withholds every lift (fail closed).

 *   B. the shared reader (compass/CompassFeedBuilder.loadBoostLiftWithheld, one
 *      helper for Compass and Media since the unification): messaging ⇒ withheld; any other restriction
 *      ⇒ not; a failed read, a degraded read, a throw or no client ⇒ withheld;
 *      nothing is written (the preference is kept).
 *   C. mediaBoostLiftAuthors: only authors a lift would touch are read.
 *   D. the Watch feed passes the loaded set into the ranker.
 *
 * Run: node --import tsx/esm --test src/test/mediaBoostRestrictionD24c.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBoostLiftWithheld } from "../compass/CompassFeedBuilder.js";
import {
  rankMediaFeed,
  mediaBoostLiftAuthors,
  type MediaFeedItem,
  type MediaRankingFlags,
  type MediaRankingInput,
} from "../services/ranking/MediaFeedRankingService.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const RESTRICTED = "a0000000-0000-4000-8000-00000000000r";
const FREE = "b0000000-0000-4000-8000-00000000000f";

const ALL_LIFTS: MediaRankingFlags = {
  rankingEnabled: true,
  activeCreatorBoostEnabled: true,
  newCreatorBoostEnabled: true,
  returningCreatorBoostEnabled: true,
  underexposedBoostEnabled: true,
  creatorFatigueEnabled: false,
  publisherBoostEnabled: true,
  featuredBoostEnabled: true,
} as MediaRankingFlags;

const LIFT_FEATURES = ["officialPublisher", "activeCreator", "newCreator", "returningCreator", "featuredByPortava", "underexposed"];

/** An item on which every one of the six lifts is positive. */
function liftable(id: string, authorId: string): MediaFeedItem {
  return {
    id, kind: "post", authorId, city: "da nang", category: "food", tags: [],
    createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    likeCount: 2, joinCount: 0,
    isOfficialPublisher: true,
    creatorWeeklyPostCount: 4,
    creatorAccountAgeDays: 3,
    creatorLastPostAt: new Date(NOW - 40 * DAY).toISOString(),
    featuredAt: new Date(NOW - DAY).toISOString(),
    qualifiedViewCount: 3, totalImpressionCount: 10,
  } as MediaFeedItem;
}

function input(withheld: ReadonlySet<string> | undefined, items: MediaFeedItem[]): MediaRankingInput {
  return {
    candidates: items,
    viewer: { userId: "viewer", followedIds: new Set(), interestTags: [], seenIds: new Set(), placeAffinities: {} } as any,
    mode: "for_you",
    sessionState: { creatorImpressions: new Map() },
    flags: ALL_LIFTS,
    nowMs: NOW,
    ...(withheld ? { boostWithheldAuthors: withheld } : {}),
  };
}

function featuresOf(withheld: ReadonlySet<string> | undefined, authorId: string) {
  const ranked = rankMediaFeed(input(withheld, [liftable("p-" + authorId, authorId)]));
  return ranked[0]!;
}

describe("A. rankMediaFeed withholds every lift from a withheld author, and only the lifts", () => {
  it("precondition: an unrestricted author's item carries all six lifts", () => {
    const r = featuresOf(new Set(), FREE);
    for (const f of LIFT_FEATURES) assert.ok((r.features[f] ?? 0) > 0, `${f} is positive for an unrestricted author`);
  });

  it("a messaging-restricted author's item carries none of them, and scores lower", () => {
    const free = featuresOf(new Set(), RESTRICTED);
    const held = featuresOf(new Set([RESTRICTED]), RESTRICTED);
    for (const f of LIFT_FEATURES) assert.equal(held.features[f] ?? 0, 0, `${f} is withheld`);
    assert.ok(held.finalScore < free.finalScore, "the lift is gone from the score, not just the features");
  });

  it("every term that is not a lift is untouched — the post keeps its organic place", () => {
    const free = featuresOf(new Set(), RESTRICTED);
    const held = featuresOf(new Set([RESTRICTED]), RESTRICTED);
    for (const k of Object.keys(free.features)) {
      if (LIFT_FEATURES.includes(k)) continue;
      // savesShares, recency, quality and the media multipliers are computed before any lift.
      if (k === "savesShares" || k.startsWith("recency") || k === "freshness") assert.equal(held.features[k], free.features[k], k);
    }
    assert.ok(held.finalScore > 0, "the post is still ranked, not dropped");
  });

  it("only the restricted author loses it: a mixed page lifts the other author", () => {
    const ranked = rankMediaFeed(input(new Set([RESTRICTED]), [liftable("p-r", RESTRICTED), liftable("p-f", FREE)]));
    const byId = new Map(ranked.map((r) => [r.item.id, r]));
    assert.ok((byId.get("p-f")!.features.activeCreator ?? 0) > 0);
    assert.equal(byId.get("p-r")!.features.activeCreator ?? 0, 0);
  });

  it("FAIL CLOSED: with no restriction state read (set absent), nobody is lifted", () => {
    const r = featuresOf(undefined, FREE);
    for (const f of LIFT_FEATURES) assert.equal(r.features[f] ?? 0, 0, `${f} withheld when nothing was read`);
  });
});

// ── B. the loader ────────────────────────────────────────────────────────────

type Answer = { data?: any[] | null; error?: any; throws?: boolean };
function restrictionsDb(byUser: Record<string, Answer>) {
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads, writes,
    from(table: string) {
      let user = "";
      const b: any = {
        select() { return b; },
        eq(col: string, v: string) { if (col === "user_id") user = v; return b; },
        is() { return b; },
        or() { return b; },
        update() { writes.push(table); return b; }, insert() { writes.push(table); return b; }, upsert() { writes.push(table); return b; }, delete() { writes.push(table); return b; },
        then(onF: any, onR: any) {
          reads.push(`${table}:${user}`);
          const a = byUser[user] ?? { data: [], error: null };
          if (a.throws) return Promise.reject(new Error("socket hang up")).then(onF, onR);
          return Promise.resolve({ data: a.data ?? null, error: a.error ?? null }).then(onF, onR);
        },
      };
      return b;
    },
  };
}

describe("B. the ONE D-24c reader Compass and Media share (compass/CompassFeedBuilder.loadBoostLiftWithheld) reads the state through the seam and fails closed", () => {
  it("messaging ⇒ withheld; hosting alone ⇒ not; none ⇒ not", async () => {
    const db = restrictionsDb({
      m: { data: [{ restriction_type: "messaging" }] },
      h: { data: [{ restriction_type: "hosting" }] },
      n: { data: [] },
    });
    const w = await loadBoostLiftWithheld(db as any, ["m", "h", "n"]);
    assert.deepEqual([...w].sort(), ["m"]);
    assert.deepEqual(db.reads.sort(), ["trust_restrictions:h", "trust_restrictions:m", "trust_restrictions:n"]);
    assert.deepEqual(db.writes, [], "the stored preference is kept: nothing is written");
  });

  it("a failed read, a missing table (degraded fail-open) or a throw ⇒ withheld", async () => {
    const db = restrictionsDb({
      e: { error: { code: "57014", message: "canceling statement due to statement timeout" } },
      t: { error: { code: "42P01", message: 'relation "public.trust_restrictions" does not exist' } },
      x: { throws: true },
    });
    const w = await loadBoostLiftWithheld(db as any, ["e", "t", "x"]);
    assert.deepEqual([...w].sort(), ["e", "t", "x"]);
  });

  it("no client ⇒ everyone withheld; no authors ⇒ no reads", async () => {
    assert.deepEqual([...(await loadBoostLiftWithheld(null, ["a", "b"]))].sort(), ["a", "b"]);
    const db = restrictionsDb({});
    assert.equal((await loadBoostLiftWithheld(db as any, [])).size, 0);
    assert.deepEqual(db.reads, []);
  });
});

describe("C. only the authors a lift would touch are read", () => {
  it("none when ranking or every lift flag is off", () => {
    const items = [liftable("p1", RESTRICTED)];
    assert.deepEqual(mediaBoostLiftAuthors(items, { ...ALL_LIFTS, rankingEnabled: false }, {}, NOW), []);
    const off = { ...ALL_LIFTS, activeCreatorBoostEnabled: false, newCreatorBoostEnabled: false, returningCreatorBoostEnabled: false, underexposedBoostEnabled: false, publisherBoostEnabled: false, featuredBoostEnabled: false };
    assert.deepEqual(mediaBoostLiftAuthors(items, off as MediaRankingFlags, {}, NOW), []);
  });

  it("an author whose items no enabled lift touches is not read", () => {
    const plain = { ...liftable("p2", FREE), isOfficialPublisher: false, creatorWeeklyPostCount: 0, creatorAccountAgeDays: 400, creatorLastPostAt: null, featuredAt: null, qualifiedViewCount: 100000, totalImpressionCount: 100000, createdAt: new Date(NOW - 400 * DAY).toISOString() } as MediaFeedItem;
    assert.deepEqual(mediaBoostLiftAuthors([liftable("p1", RESTRICTED), plain], ALL_LIFTS, {}, NOW), [RESTRICTED]);
  });
});

describe("C2. verifier F7: each lift family on its own makes its author read, and is withheld", () => {
  /** An item on which NO lift is positive. */
  const plain = (authorId: string): MediaFeedItem => ({
    id: `p-${authorId}`, kind: "post", authorId, city: "da nang", category: "food", tags: [],
    createdAt: new Date(NOW - 400 * DAY).toISOString(), likeCount: 0, joinCount: 0,
    isOfficialPublisher: false, creatorWeeklyPostCount: 0, creatorAccountAgeDays: 400,
    creatorLastPostAt: null, featuredAt: null, qualifiedViewCount: 100000, totalImpressionCount: 100000,
  } as MediaFeedItem);
  const FAMILIES: Array<[string, Partial<MediaFeedItem>]> = [
    ["officialPublisher", { isOfficialPublisher: true }],
    ["activeCreator", { creatorWeeklyPostCount: 4 }],
    ["newCreator", { creatorAccountAgeDays: 3, qualifiedViewCount: 3, totalImpressionCount: 10 }],
    ["returningCreator", { creatorLastPostAt: new Date(NOW - 40 * DAY).toISOString() }],
    ["featuredByPortava", { featuredAt: new Date(NOW - DAY).toISOString() }],
    ["underexposed", { qualifiedViewCount: 3, totalImpressionCount: 10, createdAt: new Date(NOW - 60 * 60 * 1000).toISOString() }],
  ];

  it("precondition: the plain item carries no lift, and nobody is read for it", () => {
    const r = rankMediaFeed(input(new Set(), [plain(FREE)]))[0]!;
    for (const f of LIFT_FEATURES) assert.equal(r.features[f] ?? 0, 0, f);
    assert.deepEqual(mediaBoostLiftAuthors([plain(FREE)], ALL_LIFTS, {}, NOW), []);
  });

  for (const [family, patch] of FAMILIES) {
    it(`${family} alone: the author is read, the lift applies when free and is withheld when restricted`, () => {
      const item = { ...plain(RESTRICTED), ...patch } as MediaFeedItem;
      assert.deepEqual(mediaBoostLiftAuthors([item], ALL_LIFTS, {}, NOW), [RESTRICTED], `${family}: a restricted author whose only lift is ${family} must be read`);
      const free = rankMediaFeed(input(new Set(), [item]))[0]!;
      assert.ok((free.features[family] ?? 0) > 0, `${family} applies to an unrestricted author`);
      const held = rankMediaFeed(input(new Set([RESTRICTED]), [item]))[0]!;
      assert.equal(held.features[family] ?? 0, 0, `${family} is withheld`);
    });
  }
});

describe("D. the Watch feed passes the loaded set to the ranker", () => {
  it("routes/mediaFeed.ts loads the withheld set for exactly the liftable authors and hands it to rankMediaFeed", () => {
    const src = readFileSync(join(HERE, "..", "routes", "mediaFeed.ts"), "utf8");
    assert.match(src, /boostWithheldAuthors: await loadBoostLiftWithheld\(sc, mediaBoostLiftAuthors\(rankCandidates, mediaFlags, undefined, nowMs\)\)/);
    assert.match(src, /import \{ loadBoostLiftWithheld \} from "\.\.\/compass\/CompassFeedBuilder\.js";/, "the Watch feed uses Compass's reader, not a copy");
    const ranking = readFileSync(join(HERE, "..", "services", "ranking", "MediaFeedRankingService.ts"), "utf8");
    assert.doesNotMatch(ranking, /getRestrictionState/, "no second D-24c reader in the media ranker");
  });
});
