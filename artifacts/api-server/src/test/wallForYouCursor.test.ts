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
  type ForYouCursor,
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
});
