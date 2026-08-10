/**
 * The feed-variant (migration 0208) client contract.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * Every post_media row that existed before 0208 has feed_url NULL, and always
 * will — 0208 ran no backfill. So the API must answer two different questions
 * with two different values:
 *
 *   variant exists      -> return its URL
 *   variant absent      -> return null, and the client renders the original
 *
 * The failure mode this exists to prevent is the client DERIVING the variant
 * path from the original (appending `.feed.jpg`). That is trivially easy to
 * write, looks correct against any freshly-uploaded post, and 404s for every
 * single pre-existing one — a silent, total image blackout on historical
 * content. The server reports existence; the client never infers it.
 *
 * `null` and `undefined` are NOT interchangeable here. `undefined` is dropped
 * by JSON.stringify, so the key vanishes from the response, and a client
 * written as `'feed_url' in m ? … : …` would read "absent key" as something
 * other than "no variant". The projection normalises to explicit null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterPostMedia } from "../routes/posts.js";
import { FEED_DIM, THUMBNAIL_DIM, MAX_IMAGE_DIM } from "../lib/mediaProcessing.js";

/** A ready, unmoderated post_media row — the shape the feed selects. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    media_type: "image",
    public_url: "post-media/u1/p1/m1.jpg",
    thumbnail_url: "post-media/u1/p1/m1.thumb.jpg",
    duration_seconds: null,
    width: 2048,
    height: 1365,
    sort_order: 0,
    processing_status: "ready",
    moderation_status: "approved",
    ...over,
  };
}

describe("0208 feed-variant projection contract", () => {
  it("returns the variant URL when the row has one", () => {
    const [m] = filterPostMedia([row({ feed_url: "post-media/u1/p1/m1.jpg.feed.jpg" })]);
    assert.equal(m.feed_url, "post-media/u1/p1/m1.jpg.feed.jpg");
    // The original must still be served — detail/fullscreen loads it.
    assert.equal(m.url, "post-media/u1/p1/m1.jpg");
  });

  it("returns null — not a derived path — when the row has feed_url NULL", () => {
    const [m] = filterPostMedia([row({ feed_url: null })]);
    assert.equal(m.feed_url, null);
    assert.notEqual(m.feed_url, `${m.url}.feed.jpg`);
  });

  it("returns null when the column is absent entirely (pre-0208 environment)", () => {
    // feedVariantCol() omits the column from the select when 0208 is not
    // applied, so the row arrives with no feed_url key at all. That must
    // surface as null, not as a missing key.
    const [m] = filterPostMedia([row()]);
    assert.equal(m.feed_url, null);
    assert.ok("feed_url" in m, "key must be present so the client sees an explicit null");
    assert.ok(
      JSON.stringify(m).includes('"feed_url":null'),
      "feed_url must survive JSON serialization as null, not be dropped as undefined",
    );
  });

  it("never invents a variant for a video", () => {
    const [m] = filterPostMedia([
      row({ media_type: "video", public_url: "post-media/u1/p1/m1.mp4", feed_url: null }),
    ]);
    assert.equal(m.feed_url, null);
  });

  it("keeps the size ladder ordered: thumbnail < feed < original", () => {
    // Not a style preference — the tile picks the smallest sufficient asset, and
    // that logic is only correct while these three stay in this order.
    assert.ok(THUMBNAIL_DIM < FEED_DIM, `${THUMBNAIL_DIM} < ${FEED_DIM}`);
    assert.ok(FEED_DIM < MAX_IMAGE_DIM, `${FEED_DIM} < ${MAX_IMAGE_DIM}`);
  });
});
