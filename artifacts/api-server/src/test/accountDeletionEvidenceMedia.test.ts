/**
 * Account deletion — storage objects referenced ONLY by intel_evidence
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed
 * ================================
 * An account deletion could leave the user's uploaded BYTES in the bucket.
 *
 * `intel_evidence.reference` holds a `<bucket>/<path>` storage key for a photo
 * or video attached to a map observation (lib/intelEvidenceCapture). The ROWS
 * were always erased — the table is in ERASED_BY_CASCADE and
 * `erase_intel_for_actor` deletes the actor's rows — so `check:deletion-coverage`
 * was green and the row-level story was complete. The OBJECT was the gap:
 *
 *   * POST /api/media/upload writes NO post_media row (the client persists that
 *     later, when a post is created), so evidence-only bytes are invisible to
 *     `collect_post_media_paths`;
 *   * the media_assets dual-write happens only when `media_canonical_enabled`
 *     is on, and that flag ships OFF (migration 0191), so
 *     `collect_media_asset_paths` does not see them either.
 *
 * The object therefore survived in the private post-media bucket. Unreachable
 * in practice, but unreachable is not deleted when a user asked to be erased.
 *
 * ORDERING IS THE HALF THAT IS EASY TO GET WRONG. `erase_intel_for_actor`
 * deletes the very rows whose `reference` says where the bytes are. Collect
 * after it and there is nothing left to read — and the final storage set would
 * look identical to "the user had no evidence". So this suite asserts on the
 * ORDER of operations, not only on the resulting set: every op the fake client
 * sees is appended to one list, storage removes included.
 *
 * MUTATION PROOF (performed 2026-08-31): deleting the
 * `collect_intel_evidence_paths` step from AccountDeletionService turns 5 of
 * these 8 tests RED; restoring it turns them green again.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionEvidenceMedia.test.ts
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
 * Record-only fake supabase client.
 *
 * The single `ops` list is the point: DB reads, DB writes, RPCs and storage
 * removes all land in it in the order they happened, so "collected before
 * erased" is a checkable property rather than an inference from the final set.
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

// ── The fix ──────────────────────────────────────────────────────────────────

describe("account deletion — intel_evidence media objects", () => {
  it("collects and deletes an evidence-ONLY object (no post_media, no media_assets)", async () => {
    // The exact shape the flag-off production path produces: bytes uploaded via
    // POST /api/media/upload and referenced by nothing but an evidence row.
    const c = makeClient({
      rows: {
        post_media: [],
        media_assets: [],
        intel_evidence: [
          { reference: `${POST_MEDIA_BUCKET}/${USER_ID}/1756600000000.jpg` },
          { reference: `${POST_MEDIA_BUCKET}/${USER_ID}/1756600000001.mp4` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const removed = removedPaths(c);
    assert.ok(
      removed.includes(`${USER_ID}/1756600000000.jpg`),
      `evidence photo must be deleted from the bucket: ${JSON.stringify(c._storageRemoved)}`,
    );
    assert.ok(
      removed.includes(`${USER_ID}/1756600000001.mp4`),
      `evidence video must be deleted from the bucket: ${JSON.stringify(c._storageRemoved)}`,
    );

    // The bucket comes from the reference, not from a default: these two went to
    // post-media because that is what the key said.
    assert.deepEqual(removedIn(c, POST_MEDIA_BUCKET).sort(), [
      `${USER_ID}/1756600000000.jpg`,
      `${USER_ID}/1756600000001.mp4`,
    ]);

    // And the step reports what it found, so a receipt can show it.
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.ok, true);
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.count, 2);
  });

  it("reads the references BEFORE erase_intel_for_actor deletes the rows", async () => {
    // The ordering property, asserted on the op sequence rather than on the
    // final set — a collection placed after the erasure would produce an empty
    // set that looks exactly like "this user had no evidence".
    const c = makeClient({
      rows: { intel_evidence: [{ reference: `${POST_MEDIA_BUCKET}/${USER_ID}/x.jpg` }] },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const readAt = indexOfOp(c, "intel_evidence", "select");
    const erasedAt = indexOfOp(c, "rpc:erase_intel_for_actor", "rpc");
    const removedAt = indexOfOp(c, `storage:${POST_MEDIA_BUCKET}`, "remove");

    assert.ok(readAt >= 0, "intel_evidence must be read at all");
    assert.ok(erasedAt >= 0, "erase_intel_for_actor must still run");
    assert.ok(
      readAt < erasedAt,
      `references must be read before the rows are erased (read@${readAt}, erase@${erasedAt})`,
    );
    assert.ok(
      removedAt >= 0 && removedAt < erasedAt,
      `the objects must be removed before the rows are erased (remove@${removedAt}, erase@${erasedAt})`,
    );
  });

  it("honours the bucket named by the reference instead of assuming post-media", async () => {
    const c = makeClient({
      rows: {
        intel_evidence: [{ reference: `${PROFILE_MEDIA_BUCKET}/avatars/${USER_ID}/a.jpg` }],
        // profiles has no media of its own here, so anything landing in
        // profile-media can only have come from the evidence reference.
        profiles: [{ avatar_url: null, cover_photo_url: null }],
      },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.deepEqual(removedIn(c, PROFILE_MEDIA_BUCKET), [`avatars/${USER_ID}/a.jpg`]);
    assert.deepEqual(
      removedIn(c, POST_MEDIA_BUCKET),
      [],
      "a profile-media key must not be removed from post-media",
    );
  });

  it("deletes cleanly for an actor with no evidence at all", async () => {
    const c = makeClient({ rows: { intel_evidence: [] } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true, JSON.stringify(out.steps));
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.ok, true);
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.count, 0);
    assert.deepEqual(removedPaths(c), [], "nothing to remove, so nothing is removed");
    assert.deepEqual(c._authDeleted, [USER_ID], "the deletion still completes");
    assert.equal(
      out.warnings.some((w: string) => w.includes("intel evidence")),
      false,
      `an empty evidence set is not a warning: ${JSON.stringify(out.warnings)}`,
    );
  });

  it("skips a NULL reference — text_note and sensor evidence store no object", async () => {
    const c = makeClient({
      rows: {
        intel_evidence: [
          { reference: null },
          { reference: "" },
          { reference: `${POST_MEDIA_BUCKET}/${USER_ID}/real.jpg` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true);
    assert.deepEqual(removedPaths(c), [`${USER_ID}/real.jpg`]);
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.count, 1);
  });

  // ── Defensive: a delete path may not be steered by a bad row ───────────────

  it("never removes outside an allowed bucket, and never another user's object", async () => {
    const c = makeClient({
      rows: {
        intel_evidence: [
          // A bucket outside the media allow-list.
          { reference: "secrets/anything.jpg" },
          // Path traversal dressed as one of ours.
          { reference: `${POST_MEDIA_BUCKET}/../../secrets/anything.jpg` },
          // An absolute URL on somebody else's host.
          { reference: "https://evil.example.com/a.jpg" },
          // Ours, but another user's object.
          { reference: `${POST_MEDIA_BUCKET}/${OTHER_ID}/theirs.jpg` },
          // Ours, but no owner is derivable from the path convention.
          { reference: `${POST_MEDIA_BUCKET}/not-a-uuid/orphan.jpg` },
          // A bucket name with nothing after it.
          { reference: `${POST_MEDIA_BUCKET}/` },
          // Non-string junk.
          { reference: 42 },
          // The one legitimate row, so the test cannot pass by collecting nothing.
          { reference: `${POST_MEDIA_BUCKET}/${USER_ID}/mine.jpg` },
        ],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    // Only ever the two app buckets are touched.
    for (const r of c._storageRemoved) {
      assert.ok(
        [POST_MEDIA_BUCKET, PROFILE_MEDIA_BUCKET].includes(r.bucket),
        `removed from an unexpected bucket: ${r.bucket}`,
      );
    }
    const removed = removedPaths(c);
    assert.deepEqual(removed, [`${USER_ID}/mine.jpg`], `unexpected removes: ${JSON.stringify(removed)}`);
    for (const p of removed) {
      assert.ok(!p.includes(".."), `a traversal path reached remove(): ${p}`);
      assert.ok(!p.startsWith(OTHER_ID), `another user's object reached remove(): ${p}`);
    }
    assert.equal(stepOf(out, "collect_intel_evidence_paths")?.count, 1);
  });

  it("does not fail open when the reference read fails", async () => {
    // A failed collection must not look like "there was nothing to collect".
    const c = makeClient({
      rows: { intel_evidence: [{ reference: `${POST_MEDIA_BUCKET}/${USER_ID}/1.jpg` }] },
      fail: { "intel_evidence.select": "connection reset" },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    const s = stepOf(out, "collect_intel_evidence_paths");
    assert.ok(s, "the step must be recorded even when it fails");
    assert.equal(s.ok, false, "a failed read must be recorded as a failure");
    assert.ok(
      out.warnings.some((w: string) => w.includes("intel evidence")),
      `the surviving-object risk must be surfaced: ${JSON.stringify(out.warnings)}`,
    );
    // The rest of the deletion still runs — a stalled deletion is worse than a
    // partial one — but the residual risk is on the receipt rather than silent.
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  // ── Same class of gap, same query: the 0208 feed variant ───────────────────

  it("collects post_media's feed_storage_path, not only the original and thumbnail", async () => {
    const c = makeClient({
      rows: {
        post_media: [{
          storage_bucket: POST_MEDIA_BUCKET,
          storage_path: `${USER_ID}/9.jpg`,
          thumbnail_storage_path: `${USER_ID}/9.thumb.jpg`,
          feed_storage_path: `${USER_ID}/9.feed.jpg`,
        }],
      },
    });

    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const removed = removedPaths(c);
    assert.ok(removed.includes(`${USER_ID}/9.jpg`), "original");
    assert.ok(removed.includes(`${USER_ID}/9.thumb.jpg`), "thumbnail");
    assert.ok(
      removed.includes(`${USER_ID}/9.feed.jpg`),
      `the 1500px feed variant is a third stored object and must go too: ${JSON.stringify(removed)}`,
    );
  });
});
