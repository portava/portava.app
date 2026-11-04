/**
 * Account deletion — uploads named only by posts.media_urls / media_thumbnail_url
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *   collect_post_media_url_paths (collectPostUploadReferences), uploadSiblings,
 *   and the post_media collector's sibling derivation.
 *
 * THE DEFECT (red before this change). 2083 made post_media canonical for
 * uploads, but POST /posts kept writing the upload's bare key
 * (`post-media/<uid>/<ms>.<ext>`) into posts.media_urls and created NO
 * post_media row (production, read 2026-10-24 per #795: 4 of 4 such posts).
 * Account deletion collected bytes from post_media only, so
 * tombstone_or_delete_posts erased the row (or blanked media_urls through
 * tombstone_post) and the upload — with its .thumb.jpg / .feed.jpg siblings and
 * a video's .poster.jpg — stayed in the private bucket.
 *
 * AFTER #795 the create path writes post_media rows naming storage_path and at
 * most the poster, so the same siblings are derived from the row's
 * storage_path too; the two collectors feed one de-duplicated removal set.
 *
 * MUTATION PROOF (2026-10-24):
 *   the `await collectPostUploadReferences(…)` call removed        → the media_urls tests fail
 *   the post_media `uploadSiblings` clause removed                  → the #795-shape test fails
 *   section 2's de-duplication removed                              → the "removed once" test fails
 *   the owner check dropped from uploadSiblings                     → the other-owner sibling tests fail
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionPostMediaUrls.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  uploadSiblings,
  POST_MEDIA_BUCKET,
} from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

interface Op { table: string; op: string; filters?: any[]; values?: any; paths?: string[] }

/**
 * Record-only fake supabase client — the same shape
 * accountDeletionEvidenceMedia.test.ts uses.
 *
 * The single `ops` list is the point: DB reads, DB writes, RPCs and storage
 * removes all land in it in the order they happened, so "collected before the
 * rows were deleted" is a checkable property rather than an inference from the
 * final set.
 */
function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** `table` or `table.op` -> error message. */
  fail?: Record<string, string>;
} = {}) {
  const rows: Record<string, any[]> = { posts: [], ...(opts.rows ?? {}) };
  const fail = opts.fail ?? {};
  const ops: Op[] = [];
  const storageRemoved: Array<{ bucket: string; paths: string[] }> = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _limit: 0,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      single() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters, values: q._values });
        const key = `${table}.${q._op}`;
        if (fail[key] || fail[table]) {
          return Promise.resolve({ data: null, error: { message: fail[key] ?? fail[table] } });
        }
        let data: any = rows[table] ?? [];
        if (q._limit) data = data.slice(0, q._limit);
        if (q._single) data = data.length > 0 ? data[0] : null;
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _ops: ops,
    _storageRemoved: storageRemoved,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", values: args });
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          ops.push({ table: `storage:${bucket}`, op: "remove", paths });
          storageRemoved.push({ bucket, paths });
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; },
      },
    },
  };
}

const indexOfOp = (c: any, table: string, op: string) =>
  c._ops.findIndex((o: Op) => o.table === table && o.op === op);

const removedPaths = (c: any) => c._storageRemoved.flatMap((r: any) => r.paths);
const removedIn = (c: any, bucket: string) =>
  c._storageRemoved.filter((r: any) => r.bucket === bucket).flatMap((r: any) => r.paths);

const stepOf = (out: any, name: string) => out.steps.find((s: any) => s.step === name);


const publicUrl = (bucket: string, path: string) =>
  `https://abcdefghijklmno.supabase.co/storage/v1/object/public/${bucket}/${path}`;

const IMG = `${USER_ID}/1729700000000.jpg`;
const VID = `${USER_ID}/1729700000001.mov`;

