/**
 * WallRankingService — For You cursor stability (spec §28). Proves page 2 is a
 * continuation of page 1 (no overlap, no reshuffle) and that re-fetching page 1
 * within the same session reproduces it exactly, while a fresh session gets a
 * new rank session token.
 *
 * Runs with sc = null and injected ranking-flag overrides, so no database is
 * touched — the ranker computes composite scores from the projections alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankForYou,
  decodeForYouCursor,
  encodeForYouCursor,
  WALL_RANK_VERSION,
  type ForYouCursor,
  type WallRankSignals,
  type WallRankViewer,
} from "../services/wall/WallRankingService.js";
import type { WallProjection } from "../lib/wallProjection.js";

const VIEWER: WallRankViewer = { viewerId: "viewer-1" };
const RANK_OVERRIDES = { flags: { ACTIVITY_DISCOVERY_BOOST_ENABLED: false } };

function p(id: string, publishedAt: string): WallProjection {
  return {
    projectionId: "proj_" + id,
    objectType: "social_post",
    canonicalObjectId: id,
    publishedAt,
    visibility: "public",
    actions: [],
  };
}

// Mix of distinct and tied publish times so both score-ordering and the
// session-seeded tiebreak are exercised.
function corpus(): WallProjection[] {
  return [
    p("a", "2026-09-01T10:00:00Z"),
    p("b", "2026-09-01T09:00:00Z"),
    p("c", "2026-09-01T09:00:00Z"),
    p("d", "2026-09-01T08:00:00Z"),
    p("e", "2026-09-01T08:00:00Z"),
    p("f", "2026-09-01T07:00:00Z"),
  ];
}

describe("WallRankingService For You cursor", () => {
  it("page 2 continues page 1 with no overlap and no reshuffle", async () => {
    const items = corpus();
    const page1 = await rankForYou(null, items, VIEWER, { limit: 3, rankOverrides: RANK_OVERRIDES });
    assert.equal(page1.items.length, 3);
    assert.ok(page1.nextCursor, "there is a next page");

    const page2 = await rankForYou(null, items, VIEWER, {
      limit: 3,
      cursor: page1.nextCursor,
      rankOverrides: RANK_OVERRIDES,
    });

    const ids1 = page1.items.map((x) => x.canonicalObjectId);
    const ids2 = page2.items.map((x) => x.canonicalObjectId);

    // No object appears on both pages (spec §28: never duplicate canonicalObjectId).
    assert.equal(new Set([...ids1, ...ids2]).size, ids1.length + ids2.length);
    // Together the two pages cover the whole corpus.
    assert.deepEqual(new Set([...ids1, ...ids2]), new Set(items.map((x) => x.canonicalObjectId)));
    // Same session/version carried across pages.
    assert.equal(page2.session, page1.session);
    assert.equal(page2.version, page1.version);
    assert.equal(page2.nextCursor, null, "corpus exhausted");
  });

  it("re-fetching page 1 within the same session is byte-for-byte stable", async () => {
    const items = corpus();
    const page1 = await rankForYou(null, items, VIEWER, { limit: 3, rankOverrides: RANK_OVERRIDES });

    // Reconstruct a page-1 cursor (offset 0, same session) and re-rank — the
    // ordering must not drift even though we ranked the full set again.
    const page1Cursor: ForYouCursor = {
      session: page1.session,
      version: page1.version,
      offset: 0,
      snapshotAt: page1.snapshotAt,
    };
    const refetch = await rankForYou(null, items, VIEWER, {
      limit: 3,
      cursor: page1Cursor,
      rankOverrides: RANK_OVERRIDES,
    });
    assert.deepEqual(
      refetch.items.map((x) => x.canonicalObjectId),
      page1.items.map((x) => x.canonicalObjectId),
      "page 1 is not reshuffled when re-fetched in the same session",
    );
  });

  it("a refresh (no cursor) starts a NEW rank session", async () => {
    const items = corpus();
    const first = await rankForYou(null, items, VIEWER, { limit: 3, rankOverrides: RANK_OVERRIDES });
    const second = await rankForYou(null, items, VIEWER, { limit: 3, rankOverrides: RANK_OVERRIDES });
    assert.notEqual(second.session, first.session, "each fresh feed open is a new session");
  });

  it("de-duplicates canonicalObjectId across the ranked set", async () => {
    const items = [...corpus(), p("a", "2026-09-01T10:00:00Z")]; // dup of a
    const all = await rankForYou(null, items, VIEWER, { limit: 50, rankOverrides: RANK_OVERRIDES });
    const ids = all.items.map((x) => x.canonicalObjectId);
    assert.equal(new Set(ids).size, ids.length, "no duplicate objects");
    assert.equal(ids.filter((x) => x === "a").length, 1);
  });

  it("stamps per-item ranking metadata (session/version/rank)", async () => {
    const items = corpus();
    const page = await rankForYou(null, items, VIEWER, { limit: 2, rankOverrides: RANK_OVERRIDES });
    assert.equal(page.items[0].ranking?.session, page.session);
    assert.equal(page.items[0].ranking?.rank, 0);
    assert.equal(page.items[1].ranking?.rank, 1);
    // The composite score is NOT leaked to the client (spec §37).
    assert.equal((page.items[0].ranking as any).finalScore, undefined);
  });

  it("cursor codec round-trips and rejects tampering", () => {
    const c: ForYouCursor = {
      session: "11111111-1111-1111-1111-111111111111",
      version: "wall-foryou-v1",
      offset: 3,
      snapshotAt: "2026-09-01T10:00:00.000Z",
    };
    assert.deepEqual(decodeForYouCursor(encodeForYouCursor(c)), c);
    assert.equal(decodeForYouCursor("%%%"), null);
    assert.equal(
      decodeForYouCursor(Buffer.from(JSON.stringify({ ...c, session: "bad" })).toString("base64url")),
      null,
    );
  });

  // ── The evaluation instant (spec §28) ──────────────────────────────────────
  //
  // Ranking is not a pure function of the candidate set: freshness decays
  // continuously, so WHEN a page is scored changes the order it produces. The
  // route already freezes the candidate set to the cursor's `snapshotAt`; these
  // prove the ranker is handed that same instant, so one session's pages are
  // scored at one moment rather than at three successive wall clocks.
  //
  // The clock is stubbed rather than waited on: the production failure is a
  // millisecond of real drift between two calls, which is unreproducible by
  // waiting and is exactly what made the stability test above flaky on CI
  // (it passed 30/30 locally and failed once in CI with a/c/b for a/b/c).

  const REAL_NOW = Date.now;
  const SNAPSHOT = "2026-09-01T12:00:00.000Z";

  /** Run one page with `clock` installed as Date.now, then restore it. */
  async function orderUnderClock(
    clock: () => number,
    cursor: ForYouCursor,
    items: WallProjection[],
    signals?: Map<string, WallRankSignals>,
  ): Promise<string[]> {
    Date.now = clock;
    try {
      const r = await rankForYou(null, items, VIEWER, {
        limit: 50,
        cursor,
        signals,
        rankOverrides: RANK_OVERRIDES,
      });
      return r.items.map((x) => x.canonicalObjectId);
    } finally {
      Date.now = REAL_NOW;
    }
  }

  function cursorAt(snapshotAt: string): ForYouCursor {
    return {
      session: "11111111-2222-4333-8444-555555555555",
      version: WALL_RANK_VERSION,
      offset: 0,
      snapshotAt,
    };
  }

  it("scores one session at ONE instant, not once per item (millisecond drift)", async () => {
    // `b`/`c` and `d`/`e` share a publish time, so at any single instant they are
    // exact score ties and the session-seeded tiebreak decides. Reading the clock
    // per item breaks those ties by whichever side of a millisecond boundary each
    // item landed on — which is the real CI failure, reproduced deterministically
    // by a clock that ticks once per read.
    const cursor = cursorAt(SNAPSHOT);
    const t0 = Date.parse(SNAPSHOT);

    const frozen = await orderUnderClock(() => t0, cursor, corpus());
    let tick = t0;
    const ticking = await orderUnderClock(() => tick++, cursor, corpus());

    assert.deepEqual(
      ticking,
      frozen,
      "a clock that advances mid-ranking must not reorder the page",
    );
  });

  it("scores one session at its snapshot, not at the wall clock", async () => {
    // A score crossing, not a tie: `vintage` is older but carries the engagement
    // signals, so freshness alone puts `fresh` first — until enough time passes
    // that the decayed freshness gap falls below the quality gap. Which side of
    // that crossing a page lands on must be decided by the session's snapshot,
    // so page 2 sees the same world as page 1.
    const items = [
      p("vintage", "2026-08-01T12:00:00.000Z"),
      p("fresh", "2026-09-01T11:00:00.000Z"),
    ];
    const signals = new Map<string, WallRankSignals>([
      ["vintage", {
        completeness: 1,
        positiveReviewRate: 1,
        saveCount: 40,
        shareCount: 20,
        commentCount: 30,
        impressionCount: 500,
        uniqueViewerCount: 400,
      }],
    ]);
    const cursor = cursorAt(SNAPSHOT);
    const t0 = Date.parse(SNAPSHOT);

    const atSnapshot = await orderUnderClock(() => t0, cursor, items, signals);
    const muchLater = await orderUnderClock(
      () => t0 + 30 * 86_400_000,
      cursor,
      items,
      signals,
    );

    assert.deepEqual(
      muchLater,
      atSnapshot,
      "the same session must produce the same order whenever its pages are fetched",
    );
    // Guards the assertion above against passing vacuously: this corpus really
    // does have an order to get wrong.
    assert.deepEqual(atSnapshot, ["fresh", "vintage"]);
  });

  it("a LATER snapshot ranks the same corpus differently (the instant is read)", async () => {
    // Positive control for the two tests above: they would also pass if the
    // ranker had simply stopped depending on time. Two sessions differing ONLY
    // in `snapshotAt`, scored under one frozen wall clock, must disagree — which
    // is only possible if `snapshotAt` is what the ranker evaluates at.
    const items = [
      p("vintage", "2026-08-01T12:00:00.000Z"),
      p("fresh", "2026-09-01T11:00:00.000Z"),
    ];
    const signals = new Map<string, WallRankSignals>([
      ["vintage", {
        completeness: 1,
        positiveReviewRate: 1,
        saveCount: 40,
        shareCount: 20,
        commentCount: 30,
        impressionCount: 500,
        uniqueViewerCount: 400,
      }],
    ]);
    const frozen = () => Date.parse(SNAPSHOT);
    const later = new Date(Date.parse(SNAPSHOT) + 30 * 86_400_000).toISOString();

    assert.deepEqual(
      await orderUnderClock(frozen, cursorAt(SNAPSHOT), items, signals),
      ["fresh", "vintage"],
    );
    assert.deepEqual(
      await orderUnderClock(frozen, cursorAt(later), items, signals),
      ["vintage", "fresh"],
    );
  });
});
