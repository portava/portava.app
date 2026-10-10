/**
 * census-telegraph §51, proposed ruling P-T6 — read state and typing never cross a block.
 *
 * THE LEAK. A block leaves a shared thread in place: a DM that outlived it, a group
 * with both people in it. `publishToThread` fanned every presence-class event — typing,
 * read markers, seen receipts — to every active member, and both receipt routes
 * listed every member's read position. So the person you blocked still watched you
 * type and read, and you watched them; a DM's "Seen" kept updating across the block.
 *
 * NOW. For a presence-class event with a known actor, anyone in a block with the actor
 * (either direction) is dropped from the audience, and an unreadable block state drops
 * the event (presence is the class whose loss costs a reader nothing). Content events
 * are untouched. Both receipt routes leave a blocked member's read position out, and
 * answer 503 when the block state cannot be read.
 *
 * WHAT IS EXERCISED: the real `publishToThread` with real subscribers over the
 * certification harness's fake, and the real lifecycle router for a DM receipt.
 *
 * Run: node --import tsx/esm --test src/test/telegraphPresenceAcrossBlocks.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { publishToThread, subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import { _setTestClient } from "../lib/http.js";
import lifecycleRouter from "../routes/telegraphLifecycle.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // the actor
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const CARL = "cccccccc-0000-4000-8000-0000000000c3";
const GROUP = "00000000-0000-4000-8000-0000000000e1";
const DM = "00000000-0000-4000-8000-0000000000e2";
const MSG = "11111111-0000-4000-8000-0000000000e2";

type Block = { blocker_id: string; blocked_id: string };

function world(blocks: Block[]): Record<string, unknown[]> {
  const m = (thread_id: string, user_id: string, last_read_at: string | null = null) => ({ thread_id, user_id, role: "member", left_at: null, last_read_at, visible_from_at: null });
  return {
    feature_flags: [],
    blocks,
    message_threads: [
      { id: GROUP, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: ALICE, is_e2ee: false },
      { id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      m(GROUP, ALICE), m(GROUP, BOB), m(GROUP, CARL),
      m(DM, ALICE), m(DM, BOB, "2026-05-02T00:00:00.000Z"),
    ],
    messages: [{ id: MSG, thread_id: DM, sender_id: ALICE, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null, edited_at: null, body: "hi" }],
    profiles: [{ id: ALICE, avatar_url: null, is_private: false }, { id: BOB, avatar_url: null, is_private: false }],
    user_friendships: [],
  };
}

/** Publish one event from ALICE into GROUP and report who received it. */
async function fanout(blocks: Block[], type: TelegraphEvent["type"], opts: FakeDbOptions = {}): Promise<Set<string>> {
  const got = new Set<string>();
  const unsubs = [BOB, CARL].map((u) => subscribe(u, (e) => { if (e.type === type) got.add(u); }));
  try {
    await publishToThread(makeFakeClient(world(blocks), opts) as any, GROUP, { type, payload: { userId: ALICE } }, { excludeUserId: ALICE });
  } finally {
    unsubs.forEach((u) => u());
  }
  return got;
}

describe("P-T6 — presence never crosses a block on the realtime bus", () => {
  it("CONTROL: no block — typing reaches every other member", async () => {
    assert.deepEqual([...(await fanout([], "typing.started"))].sort(), [BOB, CARL].sort());
  });

  for (const [why, blocks] of [
    ["BOB blocked ALICE", [{ blocker_id: BOB, blocked_id: ALICE }]],
    ["ALICE blocked BOB", [{ blocker_id: ALICE, blocked_id: BOB }]],
  ] as Array<[string, Block[]]>) {
    it(`${why}: ALICE's typing, read marker and seen receipt reach CARL and not BOB`, async () => {
      for (const t of ["typing.started", "typing.stopped", "read.updated", "message.seen"] as const) {
        assert.deepEqual([...(await fanout(blocks, t))], [CARL], `${why}, ${t}`);
      }
    });
  }

  it("a message is CONTENT, not presence: the bus does not filter it (the send path decides who may write)", async () => {
    assert.deepEqual([...(await fanout([{ blocker_id: BOB, blocked_id: ALICE }], "message.created"))].sort(), [BOB, CARL].sort());
  });

  it("an unreadable block state DROPS the presence event for everyone; a message still goes", async () => {
    const down: FakeDbOptions = { errors: { blocks: { message: "blocks: timeout" } } };
    assert.deepEqual([...(await fanout([], "typing.started", down))], []);
    assert.deepEqual([...(await fanout([], "message.created", down))].sort(), [BOB, CARL].sort());
  });
});

describe("P-T6 — a DM's Seen does not cross a block", () => {
  let h: RouterHarness;
  before(async () => { h = await startRouter(lifecycleRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });

  async function receipt(blocks: Block[]) {
    _setTestClient(makeFakeClient(world(blocks)), true);
    const r = await call(h.base, "GET", `/threads/${DM}/receipts?messageIds=${MSG}`, ALICE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body as { receipts: Array<{ status: string; seenBy: number; seenByUserIds: string[] }> }).receipts[0]!;
  }

  it("CONTROL: BOB read ALICE's message — SEEN", async () => {
    const r = await receipt([]);
    assert.equal(r.status, "SEEN");
    assert.deepEqual(r.seenByUserIds, [BOB]);
  });

  it("BOB blocked ALICE: his read is not hers to see — the receipt says SENT, over no recipient", async () => {
    const r = await receipt([{ blocker_id: BOB, blocked_id: ALICE }]);
    assert.equal(r.status, "SENT");
    assert.equal(r.seenBy, 0);
    assert.deepEqual(r.seenByUserIds, []);
  });
});
