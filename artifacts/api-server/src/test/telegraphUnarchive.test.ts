/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 *   POST /api/threads/:threadId/unarchive   (routes/telegraphArchive.ts,
 *                                            services/telegraph/threadArchive.ts)
 *
 * Archive in Telegraph is per member (message_thread_members.archived_at), and
 * a help request is not routed to a member who archived the conversation
 * (services/telegraph/safetyNotifications.ts, commit 6ee12e36a). Until this
 * route nothing could clear archived_at, so an archived member could never be
 * routed a help request in that conversation again.
 *
 * WHAT WOULD TURN THIS RED
 *   - the write reaching another member's row, or another conversation's;
 *   - a member who LEFT being unarchived, or answered differently from a
 *     non-member (an unarchive must not resurrect a conversation they left);
 *   - an unreadable membership answered "not a member", or written through;
 *   - a failed write answered 200, or a read-back that disagrees accepted;
 *   - a second unarchive writing again (not idempotent);
 *   - a block changing the answer (the response would tell the caller they are
 *     blocked), the block row being touched, or a send across the block being
 *     admitted after the unarchive;
 *   - a Rent-a-Buddy booking, or its post-completion call rule, changed by an
 *     unarchive;
 *   - after the unarchive, a NEW help request NOT reaching the member — through
 *     the real typed door, the real producer and the real NotificationService —
 *     or the request that arrived while they had it archived reaching them late.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphUnarchive.test.ts
 * (the route cases listen on loopback)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { _setTestTranslationProvider, type TranslationProvider } from "../lib/translation.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import { _resetSafetyRedriveMemo } from "../services/telegraph/safetyNotifications.js";
import archiveRouter from "../routes/telegraphArchive.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "75000000-0000-4000-8000-000000000001"; // the caller
const BOB = "75000000-0000-4000-8000-000000000002";   // the other member, also archived
const DANA = "75000000-0000-4000-8000-000000000004";  // blocked Alice
const ERIN = "75000000-0000-4000-8000-000000000005";  // a conversation Alice is not in
const DM = "75000000-0000-4000-8000-0000000000d1";           // Alice ↔ Bob, archived for both
const DM_BLOCKED = "75000000-0000-4000-8000-0000000000d2";   // Alice ↔ Dana, Dana blocked Alice; archived for both
const LEFT = "75000000-0000-4000-8000-0000000000d3";         // Alice archived it, then LEFT it
const BOOKING_THREAD = "75000000-0000-4000-8000-0000000000d4"; // a completed Rent-a-Buddy booking's thread
const STRANGER = "75000000-0000-4000-8000-0000000000d5";     // Bob ↔ Erin
const BOOKING = "75000000-0000-4000-8000-0000000000b1";
const BUDDY_PROFILE = "75000000-0000-4000-8000-0000000000b2";
const ARCHIVED_AT = "2026-10-16T09:00:00.000Z";

const SAME_LANGUAGE: TranslationProvider = {
  async detectLanguage() { return { language: "en", confidence: "high" }; },
  async translateText(text: string) { return { translatedText: text, provider: "stub", providerVersion: "stub-1" }; },
};

type Row = Record<string, any>;
const member = (thread_id: string, user_id: string, extra: Row = {}): Row => ({
  thread_id, user_id, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
  muted_at: null, archived_at: ARCHIVED_AT, visible_from_at: null, ...extra,
});
const thread = (id: string, thread_type: string): Row => ({
  id, thread_type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z",
});

