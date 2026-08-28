/**
 * Account deletion cascade + scheduled worker (audit P1 item 7)
 *
 * Under test:
 *   services/accountDeletion/AccountDeletionService.ts  — the cascade
 *   lib/accountDeletionScheduler.ts                     — the due-request worker
 *   routes/profile.ts POST /internal/deletion-requests/execute-due — worker endpoint
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionCascade.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  executeAccountDeletion,
  storagePathFromPublicUrl,
  PROFILE_MEDIA_BUCKET,
} from "../services/accountDeletion/AccountDeletionService.js";
import { processDueDeletions } from "../lib/accountDeletionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import profileRouter from "../routes/profile.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

// ── Fake supabase client ──────────────────────────────────────────────────────

interface Op { table: string; op: string; filters: any[]; values?: any }

function makeClient(opts: {
  rows?: Record<string, any[]>;
  /** table -> error message, injected on the given op */
  fail?: Record<string, string>;
  authDeleteError?: string;
  storageError?: string;
  /** RPC function name to fail, e.g. "erase_memory_for_user" (fatal step). */
  rpcError?: string;
} = {}) {
  // A post by default. Since owner ruling 4 (2026-08-23) the worker SELECTS the
  // user's posts and decides per post — tombstone if others have contributed,
  // delete otherwise — so a fixture with no posts exercises neither branch.
  const rows = { posts: [{ id: "post-1" }], ...(opts.rows ?? {}) };
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
      // neq/not exist because the ruling-4 third-party check chains them
      // (`.not("user_id","is",null).neq("user_id", userId)`). Without them the
      // builder throws and the whole posts step fails — which is how these four
      // tests started failing, not because the behaviour was wrong.
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
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
    /**
     * RPC steps of the cascade (SECURITY DEFINER erasures that cannot be
     * expressed as a PostgREST .delete()):
     *   erase_intel_for_actor   — IG-02 append-only contributions
     *   erase_memory_for_user   — derived memory (2190)
     *
     * This mock previously had no `rpc`, so BOTH steps failed with
     * "sc.rpc is not a function". That went unnoticed because
     * erase_intel_contributions is non-fatal — it recorded a warning and the run
     * continued, so the suite stayed green while the step never actually ran.
     * erase_derived_memory is FATAL by design (leaving derived personal memory
     * behind after a deletion request is a privacy failure), which surfaced the
     * gap. Recorded in `ops` so tests can assert these steps were reached.
     */
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", args } as never);
      const failing = opts.rpcError && opts.rpcError === fn;
      return failing ? { data: null, error: { message: opts.rpcError } } : { data: null, error: null };
    },
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
    // Ruling 4: no third-party comments on post-1, so it is hard-deleted — but
    // per post id, not by a blanket sweep on author_id. The sweep is what used to
    // take other people's comments with it.
    assert.ok(opFor(c, "posts", "delete"), "posts deleted");
    assert.deepEqual(opFor(c, "posts", "delete")!.filters, [["eq", "id", "post-1"]]);
    assert.equal(out.deletedCounts.posts, 1);
    assert.equal(out.tombstonedCounts.posts, 0);
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
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    const idxCollect = c._ops.findIndex((o: Op) => o.table === "post_media" && o.op === "select");
    const idxDelete = c._ops.findIndex((o: Op) => o.table === "posts" && o.op === "delete");
    assert.ok(idxCollect >= 0 && idxDelete >= 0);
    assert.ok(idxCollect < idxDelete, "must read post_media paths before posts cascade removes them");
    // The step was renamed when the tombstone branch was added; the ordering
    // guarantee it protects is unchanged.
    assert.ok(out.steps.some((st) => st.step === "tombstone_or_delete_posts"),
      "the posts step should be the tombstone-or-delete one");
  });

  it("aborts before touching the auth user when profile anonymisation fails", async () => {
    const c = makeClient({ fail: { "profiles.update": "permission denied" } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });

    assert.equal(out.ok, false);
    assert.deepEqual(c._authDeleted, [], "must not delete the auth user if the tombstone failed");
    assert.equal(opFor(c, "user_deletion_requests", "update"), undefined, "request stays pending for retry");
    assert.ok(out.steps.some((s) => s.step === "anonymise_profile" && !s.ok));
  });

  it("returns not-ok and leaves the request pending when the auth user cannot be deleted", async () => {
    const c = makeClient({ authDeleteError: "user not found" });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    // The email address is still on file — the deletion is NOT complete, so
    // callers must leave the request retryable instead of marking it done.
    assert.equal(out.ok, false, "auth-user failure must fail the outcome");
    assert.ok(
      out.warnings.some((w) => w.includes("email address still on file")),
      "email retention must be surfaced: " + JSON.stringify(out.warnings),
    );
    assert.equal(
      opFor(c, "user_deletion_requests", "update"),
      undefined,
      "request must NOT be marked completed while the auth user survives",
    );
    assert.ok(out.steps.some((s) => s.step === "auth_delete_user" && !s.ok));
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

  it("purges derived memory explicitly — not via a foreign-key cascade", async () => {
    // Production's public.profiles has NO foreign key to auth.users, and this
    // service keeps an ANONYMISED TOMBSTONE profile rather than deleting the row,
    // so a profiles-keyed cascade can never fire there. Migration 2187 assumed it
    // would; 2190 replaced that with this explicit step. Assert the step runs.
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, true);
    const step = out.steps.find((s) => s.step === "erase_derived_memory");
    assert.ok(step, "the cascade must include an explicit derived-memory purge");
    assert.equal(step!.ok, true);
    assert.ok(
      (c._ops as any[]).some((o) => o.table === "rpc:erase_memory_for_user"),
      "erase_memory_for_user must actually be invoked",
    );
  });

  it("ABORTS the deletion when the memory purge fails — never silently leaves memory behind", async () => {
    // The privacy guarantee: a deletion request that cannot purge derived memory
    // must fail loudly and stay retryable, rather than reporting success with the
    // user's remembered places, people and inferred preferences still stored.
    const c = makeClient({ rpcError: "erase_memory_for_user" });
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.equal(out.ok, false, "a failed memory purge must fail the run");
    const step = out.steps.find((s) => s.step === "erase_derived_memory");
    assert.ok(step && step.ok === false, "the failing step must be recorded");
    assert.deepEqual(c._authDeleted, [], "the auth user must NOT be deleted after a failed purge");
    assert.ok(
      out.warnings.some((w) => w.toLowerCase().includes("memory")),
      "the caller must be told memory may remain",
    );
  });

  it("contentOnly leaves the tombstone and the auth user alone", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null, contentOnly: true });

    assert.ok(opFor(c, "posts", "delete"));
    assert.equal(opFor(c, "profiles", "update"), undefined);
    assert.deepEqual(c._authDeleted, []);
  });
});

