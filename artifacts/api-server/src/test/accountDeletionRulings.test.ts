/**
 * The D6 rulings of 2026-08-23, as executable assertions.
 *
 * The migrations make the correct behaviour POSSIBLE; the worker decides whether
 * it happens. These tests pin the decisions the worker makes, because a rule that
 * lives only in a migration comment is a rule nobody runs.
 *
 * Ruling 4 — posts become tombstones whenever other people have contributed to
 *            their thread; hard-delete only when nobody else has.
 * Ruling 3 — a completed deletion receipt stops naming a person, and carries the
 *            policy and worker versions plus per-domain counts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accountDeletionAuthorizationFixture, PERMANENT_DELETION_TEST_OPTIONS } from "./helpers/accountDeletionAuthorizationFixture.js";
import {
  executeAccountDeletion,
  DELETION_POLICY_VERSION,
  DELETION_WORKER_VERSION,
} from "../services/accountDeletion/AccountDeletionService.js";

const USER = "11111111-1111-1111-1111-111111111111";

interface Fixture {
  /** posts authored by the deleting user */
  posts?: string[];
  /** post ids that carry a comment by somebody else */
  postsWithOtherComments?: string[];
  /** post ids named by a moderation report */
  reportedPosts?: string[];
}

/**
 * A fake Supabase client. Chainable and thenable, like the real one, recording
 * what the worker asked for so the assertions can be about DECISIONS rather than
 * about how many times a method happened to be called.
 */
function fakeClient(fx: Fixture) {
  const rows: Record<string, any[]> = {};
  const authorize = accountDeletionAuthorizationFixture(rows, USER);
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const deletes: Array<{ table: string; eq: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: any; eq: Record<string, unknown> }> = [];

  function builder(table: string, op: "select" | "delete" | "update", values?: any) {
    const eq: Record<string, unknown> = {};
    const filters: Array<[string, string, unknown]> = [];
    const api: any = {
      eq(col: string, val: unknown) { eq[col] = val; filters.push(["eq", col, val]); return api; },
      neq(col: string, val: unknown) { filters.push(["neq", col, val]); return api; },
      not(col: string, _op: string, val: unknown) { filters.push(["not", col, val]); return api; },
      is(col: string, val: unknown) { filters.push(["is", col, val]); return api; },
      in(col: string, val: unknown) { filters.push(["in", col, val]); return api; },
      or() { return api; },
      gte() { return api; },
      lte() { return api; },
      order() { return api; },
      limit() { return api; },
      select() { return api; },
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve: (v: any) => void) {
        if (op === "delete") deletes.push({ table, eq });
        if (op === "update") updates.push({ table, values, eq });

        let data: any[] = [];
        if (table === "user_deletion_requests" && op === "update") {
          data = rows[table]!.filter(row => Object.entries(eq).every(([col, value]) => row[col] === value));
          for (const row of data) Object.assign(row, values);
        }
        if (op === "select") {
          if (table === "posts") {
            data = (fx.posts ?? []).map((id) => ({ id }));
          } else if (table === "posts_comments") {
            // the worker asks: does anyone ELSE have a comment on this post?
            const postId = eq["post_id"] as string;
            data = (fx.postsWithOtherComments ?? []).includes(postId) ? [{ id: "c1" }] : [];
          } else if (table === "moderation_reports") {
            const postId = eq["subject_id"] as string;
            data = (fx.reportedPosts ?? []).includes(postId) ? [{ id: "r1" }] : [];
          }
        }
        resolve({ data, error: null, count: data.length });
      },
    };
    return api;
  }

  return {
    _rpcCalls: rpcCalls,
    _rows: rows,
    _deletes: deletes,
    _updates: updates,
    from(table: string) {
      return {
        select: () => builder(table, "select"),
        delete: () => builder(table, "delete"),
        update: (values: any) => builder(table, "update", values),
        upsert: async () => ({ data: null, error: null }),
      };
    },
    rpc: async (fn: string, args: any) => { rpcCalls.push({ fn, args }); const receipt = authorize(fn, args); if (receipt) return receipt; return { data: fn === 'erase_media_events_for_actor' ? { deleted: 0, more: false } : null, error: null }; },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { admin: { deleteUser: async () => ({ data: null, error: null }) } },
  };
}

