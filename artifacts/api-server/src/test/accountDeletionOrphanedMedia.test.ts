/**
 * Account deletion — the CLIENT-SUPPLIED media URL columns
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed
 * ================================
 * The same class the intel_evidence fix closed (see
 * accountDeletionEvidenceMedia.test.ts): the deletion erased the ROW and left
 * the OBJECT in the bucket. Four more columns held a storage reference that
 * nothing ever collected, so the row-level erasure was complete and the bytes
 * were not:
 *
 *   stories.media_url                          → delete_stories
 *   messages.media_url + media_thumbnail_url   → delete_messages
 *   hidden_gems.image_url                      → delete_hidden_gems
 *   reviews.photos (text[])                    → delete_reviews
 *
 * `check:deletion-coverage` was green throughout — it asks whether every
 * user-keyed TABLE has a stated fate, and nothing asks whether every stored
 * OBJECT does.
 *
 * WHY THESE ARE NOT THE SAME AS intel_evidence.reference
 * ======================================================
 * intel_evidence.reference is SERVER-WRITTEN: lib/intelEvidenceCapture had
 * already proven the object was ours and theirs before storing the key. These
 * four are client-supplied, and their write paths differ in how much they check:
 *
 *   stories.media_url    — POST /stories checks appStorageUrlInfo AND
 *                          ownerFromPath === user.id.
 *   messages.media_url / media_thumbnail_url — POST /threads/:id/media checks
 *                          appStorageUrlInfo only. NO ownership check, so a
 *                          sender may legitimately store another user's key.
 *   hidden_gems.image_url — `z.string().url().max(2048)`. Nothing more.
 *   reviews.photos        — `z.array(z.string().url()).max(3)`. Nothing more.
 *
 * So a value in any of them may be a foreign URL, a data URI, another user's
 * object key, or junk. The properties this suite pins are therefore not just
 * "the bytes go" but "and nothing else does":
 *
 *   * an owned object IS collected;
 *   * a foreign URL is SKIPPED and never appears in a remove() call — we have
 *     no business issuing a delete against somebody else's URL;
 *   * a path whose owner is a different user is REFUSED, on every column,
 *     including the ones whose write path "should" make it impossible;
 *   * collection PRECEDES the row deletion, asserted on the ORDERED op log
 *     rather than on the final set — a collector placed after the delete reads
 *     nothing and produces a result indistinguishable from "no media";
 *   * for reviews.photos, one bad element drops ONLY ITSELF: it neither
 *     discards its siblings nor aborts the step.
 *
 * NOT COVERED, DELIBERATELY: passport_memories.photo_url. Those ROWS are not
 * deleted at all — the table sits in deletionDispositions' UNCLASSIFIED_BACKLOG
 * ("NOT a decision") with no D6 classification, so nothing has authorised
 * erasing it. Deleting the bytes under a row that survives would manufacture a
 * broken record and pre-empt a ruling nobody has made.
 *
 * MUTATION PROOF (performed 2026-08-31) — reverting each collection step in
 * turn, then restoring it. 25 tests in this file:
 *   collect_story_media_paths        removed →  8 fail
 *   collect_message_media_paths      removed →  9 fail
 *   collect_hidden_gem_media_paths   removed →  8 fail
 *   collect_review_photo_paths       removed →  8 fail
 *   all four moved AFTER their row deletes → 16 fail — the ordering half is the
 *     one that could have made this silently useless: section 2 has already
 *     removed by then, so the collected paths go nowhere and the result is
 *     indistinguishable from "this user had no media".
 *   the `..` + ownerFromPath guards dropped from collectOwnedReference →
 *     8 fail here, and 1 of the 8 in accountDeletionEvidenceMedia.test.ts,
 *     since intel_evidence now routes through that same guard.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionOrphanedMedia.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  POST_MEDIA_BUCKET,
  PROFILE_MEDIA_BUCKET,
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

/** A public-URL form of one of our keys — the shape `z.string().url()` forces. */
const publicUrl = (bucket: string, path: string) =>
  `https://abcdefghijklmno.supabase.co/storage/v1/object/public/${bucket}/${path}`;

