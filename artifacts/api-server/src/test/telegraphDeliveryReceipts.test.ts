/**
 * Telegraph §13.2 `message.delivered` — the DELIVERED half of §7.2's lifecycle.
 *
 * census-telegraph T178: "No delivered concept exists to emit (T69)", and T69:
 * "no DELIVERED concept anywhere ... State is inferred from `created_at`,
 * `edited_at`, `deleted_at` and the thread-level `last_read_at`."
 *
 * WHAT A DELIVERED RECEIPT IS ALLOWED TO CLAIM HERE
 * =================================================
 * The bus knows exactly one delivery fact and it is a real one: whether a
 * recipient had an open realtime connection that ACCEPTED this event. That is
 * what these tests pin. They deliberately do NOT let the receipt claim the
 * message reached a device's storage or a person's eyes — the first is a client
 * acknowledgement this transport has no channel for, and the second is `seen`,
 * which is a different event with a different writer.
 *
 * WHY THE COUNT AND NOT THE NAMES
 * ===============================
 * A delivered receipt is also a presence disclosure: it tells the sender that
 * somebody's device is online right now. In a two-party thread the sender
 * already knows who the other party is, so naming them adds nothing. In a
 * larger one, naming which members are online turns a delivery receipt into a
 * roster-wide presence feed nobody consented to, so only a COUNT crosses the
 * wire. The rule keys off the audience size, not the thread type, because the
 * bus does not know the thread type and a rule that has to ask is a rule that
 * can be asked wrong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  subscribe,
  publishToUsers,
  telegraphEmitterStats,
  _resetTelegraphEmitterStats,
  type TelegraphEvent,
} from "../lib/telegraphEvents.js";

const SENDER = "d0000000-0000-0000-0000-00000000000a";
const RECIP_1 = "d0000000-0000-0000-0000-00000000000b";
const RECIP_2 = "d0000000-0000-0000-0000-00000000000c";

function created(messageId: string) {
  return {
    type: "message.created" as const,
    threadId: "d0000000-0000-0000-0000-0000000000ff",
    payload: { messageId, senderId: SENDER, msgType: "text" },
  };
}

test("a delivered message emits message.delivered back to the sender", () => {
  const sender: TelegraphEvent[] = [];
  const recip: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, (e) => recip.push(e));
  try {
    publishToUsers([RECIP_1], created("m-delivered-1"));

    assert.equal(recip.length, 1, "recipient got the message");
    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1, "sender got exactly one delivered receipt");
    const p = receipts[0].payload as Record<string, unknown>;
    assert.equal(p.messageId, "m-delivered-1");
    assert.equal(p.deliveredCount, 1);
    assert.equal(p.audienceCount, 1);
    assert.equal(p.recipientUserId, RECIP_1, "a one-person audience may be named");
    assert.equal(typeof p.deliveredAt, "string");
  } finally { u1(); u2(); }
});

test("an offline audience is reported as delivered to nobody, not as silence", () => {
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  try {
    publishToUsers([RECIP_1], created("m-offline"));

    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1, "the sender is told, rather than left guessing");
    const p = receipts[0].payload as Record<string, unknown>;
    assert.equal(p.deliveredCount, 0);
    assert.equal(p.audienceCount, 1);
    assert.equal(
      p.crossInstance,
      false,
      "no broadcast hook is registered, so zero means offline rather than offline-here",
    );
  } finally { u1(); }
});

test("a multi-recipient audience is counted, never named", () => {
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, () => {});
  const u3 = subscribe(RECIP_2, () => {});
  try {
    publishToUsers([RECIP_1, RECIP_2], created("m-group"));

    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1);
    const p = receipts[0].payload as Record<string, unknown>;
    assert.equal(p.deliveredCount, 2);
    assert.equal(p.audienceCount, 2);
    assert.equal(p.recipientUserId, null, "a multi-party audience is never named");
    const wire = JSON.stringify(receipts[0]);
    assert.ok(!wire.includes(RECIP_1), "no member id crosses the wire");
    assert.ok(!wire.includes(RECIP_2), "no member id crosses the wire");
  } finally { u1(); u2(); u3(); }
});

test("a subscriber that throws is not counted as delivered", () => {
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, () => { throw new Error("socket gone"); });
  try {
    publishToUsers([RECIP_1], created("m-threw"));

    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1);
    assert.equal((receipts[0].payload as any).deliveredCount, 0,
      "a callback that threw missed the event; it is not a delivery");
  } finally { u1(); u2(); }
});

test("a delivered receipt never produces a delivered receipt", () => {
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, () => {});
  try {
    publishToUsers([RECIP_1], created("m-no-loop"));
    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1, "exactly one — the receipt is not itself receipted");
  } finally { u1(); u2(); }
});

test("re-publishing a delivered receipt does not cascade", () => {
  // The recursion this pins is not hypothetical: a receipt is a fan-out, and a
  // fan-out that receipts itself is a livelock rather than a bug report.
  // Republished with a senderId in its payload — the only field that would let
  // one address another — it must still produce nothing.
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, () => {});
  try {
    publishToUsers([RECIP_1], {
      type: "message.delivered",
      threadId: null,
      payload: { messageId: "m-echo", senderId: SENDER, deliveredCount: 1 },
    });
    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 0, "a receipt is not a message and is never receipted");
  } finally { u1(); u2(); }
});

test("an edit is not a delivery", () => {
  // `message.updated` carries the same two fields a receipt is addressed from.
  // Only a message's FIRST arrival is a delivery; receipting an edit would
  // report the same message delivered twice and make the §28 duplicate-delivery
  // SLO count this bus's own bookkeeping as a defect.
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  const u2 = subscribe(RECIP_1, () => {});
  try {
    publishToUsers([RECIP_1], {
      type: "message.updated",
      threadId: "d0000000-0000-0000-0000-0000000000ff",
      payload: { messageId: "m-edited", senderId: SENDER },
    });
    assert.equal(sender.filter((e) => e.type === "message.delivered").length, 0);
  } finally { u1(); u2(); }
});

test("the sender is never told about their own copy", () => {
  const sender: TelegraphEvent[] = [];
  const u1 = subscribe(SENDER, (e) => sender.push(e));
  try {
    // The audience includes the sender (a caller that forgot excludeUserId).
    publishToUsers([SENDER, RECIP_1], created("m-selfish"));
    const receipts = sender.filter((e) => e.type === "message.delivered");
    assert.equal(receipts.length, 1);
    const p = receipts[0].payload as Record<string, unknown>;
    assert.equal(p.audienceCount, 1, "the sender is not part of their own audience");
    assert.equal(p.deliveredCount, 0, "delivering to oneself is not a delivery");
  } finally { u1(); }
});

test("an event with no sender in its payload emits no receipt", () => {
  _resetTelegraphEmitterStats();
  const recip: TelegraphEvent[] = [];
  const u1 = subscribe(RECIP_1, (e) => recip.push(e));
  try {
    publishToUsers([RECIP_1], { type: "message.created", payload: { messageId: "m-anon" } });
    assert.equal(recip.length, 1);
    assert.equal(
      telegraphEmitterStats().deliveryReceiptsEmitted,
      0,
      "nothing to address the receipt to, so nothing is invented",
    );
  } finally { u1(); }
});

test("emitter counters record receipts and undelivered messages", () => {
  _resetTelegraphEmitterStats();
  const u1 = subscribe(SENDER, () => {});
  const u2 = subscribe(RECIP_1, () => {});
  try {
    publishToUsers([RECIP_1], created("m-counted-1"));   // delivered
    publishToUsers([RECIP_2], created("m-counted-2"));   // nobody online
    const s = telegraphEmitterStats();
    assert.equal(s.deliveryReceiptsEmitted, 2);
    assert.equal(s.messagesDeliveredNowhere, 1);
  } finally { u1(); u2(); }
});