describe("uploadSiblings — the objects one general upload writes", () => {
  it("an image: its .thumb.jpg and .feed.jpg", () => {
    assert.deepEqual(uploadSiblings(IMG, USER_ID), [
      `${USER_ID}/1729700000000.thumb.jpg`,
      `${USER_ID}/1729700000000.feed.jpg`,
    ]);
  });
  it("a video: also its <key>.poster.jpg", () => {
    assert.deepEqual(uploadSiblings(VID, USER_ID), [
      `${USER_ID}/1729700000001.thumb.jpg`,
      `${USER_ID}/1729700000001.feed.jpg`,
      `${VID}.poster.jpg`,
    ]);
  });
  it("nothing for another owner, a client-writable prefix, a derivative, or any other layout", () => {
    for (const p of [
      `${OTHER_ID}/1729700000000.jpg`,
      `memories/${USER_ID}/1729700000000.jpg`,
      `stories/${USER_ID}/1729700000000.jpg`,
      `${USER_ID}/1729700000000.thumb.jpg`,
      `${USER_ID}/1729700000001.mov.poster.jpg`,
      `${USER_ID}/post-id/media-id.jpg`,
      `${USER_ID}/../${OTHER_ID}/1729700000000.jpg`,
      "",
    ]) {
      assert.deepEqual(uploadSiblings(p, USER_ID), [], p);
    }
  });
});

