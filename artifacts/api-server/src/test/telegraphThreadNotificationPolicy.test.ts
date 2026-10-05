/**
 * census-telegraph T398 — §30A.6's per-thread notification policy:
 * ALL / MENTIONS / IMPORTANT / temporary mute / MUTED, with SAFETY governed by
 * the safety policy rather than by an ordinary mute.
 *
 * WHAT IS EXERCISED
 *   1. The decision table (domain/telegraph/policies/threadNotificationPolicy.ts),
 *      every level against every §30A.6 cause, plus the temporary mute, the
 *      legacy muted_at, and an unreadable state.
 *   2. THE LIVE DEFECT, through the real POST /threads/:id/messages: a member who
 *      muted the thread (muted_at — every database has it, no flag) is no longer
 *      sent an @mention notification; the unmuted control still is; and an
 *      unreadable member state withholds rather than delivers.
 *   3. With migration 3760's columns and the flag ON: MENTIONS and IMPORTANT
 *      deliver a mention; a temporary mute in force withholds it.
 *   4. The real GET/PUT /threads/:id/notification-policy: flag OFF stores
 *      MUTED/ALL through muted_at and REFUSES MENTIONS / IMPORTANT / a temporary
 *      mute rather than storing something else; flag ON stores the level and the
 *      temporary mute; a non-member and an unreadable membership write nothing.
 *
 * SHOWN RED (T2 lane report): the dispatch filter removed (deliverTo := taggedIds)
 * turns the muted case red; the unreadable branch read as "not muted" turns the
 * unreadable case red; the flag-off refusal removed turns the 409 case red.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphThreadNotificationPolicy.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _setTestTranslationProvider, type TranslationProvider } from "../lib/translation.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import notificationPolicyRouter from "../routes/telegraphNotificationPolicy.js";
import {
  NOTIFICATION_CAUSES,
  THREAD_NOTIFICATION_LEVELS,
  decideThreadNotification,
  type NotificationCause,
  type ThreadNotificationState,
} from "../domain/telegraph/policies/threadNotificationPolicy.js";
import { THREAD_NOTIFICATION_POLICY_FLAG } from "../services/telegraph/threadNotificationState.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

/** Everyone reads English: translation is not what this suite is about. */
const SAME_LANGUAGE: TranslationProvider = {
  async detectLanguage() { return { language: "en", confidence: "high" }; },
  async translateText(text: string) { return { translatedText: text, provider: "stub", providerVersion: "stub-1" }; },
};
const st = (o: Partial<ThreadNotificationState> = {}): ThreadNotificationState =>
  ({ level: null, mutedAt: null, mutedUntil: null, ...o });

describe("§30A.6 — the decision table", () => {
  it("SAFETY delivers whatever the member chose, and even when their state is unreadable", () => {
    for (const s of [st({ level: "MUTED" }), st({ mutedAt: "2026-01-01T00:00:00Z" }),
      st({ mutedUntil: "2099-01-01T00:00:00Z" }), null]) {
      assert.deepEqual(decideThreadNotification({ cause: "SAFETY", state: s, nowMs: NOW }),
        { deliver: true, reason: "safety_override" });
    }
  });

  it("ALL delivers every cause; MUTED and the legacy muted_at deliver none but SAFETY", () => {
    for (const cause of NOTIFICATION_CAUSES) {
      assert.equal(decideThreadNotification({ cause, state: st({ level: "ALL" }), nowMs: NOW }).deliver, true);
      if (cause === "SAFETY") continue;
      assert.equal(decideThreadNotification({ cause, state: st({ level: "MUTED" }), nowMs: NOW }).deliver, false);
      assert.equal(decideThreadNotification({ cause, state: st({ level: "ALL", mutedAt: "x" }), nowMs: NOW }).deliver, false,
        "muted_at means MUTED whatever the level says");
    }
  });

  it("MENTIONS delivers only a mention (and safety); IMPORTANT everything but an ordinary message", () => {
    const mentions = NOTIFICATION_CAUSES.filter((c) =>
      decideThreadNotification({ cause: c, state: st({ level: "MENTIONS" }), nowMs: NOW }).deliver);
    assert.deepEqual(mentions, ["MENTION", "SAFETY"]);
    const important = NOTIFICATION_CAUSES.filter((c) =>
      decideThreadNotification({ cause: c, state: st({ level: "IMPORTANT" }), nowMs: NOW }).deliver);
    assert.deepEqual(important, NOTIFICATION_CAUSES.filter((c: NotificationCause) => c !== "MESSAGE"));
  });

  it("a temporary mute withholds until it ends, and an unparseable end is not 'no mute'", () => {
    const live = st({ level: "ALL", mutedUntil: new Date(NOW + 60_000).toISOString() });
    const ended = st({ level: "ALL", mutedUntil: new Date(NOW - 60_000).toISOString() });
    assert.deepEqual(decideThreadNotification({ cause: "MENTION", state: live, nowMs: NOW }),
      { deliver: false, reason: "temporarily_muted" });
    assert.equal(decideThreadNotification({ cause: "MENTION", state: ended, nowMs: NOW }).deliver, true);
    assert.equal(decideThreadNotification({ cause: "MENTION", state: st({ mutedUntil: "whenever" }), nowMs: NOW }).deliver, false);
  });

  it("an unreadable state withholds — a failed read is not 'not muted'", () => {
    assert.deepEqual(decideThreadNotification({ cause: "MENTION", state: null, nowMs: NOW }),
      { deliver: false, reason: "state_unreadable" });
  });

  it("the levels are the spec's names", () => {
    assert.deepEqual([...THREAD_NOTIFICATION_LEVELS], ["ALL", "MENTIONS", "IMPORTANT", "MUTED"]);
  });
});

