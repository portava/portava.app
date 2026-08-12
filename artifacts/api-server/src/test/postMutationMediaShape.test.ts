/**
 * postMutationMediaShape.test.ts — #3585: the shape-B blank-tile regression.
 *
 * WHAT BROKE
 * ----------
 * 2083 made post_media canonical for storage-backed media and STRIPPED those
 * entries out of posts.media_urls. Unit C converted the FEED endpoints to read
 * post_media, but not the mutation/pending endpoints, which kept returning the
 * raw posts row: `media_urls` now empty, and no `media` key at all.
 *
 * The client's mapPost() reads exactly those two fields:
 *
 *     mediaUrls: r.media_urls ?? []
 *     media:     Array.isArray(r.media) ? r.media : undefined
 *
 * so a storage-backed post came back as `mediaUrls: []` and `media: undefined`
 * — a post model carrying no media at all, which renders as a blank tile while
 * media_count still reads > 0. Before 2083 the same code worked, because
 * media_urls still held the storage URL. The strip is what exposed it.
 *
 * WHY THIS SUITE HAS A CONTROL
 * ----------------------------
 * The headline assertion is that `media` is POPULATED, so it cannot pass
 * vacuously the way an absence assertion can. The risk here is the opposite
 * one: that `media` is attached indiscriminately — every post handed the same
 * rows — which would satisfy "media is populated" while being just as wrong.
 *
 * So the control is the MIXED-FIXTURE case: one storage-backed post and one
 * external post in the SAME response, asserting the storage-backed one gets
 * its two rows and the external one gets `[]`. A blanket attach fails that
 * immediately. A per-post resolution passes it. That is a distinction the
 * single-post cases genuinely cannot draw.
 *
 * RED-PROOF, measured rather than assumed
 * ---------------------------------------
 * Reverting the `withPostMedia(...)` call at the pending-posts response to
 * `data ?? []` fails ALL of these, not just the storage-backed one — because
 * without it `media` is `undefined` everywhere, and `undefined` is not `[]`.
 * That is worth stating plainly: an earlier draft of this comment claimed the
 * external case would survive the revert. It does not. The external case earns
 * its place as a control through the mixed fixture, not by surviving the
 * revert.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _resetStampOverlayColCache } from "../lib/postMediaOverlay.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[] }

const CALLER_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORAGE_POST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EXTERNAL_POST = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TOKEN = "fake-3585-token";

function makeFakeClient(tables: Record<string, FakeTable>) {
  const db: Record<string, FakeTable> = {
    profiles: { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    ...tables,
  };

  function chain(tableName: string) {
    const t = db[tableName] ?? { rows: [] };
    const filters: Array<(r: Row) => boolean> = [];
    let _single = false;
    let _write: Row | null = null;

    const obj: any = {
      select()          { return obj; },
      insert(d: Row)    { _write = d; return obj; },
      update(d: Row)    { _write = d; return obj; },
      upsert(d: Row)    { _write = d; return obj; },
      delete()          { return obj; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, v: any[]){ filters.push((r) => v.includes(r[c])); return obj; },
      is(c: string, v: any)  { filters.push((r) => r[c] === v); return obj; },
      not()             { return obj; },
      order()           { return obj; },
      limit()           { return obj; },
      single()          { _single = true; return obj; },
      maybeSingle()     { _single = true; return obj; },
      then(resolve: (v: any) => any) {
        if (!resolve) return undefined;
        if (_write !== null) return resolve({ data: { ..._write }, error: null });
        const results = t.rows.filter((r) => filters.every((f) => f(r)));
        if (_single) return resolve({ data: results[0] ?? null, error: null });
        return resolve({ data: results, error: null });
      },
    };
    return obj;
  }

  return {
    from: (t: string) => chain(t),
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: CALLER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

/** A post_media row as the table actually stores it. */
function mediaRow(postId: string, id: string, sort: number, url: string): Row {
  return {
    post_id: postId,
    id,
    media_type: "image",
    public_url: url,
    thumbnail_url: `${url}.thumb.jpg`,
    duration_seconds: null,
    width: 1200,
    height: 900,
    sort_order: sort,
    processing_status: "ready",
    moderation_status: "approved",
    stamp_overlay: null,
    feed_url: null,
  };
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  _resetStampOverlayColCache();
});

async function getPending(): Promise<any> {
  const res = await fetch(`${baseUrl}/api/posts/pending`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, "pending posts must return 200");
  return res.json();
}

