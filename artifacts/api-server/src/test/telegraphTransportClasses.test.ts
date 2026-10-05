/**
 * census-telegraph T415 / T416 — §30A.12's transport classes, and the three
 * bounded strategies a LARGE_GROUP gets.
 *
 *   "Explicitly distinguish PRIVATE_CONVERSATION, SMALL_GROUP, LARGE_GROUP, and
 *    BROADCAST transport classes. Large Event conversations must not use
 *    small-group fanout, presence, or per-recipient Seen UI without bounded
 *    strategies."
 *
 * WHAT IS EXERCISED
 *   1. The classifier and the strategy table (domain/telegraph/policies/transportClass.ts),
 *      including that BROADCAST is never assigned and that the class is derived
 *      from the ACTIVE roster.
 *   2. The fan-out path reads the table: the bounds lib/telegraphEvents.ts exports
 *      are the class bounds (pinned), and a 51-member conversation sheds presence.
 *   3. Per-recipient Seen is bounded on BOTH receipt routes, through the real
 *      handlers: GET /threads/:id/receipts keeps the exact count and samples the
 *      reader ids; GET /threads/:id/read-receipts returns counts and a bounded
 *      sample of the most recent readers instead of the whole roster. A small
 *      group is unchanged on both.
 *   4. The capabilities projection states the class.
 *
 * SHOWN RED (T2 lane report): boundSeenReaders returning every id (the sample
 * dropped) turns the receipts case red; the read-receipts LARGE_GROUP branch
 * removed turns its case red; SMALL_GROUP_MAX raised to 60 turns the pinning and
 * the 51-member cases red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphTransportClasses.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import lifecycleRouter from "../routes/telegraphLifecycle.js";
import readReceiptsRouter from "../server/telegraph/readReceiptsRoute.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import {
  BROADCAST_UNASSIGNED_REASON,
  LARGE_GROUP_POLL_SIGNAL_ABOVE,
  LARGE_GROUP_SEEN_SAMPLE,
  SMALL_GROUP_MAX,
  TRANSPORT_CLASSES,
  boundSeenReaders,
  strategyFor,
  strategyForAudience,
  transportClassFor,
} from "../domain/telegraph/policies/transportClass.js";
import {
  FANOUT_HARD_MAX,
  FANOUT_PRESENCE_MAX,
  publishToThread,
  subscribe,
  type TelegraphEvent,
} from "../lib/telegraphEvents.js";
import { makeFakeClient, startRouter, call, type RouterHarness } from "./telegraphCertificationHarness.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("§30A.12 — the classifier and the table", () => {
  it("names the spec's four classes, in its order", () => {
    assert.deepEqual([...TRANSPORT_CLASSES], ["PRIVATE_CONVERSATION", "SMALL_GROUP", "LARGE_GROUP", "BROADCAST"]);
  });

  it("a 1:1 kind is PRIVATE; a group is SMALL up to the bound and LARGE above it", () => {
    assert.equal(transportClassFor({ threadType: "direct", activeMembers: 2 }), "PRIVATE_CONVERSATION");
    assert.equal(transportClassFor({ threadType: "rent_buddy_booking", activeMembers: 2 }), "PRIVATE_CONVERSATION");
    assert.equal(transportClassFor({ threadType: "circle", activeMembers: SMALL_GROUP_MAX }), "SMALL_GROUP");
    assert.equal(transportClassFor({ threadType: "trip", activeMembers: SMALL_GROUP_MAX + 1 }), "LARGE_GROUP");
    assert.equal(transportClassFor({ threadType: null, activeMembers: 900 }), "LARGE_GROUP");
  });

  it("BROADCAST is declared and never assigned — a conversation does not become one by growing", () => {
    for (const threadType of ["direct", "trip", "circle", "rent_buddy_booking", null]) {
      for (const n of [0, 1, 2, 50, 51, 499, 500, 501, 5000, 100000]) {
        assert.notEqual(transportClassFor({ threadType, activeMembers: n }), "BROADCAST");
      }
    }
    assert.ok(BROADCAST_UNASSIGNED_REASON.includes("T204"));
  });

  it("SMALL and PRIVATE fan out in full with per-recipient Seen; LARGE sheds presence and samples Seen", () => {
    for (const cls of ["PRIVATE_CONVERSATION", "SMALL_GROUP"] as const) {
      assert.deepEqual(strategyFor(cls, 10), { presence: "fan_out", messages: "fan_out", seen: "per_recipient" });
    }
    assert.deepEqual(strategyFor("LARGE_GROUP", 100), { presence: "shed", messages: "fan_out", seen: "count_with_sample" });
    assert.deepEqual(strategyFor("LARGE_GROUP", LARGE_GROUP_POLL_SIGNAL_ABOVE + 1),
      { presence: "shed", messages: "poll_signal", seen: "count_with_sample" });
  });

  it("the Seen bound keeps the count exact and samples only the ids", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `u${i}`);
    const large = boundSeenReaders(ids, strategyForAudience(60));
    assert.equal(large.seenBy, 45);
    assert.equal(large.seenByUserIds.length, LARGE_GROUP_SEEN_SAMPLE);
    assert.equal(large.seenByUserIdsSampled, true);
    const small = boundSeenReaders(ids.slice(0, 5), strategyForAudience(10));
    assert.deepEqual(small, { seenBy: 5, seenByUserIds: ids.slice(0, 5), seenByUserIdsSampled: false });
  });
});

describe("§30A.12 — the fan-out path reads the same table", () => {
  it("the bounds lib/telegraphEvents.ts exports ARE the class bounds", () => {
    assert.equal(FANOUT_PRESENCE_MAX, SMALL_GROUP_MAX);
    assert.equal(FANOUT_HARD_MAX, LARGE_GROUP_POLL_SIGNAL_ABOVE);
  });

  it("a 51-member conversation (LARGE_GROUP) sheds a typing event; a 50-member one fans it out", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const [n, expectDelivered] of [[SMALL_GROUP_MAX, true], [SMALL_GROUP_MAX + 1, false]] as const) {
      const roster = ids(n);
      const got: TelegraphEvent[] = [];
      const unsub = subscribe(roster[1]!, (e) => got.push(e));
      const client = makeFakeClient({ message_thread_members: roster.map((user_id) => ({ thread_id: "T", user_id, left_at: null })) });
      await publishToThread(client as unknown as SupabaseClient, "T", { type: "typing.started", payload: {} }, { excludeUserId: roster[0] });
      unsub();
      assert.equal(got.length > 0, expectDelivered, `${n} members`);
    }
  });
});

// ── the receipt routes ────────────────────────────────────────────────────────

const SENDER = "aaaaaaaa-0000-4000-8000-000000000001";
const BIG = "00000000-0000-4000-8000-0000000000b1";
const SMALL = "00000000-0000-4000-8000-0000000000b2";
const MSG_BIG = "11111111-0000-4000-8000-0000000000b1";
const MSG_SMALL = "11111111-0000-4000-8000-0000000000b2";
const SENT_AT = "2026-09-01T10:00:00.000Z";
const READ_AT = "2026-09-01T11:00:00.000Z";

function user(i: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

function seed(): Record<string, Record<string, unknown>[]> {
  const big = Array.from({ length: 60 }, (_, i) => user(i));
  const small = Array.from({ length: 4 }, (_, i) => user(100 + i));
  const members: Record<string, unknown>[] = [
    { thread_id: BIG, user_id: SENDER, role: "member", left_at: null, last_read_at: READ_AT, visible_from_at: null },
    { thread_id: SMALL, user_id: SENDER, role: "member", left_at: null, last_read_at: READ_AT, visible_from_at: null },
  ];
  // 40 of the 60 have read past the message, at distinct times; 20 have not.
  big.forEach((u, i) => members.push({ thread_id: BIG, user_id: u, role: "member", left_at: null,
    last_read_at: i < 40 ? new Date(Date.parse(READ_AT) + i * 60_000).toISOString() : null, visible_from_at: null }));
  small.forEach((u) => members.push({ thread_id: SMALL, user_id: u, role: "member", left_at: null,
    last_read_at: READ_AT, visible_from_at: null }));
  return {
    feature_flags: [],
    message_threads: [
      { id: BIG, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: SENDER, is_e2ee: false },
      { id: SMALL, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: SENDER, is_e2ee: false },
    ],
    message_thread_members: members,
    messages: [
      { id: MSG_BIG, thread_id: BIG, sender_id: SENDER, created_at: SENT_AT, deleted_at: null, edited_at: null, body: "hi" },
      { id: MSG_SMALL, thread_id: SMALL, sender_id: SENDER, created_at: SENT_AT, deleted_at: null, edited_at: null, body: "hi" },
    ],
    blocks: [],
    trust_restrictions: [],
    user_privacy_settings: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
  };
}

describe("§30A.12 — per-recipient Seen is bounded on both receipt routes", () => {
  let lifecycle: RouterHarness;
  let readReceipts: RouterHarness;
  let capabilities: RouterHarness;
  before(async () => {
    lifecycle = await startRouter(lifecycleRouter);
    readReceipts = await startRouter(readReceiptsRouter);
    capabilities = await startRouter(capabilityRouter);
  });
  after(async () => {
    _setTestClient(null, false);
    await lifecycle.close();
    await readReceipts.close();
    await capabilities.close();
  });

  it("GET /receipts in a LARGE_GROUP: the count is exact, the reader ids are a bounded sample", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const r = await call(lifecycle.base, "GET", `/threads/${BIG}/receipts?messageIds=${MSG_BIG}`, SENDER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const receipt = r.body.receipts[0];
    assert.equal(receipt.seenBy, 40);
    assert.equal(receipt.seenByUserIds.length, LARGE_GROUP_SEEN_SAMPLE);
    assert.equal(receipt.seenByUserIdsSampled, true);
    assert.equal(receipt.recipientCount, 60);
  });

  it("GET /receipts in a SMALL_GROUP is unchanged: every reader named", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const r = await call(lifecycle.base, "GET", `/threads/${SMALL}/receipts?messageIds=${MSG_SMALL}`, SENDER);
    const receipt = r.body.receipts[0];
    assert.equal(receipt.seenBy, 4);
    assert.equal(receipt.seenByUserIds.length, 4);
    assert.equal(receipt.seenByUserIdsSampled, false);
  });

  it("GET /read-receipts in a LARGE_GROUP: counts and the most recent readers, never the whole roster", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const r = await call(readReceipts.base, "GET", `/threads/${BIG}/read-receipts`, SENDER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.transportClass, "LARGE_GROUP");
    assert.equal(r.body.sampled, true);
    assert.equal(r.body.memberCount, 61);
    assert.equal(r.body.readerCount, 41);
    assert.equal(r.body.receipts.length, LARGE_GROUP_SEEN_SAMPLE);
    const times = r.body.receipts.map((x: { lastReadAt: string }) => Date.parse(x.lastReadAt));
    assert.deepEqual(times, [...times].sort((a: number, b: number) => b - a), "most recent readers first");
  });

  it("GET /read-receipts in a SMALL_GROUP returns every member, as before", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const r = await call(readReceipts.base, "GET", `/threads/${SMALL}/read-receipts`, SENDER);
    assert.equal(r.body.transportClass, "SMALL_GROUP");
    assert.equal(r.body.sampled, undefined);
    assert.equal(r.body.receipts.length, 5);
  });

  it("the capabilities projection states the class", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const big = await call(capabilities.base, "GET", `/threads/${BIG}/capabilities`, SENDER);
    const small = await call(capabilities.base, "GET", `/threads/${SMALL}/capabilities`, SENDER);
    assert.equal(big.body.conversation.transportClass, "LARGE_GROUP");
    assert.equal(small.body.conversation.transportClass, "SMALL_GROUP");
  });
});
