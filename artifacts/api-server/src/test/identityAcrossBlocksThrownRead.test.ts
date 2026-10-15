/**
 * census-telegraph §94 — a block read that THROWS, or answers something that is
 * not a list of attributable rows, never lets an identity cross a block.
 *
 * WHY THIS SUITE EXISTS. `identityWithheldAcrossBlocks` (services/telegraph/
 * identityAcrossBlocks.ts) states its contract as "could not check is never no
 * block": an unreadable block read withholds EVERY other person's identity, and
 * each caller turns that into withheld names/avatars or a 503. Every suite that
 * proved it used a RETURNED `{ error }`. None ever threw, so the verifier of PR
 * #724 (V-RH, mutant V6) could replace the helper's `catch` with "nobody is
 * blocked" and every suite stayed green. On main the catch is there and the
 * answer is right — but nothing pinned it, and the reader beneath it
 * (lib/exclusionSet.ts `readBlockExclusions`) handled a returned error and let a
 * throw escape, read `data: null` as "nobody", dropped a row without its id, and
 * read a candidate list longer than PostgREST's row cap in one cut `.in()`.
 *
 * WHAT IS EXERCISED: the shared helper directly, then EVERY caller on main, each
 * through its real router over the certification harness, with the `blocks`
 * read THROWING (a torn-down client), REJECTING, or answering a malformed list:
 *
 *   GET /me/threads                          routes/messaging.ts — inbox roster
 *   GET /threads/:id/messages                routes/messaging.ts — senders + quotes
 *   GET /trips/:id/availability              routes/availability.ts — crew list
 *   GET /circles/:id/availability            routes/availability.ts — circle list
 *   GET /threads/:id/receipts                routes/telegraphLifecycle.ts — 503
 *   readerFacesFor                           the receipt chips' faces
 *   GET /threads/:id/read-receipts           server/telegraph/readReceiptsRoute.ts — 503
 *
 * Each has a CONTROL beside it (no fault: the identity IS shown), so a fix that
 * made these pass by withholding everybody always would fail its neighbour.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/identityAcrossBlocksThrownRead.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import availabilityRouter from "../routes/availability.js";
import lifecycleRouter from "../routes/telegraphLifecycle.js";
import readReceiptsRouter from "../server/telegraph/readReceiptsRoute.js";
import { identityWithheldAcrossBlocks, readerFacesFor, IDENTITY_BLOCK_CHUNK } from "../services/telegraph/identityAcrossBlocks.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const BOB_AVATAR = "https://cdn.example/bob-avatar.jpg";

type Fault = "throw" | "reject" | { data: unknown };
const FAULTS: Array<[string, Fault]> = [
  ["THROWS (a torn-down client)", "throw"],
  ["REJECTS (a socket hang-up)", "reject"],
  ["answers data: null with no error", { data: null }],
  ["answers a row with no counter-party", { data: [{ blocked_id: null, blocker_id: null }] }],
];

/**
 * The fake, with every `blocks` read misbehaving in ONE named way. Every other
 * table is the harness's own. A throw is raised synchronously from `.from()`,
 * which is what a torn-down or misconfigured client does.
 */
function withBlocksFault(inner: FakeClient, fault: Fault): FakeClient {
  return {
    ...inner,
    from(t: string) {
      if (t !== "blocks") return inner.from(t);
      if (fault === "throw") throw new TypeError("blocks: the client was torn down before the read was sent");
      const settle = () => fault === "reject"
        ? Promise.reject(new Error("blocks: socket hang up"))
        : Promise.resolve({ data: fault.data, error: null, count: null });
      const chain: any = new Proxy({}, {
        get(_t, p) {
          if (p === "then") return (f: any, r: any) => settle().then(f, r);
          if (p === "catch" || p === "finally") return undefined;
          return () => chain;
        },
      });
      return chain;
    },
  } as FakeClient;
}

function install(state: Record<string, any[]>, fault?: Fault): void {
  const c = makeFakeClient(state);
  _setTestClient(fault ? withBlocksFault(c, fault) : c, true);
}

// ── 1. The shared helper ─────────────────────────────────────────────────────

