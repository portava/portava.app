/**
 * Trips spec §18.2 — the QueuedTripOperation contract and the replay /
 * revalidate / reject rule (census-trips TR343, TR349, TR451).
 *
 * Run: node --import tsx/esm --test src/test/tripOfflineQueue.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  QueuedTripOperationSchema, OFFLINE_SAFE_TYPES, QUEUE_HORIZON_MS, QUEUE_FUTURE_SKEW_MS,
  classifyQueuedOperation, classifyQueuedOperations, orderQueuedOperations, type QueuedTripOperation,
} from "../services/trips/TripOfflineQueue.js";
import { COMMANDS_ENDPOINT_TYPES, CUTOVER_GATED_TYPES } from "../routes/tripCommands.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const TRIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const ctx = { currentTripVersion: 7, now: NOW, issuable: new Set<string>(COMMANDS_ENDPOINT_TYPES), gated: CUTOVER_GATED_TYPES };
function op(over: Partial<QueuedTripOperation> = {}): QueuedTripOperation {
  return {
    operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", tripId: TRIP, expectedTripVersion: null,
    type: "JOIN_PLAN", payload: { plan_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1" },
    clientOccurredAt: new Date(NOW - 6 * 3_600_000).toISOString(), idempotencyKey: "join-1",
    ...over,
  };
}

describe("TR343 — the QueuedTripOperation contract", () => {
  it("accepts §18.2's seven fields and nothing else", () => {
    assert.equal(QueuedTripOperationSchema.safeParse(op()).success, true);
    assert.equal(QueuedTripOperationSchema.safeParse({ ...op(), actor_user_id: "x" }).success, false, "a client naming the actor is refused");
    assert.equal(QueuedTripOperationSchema.safeParse({ ...op(), idempotencyKey: "" }).success, false);
    assert.equal(QueuedTripOperationSchema.safeParse({ ...op(), operationId: "not-a-uuid" }).success, false);
    assert.equal(QueuedTripOperationSchema.safeParse({ ...op(), clientOccurredAt: "yesterday" }).success, false);
    assert.equal(QueuedTripOperationSchema.safeParse({ ...op(), expectedTripVersion: -1 }).success, false);
  });
  it("the offline-safe list is §18.2's, in the kernel's vocabulary, and every entry is issuable", () => {
    for (const t of ["JOIN_PLAN", "LEAVE_PLAN", "SET_PLAN_ATTENDANCE", "SET_PRESENCE", "CLEAR_PRESENCE"]) assert.ok(OFFLINE_SAFE_TYPES.includes(t), t);
    for (const t of OFFLINE_SAFE_TYPES) assert.ok((COMMANDS_ENDPOINT_TYPES as readonly string[]).includes(t), `${t} is offline-safe but not issuable`);
  });
});

describe("TR349 / TR451 — replay, revalidate, reject", () => {
  it("an offline-safe operation replays, with its own key and expected version", () => {
    const c = classifyQueuedOperation(op({ expectedTripVersion: 3 }), ctx);
    assert.equal(c.decision, "replay"); assert.equal(c.reasonCode, null);
    assert.match(c.detail, /expected version 3/);
  });
  it("a sensitive operation not revalidated against the current version waits: TRIP_OFFLINE_REVALIDATION_REQUIRED, with the version to use", () => {
    for (const expected of [null, 5]) {
      const c = classifyQueuedOperation(op({ type: "REMOVE_COMMITMENT", payload: { commitment_id: "x" }, expectedTripVersion: expected }), ctx);
      assert.equal(c.decision, "revalidate", String(expected)); assert.equal(c.reasonCode, "TRIP_OFFLINE_REVALIDATION_REQUIRED");
      assert.match(c.detail, /expectedTripVersion 7/);
    }
  });
  it("a sensitive operation the client revalidated (expected === current) replays", () => {
    const c = classifyQueuedOperation(op({ type: "REMOVE_COMMITMENT", payload: { commitment_id: "x" }, expectedTripVersion: 7 }), ctx);
    assert.equal(c.decision, "replay"); assert.match(c.detail, /revalidated/);
  });
  it("a cutover-gated plan write is rejected and told which door; an unknown type is rejected", () => {
    const gated = classifyQueuedOperation(op({ type: "COMPLETE_ACTIVITY" }), ctx);
    assert.equal(gated.decision, "reject"); assert.equal(gated.reasonCode, "TRIP_OFFLINE_QUEUE_REJECTED"); assert.match(gated.detail, /its own route/);
    const unknown = classifyQueuedOperation(op({ type: "TELEPORT" }), ctx);
    assert.equal(unknown.decision, "reject"); assert.match(unknown.detail, /not a command this endpoint issues/);
  });
  it("a clientOccurredAt the server cannot believe is rejected: the future, or past the horizon", () => {
    const future = classifyQueuedOperation(op({ clientOccurredAt: new Date(NOW + QUEUE_FUTURE_SKEW_MS + 1000).toISOString() }), ctx);
    assert.equal(future.decision, "reject"); assert.match(future.detail, /future/);
    const skew = classifyQueuedOperation(op({ clientOccurredAt: new Date(NOW + QUEUE_FUTURE_SKEW_MS - 1000).toISOString() }), ctx);
    assert.equal(skew.decision, "replay", "inside the allowed skew is fine");
    const old = classifyQueuedOperation(op({ clientOccurredAt: new Date(NOW - QUEUE_HORIZON_MS - 1000).toISOString() }), ctx);
    assert.equal(old.decision, "reject"); assert.match(old.detail, /horizon/);
  });
  it("a queue is replayed in the order the traveller acted, stable by operationId", () => {
    const later = op({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", clientOccurredAt: new Date(NOW - 1000).toISOString() });
    const earlier = op({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", clientOccurredAt: new Date(NOW - 5000).toISOString() });
    const tie = op({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", clientOccurredAt: new Date(NOW - 1000).toISOString() });
    assert.deepEqual(orderQueuedOperations([later, earlier, tie]).map((o) => o.operationId.slice(-1)), ["2", "1", "3"]);
    assert.deepEqual(classifyQueuedOperations([later, earlier], ctx).map((c) => c.operation.operationId.slice(-1)), ["2", "3"]);
  });
  it("§18.3 (TR350): SAVE_IDEA / UNSAVE_IDEA replay as SET operations, by identity; a malformed one is rejected", () => {
    const save = classifyQueuedOperation(op({ type: "SAVE_IDEA", payload: { placeId: "fsq:1", placeName: "Cafe" } }), ctx);
    assert.equal(save.decision, "replay"); assert.equal(save.via, "set"); assert.match(save.detail, /idempotent by construction/);
    const unsave = classifyQueuedOperation(op({ type: "UNSAVE_IDEA", payload: { placeId: "fsq:1" } }), ctx);
    assert.equal(unsave.decision, "replay"); assert.equal(unsave.via, "set");
    const bad = classifyQueuedOperation(op({ type: "SAVE_IDEA", payload: { placeName: "no id" } }), ctx);
    assert.equal(bad.decision, "reject"); assert.equal(bad.reasonCode, "TRIP_OFFLINE_QUEUE_REJECTED");
    assert.equal(classifyQueuedOperation(op(), ctx).via, "kernel", "a kernel command replays through the kernel");
  });
  it("both reason codes are Appendix B's TRIP_OFFLINE_* family", () => {
    for (const c of ["TRIP_OFFLINE_REVALIDATION_REQUIRED", "TRIP_OFFLINE_QUEUE_REJECTED", "TRIP_OFFLINE_BUNDLE_STALE"]) assert.ok((TRIP_REASON_CODES as readonly string[]).includes(c), c);
  });
});
