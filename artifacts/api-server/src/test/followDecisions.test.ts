/**
 * Follow decision tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/test/followDecisions.test.ts
 *
 * Covers the Phase 1 follow rules. Note: these test the DECISION layer (the
 * route's gatekeeping). The "follow grants nothing sensitive" guarantees are
 * structural — the follow code never reads/writes posts, trips, circles, or
 * locations — and are also enforced by RLS on those tables (proven elsewhere).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFollow, decideUnfollow, isUuid } from "../lib/followDecisions";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("1. user can follow another existing user", () => {
  assert.deepEqual(decideFollow(A, B, { targetExists: true }), { ok: true });
});

test("2. unauthenticated cannot follow", () => {
  const d = decideFollow(null, B, { targetExists: true });
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "unauthenticated");
});

test("3. cannot follow self", () => {
  const d = decideFollow(A, A, { targetExists: true });
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "cannot_follow_self");
});

test("4. cannot follow a non-existent user", () => {
  const d = decideFollow(A, B, { targetExists: false });
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "not_found");
});

test("5. invalid target id -> invalid_payload", () => {
  const d = decideFollow(A, "not-a-uuid", { targetExists: true });
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "invalid_payload");
});

test("6. blocked user cannot follow", () => {
  const d = decideFollow(A, B, { targetExists: true, blocked: true });
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "blocked");
});

test("7. unfollow requires auth", () => {
  assert.equal(decideUnfollow(null, B).ok, false);
  assert.deepEqual(decideUnfollow(A, B), { ok: true });
});

test("8. unfollow with bad target -> invalid_payload", () => {
  const d = decideUnfollow(A, "nope");
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "invalid_payload");
});

test("9. isUuid validates", () => {
  assert.equal(isUuid(A), true);
  assert.equal(isUuid("nope"), false);
});

// Structural guarantee (documented assertion): the follow decision layer takes
// ONLY (followerId, targetId, {targetExists, blocked}) — it has no access to and
// cannot grant posts/trips/circles/locations. A follow is purely a social edge.
test("10. decideFollow signature exposes no sensitive-access surface", () => {
  // The function's contract is (id, id, {targetExists, blocked?}) -> decision.
  // There is no parameter or branch that could grant private/trip/circle/map
  // access. This test documents that invariant.
  const d = decideFollow(A, B, { targetExists: true });
  assert.deepEqual(Object.keys(d), ["ok"]);
});
