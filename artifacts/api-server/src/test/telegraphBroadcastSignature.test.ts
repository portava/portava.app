/**
 * census-telegraph T72/T73 (#786 verifier) — the cross-instance broadcast signature covers the PAYLOAD.
 *
 * Since batch 2 a remote `message.created` payload drives a database write: its `sequence` advances the
 * receiving members' `delivered_sequence` (lib/telegraphOutboxDrainScheduler.ts, the delivered sink).
 * The HMAC used to cover only instanceId|userIds|type|ts, so a payload altered in transit — a different
 * sequence, a different thread — verified. Now the signature covers threadId and a canonical JSON of
 * the payload; HMAC_CONTEXT moved to v2 so a v1 signature is invalid by construction.
 *
 * MUTANT (tgprod/mutants-786.txt): BS1 the canonical string drops the payload → red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphBroadcastSignature.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { _signBroadcastForTest, _verifyBroadcastForTest, canonicalEventJson, type BroadcastPayload } from "../lib/telegraphBroadcast.js";

const KEY = "service-role-key-for-the-test";
const event = { type: "message.created" as const, threadId: "th-1", ts: "2026-10-24T10:00:00.000Z", payload: { messageId: "m-1", senderId: "u-a", sequence: 12 } };
const signed = (): BroadcastPayload => ({ sourceInstanceId: "inst-1", userIds: ["u-b", "u-c"], event, sig: _signBroadcastForTest("inst-1", ["u-b", "u-c"], event, KEY) });

test("an untouched payload verifies, including after the transport re-orders its keys", () => {
  assert.equal(_verifyBroadcastForTest(signed(), KEY), true);
  const reordered = JSON.parse(JSON.stringify({ ...signed(), event: { ts: event.ts, payload: { sequence: 12, senderId: "u-a", messageId: "m-1" }, threadId: "th-1", type: event.type } }));
  assert.equal(_verifyBroadcastForTest(reordered, KEY), true);
});

test("an altered payload (the sequence the sink writes) does NOT verify", () => {
  const p = signed();
  assert.equal(_verifyBroadcastForTest({ ...p, event: { ...p.event, payload: { ...p.event.payload, sequence: 999 } } }, KEY), false);
  assert.equal(_verifyBroadcastForTest({ ...p, event: { ...p.event, payload: { ...p.event.payload, extra: true } } }, KEY), false);
});

test("an altered thread, audience, type or time does NOT verify; another key does not verify", () => {
  const p = signed();
  assert.equal(_verifyBroadcastForTest({ ...p, event: { ...p.event, threadId: "th-2" } }, KEY), false);
  assert.equal(_verifyBroadcastForTest({ ...p, userIds: ["u-b"] }, KEY), false);
  assert.equal(_verifyBroadcastForTest({ ...p, event: { ...p.event, ts: "2026-10-24T10:00:01.000Z" } }, KEY), false);
  assert.equal(_verifyBroadcastForTest(p, "another-key"), false);
});

test("canonicalEventJson sorts keys at every depth and keeps JSON's value rules", () => {
  assert.equal(canonicalEventJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalEventJson(null), "null");
});
