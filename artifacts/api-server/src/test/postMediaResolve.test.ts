/**
 * postMediaResolve — the two-store media split.
 *
 * post_media is canonical for STORAGE-BACKED media; posts.media_urls holds
 * EXTERNAL references only (ruled 2026-08-12). These tests pin the properties
 * that make the split safe to ship AHEAD of the backfill migration, which is
 * the ordering the whole change depends on:
 *
 *   pre-migration   storage-backed URL in media_urls, no post_media row
 *   post-migration  post_media row, no media_urls entry
 *
 * The merged result must be the same list in both states, or there is a window
 * during deploy where media vanishes.
 *
 * Run: node --import tsx/esm --test src/test/postMediaResolve.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchPostMediaMap, mergePostMedia, resolveMediaForPosts } from "../lib/postMediaResolve.js";

const POST_A = "aaaaaaaa-0000-4000-a000-000000000001";
const POST_B = "bbbbbbbb-0000-4000-a000-000000000002";

const KEY_1 = "post-media/user-1/1001.jpg";
const KEY_2 = "post-media/user-1/1002.jpg";
const EXTERNAL = "https://images.unsplash.com/photo-abc?w=1080";

/** Minimal fake honouring .select().in().order() and the thenable result. */
function makeClient(rows: any[], opts: { error?: boolean; throws?: boolean } = {}) {
  return {
    from() {
      const b: any = {
        select() { return b; },
        in() { return b; },
        order(col: string, o: any) {
          if (col === "sort_order" && o?.ascending) {
            rows = [...rows].sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
          }
          return b;
        },
        then(onF: any, onR: any) {
          if (opts.throws) return Promise.reject(new Error("boom")).then(onF, onR);
          return Promise.resolve(
            opts.error ? { data: null, error: { message: "db down" } } : { data: rows, error: null },
          ).then(onF, onR);
        },
      };
      return b;
    },
  } as any;
}

const ready = (post_id: string, public_url: string, sort_order = 0, over: any = {}) => ({
  post_id, public_url, sort_order,
  processing_status: "ready", moderation_status: "approved", ...over,
});

describe("fetchPostMediaMap", () => {
  it("groups by post and orders by sort_order", async () => {
    const sc = makeClient([ready(POST_A, KEY_2, 1), ready(POST_A, KEY_1, 0)]);
    const map = await fetchPostMediaMap(sc, [POST_A]);
    assert.deepEqual(map.get(POST_A), [KEY_1, KEY_2]);
  });

  it("a post with no rows is ABSENT, not present-and-empty", async () => {
    const sc = makeClient([]);
    const map = await fetchPostMediaMap(sc, [POST_A]);
    assert.equal(map.has(POST_A), false, "callers must be able to tell 'no rows' from 'not looked up'");
  });

  it("excludes rejected and flagged moderation", async () => {
    const sc = makeClient([
      ready(POST_A, KEY_1, 0, { moderation_status: "rejected" }),
      ready(POST_A, KEY_2, 1, { moderation_status: "flagged" }),
    ]);
    const map = await fetchPostMediaMap(sc, [POST_A]);
    assert.equal(map.has(POST_A), false);
  });

  it("KEEPS pending moderation — it is the default for every new row", async () => {
    // Excluding 'pending' would hide media that has simply not been reviewed,
    // which is every newly uploaded item.
    const sc = makeClient([ready(POST_A, KEY_1, 0, { moderation_status: "pending" })]);
    const map = await fetchPostMediaMap(sc, [POST_A]);
    assert.deepEqual(map.get(POST_A), [KEY_1]);
  });

  it("excludes rows that are not finished processing", async () => {
    const sc = makeClient([ready(POST_A, KEY_1, 0, { processing_status: "pending" })]);
    const map = await fetchPostMediaMap(sc, [POST_A]);
    assert.equal(map.has(POST_A), false);
  });

  it("fails soft on a query error — empty map, no throw", async () => {
    const map = await fetchPostMediaMap(makeClient([], { error: true }), [POST_A]);
    assert.equal(map.size, 0);
  });

  it("fails soft on a thrown query", async () => {
    const map = await fetchPostMediaMap(makeClient([], { throws: true }), [POST_A]);
    assert.equal(map.size, 0);
  });

  it("no ids → no query, empty map", async () => {
    const map = await fetchPostMediaMap(makeClient([ready(POST_A, KEY_1)]), []);
    assert.equal(map.size, 0);
  });
});

describe("mergePostMedia — the deploy-window property", () => {
  // These two are the whole reason the code can ship before the migration.
  it("PRE-migration: url in media_urls, no row → same list", () => {
    const merged = mergePostMedia({ id: POST_A, media_urls: [KEY_1] }, new Map());
    assert.deepEqual(merged, [KEY_1]);
  });

  it("POST-migration: row present, media_urls emptied → same list", () => {
    const merged = mergePostMedia({ id: POST_A, media_urls: [] }, new Map([[POST_A, [KEY_1]]]));
    assert.deepEqual(merged, [KEY_1]);
  });

  it("MID-migration: present in both → deduplicated, not doubled", () => {
    const merged = mergePostMedia({ id: POST_A, media_urls: [KEY_1] }, new Map([[POST_A, [KEY_1]]]));
    assert.deepEqual(merged, [KEY_1]);
  });

  it("storage-backed comes first, external keeps its order after", () => {
    const merged = mergePostMedia(
      { id: POST_A, media_urls: [EXTERNAL] },
      new Map([[POST_A, [KEY_1, KEY_2]]]),
    );
    assert.deepEqual(merged, [KEY_1, KEY_2, EXTERNAL],
      "several surfaces render only [0], so ordering is load-bearing");
  });

  it("external-only post is untouched — the ten editorial posts", () => {
    const merged = mergePostMedia({ id: POST_B, media_urls: [EXTERNAL] }, new Map());
    assert.deepEqual(merged, [EXTERNAL]);
  });

  it("tolerates null, undefined and blank entries", () => {
    const merged = mergePostMedia(
      { id: POST_A, media_urls: ["", "  ", EXTERNAL, null as any] },
      new Map(),
    );
    assert.deepEqual(merged, [EXTERNAL]);
  });
});

describe("resolveMediaForPosts", () => {
  it("resolves a page in one lookup, every post keyed", async () => {
    const sc = makeClient([ready(POST_A, KEY_1, 0)]);
    const map = await resolveMediaForPosts(sc, [
      { id: POST_A, media_urls: [] },
      { id: POST_B, media_urls: [EXTERNAL] },
    ]);
    assert.deepEqual(map.get(POST_A), [KEY_1]);
    assert.deepEqual(map.get(POST_B), [EXTERNAL]);
  });

  it("a DB outage degrades to media_urls, not to a blank feed", async () => {
    const sc = makeClient([], { error: true });
    const map = await resolveMediaForPosts(sc, [{ id: POST_A, media_urls: [KEY_1] }]);
    assert.deepEqual(map.get(POST_A), [KEY_1]);
  });
});
