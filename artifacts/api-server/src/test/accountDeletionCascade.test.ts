/**
 * Account deletion cascade + scheduled worker (audit P1 item 7)
 *
 * Under test:
 *   services/accountDeletion/AccountDeletionService.ts  — the cascade
 *   lib/accountDeletionScheduler.ts                     — the due-request worker
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionCascade.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  executeAccountDeletion,
  storagePathFromPublicUrl,
  PROFILE_MEDIA_BUCKET,
} from "../services/accountDeletion/AccountDeletionService.js";
import { processDueDeletions } from "../lib/accountDeletionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

// ── Fake supabase client ──────────────────────────────────────────────────────

interface Op { table: string; op: string; filters: any[]; values?: any }

function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** table -> error message, injected on the given op */
  fail?: Record<string, string>;
  authDeleteError?: string;
  storageError?: string;
} = {}) {
  const rows = opts.rows ?? {};
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
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
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
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          if (opts.storageError) return { data: null, error: { message: opts.storageError } };
          storageRemoved.push({ bucket, paths });
          return { data: paths.map((p) => ({ name: p })), error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if (opts.authDeleteError) return { data: null, error: { message: opts.authDeleteError } };
          authDeleted.push(id);
          return { data: {}, error: null };
        },
      },
    },
  };
}

const opFor = (c: any, table: string, op: string) =>
  c._ops.find((o: Op) => o.table === table && o.op === op);

// ── storagePathFromPublicUrl ─────────────────────────────────────────────────

describe("storagePathFromPublicUrl", () => {
  it("extracts the object path for the bucket", () => {
    const url = `https://x.supabase.co/storage/v1/object/public/${PROFILE_MEDIA_BUCKET}/u/1/avatar.jpg`;
    assert.equal(storagePathFromPublicUrl(url, PROFILE_MEDIA_BUCKET), "u/1/avatar.jpg");
  });

  it("returns null for a URL from a different bucket, and for null", () => {
    const url = "https://x.supabase.co/storage/v1/object/public/other-bucket/a.jpg";
    assert.equal(storagePathFromPublicUrl(url, PROFILE_MEDIA_BUCKET), null);
    assert.equal(storagePathFromPublicUrl(null, PROFILE_MEDIA_BUCKET), null);
  });
});

// ── The cascade ──────────────────────────────────────────────────────────────

