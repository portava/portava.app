/**
 * Unit tests for friendDecisions.ts — pure logic, no DB or HTTP.
 * Run: node --import tsx/esm --test src/test/friendDecisions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideSendRequest,
  decideAcceptRequest,
  decideDeclineRequest,
  decideCancelRequest,
  normalizedFriendshipPair,
  isUuid,
} from "../lib/friendDecisions";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("isUuid", () => {
  it("accepts valid UUID v4", () => assert.ok(isUuid(A)));
  it("rejects non-UUID", () => assert.ok(!isUuid("not-a-uuid")));
  it("rejects empty string", () => assert.ok(!isUuid("")));
});

describe("decideSendRequest", () => {
  it("allows valid send", () => assert.deepEqual(decideSendRequest(A, B), { ok: true }));
  it("blocks self-request", () => {
    const r = decideSendRequest(A, A);
    assert.equal(r.ok, false);
    assert.ok((r as any).reason.includes("yourself"));
  });
});

describe("decideAcceptRequest", () => {
  it("allows recipient to accept", () => assert.deepEqual(decideAcceptRequest(B, B), { ok: true }));
  it("blocks non-recipient", () => {
    const r = decideAcceptRequest(A, B); // A tries to accept B's incoming — wrong
    assert.equal(r.ok, false);
    assert.ok((r as any).reason.includes("recipient"));
  });
});

describe("decideDeclineRequest", () => {
  it("allows recipient to decline", () => assert.deepEqual(decideDeclineRequest(B, B), { ok: true }));
  it("blocks non-recipient", () => {
    const r = decideDeclineRequest(A, B);
    assert.equal(r.ok, false);
  });
});

describe("decideCancelRequest", () => {
  it("allows requester to cancel", () => assert.deepEqual(decideCancelRequest(A, A), { ok: true }));
  it("blocks non-requester", () => {
    const r = decideCancelRequest(B, A); // B tries to cancel A's request
    assert.equal(r.ok, false);
    assert.ok((r as any).reason.includes("requester"));
  });
});

describe("normalizedFriendshipPair", () => {
  it("produces consistent order A<B", () => {
    const [ua, ub] = normalizedFriendshipPair(A, B);
    assert.ok(ua < ub);
    assert.equal(ua, A);
    assert.equal(ub, B);
  });
  it("produces same result regardless of input order", () => {
    const [ua, ub] = normalizedFriendshipPair(B, A);
    assert.ok(ua < ub);
    assert.equal(ua, A);
    assert.equal(ub, B);
  });
  it("same pair from both orderings are equal", () => {
    const r1 = normalizedFriendshipPair(A, B);
    const r2 = normalizedFriendshipPair(B, A);
    assert.deepEqual(r1, r2);
  });
});
