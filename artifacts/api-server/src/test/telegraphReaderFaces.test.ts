/**
 * census-telegraph T295 — "Mobile clients consume server-built projections
 * instead of independently joining raw tables." §45c left ONE raw read on the
 * conversation surface: `useReaderAvatars` read `profiles.avatar_url` for the
 * ids a receipt named. `GET /threads/:threadId/receipts` now answers those faces
 * WITH the receipt (`readerFaces`), under the rule the app's own read got from
 * `profiles_select` — applied by the server, because the route reads with the
 * service client: no face across a block either way, a private profile's face
 * only to a friend, every failure withholding rather than guessing.
 *
 * WHAT IS EXERCISED: the real lifecycle router over the certification harness.
 * A circle thread; ALICE sent one message; BOB, CARL, DANA and ERIN have read it.
 * CARL is private and not ALICE's friend; ERIN is private and her friend; DANA
 * blocked ALICE.
 *
 * Run: node --import tsx/esm --test src/test/telegraphReaderFaces.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import lifecycleRouter from "../routes/telegraphLifecycle.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer and sender
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003"; // private, not a friend
const DANA = "dddddddd-0000-4000-8000-000000000004"; // blocked ALICE
const ERIN = "eeeeeeee-0000-4000-8000-000000000005"; // private, a friend
const THREAD = "00000000-0000-4000-8000-0000000000f1";
const MSG = "11111111-0000-4000-8000-0000000000f1";

const face = (id: string) => `https://cdn.example/${id.slice(0, 4)}.jpg`;

function seed(extra: { blocks?: Array<{ blocker_id: string; blocked_id: string }> } = {}): Record<string, unknown[]> {
  const member = (user_id: string, last_read_at: string | null) => ({
    thread_id: THREAD, user_id, role: "member", left_at: null, last_read_at, visible_from_at: null,
  });
  return {
    feature_flags: [],
    message_threads: [{ id: THREAD, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: ALICE, is_e2ee: false }],
    message_thread_members: [
      member(ALICE, "2026-05-02T00:00:00.000Z"),
      member(BOB, "2026-05-02T00:00:00.000Z"),
      member(CARL, "2026-05-02T00:00:00.000Z"),
      member(DANA, "2026-05-02T00:00:00.000Z"),
      member(ERIN, "2026-05-02T00:00:00.000Z"),
    ],
    messages: [{ id: MSG, thread_id: THREAD, sender_id: ALICE, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null, edited_at: null, body: "hi" }],
    profiles: [
      { id: ALICE, avatar_url: face(ALICE), is_private: false },
      { id: BOB, avatar_url: face(BOB), is_private: false },
      { id: CARL, avatar_url: face(CARL), is_private: true },
      { id: DANA, avatar_url: face(DANA), is_private: false },
      { id: ERIN, avatar_url: face(ERIN), is_private: true },
    ],
    user_friendships: [{ user_a: ERIN, user_b: ALICE }],
    blocks: extra.blocks ?? [{ blocker_id: DANA, blocked_id: ALICE }],
  };
}

let h: RouterHarness;
before(async () => { h = await startRouter(lifecycleRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

async function receipts(tables: Record<string, unknown[]>, opts?: FakeDbOptions) {
  _setTestClient(makeFakeClient(tables, opts), true);
  const r = await call(h.base, "GET", `/threads/${THREAD}/receipts?messageIds=${MSG}`, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { receipts: Array<{ seenByUserIds: string[] }>; readerFaces: Record<string, string | null>; readerFacesDegraded: boolean };
}

describe("T295 — the receipt answers its readers' faces, under profiles_select's rule", () => {
  it("the receipt still names every reader; the faces follow the rule", async () => {
    const b = await receipts(seed());
    assert.deepEqual([...b.receipts[0]!.seenByUserIds].sort(), [BOB, CARL, DANA, ERIN].sort(), "the receipt itself is unchanged");
    assert.equal(b.readerFaces[BOB], face(BOB), "CONTROL: a public, unblocked reader's face is shown");
    assert.equal(b.readerFaces[ERIN], face(ERIN), "a private reader who is a friend: shown");
    assert.equal(b.readerFaces[CARL], null, "a private reader who is not a friend: withheld");
    assert.equal(b.readerFaces[DANA], null, "a reader who blocked the viewer: withheld");
    assert.equal(b.readerFacesDegraded, false);
  });

  it("the viewer blocked the reader: withheld too (either direction)", async () => {
    const b = await receipts(seed({ blocks: [{ blocker_id: ALICE, blocked_id: BOB }] }));
    assert.equal(b.readerFaces[BOB], null);
    assert.equal(b.readerFaces[DANA], face(DANA), "with no block left on DANA, hers is shown");
  });

  it("an unreadable block read withholds every face and says degraded; the receipt is untouched", async () => {
    const b = await receipts(seed(), { errors: { blocks: { message: "blocks: timeout" } } });
    assert.equal(b.receipts[0]!.seenByUserIds.length, 4);
    for (const id of [BOB, CARL, DANA, ERIN]) assert.equal(b.readerFaces[id], null, id);
    assert.equal(b.readerFacesDegraded, true);
  });

  it("an unreadable friendship read withholds the PRIVATE faces only", async () => {
    const b = await receipts(seed(), { errors: { user_friendships: { message: "friendships: timeout" } } });
    assert.equal(b.readerFaces[ERIN], null);
    assert.equal(b.readerFaces[BOB], face(BOB));
    assert.equal(b.readerFacesDegraded, true);
  });

  it("an unreadable profile read answers NO faces, says degraded, and still answers the receipt", async () => {
    // afterOps: the first profiles read is requireUser's account-state gate; the faces read is the next one.
    const b = await receipts(seed(), { errors: { profiles: { message: "profiles: timeout", afterOps: 1 } } });
    assert.deepEqual(b.readerFaces, {});
    assert.equal(b.readerFacesDegraded, true);
    assert.equal(b.receipts[0]!.seenByUserIds.length, 4);
  });
});