describe("identityWithheldAcrossBlocks — every failure of the block read is 'unreadable'", () => {
  for (const [why, fault] of FAULTS) {
    it(`a block read that ${why}: unreadable, every other identity withheld, never the viewer's`, async () => {
      const w = await identityWithheldAcrossBlocks(withBlocksFault(makeFakeClient({ blocks: [] }), fault), ALICE, [ALICE, BOB, CARL]);
      assert.equal(w.unreadable, true, `${why} was read as "nobody is blocked"`);
      assert.equal(w.withhold(BOB), true);
      assert.equal(w.withhold(CARL), true);
      assert.equal(w.withhold(ALICE), false, "the viewer's own identity is never withheld from her");
    });
  }

  it("CONTROL: a readable, empty block table withholds nobody", async () => {
    const w = await identityWithheldAcrossBlocks(makeFakeClient({ blocks: [] }), ALICE, [ALICE, BOB, CARL]);
    assert.equal(w.unreadable, false);
    assert.equal(w.withhold(BOB), false);
  });

  it("a roster longer than PostgREST's db-max-rows: every block is seen (each read is far below the cap)", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const sc = makeFakeClient({ blocks: many.map((id) => ({ blocker_id: id, blocked_id: ALICE })) }, { maxRows: 1000 });
    const w = await identityWithheldAcrossBlocks(sc, ALICE, many);
    assert.equal(w.unreadable, false);
    const shown = many.filter((id) => !w.withhold(id));
    assert.equal(shown.length, 0, `${shown.length} people who blocked the viewer kept their identity`);
    assert.ok(IDENTITY_BLOCK_CHUNK < 1000);
  });
});

// ── 2. GET /me/threads and GET /threads/:id/messages ─────────────────────────

const DM = "00000000-0000-4000-8000-00000000000a";
const GROUP = "00000000-0000-4000-8000-00000000000b";
const M_BOB = "11111111-0000-4000-8000-000000000001";
const M_ALICE_REPLY = "11111111-0000-4000-8000-000000000002";
const M_CARL = "11111111-0000-4000-8000-000000000003";
const PROFILES: Record<string, { id: string; handle: string; name: string; avatar_url: string | null; show_name: boolean }> = {
  [ALICE]: { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, show_name: true },
  [BOB]: { id: BOB, handle: "bob", name: "Bob", avatar_url: BOB_AVATAR, show_name: true },
  [CARL]: { id: CARL, handle: "carl", name: "Carl", avatar_url: null, show_name: true },
};

function messagingWorld(): Record<string, any[]> {
  const member = (thread: string, user: string) => ({
    thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
    last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
  });
  const thread = (id: string, type: string, at: string) => ({
    id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: at, last_message_at: at,
  });
  // `profile` models PostgREST's embed, which the harness returns whole (as telegraphIdentityAcrossBlocks does).
  const msg = (id: string, t: string, sender: string, at: string, body: string, replyTo: string | null = null) => ({
    id, thread_id: t, sender_id: sender, body, created_at: at, deleted_at: null, edited_at: null,
    original_language: "en", msg_type: "text", subtype: null, media_url: null, media_type: null,
    media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: replyTo, profile: { ...PROFILES[sender] },
  });
  return {
    feature_flags: [],
    profiles: Object.values(PROFILES).map((p) => ({ ...p })),
    profile_privacy_settings: [ALICE, BOB, CARL].map((user_id) => ({ user_id, show_real_name: true })),
    user_privacy_settings: [],
    blocks: [],
    message_threads: [thread(DM, "direct", "2026-03-11T00:02:00.000Z"), thread(GROUP, "circle", "2026-03-11T00:03:00.000Z")],
    message_thread_members: [member(DM, ALICE), member(DM, BOB), member(GROUP, ALICE), member(GROUP, BOB), member(GROUP, CARL)],
    messages: [
      msg(M_BOB, DM, BOB, "2026-03-11T00:01:00.000Z", "see you at nine"),
      msg(M_ALICE_REPLY, DM, ALICE, "2026-03-11T00:02:00.000Z", "ok!", M_BOB),
      msg(M_CARL, GROUP, CARL, "2026-03-11T00:03:00.000Z", "hello group"),
    ],
    message_translations: [], message_requests: [], message_reactions: [], trips: [], trip_members: [],
  };
}

