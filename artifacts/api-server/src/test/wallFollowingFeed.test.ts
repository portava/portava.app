/**
 * FollowingFeedService — strict reverse chronology with a deterministic
 * tiebreaker and a cursor that is stable against publishedAt + id (spec §5/§16/
 * §28 / TABLE 1). No relevance reordering happens here, by contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFollowing,
  encodeFollowingCursor,
  decodeFollowingCursor,
} from "../services/wall/FollowingFeedService.js";
import type { WallProjection } from "../lib/wallProjection.js";

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

describe("FollowingFeedService", () => {
  it("orders strictly by publishedAt DESC, tiebreak canonicalObjectId DESC", () => {
    const items = [
      p("a", "2026-09-01T10:00:00Z"),
      p("c", "2026-09-01T12:00:00Z"),
      p("b", "2026-09-01T12:00:00Z"), // same instant as c → tiebreak by id DESC
      p("d", "2026-09-01T08:00:00Z"),
    ];
    const out = buildFollowing(items, { limit: 10 });
    assert.deepEqual(
      out.items.map((x) => x.canonicalObjectId),
      ["c", "b", "a", "d"],
    );
    assert.equal(out.caughtUp, true);
    assert.equal(out.nextCursor, null);
  });

  it("paginates without overlap and reports caughtUp only at the end", () => {
    const items = [
      p("a", "2026-09-01T05:00:00Z"),
      p("b", "2026-09-01T04:00:00Z"),
      p("c", "2026-09-01T03:00:00Z"),
      p("d", "2026-09-01T02:00:00Z"),
      p("e", "2026-09-01T01:00:00Z"),
    ];
    const page1 = buildFollowing(items, { limit: 2 });
    assert.deepEqual(page1.items.map((x) => x.canonicalObjectId), ["a", "b"]);
    assert.equal(page1.caughtUp, false);
    assert.ok(page1.nextCursor);

    const page2 = buildFollowing(items, { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.items.map((x) => x.canonicalObjectId), ["c", "d"]);
    assert.equal(page2.caughtUp, false);

    const page3 = buildFollowing(items, { limit: 2, cursor: page2.nextCursor });
    assert.deepEqual(page3.items.map((x) => x.canonicalObjectId), ["e"]);
    assert.equal(page3.caughtUp, true, "last page is caught up");
    assert.equal(page3.nextCursor, null);
  });

  it("cursor is stable when new content is prepended (no drift of the tail)", () => {
    const original = [
      p("b", "2026-09-01T04:00:00Z"),
      p("c", "2026-09-01T03:00:00Z"),
      p("d", "2026-09-01T02:00:00Z"),
    ];
    const page1 = buildFollowing(original, { limit: 1 });
    assert.deepEqual(page1.items.map((x) => x.canonicalObjectId), ["b"]);

    // A newer item "a" arrives before page 2 is fetched. Because the cursor is a
    // position in a total order (not an offset), page 2 still continues after b.
    const withNew = [p("a", "2026-09-01T05:00:00Z"), ...original];
    const page2 = buildFollowing(withNew, { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(
      page2.items.map((x) => x.canonicalObjectId),
      ["c", "d"],
      "the freshly prepended item never appears mid-pagination after the cursor",
    );
  });

  it("dedupes repeated canonicalObjectId within a page", () => {
    const items = [
      p("a", "2026-09-01T05:00:00Z"),
      p("a", "2026-09-01T05:00:00Z"),
      p("b", "2026-09-01T04:00:00Z"),
    ];
    const out = buildFollowing(items, { limit: 10 });
    assert.deepEqual(out.items.map((x) => x.canonicalObjectId), ["a", "b"]);
  });

  it("does not claim caughtUp on a mid-tail page when the fetch was capped (D10)", () => {
    // A mid-tail page: the gated window ran out of after-cursor items, but the
    // underlying fetch was CAPPED (reachedEnd=false) — older eligible posts remain
    // unfetched. buildFollowing must NOT report "you're all caught up".
    const cursor = { publishedAt: "2026-09-01T03:00:00Z", id: "post-149" };
    const window = [p("post-150", "2026-09-01T02:00:00Z")]; // few items after the cursor in THIS window
    const capped = buildFollowing(window, { limit: 20, cursor, reachedEnd: false });
    assert.equal(capped.caughtUp, false, "a capped fetch window never masquerades as caught up");

    // Same page shape but the fetch reached the TRUE end (short read) ⇒ genuinely caught up.
    const ended = buildFollowing(window, { limit: 20, cursor, reachedEnd: true });
    assert.equal(ended.caughtUp, true, "the true end (short fetch) IS caught up");

    // Back-compat: callers that fetch the whole set (no reachedEnd) still report
    // caughtUp on the last page.
    const whole = buildFollowing(window, { limit: 20, cursor });
    assert.equal(whole.caughtUp, true, "reachedEnd unspecified ⇒ !hasMore suffices");
  });

  it("round-trips the cursor codec and rejects garbage", () => {
    const c = { publishedAt: "2026-09-01T04:00:00Z", id: "b" };
    assert.deepEqual(decodeFollowingCursor(encodeFollowingCursor(c)), c);
    assert.equal(decodeFollowingCursor("not-base64!!"), null);
    assert.equal(decodeFollowingCursor(Buffer.from("{}").toString("base64url")), null);
  });
});
