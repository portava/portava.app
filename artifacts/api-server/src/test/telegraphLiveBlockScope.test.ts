/**
 * census-telegraph §75 — what LIVE delivery does across a block in a GROUP thread
 * (the follow-up §73 asked for: §73 proved replays only).
 *
 * The live bus (`publishToThread`, which the outbox drainer also uses) sorts every
 * event into one of three answers, each pinned here with the real bus, real
 * subscribers and the certification harness's fake:
 *
 *   PRESENCE (typing, read, seen, delivered)  never crosses a block, either direction;
 *                                             unreadable blocks drop it (P-T6, §51).
 *   LOCATION SHARE (location.started/expired) never crosses a block with the SHARE
 *                                             OWNER, either direction; unreadable blocks
 *                                             drop it (§75 — this was the leak: both went
 *                                             to every member, the blocked one included).
 *   CONTENT (message.created and the rest)    is delivered to every member, the blocked
 *                                             one included — parity with the thread page,
 *                                             which shows a blocked person's group message
 *                                             with the identity withheld (P-T5). Changing
 *                                             that is a page decision, not a bus one.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLiveBlockScope.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publishToThread, subscribe, emitLocationStarted, emitLocationExpired, type TelegraphEvent } from "../lib/telegraphEvents.js";
import { makeFakeClient, type FakeDbOptions } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // sends / shares
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";   // in a block with ALICE
const CARL = "cccccccc-0000-4000-8000-0000000000c3";  // nobody's blocked
const GROUP = "00000000-0000-4000-8000-0000000000e1";
type Block = { blocker_id: string; blocked_id: string };

function world(blocks: Block[]): Record<string, unknown[]> {
  const m = (user_id: string) => ({ thread_id: GROUP, user_id, role: "member", left_at: null, last_read_at: null, visible_from_at: null });
  return {
    feature_flags: [], blocks,
    message_threads: [{ id: GROUP, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: ALICE, is_e2ee: false }],
    message_thread_members: [m(ALICE), m(BOB), m(CARL)],
    messages: [], profiles: [], user_friendships: [],
  };
}

async function receivers(type: TelegraphEvent["type"], send: (sc: any) => Promise<void>): Promise<string[]> {
  const got = new Set<string>();
  const unsubs = [ALICE, BOB, CARL].map((u) => subscribe(u, (e) => { if (e.type === type) got.add(u); }));
  try { await send(null); } finally { unsubs.forEach((u) => u()); }
  return [...got].sort();
}

const share = { shareId: "11111111-0000-4000-8000-000000000001", ownerUserId: ALICE, precision: "area", purpose: "meetup", startedAt: "2026-10-10T12:00:00.000Z", expiresAt: "2026-10-10T13:00:00.000Z" };
const started = (blocks: Block[], opts: FakeDbOptions = {}) =>
  receivers("location.started" as TelegraphEvent["type"], async () => { await emitLocationStarted(makeFakeClient(world(blocks), opts) as any, GROUP, share); });
const expired = (blocks: Block[], opts: FakeDbOptions = {}) =>
  receivers("location.expired" as TelegraphEvent["type"], async () => { await emitLocationExpired(makeFakeClient(world(blocks), opts) as any, GROUP, { shareId: share.shareId, ownerUserId: ALICE, expiredAt: share.expiresAt, sweptAt: share.expiresAt }); });

const DIRECTIONS: Array<[string, Block[]]> = [
  ["BOB blocked ALICE", [{ blocker_id: BOB, blocked_id: ALICE }]],
  ["ALICE blocked BOB", [{ blocker_id: ALICE, blocked_id: BOB }]],
];

describe("§75 LOCATION SHARE events never cross a block with the owner", () => {
  it("CONTROL: no block — every member hears the share start (the owner included: no actor is excluded)", async () => {
    assert.deepEqual(await started([]), [ALICE, BOB, CARL].sort());
  });
  for (const [why, blocks] of DIRECTIONS) {
    it(`${why}: location.started and location.expired reach CARL and the owner, never BOB`, async () => {
      assert.deepEqual(await started(blocks), [ALICE, CARL].sort());
      assert.deepEqual(await expired(blocks), [ALICE, CARL].sort());
    });
  }
  it("a block between two OTHER members does not hide the owner's share from either", async () => {
    assert.deepEqual(await started([{ blocker_id: BOB, blocked_id: CARL }]), [ALICE, BOB, CARL].sort());
  });
  it("unreadable block state DROPS the share event for everyone (fail closed)", async () => {
    assert.deepEqual(await started([], { errors: { blocks: { message: "blocks: timeout" } } }), []);
  });
});

describe("§75 the rest of the live bus across a block (pinned)", () => {
  for (const [why, blocks] of DIRECTIONS) {
    it(`${why}: presence-class events never reach BOB`, async () => {
      for (const t of ["typing.started", "read.updated", "message.seen", "message.delivered"] as const) {
        const got = await receivers(t, async () => { await publishToThread(makeFakeClient(world(blocks)) as any, GROUP, { type: t, payload: { userId: ALICE } }, { excludeUserId: ALICE }); });
        assert.deepEqual(got, [CARL], `${why}, ${t}`);
      }
    });
    it(`${why}: message.created IS delivered to BOB — content parity with the page (P-T5), ids only`, async () => {
      const seen: TelegraphEvent[] = [];
      const unsub = subscribe(BOB, (e) => { if (e.type === "message.created") seen.push(e); });
      try {
        await publishToThread(makeFakeClient(world(blocks)) as any, GROUP, { type: "message.created", payload: { messageId: "m-1", senderId: ALICE, msgType: "text" } }, { excludeUserId: ALICE });
      } finally { unsub(); }
      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0]!.payload ?? {}).sort(), ["messageId", "msgType", "senderId"]);
    });
  }
});
