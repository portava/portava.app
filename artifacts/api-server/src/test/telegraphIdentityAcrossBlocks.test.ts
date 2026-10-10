/**
 * census-telegraph §45d.3 — "Recorded, not fixed here — the same identity reaches
 * the same blocked viewer elsewhere." Fixed here.
 *
 * The conversation header withholds the other person's handle, name and avatar
 * across a block in either direction (re-verification 4). `GET /me/threads` and
 * `GET /threads/:threadId/messages` did not: both build identities with the
 * service client, which bypasses `profiles_select`, so inside the very DM whose
 * header hid the blocker, the inbox row and every message row still carried
 * their handle and current avatar — and a reply quoting them, their name.
 *
 * WHAT IS EXERCISED: the real messaging router over the certification harness.
 * A DM between ALICE (the viewer) and BOB, a group thread with BOB and CARL, a
 * message from each, and a reply by ALICE quoting BOB. Each direction of a
 * block, an unreadable block read (both halves), and the controls.
 *
 * Run: node --import tsx/esm --test src/test/telegraphIdentityAcrossBlocks.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import { identityWithheldAcrossBlocks, IDENTITY_BLOCK_CHUNK } from "../services/telegraph/identityAcrossBlocks.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type InjectedError, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const DM = "00000000-0000-4000-8000-00000000000a";
const GROUP = "00000000-0000-4000-8000-00000000000b";
const M_BOB = "11111111-0000-4000-8000-000000000001";
const M_ALICE_REPLY = "11111111-0000-4000-8000-000000000002";
const M_CARL = "11111111-0000-4000-8000-000000000003";
const BOB_AVATAR = "https://cdn.example/bob-new-avatar.jpg";

type Block = { blocker_id: string; blocked_id: string };

const PROFILES: Record<string, { id: string; handle: string; name: string; avatar_url: string | null; show_name: boolean }> = {
  [ALICE]: { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, show_name: true },
  [BOB]: { id: BOB, handle: "bob", name: "Bob", avatar_url: BOB_AVATAR, show_name: true },
  [CARL]: { id: CARL, handle: "carl", name: "Carl", avatar_url: null, show_name: true },
};

// `profile` on a message row models PostgREST's embed (`profile:profiles!messages_sender_id_fkey(…)`),
// which the harness's fake does not resolve: it returns the stored row whole.
const msg = (id: string, thread: string, sender: string, at: string, body: string, replyTo: string | null = null) => ({
  id, thread_id: thread, sender_id: sender, body, created_at: at, deleted_at: null, edited_at: null,
  original_language: "en", msg_type: "text", subtype: null, media_url: null, media_type: null,
  media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: replyTo, profile: { ...PROFILES[sender] },
});

function seed(blocks: Block[] = []): Record<string, any[]> {
  const member = (thread: string, user: string) => ({
    thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
    last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
  });
  const thread = (id: string, type: string, at: string) => ({
    id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: at, last_message_at: at,
  });
  return {
    feature_flags: [],
    profiles: Object.values(PROFILES).map((p) => ({ ...p })),
    // Every name is opted in, so a withheld name is the block's doing, not the display-name rule's.
    profile_privacy_settings: [ALICE, BOB, CARL].map((user_id) => ({ user_id, show_real_name: true })),
    user_privacy_settings: [],
    blocks,
    message_threads: [thread(DM, "direct", "2026-03-11T00:02:00.000Z"), thread(GROUP, "circle", "2026-03-11T00:03:00.000Z")],
    message_thread_members: [member(DM, ALICE), member(DM, BOB), member(GROUP, ALICE), member(GROUP, BOB), member(GROUP, CARL)],
    messages: [
      msg(M_BOB, DM, BOB, "2026-03-11T00:01:00.000Z", "see you at nine"),
      msg(M_ALICE_REPLY, DM, ALICE, "2026-03-11T00:02:00.000Z", "ok!", M_BOB),
      msg(M_CARL, GROUP, CARL, "2026-03-11T00:03:00.000Z", "hello group"),
    ],
    message_translations: [],
    message_requests: [],
    message_reactions: [],
    trips: [],
    trip_members: [],
  };
}

const BLOCKS_DOWN: InjectedError = { message: "blocks: permission denied", code: "42501" };

let harness: RouterHarness;
function use(state: Record<string, any[]>, errors?: Record<string, InjectedError>) {
  _setTestClient(makeFakeClient(state, errors ? { errors } : undefined), true);
}
before(async () => { harness = await startRouter(messagingRouter); });
after(async () => { _setTestClient(null, false); await harness.close(); });
beforeEach(() => resetFakeIds());

async function inbox(): Promise<{ members: (thread: string) => any[]; wire: string }> {
  const r = await call(harness.base, "GET", "/me/threads", ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const threads = r.body.threads as any[];
  return { members: (t) => (threads.find((x) => x.id === t)?.otherMembers ?? []) as any[], wire: JSON.stringify(r.body) };
}

async function thread(t: string, query = ""): Promise<{ byId: (id: string) => any; wire: string }> {
  const r = await call(harness.base, "GET", `/threads/${t}/messages${query}`, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = (r.body.messages ?? r.body) as any[];
  return { byId: (id) => rows.find((m) => m.id === id), wire: JSON.stringify(r.body) };
}

const BLOCKED_EITHER_WAY: Array<[string, Block[]]> = [
  ["BOB blocked ALICE", [{ blocker_id: BOB, blocked_id: ALICE }]],
  ["ALICE blocked BOB", [{ blocker_id: ALICE, blocked_id: BOB }]],
];

describe("§45d.3 — GET /me/threads: no member identity across a block", () => {
  it("CONTROL: no block — BOB's handle and avatar are shown (the case is live)", async () => {
    use(seed());
    const { members } = await inbox();
    const bob = members(DM).find((m) => m.id === BOB);
    assert.ok(bob, "BOB is listed in the DM");
    assert.equal(bob.handle, "bob");
    assert.equal(bob.avatarUrl, BOB_AVATAR);
  });

  for (const [why, blocks] of BLOCKED_EITHER_WAY) {
    it(`${why}: BOB stays listed by id, with no handle, name or avatar — in every thread`, async () => {
      use(seed(blocks));
      const { members, wire } = await inbox();
      for (const t of [DM, GROUP]) {
        const bob = members(t).find((m) => m.id === BOB);
        assert.ok(bob, `${t}: BOB's id was dropped (the id stays; the identity does not)`);
        assert.equal(bob.handle, null, `${t}: handle crossed the block`);
        assert.equal(bob.name, null, `${t}: name crossed the block`);
        assert.equal(bob.avatarUrl, null, `${t}: avatar crossed the block`);
      }
      assert.ok(!wire.includes(BOB_AVATAR), "BOB's avatar URL is on the wire");
      // Scoped: CARL, who is in no block, keeps his identity in the same response.
      assert.equal(members(GROUP).find((m) => m.id === CARL)?.handle, "carl");
    });
  }

  it("an unreadable block read: the inbox is still served, and nobody's identity is (could not check ≠ no block)", async () => {
    use(seed(), { blocks: BLOCKS_DOWN });
    const { members, wire } = await inbox();
    assert.ok(members(DM).length > 0, "the conversations themselves are not block-scoped and stay");
    for (const t of [DM, GROUP]) for (const m of members(t)) assert.equal(m.handle, null, `${t}/${m.id}`);
    assert.ok(!wire.includes(BOB_AVATAR));
  });
});

describe("§45d.3 — GET /threads/:threadId/messages: no sender identity across a block", () => {
  it("CONTROL: no block — BOB's row carries his handle, name and avatar", async () => {
    use(seed());
    const { byId } = await thread(DM);
    assert.equal(byId(M_BOB).senderHandle, "bob");
    assert.equal(byId(M_BOB).senderName, "Bob");
    assert.equal(byId(M_BOB).senderAvatarUrl, BOB_AVATAR);
  });

  // The quote is read by its own query. `?limit=1` keeps BOB's quoted message OFF the page, so
  // the quote path is exercised on its own and not through the page's already-withheld row (the
  // harness hands back stored rows by reference).
  it("CONTROL: no block — ALICE's reply quotes BOB by name", async () => {
    use(seed());
    const { byId } = await thread(DM, "?limit=1");
    assert.equal(byId(M_BOB), undefined, "the quoted message must be off the page for this case to test the quote read");
    assert.equal(byId(M_ALICE_REPLY).replyToSenderName, "Bob");
  });

  for (const [why, blocks] of BLOCKED_EITHER_WAY) {
    it(`${why}: the quote of BOB's message does not name him (neither name nor @handle)`, async () => {
      use(seed(blocks));
      const { byId } = await thread(DM, "?limit=1");
      assert.equal(byId(M_BOB), undefined);
      assert.equal(byId(M_ALICE_REPLY).replyToSenderName, null);
      assert.ok(byId(M_ALICE_REPLY).replyToBody, "the quoted text itself is not block-scoped");
    });
  }

  for (const [why, blocks] of BLOCKED_EITHER_WAY) {
    it(`${why}: BOB's rows keep senderId but lose handle, name and avatar; the quote loses his name`, async () => {
      use(seed(blocks));
      const { byId, wire } = await thread(DM);
      const row = byId(M_BOB);
      assert.equal(row.senderId, BOB);
      assert.equal(row.senderHandle, null, "handle crossed the block");
      assert.equal(row.senderName, null, "name crossed the block");
      assert.equal(row.senderAvatarUrl, null, "avatar crossed the block");
      assert.equal(byId(M_ALICE_REPLY).replyToSenderName, null, "the quoted sender's name crossed the block");
      assert.ok(!wire.includes(BOB_AVATAR), "BOB's avatar URL is on the wire");
      // The viewer's own identity is never withheld from her.
      assert.equal(byId(M_ALICE_REPLY).senderHandle, "alice");
    });
  }

  it("an unreadable block read withholds every other sender's identity and still serves the thread", async () => {
    use(seed(), { blocks: BLOCKS_DOWN });
    const { byId, wire } = await thread(DM);
    assert.equal(byId(M_BOB).body ?? byId(M_BOB).displayBody, "see you at nine", "the messages are not block-scoped");
    assert.equal(byId(M_BOB).senderHandle, null);
    assert.equal(byId(M_ALICE_REPLY).replyToSenderName, null);
    assert.equal(byId(M_ALICE_REPLY).senderHandle, "alice");
    assert.ok(!wire.includes(BOB_AVATAR));
  });
});

describe("identityWithheldAcrossBlocks — the shared reader", () => {
  it("asks in chunks, and one unreadable chunk makes the whole answer unreadable", async () => {
    const ids = Array.from({ length: IDENTITY_BLOCK_CHUNK + 5 }, (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const ok = await identityWithheldAcrossBlocks(makeFakeClient({ blocks: [{ blocker_id: ids[IDENTITY_BLOCK_CHUNK + 1], blocked_id: ALICE }] }), ALICE, ids);
    assert.equal(ok.unreadable, false);
    assert.equal(ok.withhold(ids[IDENTITY_BLOCK_CHUNK + 1]), true, "a block in the SECOND chunk was missed");
    assert.equal(ok.withhold(ids[0]), false);
    assert.equal(ok.withhold(ALICE), false, "the viewer's own identity is never withheld");
    const down = await identityWithheldAcrossBlocks(
      makeFakeClient({ blocks: [] }, { errors: { blocks: { ...BLOCKS_DOWN, afterOps: 2 } } }), ALICE, ids);
    assert.equal(down.unreadable, true, "a failure in the second chunk was ignored");
    assert.equal(down.withhold(ids[0]), true);
  });
});