describe("ruling 4 — posts tombstone when others have contributed", () => {
  it("TOMBSTONES a post that carries someone else's comment", async () => {
    const sc = fakeClient({ posts: ["p-shared"], postsWithOtherComments: ["p-shared"] });
    const out = await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);

    // Filtered, not compared whole: the worker also calls erase_intel_for_actor,
    // and asserting the full RPC list would break every time an unrelated step
    // gains one.
    const tombstones = sc._rpcCalls.filter((c) => c.fn === "tombstone_post");
    assert.deepEqual(tombstones.map((c) => c.args.p_post_id), ["p-shared"],
      "a post with third-party comments must go through tombstone_post, not a delete");
    assert.equal(sc._deletes.some((d) => d.table === "posts"), false,
      "it must not also be deleted — that would take the other person's comments with it");
    assert.equal(out.tombstonedCounts.posts, 1);
    assert.equal(out.deletedCounts.posts, 0);
  });

  it("HARD-DELETES a post nobody else has touched", async () => {
    const sc = fakeClient({ posts: ["p-lonely"] });
    const out = await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);

    assert.deepEqual(sc._rpcCalls.filter((c) => c.fn === "tombstone_post"), [],
      "nothing to preserve, so no tombstone");
    assert.equal(sc._deletes.some((d) => d.table === "posts" && d.eq.id === "p-lonely"), true);
    assert.equal(out.deletedCounts.posts, 1);
    assert.equal(out.tombstonedCounts.posts, 0);
  });

  it("TOMBSTONES a post named by a moderation report even with no comments", async () => {
    // Ruling 4 lists moderation dependency alongside third-party comments.
    const sc = fakeClient({ posts: ["p-reported"], reportedPosts: ["p-reported"] });
    const out = await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);

    assert.deepEqual(
      sc._rpcCalls.filter((c) => c.fn === "tombstone_post").map((c) => c.args.p_post_id),
      ["p-reported"]);
    assert.equal(out.tombstonedCounts.posts, 1);
  });

  it("decides per post, not per account", async () => {
    const sc = fakeClient({
      posts: ["p-shared", "p-lonely", "p-reported"],
      postsWithOtherComments: ["p-shared"],
      reportedPosts: ["p-reported"],
    });
    const out = await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);

    assert.deepEqual(
      sc._rpcCalls.filter((c) => c.fn === "tombstone_post").map((c) => c.args.p_post_id).sort(),
      ["p-reported", "p-shared"]);
    assert.equal(out.tombstonedCounts.posts, 2);
    assert.equal(out.deletedCounts.posts, 1);
  });
});

describe("ruling 3 — a completed receipt stops naming a person", () => {
  it("prepares counts on the exact claim and completes through the canonical receipt owner", async () => {
    const sc = fakeClient({ posts: ["p-shared"], postsWithOtherComments: ["p-shared"] });
    await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);
    const claim = sc._rpcCalls.find(call => call.fn === 'claim_account_permanent_deletion')!;
    const prepared = sc._rpcCalls.find(call => call.fn === 'prepare_account_auth_deletion')!;
    const settled = sc._rpcCalls.find(call => call.fn === 'settle_account_auth_deletion')!;
    assert.equal(prepared.args.p_token, claim.args.p_token);
    assert.equal(prepared.args.p_request, 'cccccccc-0000-4000-8000-000000000001');
    assert.equal(prepared.args.p_policy, DELETION_POLICY_VERSION);
    assert.equal(prepared.args.p_worker, DELETION_WORKER_VERSION);
    assert.deepEqual(prepared.args.p_tombstoned, { posts: 1 });
    assert.deepEqual(prepared.args.p_deleted, { media_events: 0, posts: 0 });
    assert.equal(settled.args.p_request, prepared.args.p_request);
    assert.equal(settled.args.p_generation, PERMANENT_DELETION_TEST_OPTIONS.generation);
    assert.equal(sc._updates.some(row => row.table === 'user_deletion_requests'), false, 'no parallel raw receipt writer');
    const receipt = sc._rows.user_deletion_requests![0]!;
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.user_id, null); assert.equal(receipt.execution_subject_id, null);
  });

  it("carries no identifying field beyond the user_id it is clearing", async () => {
    const sc = fakeClient({ posts: [] });
    await executeAccountDeletion(sc as any, USER, PERMANENT_DELETION_TEST_OPTIONS);
    const receipt = sc._rows.user_deletion_requests![0]!;

    for (const key of Object.keys(receipt)) {
      assert.doesNotMatch(key, /email|username|handle|ip_address|device|hash/,
        `receipt field "${key}" would make the record identifying`);
    }
  });
});