function seed(over: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  return {
    feature_flags: [],
    blocks: [{ blocker_id: DANA, blocked_id: ALICE }],
    profiles: [ALICE, BOB, DANA, ERIN].map((id, i) => ({ id, handle: ["alice", "bob", "dana", "erin"][i], name: null, account_status: null, auto_translate_messages: true, preferred_language: "en" })),
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [], trust_profiles: [], trust_restrictions: [],
    message_requests: [], user_privacy_settings: [], profile_privacy_settings: [], reports: [], message_translations: [], telegraph_events: [],
    message_threads: [thread(DM, "direct"), thread(DM_BLOCKED, "direct"), thread(LEFT, "direct"), thread(BOOKING_THREAD, "rent_buddy_booking"), thread(STRANGER, "direct")],
    message_thread_members: [
      member(DM, ALICE), member(DM, BOB),
      member(DM_BLOCKED, ALICE), member(DM_BLOCKED, DANA),
      member(LEFT, ALICE, { left_at: "2026-10-16T10:00:00.000Z" }), member(LEFT, BOB, { archived_at: null }),
      member(BOOKING_THREAD, ALICE), member(BOOKING_THREAD, BOB),
      member(STRANGER, BOB), member(STRANGER, ERIN),
    ],
    // Completed, and the pair did NOT both choose "stay connected" — so completion archived it for both.
    rent_buddy_bookings: [{ id: BOOKING, traveler_id: ALICE, buddy_id: BUDDY_PROFILE, status: "completed", telegraph_thread_id: BOOKING_THREAD, stay_connected_traveler: true, stay_connected_buddy: false }],
    rent_buddy_profiles: [{ id: BUDDY_PROFILE, user_id: BOB }],
    messages: [], trips: [], trip_members: [], trip_crew_location_sessions: [], meetup_polls: [], saved_messages: [],
    notifications: [], tags: [], user_tag_settings: [], location_preferences: [],
    ...over,
  };
}

const archivedAtOf = (c: FakeClient, threadId: string, userId: string) =>
  (c._store.message_thread_members ?? []).find((m: Row) => m.thread_id === threadId && m.user_id === userId)?.archived_at;
const writesTo = (c: FakeClient, table: string) =>
  [...c._observed.updates, ...c._observed.inserts, ...c._observed.upserts, ...c._observed.deletes].filter((w) => w.table === table).length;

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(archiveRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => { _setTestClient(null, false); _setTestTranslationProvider(null); await harness.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); _clearSendTierCache(); _setTestTranslationProvider(SAME_LANGUAGE); });

function use(over: Record<string, unknown[]> = {}, opts?: FakeDbOptions): FakeClient {
  const c = makeFakeClient(seed(over) as Record<string, any[]>, opts);
  _setTestClient(c, true);
  return c;
}
const unarchive = (threadId: string, as = ALICE) => call(harness.base, "POST", `/threads/${threadId}/unarchive`, as);

describe("POST /threads/:threadId/unarchive — the caller's own membership, nothing else", () => {
  it("clears the caller's archived_at and answers the read-back", async () => {
    const c = use();
    const r = await unarchive(DM);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, threadId: DM, archivedAt: null, changed: true });
    assert.equal(archivedAtOf(c, DM, ALICE), null);
  });

  it("does not touch the other member's archive, another conversation, the thread or the booking", async () => {
    const c = use();
    const threadsBefore = JSON.stringify(c._store.message_threads);
    const bookingsBefore = JSON.stringify(c._store.rent_buddy_bookings);
    await unarchive(DM);
    assert.equal(archivedAtOf(c, DM, BOB), ARCHIVED_AT, "Bob's own archive is his");
    for (const [t, u] of [[DM_BLOCKED, ALICE], [BOOKING_THREAD, ALICE], [STRANGER, BOB], [STRANGER, ERIN]] as const) {
      assert.equal(archivedAtOf(c, t, u), ARCHIVED_AT, `${t}/${u} untouched`);
    }
    assert.equal(JSON.stringify(c._store.message_threads), threadsBefore, "message_threads.status is not an unarchive's to write");
    assert.equal(JSON.stringify(c._store.rent_buddy_bookings), bookingsBefore);
    const writes = c._observed.updates.filter((w) => w.table === "message_thread_members");
    assert.deepEqual(writes.map((w) => w.patch), [{ archived_at: null }], "one write, of archived_at only");
  });

  it("is idempotent: a second unarchive answers ok, unchanged, and writes nothing", async () => {
    const c = use();
    assert.equal((await unarchive(DM)).status, 200);
    const r = await unarchive(DM);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, threadId: DM, archivedAt: null, changed: false });
    assert.equal(writesTo(c, "message_thread_members"), 1);
  });

  it("a conversation that was never archived: ok, unchanged, nothing written", async () => {
    const c = use({ message_thread_members: [member(DM, ALICE, { archived_at: null }), member(DM, BOB)] });
    const r = await unarchive(DM);
    assert.deepEqual(r.body, { ok: true, threadId: DM, archivedAt: null, changed: false });
    assert.equal(writesTo(c, "message_thread_members"), 0);
  });

  it("tells the caller's own other devices (thread.updated), only when something changed, and nobody else", async () => {
    use();
    const mine: TelegraphEvent[] = [];
    const bobs: TelegraphEvent[] = [];
    const u1 = subscribe(ALICE, (e) => mine.push(e));
    const u2 = subscribe(BOB, (e) => bobs.push(e));
    try {
      await unarchive(DM);
      await unarchive(DM);
    } finally { u1(); u2(); }
    assert.deepEqual(mine.map((e) => [e.type, (e.payload as Row).threadId]), [["thread.updated", DM]]);
    assert.equal(bobs.length, 0, "an unarchive is not news to the other members");
  });
});