describe("account deletion — posts.media_urls uploads (no post_media row: main before #795)", () => {
  it("collects every owned upload with its siblings, plus media_thumbnail_url, and removes them BEFORE the post rows go", async () => {
    const c = makeClient({
      rows: {
        posts: [
          { id: "p1", media_urls: [`${POST_MEDIA_BUCKET}/${IMG}`], media_thumbnail_url: null },
          {
            id: "p2",
            media_urls: [publicUrl(POST_MEDIA_BUCKET, VID)],
            media_thumbnail_url: `${POST_MEDIA_BUCKET}/${USER_ID}/1729700000001.thumb.jpg`,
          },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      IMG,
      `${USER_ID}/1729700000000.feed.jpg`,
      `${USER_ID}/1729700000000.thumb.jpg`,
      VID,
      `${VID}.poster.jpg`,
      `${USER_ID}/1729700000001.feed.jpg`,
      `${USER_ID}/1729700000001.thumb.jpg`,
    ].sort());
    // Three references: two uploads and one client-supplied thumbnail.
    assert.equal(stepOf(out, "collect_post_media_url_paths")?.count, 3);
    // Removed once: the thumbnail is both a sibling and media_thumbnail_url.
    const all = removedIn(c, POST_MEDIA_BUCKET);
    assert.equal(all.length, new Set(all).size, `an object was removed twice: ${JSON.stringify(all)}`);

    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");
    const firstPostWrite = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "delete");
    assert.ok(removedAt >= 0 && firstPostWrite > removedAt,
      `the bytes must go before the rows (remove@${removedAt}, posts.delete@${firstPostWrite})`);
  });

  it("a TOMBSTONED post's uploads go too: read before tombstone_post blanks media_urls", async () => {
    const c = makeClient({
      rows: {
        posts: [{ id: "p1", media_urls: [`${POST_MEDIA_BUCKET}/${IMG}`] }],
        // Somebody else commented, so the post is tombstoned, not hard-deleted.
        posts_comments: [{ id: "c1", post_id: "p1", user_id: OTHER_ID }],
      },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.tombstonedCounts.posts, 1, JSON.stringify(out.steps));
    assert.ok(removedIn(c, POST_MEDIA_BUCKET).includes(IMG));
    const readAt = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "select");
    const tombAt = indexOfOp(c, "rpc:tombstone_post", "rpc");
    assert.ok(readAt >= 0 && tombAt > readAt, `read@${readAt} must precede tombstone_post@${tombAt}`);
  });

  it("never removes another user's object, an external URL or junk — and derives no siblings for them", async () => {
    const c = makeClient({
      rows: {
        posts: [{
          id: "p1",
          media_urls: [
            `${POST_MEDIA_BUCKET}/${OTHER_ID}/1729700000000.jpg`,
            publicUrl(POST_MEDIA_BUCKET, `${OTHER_ID}/1729700000002.mov`),
            "https://images.unsplash.com/photo-1234.jpg",
            `${POST_MEDIA_BUCKET}/../../secrets/x.jpg`,
            "data:image/png;base64,iVBORw0KGgo=",
            42,
            null,
            `${POST_MEDIA_BUCKET}/${IMG}`, // the one legitimate entry: a bad sibling element drops only itself
          ],
          media_thumbnail_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/1729700000000.thumb.jpg`,
        }],
      },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(stepOf(out, "collect_post_media_url_paths")?.ok, true);
    assert.equal(stepOf(out, "collect_post_media_url_paths")?.count, 1);
    for (const p of removedPaths(c)) {
      assert.ok(!p.includes(OTHER_ID), `another user's object reached remove(): ${p}`);
      assert.ok(!p.includes("..") && !p.includes("unsplash") && !p.includes("secrets"), p);
    }
    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      IMG, `${USER_ID}/1729700000000.feed.jpg`, `${USER_ID}/1729700000000.thumb.jpg`,
    ].sort());
  });

  it("an unreadable posts read FAILS the step and warns; the rest of the deletion still runs", async () => {
    const c = makeClient({
      rows: { posts: [{ id: "p1", media_urls: [`${POST_MEDIA_BUCKET}/${IMG}`] }] },
      fail: { "posts.select": "connection reset" },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    const s = stepOf(out, "collect_post_media_url_paths");
    assert.ok(s, "the step is recorded even when it fails");
    assert.equal(s.ok, false);
    assert.ok(out.warnings.some((w: string) => w.startsWith("post upload objects may remain in storage")),
      JSON.stringify(out.warnings));
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });
});

describe("account deletion — post_media rows (the shape after #795)", () => {
  it("derives the upload's siblings from storage_path, which #795's create-path rows do not name", async () => {
    const c = makeClient({
      rows: {
        post_media: [
          // #795 insertUploadRows: storage_path, and the poster only if it existed at create.
          { storage_bucket: POST_MEDIA_BUCKET, storage_path: VID, thumbnail_storage_path: null, feed_storage_path: null },
          { storage_bucket: POST_MEDIA_BUCKET, storage_path: IMG, thumbnail_storage_path: null, feed_storage_path: null },
          // A postcard slot's layout (<uid>/<postId>/<mediaId>.<ext>) is not a general upload: unchanged.
          { storage_bucket: POST_MEDIA_BUCKET, storage_path: `${USER_ID}/post-x/media-y.jpg`, thumbnail_storage_path: null, feed_storage_path: null },
        ],
        // After 3924 media_urls carries external references only.
        posts: [{ id: "p1", media_urls: ["https://example.com/x.jpg"] }],
      },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      VID, `${VID}.poster.jpg`, `${USER_ID}/1729700000001.feed.jpg`, `${USER_ID}/1729700000001.thumb.jpg`,
      IMG, `${USER_ID}/1729700000000.feed.jpg`, `${USER_ID}/1729700000000.thumb.jpg`,
      `${USER_ID}/post-x/media-y.jpg`,
    ].sort());
    assert.equal(stepOf(out, "collect_post_media_url_paths")?.count, 0, "an external reference is not ours to delete");
  });

  it("a key named by BOTH a post_media row and media_urls (mid-#795) is removed exactly once", async () => {
    const c = makeClient({
      rows: {
        post_media: [{ storage_bucket: POST_MEDIA_BUCKET, storage_path: IMG, thumbnail_storage_path: null, feed_storage_path: `${USER_ID}/1729700000000.feed.jpg` }],
        posts: [{ id: "p1", media_urls: [`${POST_MEDIA_BUCKET}/${IMG}`] }],
      },
    });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));
    const all = removedIn(c, POST_MEDIA_BUCKET);
    assert.deepEqual([...all].sort(), [IMG, `${USER_ID}/1729700000000.feed.jpg`, `${USER_ID}/1729700000000.thumb.jpg`].sort());
    assert.equal(stepOf(out, `delete_storage:${POST_MEDIA_BUCKET}`)?.count, 3);
  });
});
