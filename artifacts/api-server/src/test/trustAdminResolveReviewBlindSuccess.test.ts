/**
 * trustAdminResolveReviewBlindSuccess — an adjudication that did not happen must
 * not be reported as done, and must not be written into the admin audit log.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `adminResolveReview` (reachable as POST
 * /admin/trust/gaming-flags/:id/mark-reviewed) had:
 *
 *     const { data: review } = await db.from("trust_reviews")…    // error unbound
 *     if (!review) throw new Error("Review not found");
 *
 *     await db.from("trust_reviews").update({ status: resolution, … })
 *       .eq("id", reviewId);                                      // result DISCARDED
 *
 *     await logAdminAction(db, adminId, …, "resolve_review", …);
 *     return { ok: true };
 *
 * Two failures, both silent, both on a moderation path:
 *
 *  1. supabase-js RESOLVES on a database error, so an unreadable `trust_reviews`
 *     came back as `{ data: null }` and the admin was told "Review not found"
 *     about a row that is right there.
 *  2. The update had no `.select()` and no `.error` check — its result was
 *     thrown away entirely. A failed write still returned `{ ok: true }`, left
 *     the review sitting in the queue, AND wrote a `resolve_review` row into
 *     `trust_admin_actions` for an action that never took place. A false entry
 *     in the one log whose whole purpose is to be trustworthy.
 *
 * The two sibling adjudication paths in the same file — `confirmEvent` and
 * `dismissEvent` — already observe their status transition through `.select()`
 * plus `affectedRows` for exactly this reason. This one was left behind.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * `makeFailClosedClient` resolves the error rather than throwing, so the path
 * production takes is the path under test. The write failure is injected with
 * `failWritesOn` (writes only) and the read failure with `failOn` (reads only),
 * so each test fails exactly ONE of the two and the other stays healthy — a
 * green cannot come from the whole table being unreachable.
 *
 * WHAT ELSE COULD MAKE "it threw" PASS? The pre-existing "Review not found"
 * throw, which fires whenever the seed is empty. So test 1 is the control: on a
 * healthy client the SAME seed resolves successfully and writes exactly one
 * audit row — the fixture provably reaches the audit write. And tests 2-3
 * assert the audit table is UNTOUCHED, which no "throw earlier" could fake into
 * being wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import { adminResolveReview } from "../services/trust/TrustAdminService.js";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function spec(opts: { failRead?: boolean; failWrite?: boolean } = {}): FakeClientSpec {
  return {
    rows: {
      trust_reviews: [{ id: REVIEW, user_id: SUBJECT, status: "open", notes: null }],
      trust_admin_actions: [],
    },
    failOn: (c) =>
      opts.failRead && c.table === "trust_reviews"
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
    failWritesOn: (t) =>
      opts.failWrite && t === "trust_reviews"
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
  };
}

test("1. control: a healthy resolve succeeds AND writes exactly one audit row", async () => {
  const s = spec();
  const db = makeFailClosedClient(s);
  const result = await adminResolveReview(db, ADMIN, REVIEW, "dismissed", "spam");
  assert.deepEqual(result, { ok: true });
  assert.equal(
    (s.inserted?.trust_admin_actions ?? []).length, 1,
    "the fixture provably reaches the audit write — so its ABSENCE below is meaningful",
  );
  assert.equal(s.inserted!.trust_admin_actions[0].action_type, "resolve_review");
  assert.equal(s.updated?.trust_reviews?.[0]?.status, "dismissed", "and the review really was updated");
});

test("2. a FAILED update is not reported as ok, and writes no audit row", async () => {
  const s = spec({ failWrite: true });
  const db = makeFailClosedClient(s);

  await assert.rejects(
    () => adminResolveReview(db, ADMIN, REVIEW, "dismissed", "spam"),
    (err: Error) => {
      // Not the pre-existing "Review not found" throw — the READ succeeded here.
      assert.match(err.message, /status update failed/);
      return true;
    },
    "a discarded write result made this return { ok: true } to the admin",
  );

  assert.equal(
    (s.inserted?.trust_admin_actions ?? []).length, 0,
    "no `resolve_review` audit row for a resolution that never happened",
  );
});

test("3. an UNREADABLE review is not reported to the admin as a missing one", async () => {
  const s = spec({ failRead: true });
  const db = makeFailClosedClient(s);

  await assert.rejects(
    () => adminResolveReview(db, ADMIN, REVIEW, "resolved"),
    (err: Error) => {
      assert.match(err.message, /review read failed/);
      // The row IS in the seed. "Review not found" would be a false statement.
      assert.doesNotMatch(err.message, /Review not found/);
      return true;
    },
  );
  assert.equal((s.inserted?.trust_admin_actions ?? []).length, 0);
});

test("4. a genuinely absent review still says 'Review not found'", async () => {
  const s: FakeClientSpec = { rows: { trust_reviews: [], trust_admin_actions: [] } };
  await assert.rejects(
    () => adminResolveReview(makeFailClosedClient(s), ADMIN, REVIEW, "resolved"),
    /Review not found/,
    "the honest not-found answer is preserved — the fix is not 'always throw a db error'",
  );
});