describe("refusals: who may not unarchive, and an unknown is never a refusal or a write", () => {
  it("a non-member: 403 'Not a member of this thread', nothing written", async () => {
    const c = use();
    const r = await unarchive(STRANGER);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: "forbidden", message: "Not a member of this thread" });
    assert.equal(writesTo(c, "message_thread_members"), 0);
  });

  it("a member who LEFT: refused exactly as a non-member; the left, archived row is not resurrected", async () => {
    const c = use();
    const left = await unarchive(LEFT);
    const stranger = await unarchive(STRANGER);
    assert.equal(left.status, 403);
    assert.deepEqual(left.body, stranger.body);
    const row = (c._store.message_thread_members ?? []).find((m: Row) => m.thread_id === LEFT && m.user_id === ALICE);
    assert.equal(row.archived_at, ARCHIVED_AT);
    assert.equal(row.left_at, "2026-10-16T10:00:00.000Z");
    assert.equal(writesTo(c, "message_thread_members"), 0);
  });

  it("a member who leaves between the read and the write is refused, not told 'unarchived'", async () => {
    const c = use();
    // Alice leaves in the instant between the membership read and the write.
    const realFrom = c.from.bind(c);
    (c as any).from = (table: string) => {
      const q = realFrom(table);
      if (table !== "message_thread_members") return q;
      const update = q.update;
      q.update = (patch: Row) => { c._store.message_thread_members!.find((m: Row) => m.thread_id === DM && m.user_id === ALICE)!.left_at = "2026-10-17T00:00:00.000Z"; return update(patch); };
      return q;
    };
    const r = await unarchive(DM);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(archivedAtOf(c, DM, ALICE), ARCHIVED_AT);
  });

  it("an UNREADABLE membership is a 503 — never 'not a member', never a write", async () => {
    const c = use({}, { errors: { message_thread_members: { message: "permission denied", code: "42501", ops: ["select"] } } });
    const r = await unarchive(DM);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(writesTo(c, "message_thread_members"), 0);
    assert.equal(archivedAtOf(c, DM, ALICE), ARCHIVED_AT);
  });

  it("a FAILED write is a 500, not 'unarchived'", async () => {
    const c = use({}, { errors: { message_thread_members: { message: "deadlock", code: "40P01", ops: ["update"] } } });
    const r = await unarchive(DM);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
    assert.equal(archivedAtOf(c, DM, ALICE), ARCHIVED_AT);
  });

  it("a banned account is refused by the account-state gate (requireUser's), before anything is written", async () => {
    // The gate reads profiles with its user_account_states embedded; this fake returns the row as stored.
    const c = use({ profiles: [{ id: ALICE, handle: "alice", name: null, account_status: null, user_account_states: [{ state: "banned", expires_at: null }] }] });
    const r = await unarchive(DM);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "account_banned");
    assert.equal(writesTo(c, "message_thread_members"), 0);
    assert.equal(archivedAtOf(c, DM, ALICE), ARCHIVED_AT);
  });

  it("a malformed id is a 400; no token is a 401", async () => {
    use();
    assert.equal((await unarchive("not-a-uuid")).status, 400);
    const r = await fetch(`${harness.base}/threads/${DM}/unarchive`, { method: "POST" });
    assert.equal(r.status, 401);
  });
});