// ── Merged legacy cascade steps (old services/accountDeletion.ts union) ──────

describe("executeAccountDeletion — merged legacy cascade steps", () => {
  it("clears stories, reviews, gems, saves, follows, notifications and search history", async () => {
    const c = makeClient();

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    // Stories + engagement rows, scoped to the right column each time.
    assert.deepEqual(opFor(c, "story_reactions", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "story_replies", "delete")!.filters,   [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "story_views", "delete")!.filters,     [["eq", "viewer_id", USER_ID]]);
    assert.deepEqual(opFor(c, "stories", "delete")!.filters,         [["eq", "owner_id", USER_ID]]);

    // The user's own interactions on other users' posts.
    for (const t of ["post_reactions", "posts_comments", "post_shares", "post_saves", "posts_likes", "comment_likes"]) {
      assert.deepEqual(opFor(c, t, "delete")!.filters, [["eq", "user_id", USER_ID]], `${t} scoped to user`);
    }

    // Reviews + hidden gems (saves and authored submissions).
    assert.deepEqual(opFor(c, "reviews", "delete")!.filters,          [["eq", "reviewer_id", USER_ID]]);
    assert.deepEqual(opFor(c, "hidden_gem_saves", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "hidden_gems", "delete")!.filters,      [["eq", "submitted_by", USER_ID]]);

    // Saved items.
    assert.deepEqual(opFor(c, "saved_places", "delete")!.filters,    [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "user_saves", "delete")!.filters,      [["eq", "saver_id", USER_ID]]);
    assert.deepEqual(opFor(c, "wishlist_places", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "event_saves", "delete")!.filters,     [["eq", "user_id", USER_ID]]);

    // Follow graph, both directions.
    const followOps = c._ops.filter((o: Op) => o.table === "user_follows" && o.op === "delete");
    assert.equal(followOps.length, 2, "user_follows deleted in both directions");
    assert.ok(followOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "follower_id" && f[2] === USER_ID)));
    assert.ok(followOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "following_id" && f[2] === USER_ID)));

    // Notifications: received AND acting, plus push-device rows + history.
    const notifOps = c._ops.filter((o: Op) => o.table === "notifications" && o.op === "delete");
    assert.equal(notifOps.length, 2, "notifications deleted by user_id and actor_id");
    assert.ok(notifOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "user_id" && f[2] === USER_ID)));
    assert.ok(notifOps.some((o: Op) => o.filters.some((f: any[]) => f[1] === "actor_id" && f[2] === USER_ID)));
    assert.deepEqual(opFor(c, "notification_devices", "delete")!.filters, [["eq", "user_id", USER_ID]]);
    assert.deepEqual(opFor(c, "search_history", "delete")!.filters,       [["eq", "user_id", USER_ID]]);
  });

  it("deletes key_packages by device_id BEFORE deleting the devices rows", async () => {
    const c = makeClient({ rows: { devices: [{ id: "dev-1" }, { id: "dev-2" }] } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const kp = opFor(c, "key_packages", "delete")!;
    assert.deepEqual(kp.filters, [["in", "device_id", ["dev-1", "dev-2"]]]);

    const idxKp = c._ops.findIndex((o: Op) => o.table === "key_packages" && o.op === "delete");
    const idxDev = c._ops.findIndex((o: Op) => o.table === "devices" && o.op === "delete");
    assert.ok(idxKp >= 0 && idxDev >= 0);
    assert.ok(idxKp < idxDev, "key_packages (FK on devices) must be cleared before devices");
  });

  it("one failing content table records its step but never aborts the rest", async () => {
    const c = makeClient({ fail: { "reviews.delete": "permission denied" } });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.ok(out.steps.some((s) => s.step === "delete_reviews" && !s.ok));
    assert.ok(out.warnings.some((w) => w.includes("reviews")));
    // Everything after reviews still ran, up to and including the auth user.
    assert.ok(opFor(c, "search_history", "delete"), "later steps still execute");
    assert.deepEqual(c._authDeleted, [USER_ID]);
    assert.equal(opFor(c, "user_deletion_requests", "update")!.values.status, "completed");
  });

  it("contentOnly also runs the merged content steps", async () => {
    const c = makeClient();
    await executeAccountDeletion(c, USER_ID, { actorId: null, contentOnly: true });

    assert.ok(opFor(c, "stories", "delete"));
    assert.ok(opFor(c, "user_follows", "delete"));
    assert.ok(opFor(c, "search_history", "delete"));
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

// ── The internal worker endpoint (routes/profile.ts) ─────────────────────────

describe("POST /internal/deletion-requests/execute-due", () => {
  let server: http.Server;
  let base: string;
  const SECRET = "test-internal-secret";
  let savedSecret: string | undefined;

  before(async () => {
    savedSecret = process.env.INTERNAL_API_SECRET;
    process.env.INTERNAL_API_SECRET = SECRET;
    await new Promise<void>((resolve) => {
      const app = express();
      app.use(express.json());
      app.use((req: any, _res: any, next: any) => {
        req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
        next();
      });
      app.use("/api", profileRouter);
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => _setTestServiceClient(null as any));

  function post(headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL("/api/internal/deletion-requests/execute-due", base);
      const req = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST", headers },
        (res) => {
          let raw = "";
          res.on("data", (ch) => { raw += ch; });
          res.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("rejects a missing/invalid internal secret", async () => {
    _setTestServiceClient(makeClient() as any);
    const noSecret = await post();
    assert.equal(noSecret.status, 401);
    const badSecret = await post({ "x-internal-secret": "wrong" });
    assert.equal(badSecret.status, 401);
  });

  it("responds 503/skipped and touches nothing when the feature flag is off", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: false }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 503);
    assert.equal(body.skipped, true);
    assert.equal(opFor(c, "user_deletion_requests", "select"), undefined, "must not even query for due rows");
    assert.deepEqual(c._authDeleted, []);
  });

  it("executes due requests through the unified cascade when enabled", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.processed, 1);
    assert.equal(body.executed, 1);
    assert.deepEqual(body.failed, []);
    assert.deepEqual(c._authDeleted, [USER_ID], "cascade actually ran (auth user removed)");
    assert.equal(opFor(c, "user_deletion_requests", "update")!.values.status, "completed");
  });

  it("leaves a failed request pending and reports it in `failed`", async () => {
    const c = makeClient({
      rows: {
        feature_flags: [{ enabled: true }],
        user_deletion_requests: [{ user_id: USER_ID, status: "pending", scheduled_at: "2020-01-01T00:00:00Z" }],
      },
      authDeleteError: "auth API down",
    });
    _setTestServiceClient(c as any);

    const { status, body } = await post({ "x-internal-secret": SECRET });

    assert.equal(status, 200);
    assert.equal(body.executed, 0);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].userId, USER_ID);
    assert.ok(body.failed[0].failedSteps.some((s: any) => s.step === "auth_delete_user"));
    assert.equal(
      opFor(c, "user_deletion_requests", "update"),
      undefined,
      "request must NOT be marked completed on a failed cascade",
    );
  });
});
