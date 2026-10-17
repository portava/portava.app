/**
 * census-telegraph T256 (wave 5, lane 7) — §19 P2 Message: a message is now
 * NOTIFIED, under the standard policy.
 *
 * 49780ca56 restated T256 C → W: the template, the P2 band and the coalescing
 * rule existed, and nothing created a `telegraph.message` notification.
 * services/telegraph/messageNotifications.ts is the producer; the text, media
 * and voice doors call it after they answer.
 *
 * WHAT WOULD TURN THIS RED
 *   - the sender told about their own message; a blocked pair (either way), a
 *     muted member or a member who left told; an unreadable roster, blocks table
 *     or thread choice telling anyone;
 *   - the BODY (or any of its words) reaching a notification;
 *   - the template routing to the `telegraph` channel (a second message posted
 *     into the thread);
 *   - a burst in one conversation notifying more than once inside P2's window;
 *   - a member the message already reached as an @mention told twice;
 *   - the person who asked for help (SAFETY_EVENT) silenced by a thread mute —
 *     or anyone else's message overriding one;
 *   - a door that stops producing it.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC SUPABASE_URL=http://127.0.0.1:9 \
 *        SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphMessageNotifications.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _setTestTranslationProvider, type TranslationProvider } from "../lib/translation.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { getTemplate, renderTemplate } from "../services/notifications/NotificationTemplateService.js";
import { NotificationService, type CreateNotificationInput, type NotificationRow } from "../services/notifications/NotificationService.js";
import { bandFor, dedupeWindowFor } from "../domain/telegraph/policies/attentionLadder.js";
import { THREAD_NOTIFICATION_POLICY_FLAG } from "../services/telegraph/threadNotificationState.js";
import {
  MESSAGE_NOTIFICATION_EVENT,
  isNotifiableMessage,
  messageCausalEventId,
  notifyNewMessage,
  type MessageNotifyDeps,
} from "../services/telegraph/messageNotifications.js";
import messagingRouter from "../routes/messaging.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "72000000-0000-4000-8000-000000000001"; // the sender
const BOB = "72000000-0000-4000-8000-000000000002";   // told
const CARL = "72000000-0000-4000-8000-000000000003";  // blocked Alice
const DANA = "72000000-0000-4000-8000-000000000004";  // muted the thread
const ERIN = "72000000-0000-4000-8000-000000000005";  // left
const FRAN = "72000000-0000-4000-8000-000000000006";  // Alice blocked her
const THREAD = "72000000-0000-4000-8000-0000000000d1";
const MSG = "72000000-0000-4000-8000-0000000000e1";
const SECRET = "the gate code is 4417";

// ── a small fake for the producer unit cases ─────────────────────────────────
type Row = Record<string, any>;
function fake(seed: Record<string, Row[]>, failReads: string[] = []) {
  const db: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const val = (r: Row, c: string) => { const m = /^(\w+)->>(\w+)$/.exec(c); return m ? (r[m[1]!] ?? {})[m[2]!] : r[c]; };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" = "select";
    let inserted: Row | null = null;
    let lim: number | null = null;
    const run = () => {
      if (mode === "select" && failReads.includes(table)) return { data: null, error: { message: `${table} unreadable` } };
      if (mode === "insert") return { data: inserted, error: null };
      const out = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: lim === null ? out : out.slice(0, lim), error: null };
    };
    const t: any = {
      select() { return p; },
      insert(r: Row) { mode = "insert"; inserted = { id: `n-${++n}`, created_at: new Date().toISOString(), ...r }; (db[table] ??= []).push(inserted); return p; },
      eq(c: string, v: any) { filters.push((r) => String(val(r, c)) === String(v)); return p; },
      neq(c: string, v: any) { filters.push((r) => String(val(r, c)) !== String(v)); return p; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(val(r, c)))); return p; },
      is(c: string, v: any) { filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)); return p; },
      gt(c: string, v: any) { filters.push((r) => String(val(r, c) ?? "") > String(v)); return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }); },
      single() { return t.maybeSingle(); },
      then(res: any, rej?: any) { return Promise.resolve(run()).then(res, rej); },
    };
    const p: any = new Proxy(t, { get(o, k) { if (k in o) return o[k as string]; if (k === "catch" || k === "finally") return undefined; return () => p; } });
    return p;
  }
  return { db, from, rpc: async () => ({ data: null, error: { code: "PGRST202" } }) } as any;
}

const member = (user_id: string, over: Row = {}) => ({ thread_id: THREAD, user_id, left_at: null, muted_at: null, ...over });
function world(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    feature_flags: [],
    message_thread_members: [member(ALICE), member(BOB), member(CARL), member(DANA, { muted_at: "2026-10-01T00:00:00.000Z" }), member(ERIN, { left_at: "2026-10-01T00:00:00.000Z" }), member(FRAN)],
    blocks: [{ blocker_id: CARL, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: FRAN }],
    profiles: [{ id: ALICE, handle: "alice", display_name: "Alice Real" }],
    profile_privacy_settings: [],
    messages: [],
    notifications: [],
    ...extra,
  };
}
function recording() {
  const created: CreateNotificationInput[] = [];
  const routed: string[] = [];
  const deps: MessageNotifyDeps = {
    async create(i) { created.push(i); return { id: `n-${created.length}`, userId: i.userId } as NotificationRow; },
    async route(r) { routed.push(r.userId); },
  };
  return { deps, created, routed };
}
const send = (over: Partial<Parameters<typeof notifyNewMessage>[1]> = {}) => ({ threadId: THREAD, senderId: ALICE, messageId: MSG, msgType: "text", subtype: null, nowMs: Date.now(), ...over });
const needHelp = (sender: string, at: string) => ({ id: `nh-${sender}`, thread_id: THREAD, sender_id: sender, created_at: at, deleted_at: null, msg_type: "coordination", subtype: null, body: JSON.stringify({ kind: "COORDINATION", envelopeVersion: "1", payload: { state: "NEED_HELP" } }) });
const allClear = (sender: string, at: string) => ({ id: `ac-${sender}`, thread_id: THREAD, sender_id: sender, created_at: at, deleted_at: null, msg_type: "safety", subtype: "all_clear", body: JSON.stringify({ kind: "SAFETY", envelopeVersion: "1", payload: { kind: "all_clear", label: "All good" } }) });

describe("T256 — the template is §19's P2, never the telegraph channel, and carries no body", () => {
  it("in-app and push only; P2; five-minute coalescing; a fixed 'New message'", () => {
    const t = getTemplate(MESSAGE_NOTIFICATION_EVENT)!;
    assert.deepEqual(t.defaultChannels, ["in_app", "push"], "the telegraph channel posts a system message INTO the thread being reported");
    assert.equal(bandFor(MESSAGE_NOTIFICATION_EVENT), "P2_MESSAGE");
    assert.equal(dedupeWindowFor(MESSAGE_NOTIFICATION_EVENT), 5 * 60 * 1000);
    const r = renderTemplate(MESSAGE_NOTIFICATION_EVENT, { actor: "@alice", threadId: THREAD })!;
    assert.equal(r.title, "@alice");
    assert.equal(r.body, "New message");
    assert.equal(r.actionUrl, `/messages/${THREAD}`);
  });

  it("only a message a PERSON sent: text, media, voice and the app's cards — never protocol rows", () => {
    for (const [msgType, subtype, want] of [["text", null, true], ["media", null, true], ["voice", null, true], ["system", "post_card", true], ["system", "meetup", true], ["system", "e2ee_welcome", false], ["system", null, false], ["coordination", null, false], ["location", null, false], ["gif", null, true], ["media_album", null, true], ["memory_note", null, true], ["portava_object", "place", true], ["safety", "need_help", false], ["safety", "heads_up", false], ["safety", "all_clear", false], ["safety", "check_in", true], ["action", "meet_here", true], ["announcement", null, false]] as const) { // wave 5 safety lane: an ACTION proposal and a check-in are messages; the safety SIGNALS and an announcement have their own causes
      assert.equal(isNotifiableMessage({ msgType, subtype }), want, `${msgType}/${subtype}`);
    }
  });
});

describe("T256 — who is told about a message", () => {
  it("the other active members, minus a block EITHER way and a mute; never the sender; no body; the message's causal id", async () => {
    const { deps, created, routed } = recording();
    const r = await notifyNewMessage(fake(world()), send(), { deps });
    assert.equal(r.status, "notified");
    assert.deepEqual(created.map((c) => c.userId), [BOB], "Carl blocked Alice, Alice blocked Fran, Dana muted, Erin left, Alice sent it");
    assert.deepEqual(routed, [BOB]);
    const c = created[0]!;
    assert.equal(c.eventType, "telegraph.message");
    assert.equal(c.sourceType, "thread");
    assert.equal(c.sourceId, THREAD, "P2 coalesces per conversation");
    assert.equal(c.causalEventId, `MESSAGE:${MSG}`);
    assert.deepEqual(c.params, { actor: "@alice", threadId: THREAD }, "no preview — and Alice does not show her real name");
    assert.ok(r.status === "notified" && r.cause === "MESSAGE");
    for (const [who, why] of [[CARL, "blocked"], [FRAN, "blocked"], [DANA, "muted"]] as const) {
      assert.ok(r.status === "notified" && r.withheld.some((w) => w.userId === who && w.reason === why), `${who} ${why}`);
    }
  });

  it("MENTIONS and IMPORTANT exclude an ordinary message; ALL delivers", async () => {
    const { deps, created } = recording();
    const levels = world({
      feature_flags: [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: true }],
      message_thread_members: [member(ALICE, { notification_level: "all", muted_until: null }), member(BOB, { notification_level: "mentions", muted_until: null }), member(CARL, { notification_level: "important", muted_until: null }), member(DANA, { notification_level: "all", muted_until: null })],
      blocks: [],
    });
    await notifyNewMessage(fake(levels), send(), { deps });
    assert.deepEqual(created.map((c) => c.userId), [DANA]);
  });

  for (const [table, stage] of [["message_thread_members", "roster"], ["blocks", "blocks"], ["feature_flags", "thread_policy"]] as const) {
    it(`an unreadable ${table} tells NOBODY (refused at ${stage})`, async () => {
      const { deps, created } = recording();
      const r = await notifyNewMessage(fake(world(), [table]), send(), { deps });
      assert.deepEqual(r, { status: "refused", stage });
      assert.equal(created.length, 0);
    });
  }

  it("a protocol row is skipped before anything is read", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world(), ["message_thread_members"]), send({ msgType: "system", subtype: "e2ee_welcome" }), { deps });
    assert.deepEqual(r, { status: "skipped", reason: "not_a_person_message" });
    assert.equal(created.length, 0);
  });

  it("never rejects", async () => {
    const r = await notifyNewMessage({ from() { throw new Error("torn down"); } } as any, send(), {});
    assert.deepEqual(r, { status: "refused", stage: "threw" });
  });
});

describe("T256 — §15.2 safety mode: the person who asked for help is not silenced by a mute", () => {
  it("SAFETY_EVENT raised by the SENDER: cause SAFETY, the muted member is told, on its own coalescing source", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world({ messages: [needHelp(ALICE, "2026-10-17T10:00:00.000Z")] })), send(), { deps });
    assert.ok(r.status === "notified" && r.cause === "SAFETY" && r.safety === "read");
    assert.deepEqual(created.map((c) => c.userId).sort(), [BOB, DANA].sort(), "a mute does not silence the person who asked for help; a block still stands");
    assert.equal(created[0]!.sourceType, "thread_safety", "never coalesced behind an ordinary burst");
  });

  it("…anyone ELSE's message in that conversation is ordinary: the mute holds", async () => {
    const { deps, created } = recording();
    await notifyNewMessage(fake(world({ messages: [needHelp(BOB, "2026-10-17T10:00:00.000Z")] })), send(), { deps });
    assert.ok(!created.some((c) => c.userId === DANA));
  });

  it("…and once ALL CLEAR is posted, the sender's messages are ordinary again", async () => {
    const { deps, created } = recording();
    await notifyNewMessage(fake(world({ messages: [needHelp(ALICE, "2026-10-17T10:00:00.000Z"), allClear(ALICE, "2026-10-17T10:30:00.000Z")] })), send(), { deps });
    assert.ok(!created.some((c) => c.userId === DANA));
  });

  it("an UNREADABLE safety state overrides no mute (no evidence), and says so", async () => {
    const { deps, created } = recording();
    const r = await notifyNewMessage(fake(world({ messages: [needHelp(ALICE, "2026-10-17T10:00:00.000Z")] }), ["messages"]), send(), { deps });
    assert.ok(r.status === "notified" && r.cause === "MESSAGE" && r.safety === "unreadable");
    assert.deepEqual(created.map((c) => c.userId), [BOB]);
  });

  it("a SAFETY message is told even when the thread choices cannot be read; an ordinary one is not", async () => {
    const safe = recording();
    const r = await notifyNewMessage(fake(world({ messages: [needHelp(ALICE, "2026-10-17T10:00:00.000Z")] }), ["feature_flags"]), send(), { deps: safe.deps });
    assert.ok(r.status === "notified" && r.cause === "SAFETY");
    assert.deepEqual(safe.created.map((c) => c.userId).sort(), [BOB, DANA].sort());
  });
});

describe("T256 — dedupe, through the real NotificationService", () => {
  it("a burst in one conversation is ONE notification inside P2's window; another conversation is not coalesced into it", async () => {
    const sc = fake(world({ message_thread_members: [member(ALICE), member(BOB)], blocks: [] }));
    const ns = new NotificationService(sc);
    const deps: MessageNotifyDeps = { create: (i) => ns.create(i), route: async () => undefined };
    await notifyNewMessage(sc, send({ messageId: "m-1" }), { deps });
    await notifyNewMessage(sc, send({ messageId: "m-2" }), { deps });
    assert.equal(sc.db.notifications.filter((n: Row) => n.user_id === BOB).length, 1);
    assert.equal(sc.db.notifications[0].body, "New message");
  });

  it("a member the message already reached as an @mention (same causal id) is not told twice", async () => {
    const sc = fake(world({ message_thread_members: [member(ALICE), member(BOB)], blocks: [] }));
    const ns = new NotificationService(sc);
    await ns.create({ userId: BOB, eventType: "pulse.user_tagged", actorId: ALICE, sourceType: "message", sourceId: MSG, params: { taggerHandle: "alice", context: "@alice mentioned you in a message." }, causalEventId: messageCausalEventId(MSG) });
    await notifyNewMessage(sc, send(), { deps: { create: (i) => ns.create(i), route: async () => undefined } });
    assert.deepEqual(sc.db.notifications.map((n: Row) => n.event_type), ["pulse.user_tagged"]);
  });
});

// ── the doors ────────────────────────────────────────────────────────────────

const SAME_LANGUAGE: TranslationProvider = {
  async detectLanguage() { return { language: "en", confidence: "high" }; },
  async translateText(text: string) { return { translatedText: text, provider: "stub", providerVersion: "stub-1" }; },
};
function doorSeed(): Record<string, unknown[]> {
  const m = (user_id: string, over: Row = {}) => ({ thread_id: THREAD, user_id, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...over });
  return {
    feature_flags: [], blocks: [{ blocker_id: CARL, blocked_id: ALICE }],
    profiles: [ALICE, BOB, CARL, DANA].map((id, i) => ({ id, handle: ["alice", "bob", "carl", "dana"][i], name: null, account_status: null, auto_translate_messages: true })),
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [], trust_profiles: [], trust_restrictions: [],
    message_requests: [], user_privacy_settings: [], profile_privacy_settings: [],
    message_threads: [{ id: THREAD, thread_type: "circle", trip_id: null, circle_owner_id: ALICE, title: "Crew", status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" }],
    message_thread_members: [m(ALICE), m(BOB), m(CARL), m(DANA, { muted_at: "2026-10-01T00:00:00.000Z" })],
    messages: [], message_translations: [], rent_buddy_bookings: [], trip_crew_location_sessions: [], meetup_polls: [], saved_messages: [],
    reports: [], notifications: [], tags: [], user_tag_settings: [],
  };
}

describe("T256 — the send doors produce it", () => {
  let messaging: RouterHarness;
  let voice: RouterHarness;
  let kinds: RouterHarness;
  let share: RouterHarness;
  before(async () => { messaging = await startRouter(messagingRouter); voice = await startRouter(telegraphVoiceRouter); kinds = await startRouter(telegraphKindsRouter); share = await startRouter(telegraphShareRouter); });
  after(async () => { _setTestClient(null, false); _setTestTranslationProvider(null); await messaging.close(); await voice.close(); await kinds.close(); await share.close(); });
  beforeEach(() => { resetFakeIds(); _resetRateLimit(); _clearSendTierCache(); _setTestTranslationProvider(SAME_LANGUAGE); });

  function use() {
    // The harness filters by plain column and stamps no created_at; the dedupe rules read `metadata->>causal_event_id`
    // and `created_at > since`, so give each notification row what the database would.
    const c = makeFakeClient(doorSeed() as Record<string, any[]>, { onRead: (table, store) => { if (table === "notifications") for (const r of store.notifications ?? []) { r["metadata->>causal_event_id"] = r.metadata?.causal_event_id; r.created_at ??= new Date().toISOString(); } } });
    _setTestClient(c, true);
    return c;
  }
  const notified = (c: ReturnType<typeof use>) => (c._store.notifications ?? []).filter((n: Row) => n.event_type === "telegraph.message");
  async function settle(c: ReturnType<typeof use>, want: number) {
    for (let i = 0; i < 300 && notified(c).length < want; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    return notified(c);
  }

  it("the text door: Bob is told; Alice (the sender), Carl (blocked her) and Dana (muted) are not; no word of the body anywhere", async () => {
    const c = use();
    const r = await call(messaging.base, "POST", `/threads/${THREAD}/messages`, ALICE, { body: SECRET });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await settle(c, 1);
    assert.deepEqual(rows.map((n: Row) => n.user_id), [BOB]);
    assert.equal(rows[0].body, "New message");
    assert.equal(rows[0].metadata.causal_event_id, `MESSAGE:${r.body.id}`);
    const all = JSON.stringify(c._store.notifications ?? []);
    for (const word of ["gate", "4417"]) assert.ok(!all.includes(word), `the body leaked into a notification (${word})`);
  });

  it("the text door: an @mentioned member gets the mention, not a second notification for the same message", async () => {
    const c = use();
    const r = await call(messaging.base, "POST", `/threads/${THREAD}/messages`, ALICE, { body: "@bob are you near the pier" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 300));
    const bobs = (c._store.notifications ?? []).filter((n: Row) => n.user_id === BOB).map((n: Row) => n.event_type);
    assert.deepEqual(bobs, ["pulse.user_tagged"], "one message, told twice");
  });

  it("the voice door produces it too", async () => {
    const c = use();
    const r = await call(voice.base, "POST", `/threads/${THREAD}/voice`, ALICE, { payload: { url: `post-media/${ALICE}/voice/1700000000000.m4a`, durationSeconds: 4, waveform: [0.2, 0.6], mimeType: "audio/mp4", sizeBytes: 4096 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await settle(c, 1);
    assert.deepEqual(rows.map((n: Row) => n.user_id), [BOB]);
    assert.equal(rows[0].body, "New message");
  });

  it("the typed door: a GIF is a message and is told; a LOCATION is not this cause and tells nobody here", async () => {
    const c = use();
    const gif = await call(kinds.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "GIF", payload: { url: "post-media/g/a.gif" } });
    assert.equal(gif.status, 201, JSON.stringify(gif.body));
    const rows = await settle(c, 1);
    assert.deepEqual(rows.map((n: Row) => n.user_id), [BOB]);
    const loc = await call(kinds.base, "POST", `/threads/${THREAD}/typed-messages`, ALICE, { kind: "LOCATION", payload: { label: "An Thuong", precision: "area" } });
    assert.equal(loc.status, 201, JSON.stringify(loc.body));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(notified(c).filter((n: Row) => n.metadata?.causal_event_id === `MESSAGE:${loc.body.id}`).length, 0, "a LOCATION filed as MESSAGE");
  });

  it("the share door: sharing a Portava object is a message, and is told", async () => {
    const c = use();
    const r = await call(share.base, "POST", `/threads/${THREAD}/share`, ALICE, { objectType: "PROFILE", objectId: BOB });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await settle(c, 1);
    assert.deepEqual(rows.map((n: Row) => n.user_id), [BOB]);
  });

  it("the media door produces it too", async () => {
    const c = use();
    const r = await call(messaging.base, "POST", `/threads/${THREAD}/media`, ALICE, { mediaUrl: "http://127.0.0.1:9/storage/v1/object/public/post-media/a/b.jpg", mediaType: "image" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = await settle(c, 1);
    assert.deepEqual(rows.map((n: Row) => n.user_id), [BOB]);
  });
});