describe("§94 — GET /me/threads and GET /threads/:id/messages under a failed block read", () => {
  let h: RouterHarness;
  before(async () => { h = await startRouter(messagingRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });
  beforeEach(() => resetFakeIds());

  it("CONTROL: no fault — BOB's handle and avatar are in the inbox and on his message", async () => {
    install(messagingWorld());
    const inbox = await call(h.base, "GET", "/me/threads", ALICE);
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    const bob = (inbox.body.threads as any[]).find((t) => t.id === DM)?.otherMembers?.find((m: any) => m.id === BOB);
    assert.equal(bob?.handle, "bob");
    const thread = await call(h.base, "GET", `/threads/${DM}/messages`, ALICE);
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    const rows = (thread.body.messages ?? thread.body) as any[];
    assert.equal(rows.find((m) => m.id === M_BOB)?.senderAvatarUrl, BOB_AVATAR);
  });

  for (const [why, fault] of FAULTS) {
    it(`a block read that ${why}: the inbox is served and no other member's identity is`, async () => {
      install(messagingWorld(), fault);
      const r = await call(h.base, "GET", "/me/threads", ALICE);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const threads = r.body.threads as any[];
      assert.ok(threads.length > 0, "the conversations themselves are not block-scoped and stay");
      for (const t of threads) for (const m of (t.otherMembers ?? []) as any[]) {
        assert.equal(m.handle, null, `${t.id}/${m.id}: handle crossed an unread block`);
        assert.equal(m.avatarUrl ?? null, null, `${t.id}/${m.id}: avatar crossed an unread block`);
      }
      assert.ok(!JSON.stringify(r.body).includes(BOB_AVATAR));
    });

    it(`a block read that ${why}: the thread is served, every other sender's identity and the quoted name withheld`, async () => {
      install(messagingWorld(), fault);
      const r = await call(h.base, "GET", `/threads/${DM}/messages`, ALICE);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = (r.body.messages ?? r.body) as any[];
      const bob = rows.find((m) => m.id === M_BOB);
      assert.ok(bob, "the message itself is not block-scoped");
      assert.equal(bob.senderHandle, null);
      assert.equal(bob.senderName, null);
      assert.equal(bob.senderAvatarUrl, null);
      assert.equal(rows.find((m) => m.id === M_ALICE_REPLY)?.senderHandle, "alice", "the viewer is never withheld from herself");
      assert.ok(!JSON.stringify(r.body).includes(BOB_AVATAR));
      // The quote is read by its own query; `?limit=1` keeps BOB's message off the page.
      install(messagingWorld(), fault);
      const q = await call(h.base, "GET", `/threads/${DM}/messages?limit=1`, ALICE);
      assert.equal(q.status, 200, JSON.stringify(q.body));
      const reply = ((q.body.messages ?? q.body) as any[]).find((m) => m.id === M_ALICE_REPLY);
      assert.equal(reply?.replyToSenderName ?? null, null, "the quoted sender's name crossed an unread block");
    });
  }
});

// ── 3. GET /trips/:id/availability and GET /circles/:id/availability ─────────

const TRIP = "eeeeeeee-0000-4000-8000-0000000000e5";
const DAY = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

function crewWorld(): Record<string, any[]> {
  const people = [ALICE, BOB, CARL];
  return {
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: ALICE, start_date: DAY, end_date: DAY }],
    trip_members: people.map((u, i) => ({ trip_id: TRIP, user_id: u, role: i === 0 ? "owner" : "member", status: "accepted" })),
    circle_memberships: [BOB, CARL].map((o) => ({ user_id: ALICE, other_id: o })),
    profiles: people.map((u) => ({ id: u, handle: PROFILES[u].handle, name: PROFILES[u].name, avatar_url: `https://cdn.example/${PROFILES[u].handle}.jpg` })),
    profile_privacy_settings: [],
    trip_availability: people.map((u) => ({ trip_id: TRIP, user_id: u, open_days: { [DAY]: ["evening"] } })),
    user_availability: people.map((u) => ({ user_id: u, weekly_days: { mon: ["evening"] }, open_to_meet: true })),
    quick_availability_status: people.map((u) => ({ user_id: u, status: "free_now", expires_at: FUTURE })),
    location_preferences: people.map((u) => ({ user_id: u, location_mode: "city", sharing_paused: false, discovery_visibility: "everyone" })),
    blocks: [],
  };
}

for (const [label, path] of [["trip", `/trips/${TRIP}/availability`], ["circle", `/circles/${ALICE}/availability`]] as const) {
  describe(`§94 — GET ${label} availability under a failed block read`, () => {
    let h: RouterHarness;
    before(async () => { h = await startRouter(availabilityRouter); });
    after(async () => { _setTestClient(null, false); await h.close(); });

    it("CONTROL: no fault — BOB's identity and availability are listed", async () => {
      install(crewWorld());
      const r = await call(h.base, "GET", path, ALICE);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const bob = (r.body.members as any[]).find((m) => m.userId === BOB);
      assert.equal(bob?.handle, "bob");
      assert.equal(bob?.quickStatus?.status, "free_now");
    });

    for (const [why, fault] of FAULTS) {
      it(`a block read that ${why}: every other member is hidden — no identity, no availability`, async () => {
        install(crewWorld(), fault);
        const r = await call(h.base, "GET", path, ALICE);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        for (const id of [BOB, CARL]) {
          const m = (r.body.members as any[]).find((x) => x.userId === id);
          assert.ok(m, `${id} is still listed by id`);
          assert.equal(m.handle, null, `${id}: handle crossed an unread block`);
          assert.equal(m.avatarUrl, null, `${id}: avatar crossed an unread block`);
          assert.equal(m.quickStatus, null, `${id}: availability crossed an unread block`);
        }
        assert.equal((r.body.members as any[]).find((x) => x.userId === ALICE)?.handle, "alice");
        assert.ok(!JSON.stringify(r.body).includes("bob.jpg"));
      });
    }
  });
}

