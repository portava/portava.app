/**
 * rank_events write amplification from the DRS scoring loop.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-08-29)
 * ----------------------------------------------
 * DiscoveryRankingService wrote TWO analytics rows per candidate — ITEM_ELIGIBLE
 * and ITEM_SCORED — for a gate that is structurally unreachable on all three
 * surfaces that use it (Discovery, Compass, Pulse). Measured in production, those
 * two event types were 116,088 rows: 49.6% of the entire rank_events table, in a
 * table with no retention policy.
 *
 * ITEM_ELIGIBLE carried no information ITEM_SCORED did not. No control flow
 * separates the two writes, so every item that emitted one emitted the other with
 * an identical field set; production confirmed the pairing exactly (46,677 =
 * 46,677 on pulse, 11,367 = 11,367 on compass). And the inference runs the other
 * way: an ineligible item is never scored, so an ITEM_SCORED row already proves
 * the item passed.
 *
 * Meanwhile the gate's only INTERESTING outcome — a rejection — wrote nothing at
 * all, so "the gate rejected five items" was indistinguishable from "five items
 * were never candidates".
 *
 * These tests pin the whole contract: the count per candidate, that ranking
 * output is unchanged by the write change, that rejections are now recorded, and
 * that a PostgREST `{ error }` RESPONSE (which does not throw) is reported rather
 * than swallowed.
 *
 * Pure and offline — the db is a recording stub.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rankItems } from "../services/ranking/DiscoveryRankingService.js";
import type { RankingInput, RankingViewerContext } from "../services/ranking/DiscoveryRankingService.js";
import { RankingEvent } from "../services/ranking/rankingAnalytics.js";
import { logger } from "../lib/logger.js";

const VIEWER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

const ACTIVE_FLAGS = {
  rankingEnabled: true,
  explorationEnabled: false,
  activityBoostEnabled: false,
  experimentEnabled: false,
  shadowMode: false,
} as any;

function makeViewer(overrides: Partial<RankingViewerContext> = {}): RankingViewerContext {
  return {
    viewerId: VIEWER_ID,
    travelStyles: ["adventure"],
    preferredLanguages: ["en"],
    preferredCities: ["paris"],
    currentCity: "paris",
    currentCountry: "FR",
    lat: 48.85,
    lng: 2.35,
    viewerAge: null,
    followedCreatorIds: new Set<string>(),
    mutedCreatorIds: new Set<string>(),
    sessionId: "sess-1",
    ...overrides,
  } as RankingViewerContext;
}

function makeItem(id: string, overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    itemId: id,
    itemType: "post",
    creatorId: null,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    city: "paris",
    country: "FR",
    tags: ["adventure"],
    category: "adventure",
    languageCode: "en",
    hasMedia: true,
    distanceKm: 2,
    ...overrides,
  } as RankingInput;
}

interface Recorded { table: string; row: any }

/**
 * Recording stub. `mode` selects how the insert settles — the `error` mode is
 * the one that mattered: PostgREST rejections RESOLVE with { error } rather than
 * throwing, so a success handler that ignores the result loses them.
 */
function stubDb(mode: "ok" | "error" | "throw" = "ok") {
  const inserts: Recorded[] = [];
  return {
    inserts,
    from(table: string) {
      return {
        insert(row: any) {
          inserts.push({ table, row });
          if (mode === "throw") throw new Error("connection reset");
          const settled = mode === "error"
            ? { error: { message: "violates check constraint" }, data: null }
            : { error: null, data: null };
          return Promise.resolve(settled);
        },
        select() { return this; },
        eq() { return this; },
        in() { return Promise.resolve({ data: [], error: null }); },
        gte() { return Promise.resolve({ data: [], error: null }); },
      };
    },
  } as any;
}