describe("#3585 — mutation/pending responses carry post_media, not just media_urls", () => {
  it("storage-backed post: media_urls is empty post-2083, and media IS populated", async () => {
    _setTestClient(
      makeFakeClient({
        posts: {
          rows: [
            {
              id: STORAGE_POST,
              author_id: CALLER_ID,
              content: "uploaded photos",
              // Post-2083 state: the storage-backed entries were stripped out.
              media_urls: [],
              media_count: 2,
              status: "active",
              post_status: "pending_delay",
              created_at: "2026-08-12T00:00:00Z",
            },
          ],
        },
        post_media: {
          rows: [
            mediaRow(STORAGE_POST, "m2", 1, "https://cdn.example/post-media/b.jpg"),
            mediaRow(STORAGE_POST, "m1", 0, "https://cdn.example/post-media/a.jpg"),
          ],
        },
      }) as any,
      true,
    );

    const body = await getPending();
    const post = body.posts.find((p: any) => p.id === STORAGE_POST);
    assert.ok(post, "the pending post must be returned");

    // The precondition that makes this bug possible, asserted so the test
    // fails loudly if the fixture stops representing the post-2083 world.
    assert.deepEqual(post.media_urls, [], "fixture must model the stripped column");
    assert.equal(post.media_count, 2, "media_count still reports media exists");

    // The regression itself.
    assert.ok(Array.isArray(post.media), "media must be an array, not undefined");
    assert.equal(post.media.length, 2, "both post_media rows must be projected");

    // sort_order, not insertion order — filterPostMedia sorts.
    assert.deepEqual(
      post.media.map((m: any) => m.url),
      [
        "https://cdn.example/post-media/a.jpg",
        "https://cdn.example/post-media/b.jpg",
      ],
      "media must be ordered by sort_order",
    );
    assert.equal(post.media[0].thumbnail_url, "https://cdn.example/post-media/a.jpg.thumb.jpg");
  });

  it("CONTROL — mixed response resolves media PER POST, not indiscriminately", async () => {
    // Both posts in one response. A blanket attach — every post handed the same
    // rows — would satisfy "media is populated" while being just as wrong as
    // attaching nothing. This is the case that tells the two apart, and the
    // single-post cases cannot.
    _setTestClient(
      makeFakeClient({
        posts: {
          rows: [
            {
              id: STORAGE_POST,
              author_id: CALLER_ID,
              content: "uploaded photos",
              media_urls: [],
              media_count: 2,
              status: "active",
              post_status: "pending_delay",
              created_at: "2026-08-12T00:00:00Z",
            },
            {
              id: EXTERNAL_POST,
              author_id: CALLER_ID,
              content: "editorial post",
              media_urls: ["https://images.unsplash.com/photo-123"],
              media_count: 1,
              status: "active",
              post_status: "pending_delay",
              created_at: "2026-08-12T00:00:00Z",
            },
          ],
        },
        post_media: {
          rows: [
            mediaRow(STORAGE_POST, "m1", 0, "https://cdn.example/post-media/a.jpg"),
            mediaRow(STORAGE_POST, "m2", 1, "https://cdn.example/post-media/b.jpg"),
          ],
        },
      }) as any,
      true,
    );

    const body = await getPending();
    const storage = body.posts.find((p: any) => p.id === STORAGE_POST);
    const external = body.posts.find((p: any) => p.id === EXTERNAL_POST);
    assert.ok(storage && external, "both pending posts must be returned");

    assert.equal(storage.media.length, 2, "the storage-backed post gets its own two rows");
    assert.deepEqual(
      external.media,
      [],
      "the external post gets [] — proving rows are keyed by post_id, not blanket-attached",
    );
    assert.deepEqual(
      external.media_urls,
      ["https://images.unsplash.com/photo-123"],
      "external references survive untouched — that is media_urls' documented role",
    );
  });

  it("non-ready and rejected post_media rows are excluded, and never crash", async () => {
    _setTestClient(
      makeFakeClient({
        posts: {
          rows: [
            {
              id: STORAGE_POST,
              author_id: CALLER_ID,
              content: "mixed states",
              media_urls: [],
              media_count: 3,
              status: "active",
              post_status: "pending_delay",
              created_at: "2026-08-12T00:00:00Z",
            },
          ],
        },
        post_media: {
          rows: [
            mediaRow(STORAGE_POST, "ok", 0, "https://cdn.example/post-media/ok.jpg"),
            { ...mediaRow(STORAGE_POST, "pending", 1, "https://cdn.example/post-media/p.jpg"), processing_status: "processing" },
            { ...mediaRow(STORAGE_POST, "rejected", 2, "https://cdn.example/post-media/r.jpg"), moderation_status: "rejected" },
          ],
        },
      }) as any,
      true,
    );

    const body = await getPending();
    const post = body.posts.find((p: any) => p.id === STORAGE_POST);
    assert.equal(post.media.length, 1, "only the ready, non-rejected row is projected");
    assert.equal(post.media[0].url, "https://cdn.example/post-media/ok.jpg");
  });
});