// ── 4. The two receipt routes and the receipt faces ──────────────────────────

const MSG = "11111111-0000-4000-8000-0000000000e2";

function receiptWorld(): Record<string, any[]> {
  const m = (thread_id: string, user_id: string, last_read_at: string | null = null) => ({ thread_id, user_id, role: "member", left_at: null, last_read_at, visible_from_at: null });
  return {
    feature_flags: [],
    blocks: [],
    message_threads: [
      { id: GROUP, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: ALICE, is_e2ee: false },
      { id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    message_thread_members: [
      m(GROUP, ALICE, "2026-05-02T00:00:00.000Z"), m(GROUP, BOB, "2026-05-02T00:00:00.000Z"), m(GROUP, CARL, "2026-05-02T00:00:00.000Z"),
      m(DM, ALICE), m(DM, BOB, "2026-05-02T00:00:00.000Z"),
    ],
    messages: [{ id: MSG, thread_id: DM, sender_id: ALICE, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null, edited_at: null, body: "hi" }],
    profiles: [ALICE, BOB, CARL].map((id) => ({ id, avatar_url: id === BOB ? BOB_AVATAR : null, is_private: false })),
    user_friendships: [],
    trust_restrictions: [], user_privacy_settings: [], rent_buddy_bookings: [], trip_crew_location_sessions: [],
  };
}

describe("§94 — GET /threads/:id/receipts (lifecycle) under a failed block read: 503, never a receipt", () => {
  let h: RouterHarness;
  before(async () => { h = await startRouter(lifecycleRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });

  it("CONTROL: no fault — BOB read ALICE's message, and his face comes with the receipt", async () => {
    install(receiptWorld());
    const r = await call(h.base, "GET", `/threads/${DM}/receipts?messageIds=${MSG}`, ALICE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.receipts[0].seenByUserIds, [BOB]);
    assert.equal(r.body.readerFaces[BOB], BOB_AVATAR);
  });

  for (const [why, fault] of FAULTS) {
    it(`a block read that ${why}: 503 degraded_unavailable, and BOB's read state is not on the wire`, async () => {
      install(receiptWorld(), fault);
      const r = await call(h.base, "GET", `/threads/${DM}/receipts?messageIds=${MSG}`, ALICE);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.ok(!JSON.stringify(r.body).includes(BOB));
    });
  }
});

describe("§94 — readerFacesFor under a failed block read: no other face, and it says degraded", () => {
  it("CONTROL: no fault — BOB's face is answered and nothing is degraded", async () => {
    const f = await readerFacesFor(makeFakeClient(receiptWorld()), ALICE, [ALICE, BOB]);
    assert.equal(f.faces[BOB], BOB_AVATAR);
    assert.equal(f.degraded, false);
  });

  for (const [why, fault] of FAULTS) {
    it(`a block read that ${why}: BOB's face is withheld and the answer is degraded`, async () => {
      const f = await readerFacesFor(withBlocksFault(makeFakeClient(receiptWorld()), fault), ALICE, [ALICE, BOB]);
      assert.equal(f.faces[BOB] ?? null, null, "a face crossed an unread block");
      assert.equal(f.degraded, true);
    });
  }
});

describe("§94 — GET /threads/:id/read-receipts under a failed block read: 503, never a read position", () => {
  let h: RouterHarness;
  before(async () => { h = await startRouter(readReceiptsRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });

  it("CONTROL: no fault — every member's read position is listed in the group", async () => {
    install(receiptWorld());
    const r = await call(h.base, "GET", `/threads/${GROUP}/read-receipts`, ALICE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body.receipts as any[]).map((x) => x.userId).sort(), [ALICE, BOB, CARL].sort());
  });

  for (const [why, fault] of FAULTS) {
    it(`a block read that ${why}: 503 degraded_unavailable, and no member's read position is on the wire`, async () => {
      install(receiptWorld(), fault);
      const r = await call(h.base, "GET", `/threads/${GROUP}/read-receipts`, ALICE);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.ok(!JSON.stringify(r.body).includes(BOB));
    });
  }
});