/** rank_events rows only, tallied by event_type. */
function tally(inserts: Recorded[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of inserts) {
    if (i.table !== "rank_events") continue;
    const k = i.row?.event_type ?? "(none)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Analytics writes are fire-and-forget; let the microtask queue drain. */
const settle = () => new Promise((r) => setTimeout(r, 10));

let warnings: string[];
let originalWarn: typeof logger.warn;
beforeEach(() => {
  warnings = [];
  originalWarn = logger.warn.bind(logger);
  (logger as any).warn = (ctx: any, msg?: string) => { warnings.push(msg ?? String(ctx)); };
});
afterEach(() => { (logger as any).warn = originalWarn; });

describe("rank_events writes per candidate", () => {
  it("writes ONE analytics row per scored candidate, not two", async () => {
    const db = stubDb();
    const items = Array.from({ length: 10 }, (_, i) => makeItem(`item-${i}`));

    const results = await rankItems(items, "discovery", makeViewer(), db, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    } as any);
    await settle();

    const t = tally(db.inserts);
    assert.equal(results.length, 10);
    assert.equal(t[RankingEvent.ITEM_SCORED], 10, "one ITEM_SCORED per candidate");
    assert.equal(t[RankingEvent.ITEM_ELIGIBLE], undefined, "ITEM_ELIGIBLE must no longer be written");

    const total = db.inserts.filter((i) => i.table === "rank_events").length;
    assert.equal(total, 10, `10 candidates must cost 10 rows, got ${total}`);
    assert.notEqual(total, 20, "the pre-fix cost was 2 rows per candidate");
  });

  it("scales linearly at 1 row per candidate", async () => {
    for (const n of [1, 5, 50]) {
      const db = stubDb();
      await rankItems(
        Array.from({ length: n }, (_, i) => makeItem(`i-${i}`)),
        "discovery", makeViewer(), db,
        { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any,
      );
      await settle();
      const total = db.inserts.filter((i) => i.table === "rank_events").length;
      assert.equal(total, n, `${n} candidates must cost ${n} rows, got ${total}`);
    }
  });
});

describe("the gate's rejection is now observable", () => {
  it("writes ITEM_INELIGIBLE — and no ITEM_SCORED — for a rejected item", async () => {
    const db = stubDb();
    const results = await rankItems(
      [makeItem("gone", { isDeleted: true } as any)],
      "discovery", makeViewer(), db,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any,
    );
    await settle();

    const t = tally(db.inserts);
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.eligibilityReason, "item_deleted");
    assert.equal(t[RankingEvent.ITEM_INELIGIBLE], 1, "a rejection must leave a record");
    assert.equal(t[RankingEvent.ITEM_SCORED], undefined, "a rejected item is never scored");
    assert.equal(t[RankingEvent.ITEM_ELIGIBLE], undefined);
  });

  it("a mixed batch costs exactly one row per candidate either way", async () => {
    const db = stubDb();
    await rankItems(
      [makeItem("ok-1"), makeItem("bad-1", { isPrivate: true } as any), makeItem("ok-2")],
      "discovery", makeViewer(), db,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any,
    );
    await settle();

    const t = tally(db.inserts);
    assert.equal(t[RankingEvent.ITEM_SCORED], 2);
    assert.equal(t[RankingEvent.ITEM_INELIGIBLE], 1);
    assert.equal(db.inserts.filter((i) => i.table === "rank_events").length, 3);
  });
});

describe("ranking output is unaffected by the analytics change", () => {
  it("produces identical scores and order with and without a db", async () => {
    const items = ["a", "b", "c", "d"].map((id, i) =>
      makeItem(id, { distanceKm: i + 1, tags: i % 2 ? ["adventure"] : ["food"] } as any));
    const opts = { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any;

    const withDb = await rankItems(items, "discovery", makeViewer(), stubDb(), opts);
    const noDb   = await rankItems(items, "discovery", makeViewer(), null, opts);
    await settle();

    assert.deepEqual(
      withDb.map((o) => [o.itemId, o.finalScore, o.eligibilityPassed]),
      noDb.map((o)  => [o.itemId, o.finalScore, o.eligibilityPassed]),
      "analytics writing must not influence scoring",
    );
  });

  it("every candidate still passes the gate on discovery — behaviour unchanged", async () => {
    const results = await rankItems(
      Array.from({ length: 6 }, (_, i) => makeItem(`n-${i}`)),
      "discovery", makeViewer(), null,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any,
    );
    assert.ok(results.every((r) => r.eligibilityPassed), "discovery inputs are all eligible, as before");
  });
});

describe("a PostgREST { error } RESPONSE is reported, not swallowed", () => {
  it("logs a rejection that RESOLVES with an error object", async () => {
    // The case that was invisible: PostgREST rejections do not throw.
    const db = stubDb("error");
    await rankItems([makeItem("x")], "discovery", makeViewer(), db,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any);
    await settle();
    assert.ok(
      warnings.some((w) => /insert rejected/i.test(w)),
      `expected a rejection warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("logs a THROWN failure, and neither case breaks ranking", async () => {
    const db = stubDb("throw");
    const results = await rankItems([makeItem("y")], "discovery", makeViewer(), db,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS } as any);
    await settle();
    assert.equal(results.length, 1, "ranking must survive an analytics failure");
    assert.ok(results[0]!.eligibilityPassed);
  });
});