// ── the live path ─────────────────────────────────────────────────────────────

const ALICE = "71000000-0000-4000-8000-000000000001";
const BOB = "71000000-0000-4000-8000-000000000002";
const CAROL = "71000000-0000-4000-8000-000000000003";
const TRIP = "71000000-0000-4000-8000-0000000000a1";
const THREAD = "71000000-0000-4000-8000-0000000000d1";

function seed(bob: Record<string, unknown> = {}, flags: Array<{ flag: string; enabled: boolean }> = []): Record<string, unknown[]> {
  return {
    feature_flags: flags,
    blocks: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: null, auto_translate_messages: true },
      { id: BOB, handle: "bob", name: "Bob", account_status: null, auto_translate_messages: true },
      { id: CAROL, handle: "carol", name: "Carol", account_status: null, auto_translate_messages: true },
    ],
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [],
    trust_profiles: [], trust_restrictions: [], message_requests: [], user_privacy_settings: [],
    message_threads: [{
      id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "Crew", status: "active",
      is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
      last_message_at: "2026-03-11T00:00:00.000Z",
    }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...bob },
    ],
    messages: [], message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
    ],
    rent_buddy_bookings: [], trip_crew_location_sessions: [], meetup_polls: [], saved_messages: [],
    reports: [], notifications: [], tags: [], user_tag_settings: [],
  };
}

let messaging: RouterHarness;
let policy: RouterHarness;
before(async () => {
  messaging = await startRouter(messagingRouter);
  policy = await startRouter(notificationPolicyRouter);
});
after(async () => {
  _setTestClient(null, false);
  _setTestTranslationProvider(null);
  await messaging.close();
  await policy.close();
});
beforeEach(() => {
  resetFakeIds();
  _resetRateLimit();
  _clearSendTierCache();
  _setTestTranslationProvider(SAME_LANGUAGE);
});