describe("executeAccountDeletion — full cascade", () => {
  it("deletes content, storage, verification rows, and the auth user", async () => {
    const c = makeClient({
      rows: {
        post_media: [
          { storage_bucket: "post-media", storage_path: "p/1.jpg", thumbnail_storage_path: "p/1_t.jpg" },
        ],
        media_assets: [{ storage_bucket: "post-media", storage_path: "m/2.jpg", thumbnail_path: null }],
        profiles: [{
          avatar_url: `https://x/storage/v1/object/public/${PROFILE_MEDIA_BUCKET}/av.jpg`,
          cover_photo_url: null,
        }],
      },
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Content rows deleted, each scoped to this user.
    assert.ok(opFor(c, "posts", "delete"), "posts deleted");
    assert.deepEqual(opFor(c, "posts", "delete")!.filters, [["eq", "author_id", USER_ID]]);
    assert.ok(opFor(c, "messages", "delete"), "message ciphertext deleted");
    assert.deepEqual(opFor(c, "messages", "delete")!.filters, [["eq", "sender_id", USER_ID]]);
    assert.ok(opFor(c, "identity_verifications", "delete"), "verification rows deleted");
    assert.ok(opFor(c, "media_assets", "delete"), "media_assets deleted");

    // Storage objects removed, including thumbnails and the profile avatar.
    const removed = c._storageRemoved.flatMap((r) => r.paths);
    assert.ok(removed.includes("p/1.jpg"));
    assert.ok(removed.includes("p/1_t.jpg"));
    assert.ok(removed.includes("m/2.jpg"));
    assert.ok(removed.includes("av.jpg"));

    // Auth user removed — this is what drops the email address.
    assert.deepEqual(c._authDeleted, [USER_ID]);

    // Profile anonymised into a tombstone rather than deleted.
    const upd = opFor(c, "profiles", "update")!;
    assert.equal(upd.values.display_name, "Deleted User");
    assert.equal(upd.values.account_status, "deleted");
    assert.equal(upd.values.username, null);
    assert.equal(upd.values.full_name, null);

    // Request closed out.
    const reqUpd = opFor(c, "user_deletion_requests", "update")!;
    assert.equal(reqUpd.values.status, "completed");
    assert.ok(reqUpd.values.executed_at);
  });

  it("collects storage paths BEFORE deleting the rows that hold them", async () => {
    const c = makeClient({
      rows: { post_media: [{ storage_bucket: "post-media", storage_path: "p/1.jpg" }] },
    });
    await executeAccountDeletion(c, USER_ID, { actorId: null });

    const idxCollect = c._ops.findIndex((o: Op) => o.table === "post_media" && o.op === "select");
    const idxDelete = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "delete");
    assert.ok(idxCollect >= 0 && idxDelete >= 0);
    assert.ok(idxCollect < idxDelete, "must read post_media paths before posts cascade removes them");
  });

  it("aborts before touching the auth user when profile anonymisation fails", async () => {
    const c = makeClient({ fail: { "profiles.update": "permission denied" } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    assert.equal(out.ok, false);
    assert.deepEqual(c._authDeleted, [], "must not delete the auth user if the tombstone failed");
    assert.equal(opFor(c, "user_deletion_requests", "update"), undefined, "request stays pending for retry");
    assert.ok(out.steps.some((s) => s.step === "anonymise_profile" && !s.ok));
  });

  it("still completes, but warns loudly, when the auth user cannot be deleted", async () => {
    const c = makeClient({ authDeleteError: "user not found" });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true, "content deletion still counts as done");
    assert.ok(
      out.warnings.some((w) => w.includes("email address still on file")),
      "email retention must be surfaced: " + JSON.stringify(out.warnings),
    );
    assert.equal(opFor(c, "user_deletion_requests", "update")!.values.status, "completed");
  });

  it("does not abort the run when Storage is unavailable", async () => {
    const c = makeClient({
      rows: { post_media: [{ storage_bucket: "post-media", storage_path: "p/1.jpg" }] },
      storageError: "bucket unavailable",
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true);
    assert.ok(out.warnings.some((w) => w.includes("storage objects")));
    assert.ok(opFor(c, "posts", "delete"), "content deletion proceeds regardless");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("contentOnly leaves the tombstone and the auth user alone", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null, contentOnly: true });

    assert.ok(opFor(c, "posts", "delete"));
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
  });
});

// ── The scheduler ────────────────────────────────────────────────────────────

describe("accountDeletionScheduler — fails closed", () => {
  beforeEach(() => _setTestServiceClient(null as any));

  it("does nothing when the feature flag is off", async () => {
    const c = makeClient({ rows: { feature_flags: [{ enabled: false }] } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.skipped, true);
    assert.equal(r.executed, 0);
    assert.equal(opFor(c, "user_deletion_requests", "select"), undefined, "must not even query for due rows");
  });

  it("does nothing when the flag row is missing", async () => {
    const c = makeClient({ rows: { feature_flags: [] } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();
    assert.equal(r.skipped, true);
    assert.deepEqual(c._authDeleted, []);
  });

  it("does nothing when the flag lookup errors", async () => {
    const c = makeClient({ fail: { feature_flags: "relation does not exist" } });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();
    assert.equal(r.skipped, true);
  });

  it("executes due requests when enabled, filtering on pending + scheduled_at", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.skipped, false);
    assert.equal(r.considered, 1);
    assert.equal(r.executed, 1);
    assert.equal(r.failed, 0);

    const q = opFor(c, "user_deletion_requests", "select")!;
    assert.ok(q.filters.some((f: any[]) => f[0] === "eq" && f[1] === "status" && f[2] === "pending"));
    assert.ok(q.filters.some((f: any[]) => f[0] === "lte" && f[1] === "scheduled_at"));

    assert.deepEqual(c._authDeleted, [USER_ID], "the due account is actually deleted");
  });

  it("reports a failure instead of marking the request done", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
      fail: { "profiles.update": "db down" },
    });
    _setTestServiceClient(c as any);

    const r = await processDueDeletions();

    assert.equal(r.executed, 0);
    assert.equal(r.failed, 1);
    assert.deepEqual(c._authDeleted, []);
  });
});
