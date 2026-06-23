"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Follow decision tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/test/followDecisions.test.ts
 *
 * Covers the Phase 1 follow rules. Note: these test the DECISION layer (the
 * route's gatekeeping). The "follow grants nothing sensitive" guarantees are
 * structural — the follow code never reads/writes posts, trips, circles, or
 * locations — and are also enforced by RLS on those tables (proven elsewhere).
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var followDecisions_1 = require("../lib/followDecisions");
var A = "11111111-1111-4111-8111-111111111111";
var B = "22222222-2222-4222-8222-222222222222";
(0, node_test_1.test)("1. user can follow another existing user", function () {
    strict_1.default.deepEqual((0, followDecisions_1.decideFollow)(A, B, { targetExists: true }), { ok: true });
});
(0, node_test_1.test)("2. unauthenticated cannot follow", function () {
    var d = (0, followDecisions_1.decideFollow)(null, B, { targetExists: true });
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "unauthenticated");
});
(0, node_test_1.test)("3. cannot follow self", function () {
    var d = (0, followDecisions_1.decideFollow)(A, A, { targetExists: true });
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "cannot_follow_self");
});
(0, node_test_1.test)("4. cannot follow a non-existent user", function () {
    var d = (0, followDecisions_1.decideFollow)(A, B, { targetExists: false });
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "not_found");
});
(0, node_test_1.test)("5. invalid target id -> invalid_payload", function () {
    var d = (0, followDecisions_1.decideFollow)(A, "not-a-uuid", { targetExists: true });
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "invalid_payload");
});
(0, node_test_1.test)("6. blocked user cannot follow", function () {
    var d = (0, followDecisions_1.decideFollow)(A, B, { targetExists: true, blocked: true });
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "blocked");
});
(0, node_test_1.test)("7. unfollow requires auth", function () {
    strict_1.default.equal((0, followDecisions_1.decideUnfollow)(null, B).ok, false);
    strict_1.default.deepEqual((0, followDecisions_1.decideUnfollow)(A, B), { ok: true });
});
(0, node_test_1.test)("8. unfollow with bad target -> invalid_payload", function () {
    var d = (0, followDecisions_1.decideUnfollow)(A, "nope");
    strict_1.default.equal(d.ok, false);
    strict_1.default.equal(d.code, "invalid_payload");
});
(0, node_test_1.test)("9. isUuid validates", function () {
    strict_1.default.equal((0, followDecisions_1.isUuid)(A), true);
    strict_1.default.equal((0, followDecisions_1.isUuid)("nope"), false);
});
// Structural guarantee (documented assertion): the follow decision layer takes
// ONLY (followerId, targetId, {targetExists, blocked}) — it has no access to and
// cannot grant posts/trips/circles/locations. A follow is purely a social edge.
(0, node_test_1.test)("10. decideFollow signature exposes no sensitive-access surface", function () {
    // The function's contract is (id, id, {targetExists, blocked?}) -> decision.
    // There is no parameter or branch that could grant private/trip/circle/map
    // access. This test documents that invariant.
    var d = (0, followDecisions_1.decideFollow)(A, B, { targetExists: true });
    strict_1.default.deepEqual(Object.keys(d), ["ok"]);
});