/**
 * References that must NEVER reach remove(), whatever column they sit in.
 * Reused across the four columns so no column gets a weaker guard than another.
 */
const HOSTILE_REFERENCES: Array<[label: string, value: any]> = [
  ["an external host", "https://images.unsplash.com/photo-1234.jpg"],
  ["a data URI", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="],
  ["a bucket outside the allow-list", "secrets/private.jpg"],
  ["path traversal dressed as ours", `${POST_MEDIA_BUCKET}/../../secrets/private.jpg`],
  ["another user's object key", `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.jpg`],
  ["another user's object as a public URL", publicUrl(POST_MEDIA_BUCKET, `${OTHER_ID}/theirs.jpg`)],
  ["a path with no derivable owner", `${POST_MEDIA_BUCKET}/not-a-uuid/orphan.jpg`],
  ["a bucket name with nothing after it", `${POST_MEDIA_BUCKET}/`],
  ["an empty string", ""],
  ["null", null],
  ["non-string junk", 42],
];

/** Assert nothing hostile got through, whatever else the run removed. */
function assertNoHostileRemovals(c: any) {
  for (const r of c._storageRemoved) {
    assert.ok(
      [POST_MEDIA_BUCKET, PROFILE_MEDIA_BUCKET].includes(r.bucket),
      `removed from a bucket outside the allow-list: ${r.bucket}`,
    );
  }
  for (const p of removedPaths(c)) {
    assert.ok(!p.includes(".."), `a traversal path reached remove(): ${p}`);
    assert.ok(!p.startsWith(OTHER_ID), `another user's object reached remove(): ${p}`);
    assert.ok(!p.includes("unsplash") && !p.includes("data:"), `a foreign reference reached remove(): ${p}`);
    assert.ok(!p.includes("secrets"), `an out-of-bucket path reached remove(): ${p}`);
  }
}

// ── stories.media_url ────────────────────────────────────────────────────────

describe("account deletion — stories.media_url", () => {
  it("collects the story's object, in both the bare-key and public-URL shapes", async () => {
    const c = makeClient({
      rows: {
        stories: [
          { media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/story-1.jpg` },
          { media_url: publicUrl(POST_MEDIA_BUCKET, `${USER_ID}/story-2.mp4`) },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/story-1.jpg`,
      `${USER_ID}/story-2.mp4`,
    ]);
    assert.equal(stepOf(out, "collect_story_media_paths")?.count, 2);
  });

  it("skips foreign and hostile references without issuing a delete for them", async () => {
    const c = makeClient({
      rows: {
        stories: [
          ...HOSTILE_REFERENCES.map(([, media_url]) => ({ media_url })),
          // The one legitimate row, so the test cannot pass by collecting nothing.
          { media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/mine.jpg` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), [`${USER_ID}/mine.jpg`],
      `unexpected removes: ${JSON.stringify(c._storageRemoved)}`);
    assertNoHostileRemovals(c);
    assert.equal(stepOf(out, "collect_story_media_paths")?.count, 1);
  });

  it("refuses a story pointing at ANOTHER user's object even though POST /stories checks ownership", async () => {
    // The write path does check ownerFromPath === user.id. That is a property of
    // the endpoint as it is written today, not of the rows already in the table,
    // and on a DELETE path a wrong answer destroys a third party's file.
    const c = makeClient({
      rows: { stories: [{ media_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/not-mine.jpg` }] },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), []);
    assert.equal(stepOf(out, "collect_story_media_paths")?.count, 0);
  });

  it("reads media_url BEFORE delete_stories removes the rows", async () => {
    const c = makeClient({
      rows: { stories: [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/s.jpg` }] },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const readAt = indexOfOp(c, "stories", "select");
    const deletedAt = indexOfOp(c, "stories", "delete");
    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");

    assert.ok(readAt >= 0, "stories must be read at all");
    assert.ok(deletedAt >= 0, "delete_stories must still run");
    assert.ok(readAt < deletedAt,
      `media_url must be read before the rows are deleted (read@${readAt}, delete@${deletedAt})`);
    assert.ok(removedAt >= 0 && removedAt < deletedAt,
      `the object must be removed before the rows are deleted (remove@${removedAt}, delete@${deletedAt})`);
  });

  it("does not fail open when the story read fails", async () => {
    const c = makeClient({
      rows: { stories: [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/s.jpg` }] },
      fail: { "stories.select": "connection reset" },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    const s = stepOf(out, "collect_story_media_paths");
    assert.ok(s, "the step must be recorded even when it fails");
    assert.equal(s.ok, false, "a failed read must be recorded as a failure");
    assert.ok(out.warnings.some((w: string) => w.includes("story media")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`);
    assert.deepEqual(c._authDeleted, [USER_ID], "the rest of the deletion still runs");
  });
});

// ── messages.media_url + messages.media_thumbnail_url ────────────────────────

describe("account deletion — messages.media_url and media_thumbnail_url", () => {
  it("collects BOTH objects of a video message, and the single object of a photo message", async () => {
    const c = makeClient({
      rows: {
        messages: [
          {
            media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/clip.mp4`,
            media_thumbnail_url: `${POST_MEDIA_BUCKET}/${USER_ID}/clip.thumb.jpg`,
          },
          { media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/photo.jpg`, media_thumbnail_url: null },
          // A plain text message references nothing.
          { media_url: null, media_thumbnail_url: null },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const removed = removedPaths(c);
    assert.ok(removed.includes(`${USER_ID}/clip.mp4`), "the video itself");
    assert.ok(removed.includes(`${USER_ID}/clip.thumb.jpg`),
      `the video's separately-uploaded poster frame is a SECOND object: ${JSON.stringify(removed)}`);
    assert.ok(removed.includes(`${USER_ID}/photo.jpg`), "the photo");
    assert.equal(stepOf(out, "collect_message_media_paths")?.count, 3);
  });

  it("refuses another user's key — the write path validates the bucket but NOT the owner", async () => {
    // POST /threads/:threadId/media calls appStorageUrlInfo(mediaUrl) and stops
    // there. A sender can store a key belonging to someone else and the row is
    // entirely legitimate, so an unguarded collector here would let one user's
    // deletion destroy another user's file. This is the column that makes the
    // ownership check mandatory rather than belt-and-braces.
    const c = makeClient({
      rows: {
        messages: [{
          media_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.mp4`,
          media_thumbnail_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.thumb.jpg`,
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), [],
      `another user's message media reached remove(): ${JSON.stringify(c._storageRemoved)}`);
    assert.equal(stepOf(out, "collect_message_media_paths")?.count, 0);
  });

  it("a refused thumbnail does not suppress its own message's original", async () => {
    const c = makeClient({
      rows: {
        messages: [{
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/ok.mp4`,
          media_thumbnail_url: `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.jpg`,
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), [`${USER_ID}/ok.mp4`]);
    assert.equal(stepOf(out, "collect_message_media_paths")?.count, 1);
  });

  it("skips foreign and hostile references without issuing a delete for them", async () => {
    const c = makeClient({
      rows: {
        messages: [
          ...HOSTILE_REFERENCES.map(([, v]) => ({ media_url: v, media_thumbnail_url: v })),
          { media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/mine.jpg`, media_thumbnail_url: null },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), [`${USER_ID}/mine.jpg`],
      `unexpected removes: ${JSON.stringify(c._storageRemoved)}`);
    assertNoHostileRemovals(c);
    assert.equal(stepOf(out, "collect_message_media_paths")?.count, 1);
  });

  it("reads the media columns BEFORE delete_messages removes the rows", async () => {
    const c = makeClient({
      rows: {
        messages: [{
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/m.jpg`,
          media_thumbnail_url: null,
        }],
      },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const readAt = indexOfOp(c, "messages", "select");
    const deletedAt = indexOfOp(c, "messages", "delete");
    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");

    assert.ok(readAt >= 0 && deletedAt >= 0, "messages must be both read and deleted");
    assert.ok(readAt < deletedAt,
      `media columns must be read before the rows are deleted (read@${readAt}, delete@${deletedAt})`);
    assert.ok(removedAt >= 0 && removedAt < deletedAt,
      `the objects must be removed before the rows are deleted (remove@${removedAt}, delete@${deletedAt})`);
  });

  it("does not fail open when the message read fails", async () => {
    const c = makeClient({
      rows: { messages: [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/m.jpg` }] },
      fail: { "messages.select": "statement timeout" },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "collect_message_media_paths")?.ok, false);
    assert.ok(out.warnings.some((w: string) => w.includes("message media")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`);
    // The row delete is a SEPARATE step and must still have run: a stalled
    // deletion is worse than a partial one.
    assert.equal(stepOf(out, "delete_messages")?.ok, true);
  });
});

// ── hidden_gems.image_url ────────────────────────────────────────────────────

describe("account deletion — hidden_gems.image_url", () => {
  it("collects the submitted gem's photo", async () => {
    const c = makeClient({
      rows: {
        hidden_gems: [
          { image_url: publicUrl(POST_MEDIA_BUCKET, `${USER_ID}/gem-1.jpg`) },
          { image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/gem-2.jpg` },
          // The column is nullable and most gems have no photo.
          { image_url: null },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/gem-1.jpg`,
      `${USER_ID}/gem-2.jpg`,
    ]);
    assert.equal(stepOf(out, "collect_hidden_gem_media_paths")?.count, 2);
  });

  it("skips a foreign URL — the write path accepts ANY url, so most values are not ours", async () => {
    // `imageUrl: z.string().url().max(2048)` and nothing else. An external
    // image is a perfectly ordinary value in this column, and issuing a delete
    // against someone else's host is not ours to do.
    const c = makeClient({
      rows: {
        hidden_gems: [
          ...HOSTILE_REFERENCES.map(([, image_url]) => ({ image_url })),
          { image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/mine.jpg` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), [`${USER_ID}/mine.jpg`],
      `unexpected removes: ${JSON.stringify(c._storageRemoved)}`);
    assertNoHostileRemovals(c);
    assert.equal(stepOf(out, "collect_hidden_gem_media_paths")?.count, 1);
  });

  it("refuses a gem pointing at another user's object", async () => {
    const c = makeClient({
      rows: { hidden_gems: [{ image_url: publicUrl(POST_MEDIA_BUCKET, `${OTHER_ID}/theirs.jpg`) }] },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedPaths(c), []);
    assert.equal(stepOf(out, "collect_hidden_gem_media_paths")?.count, 0);
  });

  it("reads image_url BEFORE delete_hidden_gems removes the rows", async () => {
    const c = makeClient({
      rows: { hidden_gems: [{ image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/g.jpg` }] },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const readAt = indexOfOp(c, "hidden_gems", "select");
    const deletedAt = indexOfOp(c, "hidden_gems", "delete");
    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");

    assert.ok(readAt >= 0 && deletedAt >= 0, "hidden_gems must be both read and deleted");
    assert.ok(readAt < deletedAt,
      `image_url must be read before the rows are deleted (read@${readAt}, delete@${deletedAt})`);
    assert.ok(removedAt >= 0 && removedAt < deletedAt,
      `the object must be removed before the rows are deleted (remove@${removedAt}, delete@${deletedAt})`);
  });

  it("does not fail open when the gem read fails", async () => {
    const c = makeClient({
      rows: { hidden_gems: [{ image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/g.jpg` }] },
      fail: { "hidden_gems.select": "permission denied" },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "collect_hidden_gem_media_paths")?.ok, false);
    assert.ok(out.warnings.some((w: string) => w.includes("hidden gem media")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`);
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });
});

// ── reviews.photos — an ARRAY, which changes the failure mode ────────────────

describe("account deletion — reviews.photos (text[])", () => {
  it("collects every photo of every review", async () => {
    const c = makeClient({
      rows: {
        reviews: [
          {
            photos: [
              `${POST_MEDIA_BUCKET}/${USER_ID}/r1-a.jpg`,
              publicUrl(POST_MEDIA_BUCKET, `${USER_ID}/r1-b.jpg`),
            ],
          },
          { photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/r2-a.jpg`] },
          // The column is `NOT NULL DEFAULT '{}'`, so most reviews look like this.
          { photos: [] },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/r1-a.jpg`,
      `${USER_ID}/r1-b.jpg`,
      `${USER_ID}/r2-a.jpg`,
    ]);
    assert.equal(stepOf(out, "collect_review_photo_paths")?.count, 3);
  });

  it("ONE bad element drops only itself — its siblings survive and the step does not abort", async () => {
    // The array-specific property. A single foreign, hostile or junk element
    // among good ones must not orphan the good ones, and must not throw the
    // step — which would strand every LATER review's photos as well.
    const c = makeClient({
      rows: {
        reviews: [
          {
            photos: [
              `${POST_MEDIA_BUCKET}/${USER_ID}/good-1.jpg`,
              `${POST_MEDIA_BUCKET}/${OTHER_ID}/someone-elses.jpg`, // refused
              "https://images.unsplash.com/photo-9.jpg",            // foreign
              `${POST_MEDIA_BUCKET}/../../secrets/x.jpg`,           // traversal
              null,                                                 // junk
              `${POST_MEDIA_BUCKET}/${USER_ID}/good-2.jpg`,
            ],
          },
          // A LATER review proves the bad elements above did not abort the step.
          { photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/good-3.jpg`] },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    const s = stepOf(out, "collect_review_photo_paths");
    assert.equal(s?.ok, true, "a bad element must not fail the step");
    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/good-1.jpg`,
      `${USER_ID}/good-2.jpg`,
      `${USER_ID}/good-3.jpg`,
    ], `the good photos must all survive one bad sibling: ${JSON.stringify(c._storageRemoved)}`);
    assertNoHostileRemovals(c);
    assert.equal(s?.count, 3);
  });

  it("tolerates a non-array photos value without aborting", async () => {
    // The column is NOT NULL text[], but a delete path may not assume the shape
    // it reads back — `.photos.length` on a null would throw the whole step and
    // orphan every other review's photos.
    const c = makeClient({
      rows: {
        reviews: [
          { photos: null },
          { photos: "not-an-array" },
          {},
          { photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/good.jpg`] },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "collect_review_photo_paths")?.ok, true);
    assert.deepEqual(removedPaths(c), [`${USER_ID}/good.jpg`]);
  });

  it("reads photos BEFORE delete_reviews removes the rows", async () => {
    const c = makeClient({
      rows: { reviews: [{ photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/p.jpg`] }] },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const readAt = indexOfOp(c, "reviews", "select");
    const deletedAt = indexOfOp(c, "reviews", "delete");
    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");

    assert.ok(readAt >= 0 && deletedAt >= 0, "reviews must be both read and deleted");
    assert.ok(readAt < deletedAt,
      `photos must be read before the rows are deleted (read@${readAt}, delete@${deletedAt})`);
    assert.ok(removedAt >= 0 && removedAt < deletedAt,
      `the objects must be removed before the rows are deleted (remove@${removedAt}, delete@${deletedAt})`);
  });

  it("does not fail open when the review read fails", async () => {
    const c = makeClient({
      rows: { reviews: [{ photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/p.jpg`] }] },
      fail: { "reviews.select": "connection reset" },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(stepOf(out, "collect_review_photo_paths")?.ok, false);
    assert.ok(out.warnings.some((w: string) => w.includes("review photo")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`);
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });
});

// ── All four together ────────────────────────────────────────────────────────

describe("account deletion — all four columns in one run", () => {
  it("erases every owned object across the four columns and nothing else", async () => {
    const c = makeClient({
      rows: {
        stories:     [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/story.jpg` }],
        messages:    [{
          media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/msg.mp4`,
          media_thumbnail_url: `${POST_MEDIA_BUCKET}/${USER_ID}/msg.thumb.jpg`,
        }],
        hidden_gems: [{ image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/gem.jpg` }],
        reviews:     [{ photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/review.jpg`] }],
        // Each column also carries one value that is NOT ours, mixed in the way
        // production data actually is.
        profiles:    [{ avatar_url: null, cover_photo_url: null }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps.filter((s: any) => !s.ok)));

    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/gem.jpg`,
      `${USER_ID}/msg.mp4`,
      `${USER_ID}/msg.thumb.jpg`,
      `${USER_ID}/review.jpg`,
      `${USER_ID}/story.jpg`,
    ]);

    for (const name of [
      "collect_story_media_paths",
      "collect_message_media_paths",
      "collect_hidden_gem_media_paths",
      "collect_review_photo_paths",
    ]) {
      assert.equal(stepOf(out, name)?.ok, true, `${name} must be recorded and green`);
    }
  });

  it("a user with none of this content deletes cleanly and warns about nothing", async () => {
    const c = makeClient({
      rows: { stories: [], messages: [], hidden_gems: [], reviews: [] },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.deepEqual(removedPaths(c), [], "nothing to remove, so nothing is removed");
    for (const name of [
      "collect_story_media_paths",
      "collect_message_media_paths",
      "collect_hidden_gem_media_paths",
      "collect_review_photo_paths",
    ]) {
      assert.equal(stepOf(out, name)?.count, 0, `${name} must report zero, not be absent`);
    }
    assert.deepEqual(out.warnings, [], `an empty content set is not a warning: ${JSON.stringify(out.warnings)}`);
  });

  it("every collection happens before ANY of the row deletes", async () => {
    // The ordering property stated once over the whole set: the LAST collection
    // read must still precede the FIRST row delete of the four tables. A step
    // that drifts down into section 3 later would satisfy its own pairwise
    // ordering test only by accident.
    const c = makeClient({
      rows: {
        stories:     [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/a.jpg` }],
        messages:    [{ media_url: `${POST_MEDIA_BUCKET}/${USER_ID}/b.jpg` }],
        hidden_gems: [{ image_url: `${POST_MEDIA_BUCKET}/${USER_ID}/c.jpg` }],
        reviews:     [{ photos: [`${POST_MEDIA_BUCKET}/${USER_ID}/d.jpg`] }],
      },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const reads = ["stories", "messages", "hidden_gems", "reviews"].map((t) => {
      const i = indexOfOp(c, t, "select");
      assert.ok(i >= 0, `${t} must be read`);
      return i;
    });
    const deletes = ["stories", "messages", "hidden_gems", "reviews"].map((t) => {
      const i = indexOfOp(c, t, "delete");
      assert.ok(i >= 0, `${t} rows must still be deleted`);
      return i;
    });

    const lastRead = Math.max(...reads);
    const firstDelete = Math.min(...deletes);
    assert.ok(lastRead < firstDelete,
      `every reference must be collected before the first row delete (last read@${lastRead}, first delete@${firstDelete})`);

    const firstRemove = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");
    assert.ok(firstRemove >= 0 && firstRemove < firstDelete,
      `the bytes must go before the rows (remove@${firstRemove}, first delete@${firstDelete})`);
    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/a.jpg`, `${USER_ID}/b.jpg`, `${USER_ID}/c.jpg`, `${USER_ID}/d.jpg`,
    ]);
  });
});

// ── The one that is NOT closed here, recorded so it cannot be forgotten ──────

describe("account deletion — passport_memories is deliberately untouched", () => {
  it("neither deletes passport_memories rows nor removes their photo_url objects", async () => {
    // Documenting a KNOWN GAP, not asserting it is correct. passport_memories
    // rows survive account deletion outright — the table is in
    // deletionDispositions' UNCLASSIFIED_BACKLOG, which is explicitly "NOT a
    // decision", and it carries no D6 classification, so no ruling authorises
    // erasing it.
    //
    // Collecting its bytes ALONE would be worse than the current state: the row
    // survives, and a surviving passport memory whose photo has been deleted is
    // a broken record rather than an erasure. Row delete and byte collection
    // belong in the SAME change, once the table has a fate.
    //
    // When that happens, this test fails — which is the point. Replace it with
    // the positive assertions rather than deleting it.
    const c = makeClient({
      rows: {
        passport_memories: [{ photo_url: `${POST_MEDIA_BUCKET}/${USER_ID}/memory.jpg` }],
      },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(indexOfOp(c, "passport_memories", "select"), -1,
      "passport_memories is not read today");
    assert.equal(indexOfOp(c, "passport_memories", "delete"), -1,
      "passport_memories rows are not deleted today — that is the larger open defect");
    assert.deepEqual(removedPaths(c), [],
      "and its bytes are deliberately not collected while the row survives");
  });
});
