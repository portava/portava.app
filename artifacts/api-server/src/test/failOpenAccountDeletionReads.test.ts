/**
 * FAIL-OPEN unchecked reads — the account-deletion tombstone decision.
 *
 * `hasThirdPartyInterest(postId)` decides, per post, between TOMBSTONE (blank
 * the post, keep the row so other people's replies and any moderation evidence
 * survive) and HARD DELETE (the row goes, and `posts` CASCADEs to
 * `posts_comments`). It answered that question from two reads:
 *
 *     const { data: otherComments } = await sc.from("posts_comments")…
 *     const { data: reports }       = await sc.from("moderation_reports")…
 *
 * supabase-js RESOLVES on a database error, so BOTH of those return the same
 * empty array for "nobody else commented / nobody reported this" and for "the
 * table could not be read" — and the empty array routes the post into the
 * hard-delete branch. A transient read failure therefore destroyed other users'
 * comment threads, and deleted REPORTED posts together with the evidence a
 * moderator was about to look at. It is irreversible and it is invisible: the
 * only person who ever finds out is the one whose comment vanished.
 *
 * The fix throws instead of answering. The surrounding loop already wraps each
 * post in try/catch, collects the message, keeps going with the remaining
 * posts, and throws once at the end so the STEP fails — which is exactly the
 * honest outcome: nothing destroyed on an unread precondition, the post left
 * as it was, and the operator told why.
 *
 * Both halves are pinned. The healthy half matters as much as the failure one:
 * a "fix" that refused every post would pass every failure assertion here and
 * would silently stop erasing accounts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/failOpenAccountDeletionReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const ALL_POSTS = ["post-A", "post-B", "post-C"];

interface StubOpts {
  /** Posts with a foreign comment. */
  commentedPosts?: Set<string>;
  /** Posts named by a moderation report. */
  reportedPosts?: Set<string>;
  /** Reads of this table resolve an error (never throw — see the module doc). */
  failReadsOn?: "posts_comments" | "moderation_reports";
}

const READ_ERROR = {
  message: "server closed the connection unexpectedly",
  code: "08006",
};

function makeStub(opts: StubOpts = {}) {
  const commented = opts.commentedPosts ?? new Set<string>();
  const reported = opts.reportedPosts ?? new Set<string>();
  const deletedPosts: string[] = [];
  const tombstoned: string[] = [];

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _limit: undefined as number | undefined,
      _single: false,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update() { q._op = "update"; return q; },
      insert() { q._op = "insert"; return q; },
      upsert() { q._op = "upsert"; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not() { return q; },
      in() { return q; },
      or() { return q; },
      lte() { return q; },
      order() { return q; },
      range() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        if (table === "posts" && q._op === "delete") {
          const id = q._filters.find((f: any[]) => f[0] === "eq" && f[1] === "id")?.[2];
          if (id) deletedPosts.push(id);
          return Promise.resolve({ data: null, error: null });
        }
        if (q._op !== "select") return Promise.resolve({ data: null, error: null });

        // A RESOLVED error, exactly as supabase-js delivers it. Never a throw:
        // a `try/catch` around a supabase read is dead code, and a test whose
        // stub threw would be proving something production never does.
        if (table === opts.failReadsOn) {
          return Promise.resolve({ data: null, error: READ_ERROR });
        }

        let data: any[] = [];
        if (table === "posts") {
          data = ALL_POSTS.map((id) => ({ id }));
        } else if (table === "posts_comments") {
          const pid = q._filters.find((f: any[]) => f[0] === "eq" && f[1] === "post_id")?.[2];
          data = pid && commented.has(pid) ? [{ id: `c-${pid}` }] : [];
        } else if (table === "moderation_reports") {
          const pid = q._filters.find((f: any[]) => f[0] === "eq" && f[1] === "subject_id")?.[2];
          data = pid && reported.has(pid) ? [{ id: `r-${pid}` }] : [];
        }
        if (q._limit != null) data = data.slice(0, q._limit);
        if (q._single) return Promise.resolve({ data: data[0] ?? null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _deletedPosts: deletedPosts,
    _tombstoned: tombstoned,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "tombstone_post") tombstoned.push(args.p_post_id as string);
      return { data: null, error: null };
    },
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
    auth: { admin: { deleteUser: async () => ({ data: {}, error: null }) } },
  };
}

function postsStep(out: any) {
  return out.steps.find((s: any) => s.step === "tombstone_or_delete_posts");
}

describe("AccountDeletionService.hasThirdPartyInterest — posts_comments", () => {
  it("FAILURE: an unreadable posts_comments hard-deletes NOTHING", async () => {
    const c = makeStub({ failReadsOn: "posts_comments" });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.deepEqual(
      c._deletedPosts, [],
      "not one post may be hard-deleted while third-party interest is unknown",
    );
    assert.deepEqual(c._tombstoned, [], "and none may be blanked on a guess either");
    const step = postsStep(out);
    assert.equal(step?.ok, false, "the posts step must be recorded as failed");
    assert.match(
      String(step?.error ?? ""), /posts_comments unreadable/,
      `the operator must be told why: ${JSON.stringify(step)}`,
    );
    assert.ok(out.warnings.some((w: string) => w.includes("posts")), "and the survivor risk surfaced");
  });

  it("HEALTHY: a post with a foreign comment is tombstoned, not deleted", async () => {
    const c = makeStub({ commentedPosts: new Set(["post-B"]) });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.deepEqual(c._tombstoned, ["post-B"]);
    assert.deepEqual(c._deletedPosts.sort(), ["post-A", "post-C"]);
    assert.equal(postsStep(out)?.ok, true);
    assert.equal(out.tombstonedCounts.posts, 1);
    assert.equal(out.deletedCounts.posts, 2);
  });
});

describe("AccountDeletionService.hasThirdPartyInterest — moderation_reports", () => {
  it("FAILURE: an unreadable moderation_reports hard-deletes NOTHING", async () => {
    const c = makeStub({ failReadsOn: "moderation_reports" });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.deepEqual(
      c._deletedPosts, [],
      "a reported post must never be destroyed together with its evidence on an unread table",
    );
    const step = postsStep(out);
    assert.equal(step?.ok, false);
    assert.match(String(step?.error ?? ""), /moderation_reports unreadable/);
  });

  it("HEALTHY: a reported post is tombstoned; an unreported one is still deleted", async () => {
    const c = makeStub({ reportedPosts: new Set(["post-C"]) });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.deepEqual(c._tombstoned, ["post-C"]);
    assert.deepEqual(c._deletedPosts.sort(), ["post-A", "post-B"]);
    assert.equal(postsStep(out)?.ok, true);
  });

  it("HEALTHY: with neither comments nor reports, every post is still hard-deleted", async () => {
    const c = makeStub();
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    assert.deepEqual(c._deletedPosts.sort(), [...ALL_POSTS].sort());
    assert.deepEqual(c._tombstoned, []);
    assert.equal(postsStep(out)?.ok, true);
    assert.equal(out.deletedCounts.posts, 3);
  });
});
