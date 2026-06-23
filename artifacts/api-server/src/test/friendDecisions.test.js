"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Unit tests for friendDecisions.ts — pure logic, no DB or HTTP.
 * Run: node --import tsx/esm --test src/test/friendDecisions.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var friendDecisions_1 = require("../lib/friendDecisions");
var A = "aaaaaaaa-0000-0000-0000-000000000001";
var B = "bbbbbbbb-0000-0000-0000-000000000002";
(0, node_test_1.describe)("isUuid", function () {
    (0, node_test_1.it)("accepts valid UUID v4", function () { return strict_1.default.ok((0, friendDecisions_1.isUuid)(A)); });
    (0, node_test_1.it)("rejects non-UUID", function () { return strict_1.default.ok(!(0, friendDecisions_1.isUuid)("not-a-uuid")); });
    (0, node_test_1.it)("rejects empty string", function () { return strict_1.default.ok(!(0, friendDecisions_1.isUuid)("")); });
});
(0, node_test_1.describe)("decideSendRequest", function () {
    (0, node_test_1.it)("allows valid send", function () { return strict_1.default.deepEqual((0, friendDecisions_1.decideSendRequest)(A, B), { ok: true }); });
    (0, node_test_1.it)("blocks self-request", function () {
        var r = (0, friendDecisions_1.decideSendRequest)(A, A);
        strict_1.default.equal(r.ok, false);
        strict_1.default.ok(r.reason.includes("yourself"));
    });
});
(0, node_test_1.describe)("decideAcceptRequest", function () {
    (0, node_test_1.it)("allows recipient to accept", function () { return strict_1.default.deepEqual((0, friendDecisions_1.decideAcceptRequest)(B, B), { ok: true }); });
    (0, node_test_1.it)("blocks non-recipient", function () {
        var r = (0, friendDecisions_1.decideAcceptRequest)(A, B); // A tries to accept B's incoming — wrong
        strict_1.default.equal(r.ok, false);
        strict_1.default.ok(r.reason.includes("recipient"));
    });
});
(0, node_test_1.describe)("decideDeclineRequest", function () {
    (0, node_test_1.it)("allows recipient to decline", function () { return strict_1.default.deepEqual((0, friendDecisions_1.decideDeclineRequest)(B, B), { ok: true }); });
    (0, node_test_1.it)("blocks non-recipient", function () {
        var r = (0, friendDecisions_1.decideDeclineRequest)(A, B);
        strict_1.default.equal(r.ok, false);
    });
});
(0, node_test_1.describe)("decideCancelRequest", function () {
    (0, node_test_1.it)("allows requester to cancel", function () { return strict_1.default.deepEqual((0, friendDecisions_1.decideCancelRequest)(A, A), { ok: true }); });
    (0, node_test_1.it)("blocks non-requester", function () {
        var r = (0, friendDecisions_1.decideCancelRequest)(B, A); // B tries to cancel A's request
        strict_1.default.equal(r.ok, false);
        strict_1.default.ok(r.reason.includes("requester"));
    });
});
(0, node_test_1.describe)("normalizedFriendshipPair", function () {
    (0, node_test_1.it)("produces consistent order A<B", function () {
        var _a = (0, friendDecisions_1.normalizedFriendshipPair)(A, B), ua = _a[0], ub = _a[1];
        strict_1.default.ok(ua < ub);
        strict_1.default.equal(ua, A);
        strict_1.default.equal(ub, B);
    });
    (0, node_test_1.it)("produces same result regardless of input order", function () {
        var _a = (0, friendDecisions_1.normalizedFriendshipPair)(B, A), ua = _a[0], ub = _a[1];
        strict_1.default.ok(ua < ub);
        strict_1.default.equal(ua, A);
        strict_1.default.equal(ub, B);
    });
    (0, node_test_1.it)("same pair from both orderings are equal", function () {
        var r1 = (0, friendDecisions_1.normalizedFriendshipPair)(A, B);
        var r2 = (0, friendDecisions_1.normalizedFriendshipPair)(B, A);
        strict_1.default.deepEqual(r1, r2);
    });
});