describe("a block: not told, not undone", () => {
  it("unarchive answers across a block exactly as without one, and the block row is untouched", async () => {
    const c = use();
    const blocksBefore = JSON.stringify(c._store.blocks);
    const across = await unarchive(DM_BLOCKED);
    const plain = await unarchive(DM);
    assert.equal(across.status, 200);
    assert.deepEqual({ ...across.body, threadId: null }, { ...plain.body, threadId: null }, "any difference would answer 'did this person block me?'");
    assert.equal(JSON.stringify(c._store.blocks), blocksBefore);
    assert.equal(writesTo(c, "blocks"), 0);
  });

  it("after the unarchive a send across the block is still refused (CONTROL: the unblocked DM sends)", async () => {
    const c = use();
    await unarchive(DM_BLOCKED);
    await unarchive(DM);
    const control = await call(harness.base, "POST", `/threads/${DM}/messages`, ALICE, { body: "hello" });
    assert.equal(control.status, 201, `control send failed — the fixture cannot prove the refusal: ${JSON.stringify(control.body)}`);
    const across = await call(harness.base, "POST", `/threads/${DM_BLOCKED}/messages`, ALICE, { body: "hello" });
    assert.equal(across.status, 403, JSON.stringify(across.body));
    assert.deepEqual(across.body, { error: "forbidden", message: "You cannot message this user" }, "the send path's own block refusal");
    assert.equal((c._store.messages ?? []).filter((m: Row) => m.thread_id === DM_BLOCKED).length, 0);
  });
});

describe("Rent-a-Buddy: an unarchive reopens one member's VIEW, not the booking's post-completion rules", () => {
  it("the traveller unarchives a completed booking's thread: only her row; the buddy stays archived; the booking is unchanged", async () => {
    const c = use();
    const before = JSON.stringify(c._store.rent_buddy_bookings);
    const r = await unarchive(BOOKING_THREAD);
    assert.equal(r.status, 200);
    assert.equal(archivedAtOf(c, BOOKING_THREAD, ALICE), null);
    assert.equal(archivedAtOf(c, BOOKING_THREAD, BOB), ARCHIVED_AT);
    assert.equal(JSON.stringify(c._store.rent_buddy_bookings), before);
  });

  it("calling stays refused after it: a completed booking is callable only when BOTH chose stay-connected (isRabBookingCallEligible)", async () => {
    const c = use();
    const beforeCap = await resolveConversationCapabilities(c as any, { viewerId: ALICE, conversationId: BOOKING_THREAD });
    await unarchive(BOOKING_THREAD);
    const afterCap = await resolveConversationCapabilities(c as any, { viewerId: ALICE, conversationId: BOOKING_THREAD });
    assert.equal(beforeCap.capabilities.canCall, false);
    assert.equal(afterCap.capabilities.canCall, false);
    assert.equal(afterCap.reasons.canCall, "TELEGRAPH_POLICY_BOOKING_NOT_ACTIVE");
    // CONTROL: the same fixture with BOTH opted in is callable, so the refusal above is the booking rule.
    const both = makeFakeClient(seed({ rent_buddy_bookings: [{ id: BOOKING, traveler_id: ALICE, buddy_id: BUDDY_PROFILE, status: "completed", telegraph_thread_id: BOOKING_THREAD, stay_connected_traveler: true, stay_connected_buddy: true }] }) as Record<string, any[]>);
    assert.equal((await resolveConversationCapabilities(both as any, { viewerId: ALICE, conversationId: BOOKING_THREAD })).capabilities.canCall, true);
  });
});

