/**
 * Account deletion — a failing tombstone_post RPC must not abort the erasure
 * loop (audit H1, code half).
 *
 * Regression: `tombstone_post` is absent in an under-migrated environment
 * (PGRST202/42883). The old loop threw on the first tombstone failure, which
 * aborted the whole loop — every post not yet reached, INCLUDING ordinary posts
 * the else-branch would hard-delete, was left in place, while the caller still
 * marked the request completed. The fix attempts every post independently and
 * throws once at the end, so deletable posts still die and outcome.ok is false.
 *
 * Proof: with posts A,B,C,D where A and C take the (failing) tombstone branch
 * and B,D take the delete branch — and A first — assert B and D are still
 * deleted and both tombstones were attempted. Under the old code the throw on
 * A aborts the loop, so B, C and D are never reached.
 *
 * The posts step is one of the cascade's non-fatal steps (out.ok reflects only
 * profile/auth/mark-completed), so the observable failure here is the step's own
 * `ok:false` plus the "posts may remain" warning. Fully preventing a request
 * from being marked completed while tombstone-branch posts survive is the domain
 * of applying migration 2141 to prod (audit H1 schema half), not this code half.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionRpcFailure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

// Posts A and C have third-party interest → tombstone branch (which fails);
// B and D have none → delete branch (which must still succeed). A is first, so
// the old abort-on-first-failure loop never reaches B, C or D.
const ALL_POSTS = ["post-A", "post-B", "post-C", "post-D"];
const INTEREST = new Set(["post-A", "post-C"]);

function makeStub() {
  const deletedPosts: string[] = [];
  const tombstoneAttempts: string[] = [];
  const authDeleted: string[] = [];

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

        let data: any[] = [];
        if (table === "posts") {
          data = ALL_POSTS.map((id) => ({ id }));
        } else if (table === "posts_comments") {
          // hasThirdPartyInterest: a foreign comment exists only for INTEREST posts.
          const pid = q._filters.find((f: any[]) => f[0] === "eq" && f[1] === "post_id")?.[2];
          data = pid && INTEREST.has(pid) ? [{ id: `c-${pid}` }] : [];
        }
        // moderation_reports and every other select → empty.
        if (q._limit != null) data = data.slice(0, q._limit);
        if (q._single) return Promise.resolve({ data: data[0] ?? null, error: null });
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _deletedPosts: deletedPosts,
    _tombstoneAttempts: tombstoneAttempts,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "tombstone_post") {
        tombstoneAttempts.push(args.p_post_id as string);
        // Function absent in an under-migrated environment.
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.tombstone_post" } };
      }
      return { data: null, error: null }; // erase_intel / erase_memory succeed
    },
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
    auth: { admin: { deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; } } },
  };
}

describe("executeAccountDeletion — tombstone_post RPC failure", () => {
  it("still deletes every non-tombstone post and records the posts step as failed", async () => {
    const c = makeStub();

    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });

    // The delete-branch posts must be gone even though the FIRST post (A) failed
    // on the tombstone branch — the loop did not abort on it.
    assert.ok(c._deletedPosts.includes("post-B"), `post-B must be deleted; got ${JSON.stringify(c._deletedPosts)}`);
    assert.ok(c._deletedPosts.includes("post-D"), `post-D must be deleted; got ${JSON.stringify(c._deletedPosts)}`);

    // Both interest posts were attempted — the loop reached C after A failed.
    assert.deepEqual(c._tombstoneAttempts.sort(), ["post-A", "post-C"]);

    // The posts step is recorded as failed and the survivor risk is surfaced.
    const postsStep = out.steps.find((s) => s.step === "tombstone_or_delete_posts");
    assert.ok(postsStep && postsStep.ok === false, "the posts step must be recorded as failed");
    assert.ok(
      out.warnings.some((w) => w.includes("posts may remain")),
      `the survivor risk must be surfaced: ${JSON.stringify(out.warnings)}`,
    );

    // No post was recorded as tombstoned (both attempts errored); the two
    // delete-branch posts are counted.
    assert.equal(out.tombstonedCounts.posts ?? 0, 0);
    assert.equal(out.deletedCounts.posts, 2);
  });
});
