/**
 * Telegraph §30A.12 — bounded fan-out strategies for large conversations.
 *
 * census-telegraph T416: "Large Event conversations must not use small-group
 * fanout, presence or per-recipient Seen UI without bounded strategies | N ∅ |
 * Unguarded absence: `publishToThread` fans out to every active member with no
 * size bound, and the rule is unviolated only because event conversations do
 * not exist."
 *
 * The absence being unguarded is the part this closes. Whether a 900-member
 * conversation can be CREATED is a different question (it cannot, today), but
 * the fan-out path is the same one for every thread type, so the bound belongs
 * on the path rather than on a thread type that does not exist yet. A rule that
 * waits for its subject to appear is a rule that will be missing on the day it
 * first matters.
 *
 * TWO BOUNDS, BECAUSE THERE ARE TWO COSTS
 * =======================================
 * Presence-class events (typing, read receipts, per-message seen, delivery
 * receipts) cost O(members) PER KEYSTROKE and carry nothing a reader loses by
 * missing. They stop at the smaller bound. Message-class events cost
 * O(members) per message and carry the conversation itself, so they survive the
 * smaller bound and degrade — above the hard bound — to a single poll signal
 * per member rather than a full payload, which is what keeps one publish from
 * becoming unbounded work.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  subscribe,
  publishToThread,
  telegraphEmitterStats,
  _resetTelegraphEmitterStats,
  FANOUT_PRESENCE_MAX,
  FANOUT_HARD_MAX,
  type TelegraphEvent,
} from "../lib/telegraphEvents.js";

const THREAD = "f0000000-0000-0000-0000-0000000000aa";

function members(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f0000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
}

function fakeClient(userIds: string[], opts: { error?: boolean } = {}) {
  return {
    from() {
      const q: any = {
        select() { return q; },
        eq() { return q; },
        is() { return q; },
        then(resolve: (v: any) => void) {
          if (opts.error) return resolve({ data: null, error: { message: "denied", code: "42501" } });
          return resolve({ data: userIds.map((user_id) => ({ user_id })), error: null });
        },
      };
      return q;
    },
  } as any;
}

/** Subscribe everyone and collect what each one actually receives. */
function watch(ids: string[]) {
  const seen = new Map<string, TelegraphEvent[]>();
  const unsubs = ids.map((id) => {
    seen.set(id, []);
    return subscribe(id, (e) => seen.get(id)!.push(e));
  });
  return { seen, stop: () => unsubs.forEach((u) => u()) };
}

test("the two bounds are exported and ordered", () => {
  assert.ok(FANOUT_PRESENCE_MAX > 0);
  assert.ok(FANOUT_HARD_MAX > FANOUT_PRESENCE_MAX,
    "the hard bound must sit above the presence bound or the presence bound is unreachable");
});

test("a small conversation is unchanged: presence fans out in full", async () => {
  _resetTelegraphEmitterStats();
  const ids = members(3);
  const w = watch(ids);
  try {
    await publishToThread(fakeClient(ids), THREAD, { type: "typing.started", payload: { userId: ids[0] } });
    for (const id of ids) {
      assert.equal(w.seen.get(id)!.filter((e) => e.type === "typing.started").length, 1, id);
    }
    assert.equal(telegraphEmitterStats().presenceShedLargeConversation, 0);
  } finally { w.stop(); }
});

test("presence is SHED above the presence bound, and counted", async () => {
  _resetTelegraphEmitterStats();
  const ids = members(FANOUT_PRESENCE_MAX + 1);
  const w = watch(ids);
  try {
    await publishToThread(fakeClient(ids), THREAD, { type: "typing.started", payload: { userId: ids[0] } });
    const total = ids.reduce((n, id) => n + w.seen.get(id)!.length, 0);
    assert.equal(total, 0, "nobody receives a typing indicator in a conversation this size");
    assert.equal(telegraphEmitterStats().presenceShedLargeConversation, 1,
      "the shed is a number an operator can see, not a silent drop");
  } finally { w.stop(); }
});

test("every presence-class event is shed, not just typing", async () => {
  const ids = members(FANOUT_PRESENCE_MAX + 1);
  for (const type of ["typing.started", "typing.stopped", "read.updated", "message.seen", "message.delivered"] as const) {
    _resetTelegraphEmitterStats();
    const w = watch(ids);
    try {
      await publishToThread(fakeClient(ids), THREAD, { type, payload: {} });
      const total = ids.reduce((n, id) => n + w.seen.get(id)!.length, 0);
      assert.equal(total, 0, `${type} must not fan out to a large conversation`);
    } finally { w.stop(); }
  }
});

test("a message SURVIVES the presence bound — the conversation is the payload", async () => {
  _resetTelegraphEmitterStats();
  const ids = members(FANOUT_PRESENCE_MAX + 1);
  const w = watch(ids);
  try {
    await publishToThread(fakeClient(ids), THREAD, {
      type: "message.created",
      payload: { messageId: "m1", senderId: "nobody" },
    });
    const got = ids.filter((id) => w.seen.get(id)!.some((e) => e.type === "message.created")).length;
    assert.equal(got, ids.length, "a message is not presence and is not shed for being popular");
    assert.equal(telegraphEmitterStats().fanoutDegradedLargeConversation, 0);
  } finally { w.stop(); }
});

test("above the hard bound a message degrades to a poll signal, never to silence", async () => {
  _resetTelegraphEmitterStats();
  const ids = members(FANOUT_HARD_MAX + 1);
  const w = watch(ids);
  try {
    await publishToThread(fakeClient(ids), THREAD, {
      type: "message.created",
      payload: { messageId: "m1", senderId: "nobody", body: "never on this path" },
    });
    for (const id of ids) {
      const evts = w.seen.get(id)!;
      assert.equal(evts.length, 1, "exactly one frame per member");
      assert.equal(evts[0].type, "thread.updated", "degraded to a poll signal");
      assert.equal((evts[0].payload as any).degraded, "large_conversation");
      assert.equal((evts[0].payload as any).originalType, "message.created",
        "the client is told WHAT it must poll for, not merely that something happened");
      assert.ok(!JSON.stringify(evts[0]).includes("never on this path"),
        "the degraded signal carries no payload — that is the whole point of degrading");
    }
    assert.equal(telegraphEmitterStats().fanoutDegradedLargeConversation, 1);
  } finally { w.stop(); }
});

test("an unreadable roster still refuses rather than fanning out to nobody quietly", async () => {
  _resetTelegraphEmitterStats();
  const ids = members(3);
  const w = watch(ids);
  try {
    await publishToThread(fakeClient(ids, { error: true }), THREAD, { type: "message.created", payload: {} });
    assert.equal(telegraphEmitterStats().eventsDroppedUnresolvedAudience, 1);
    assert.equal(telegraphEmitterStats().presenceShedLargeConversation, 0,
      "an unreadable roster is not a large conversation");
  } finally { w.stop(); }
});