// ── the owner ruling end to end: a help request after unarchive ─────────────

describe("after an unarchive, a NEW help request routes to that member (real typed door → producer → NotificationService)", () => {
  const SOS_THREAD = "75000000-0000-4000-8000-0000000000e1";
  let door: RouterHarness;
  before(async () => {
    const all = express.Router();
    all.use(commandRouter); // first, exactly as routes/index.ts mounts it
    all.use(telegraphKindsRouter);
    all.use(archiveRouter);
    door = await startRouter(all);
  });
  after(async () => { await door.close(); });
  beforeEach(() => { _resetSafetyRedriveMemo(); });

  function sosWorld(): FakeClient {
    const crew = (id: string) => ({ ...thread(id, "trip"), title: "Crew" });
    const c = makeFakeClient(seed({
      message_threads: [crew(SOS_THREAD)],
      // Bob ARCHIVED it; Dana did not (she is not blocked here: this world has no blocks).
      message_thread_members: [member(SOS_THREAD, ALICE, { archived_at: null }), member(SOS_THREAD, BOB), member(SOS_THREAD, DANA, { archived_at: null })],
      blocks: [],
    }) as Record<string, any[]>, {
      // The dedupe rules read `metadata->>causal_event_id` and `created_at > since`: give each notification row what the database would.
      onRead: (table, store) => { if (table === "notifications") for (const r of store.notifications ?? []) { r["metadata->>causal_event_id"] = r.metadata?.causal_event_id; r.created_at ??= new Date().toISOString(); } },
    });
    _setTestClient(c, true);
    return c;
  }
  const sos = (c: FakeClient) => (c._store.notifications ?? []).filter((n: Row) => n.event_type === "telegraph.sos");
  async function settle(c: FakeClient, want: number) {
    for (let i = 0; i < 300 && sos(c).length < want; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 80));
    return sos(c);
  }
  const askForHelp = () => call(door.base, "POST", `/threads/${SOS_THREAD}/typed-messages`, ALICE, { kind: "SAFETY", payload: { kind: "need_help", label: "north gate" } });
  const toldFor = (c: FakeClient, userId: string, messageId: string) => sos(c).filter((n: Row) => n.user_id === userId && n.metadata?.causal_event_id === `MESSAGE:${messageId}`);

  it("archived: not told; unarchived through the route: the next request reaches them; the earlier one never does", async () => {
    const c = sosWorld();
    const first = await askForHelp();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const afterFirst = await settle(c, 1);
    assert.deepEqual(afterFirst.map((n: Row) => n.user_id), [DANA], "Bob had it archived");

    const r = await call(door.base, "POST", `/threads/${SOS_THREAD}/unarchive`, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(archivedAtOf(c, SOS_THREAD, BOB), null);

    _resetRateLimit(); _clearSendTierCache();
    const second = await askForHelp();
    assert.equal(second.status, 201, JSON.stringify(second.body));
    await settle(c, 3);
    assert.equal(toldFor(c, BOB, second.body.id).length, 1, "unarchived: the new help request reaches Bob");
    assert.equal(toldFor(c, DANA, second.body.id).length, 1);
    assert.equal(toldFor(c, BOB, first.body.id).length, 0, "the request that arrived while archived is not delivered late");
    assert.equal(toldFor(c, ALICE, second.body.id).length, 0, "never the sender");
  });

  it("CONTROL: without the unarchive, the next request still skips the member who archived it", async () => {
    const c = sosWorld();
    await askForHelp();
    await settle(c, 1);
    _resetRateLimit(); _clearSendTierCache();
    const second = await askForHelp();
    assert.equal(second.status, 201, JSON.stringify(second.body));
    await settle(c, 2);
    assert.equal(toldFor(c, BOB, second.body.id).length, 0);
    assert.equal(toldFor(c, DANA, second.body.id).length, 1);
  });
});