function use(state: Record<string, unknown[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(state as Record<string, any[]>, opts);
  _setTestClient(c, true);
  return c;
}
const mentionNotifications = (c: FakeClient) =>
  c._observed.inserts.filter((w) => w.table === "notifications").flatMap((w) => w.rows)
    .filter((r: { user_id?: string }) => r.user_id === BOB);

async function mentionBob(c: FakeClient) {
  const r = await call(messaging.base, "POST", `/threads/${THREAD}/messages`, ALICE, { body: "@bob where are you" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return mentionNotifications(c);
}

describe("§30A.6 on the live mention path (no migration, no flag)", () => {
  it("CONTROL: an unmuted member is notified of an @mention", async () => {
    const c = use(seed());
    assert.equal((await mentionBob(c)).length, 1);
  });

  it("a member who MUTED the thread is no longer notified — the mute was a label before", async () => {
    const c = use(seed({ muted_at: "2026-10-01T00:00:00.000Z" }));
    assert.equal((await mentionBob(c)).length, 0);
  });

  it("an UNREADABLE member state withholds the notification rather than delivering it", async () => {
    // Fail message_thread_members from the notification-state read onward. The
    // offset is measured on a healthy run, never guessed.
    const probe = use(seed());
    await mentionBob(probe);
    const idx = probe._observed.selects.findIndex((s) => s.table === "message_thread_members" && s.sel === "user_id, muted_at");
    assert.ok(idx >= 0, "the notification-state read was not observed — the call site moved");
    const before = probe._observed.selects.filter((s, i) => s.table === "message_thread_members" && i < idx).length;
    const c = use(seed(), { errors: { message_thread_members: { message: "denied", code: "42501", afterOps: before, ops: ["select"] } } });
    const r = await call(messaging.base, "POST", `/threads/${THREAD}/messages`, ALICE, { body: "@bob where are you" });
    assert.equal(r.status, 201, "the message itself is still delivered — notification is a side effect");
    assert.equal(mentionNotifications(c).length, 0);
  });
});

describe("§30A.6 with migration 3760's columns and the flag ON", () => {
  const ON = [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: true }];
  for (const level of ["mentions", "important"]) {
    it(`level ${level.toUpperCase()} still delivers a mention`, async () => {
      const c = use(seed({ notification_level: level, muted_until: null }, ON));
      assert.equal((await mentionBob(c)).length, 1);
    });
  }
  it("a temporary mute in force withholds the mention; an ended one does not", async () => {
    const live = use(seed({ notification_level: "all", muted_until: "2099-01-01T00:00:00.000Z" }, ON));
    assert.equal((await mentionBob(live)).length, 0);
    const ended = use(seed({ notification_level: "all", muted_until: "2020-01-01T00:00:00.000Z" }, ON));
    assert.equal((await mentionBob(ended)).length, 1);
  });
});

describe("GET/PUT /threads/:id/notification-policy", () => {
  async function putReq(asUser: string, body: unknown) {
    const r = await fetch(`${policy.base}/threads/${THREAD}/notification-policy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  }

  it("flag OFF: MUTED and ALL are stored through muted_at and read back", async () => {
    const c = use(seed());
    const muted = await putReq(BOB, { level: "MUTED" });
    assert.equal(muted.status, 200);
    assert.equal(muted.body.level, "MUTED");
    const bobRow = (c._store.message_thread_members as Array<Record<string, unknown>>).find((r) => r.user_id === BOB)!;
    assert.ok(typeof bobRow.muted_at === "string", "muted_at was written");
    assert.ok(!("notification_level" in bobRow) || bobRow.notification_level === undefined,
      "with the flag off the 3760 column is never named");
    const all = await putReq(BOB, { level: "ALL" });
    assert.equal(all.body.level, "ALL");
    assert.equal(bobRow.muted_at, null);
    assert.deepEqual(all.body.levelsAvailable, ["ALL", "MUTED"]);
  });

  it("flag OFF: MENTIONS, IMPORTANT and a temporary mute are REFUSED, and nothing is written", async () => {
    for (const body of [{ level: "MENTIONS" }, { level: "IMPORTANT" }, { level: "ALL", muteForMinutes: 60 }]) {
      const c = use(seed());
      const r = await putReq(BOB, body);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(c._observed.updates.length, 0, "a refused choice wrote something");
    }
  });

  it("flag ON: the level and a temporary mute are stored and read back", async () => {
    const c = use(seed({ notification_level: "all", muted_until: null }, [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: true }]));
    const r = await putReq(BOB, { level: "MENTIONS", muteForMinutes: 60 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.level, "MENTIONS");
    assert.equal(r.body.temporaryMuteActive, true);
    const bobRow = (c._store.message_thread_members as Array<Record<string, unknown>>).find((x) => x.user_id === BOB)!;
    assert.equal(bobRow.notification_level, "mentions");
    const until = Date.parse(String(bobRow.muted_until));
    assert.ok(until > Date.now() + 55 * 60_000 && until < Date.now() + 65 * 60_000);
    const got = await fetch(`${policy.base}/threads/${THREAD}/notification-policy`, { headers: { authorization: `Bearer ${BOB}` } });
    assert.equal((await got.json() as { level: string }).level, "MENTIONS");
  });

  it("a non-member is refused and nothing is written", async () => {
    const c = use(seed());
    const r = await putReq(CAROL, { level: "MUTED" });
    assert.equal(r.status, 403);
    assert.equal(c._observed.updates.length, 0);
  });

  it("an unreadable membership is a 503, never 'not a member' and never a write", async () => {
    const c = use(seed(), { errors: { message_thread_members: { message: "denied", code: "42501" } } });
    const r = await putReq(BOB, { level: "MUTED" });
    assert.equal(r.status, 503);
    assert.equal(c._observed.updates.length, 0);
  });

  it("a malformed choice is refused", async () => {
    use(seed());
    assert.equal((await putReq(BOB, { level: "LOUD" })).status, 400);
    assert.equal((await putReq(BOB, { level: "ALL", muteForMinutes: 7 })).status, 400);
  });
});
