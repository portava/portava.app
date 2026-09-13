/**
 * Census T344 / T363 — the three consequences `census-telegraph.md` §15.8 named
 * and left open, plus the one §16.4 found inside its own fix and did not close.
 *
 * All four are the same supabase-js property the §14/§15/§16 lanes worked
 * through: a failed read RESOLVES as `{ data: null }`, so a handler that
 * destructures only `{ data }` cannot tell "the table said nothing" from "the
 * table could not be read", and answers as though it knew.
 *
 *   1. THE MENTION NOTIFICATION (`routes/messaging.ts`, the tagger profile).
 *      `resolveHandle(taggerProfile) ?? 'someone'` after a `.single()` whose
 *      error was dropped. §16.4 declined this one for a stated reason: `.single()`
 *      errors when NO ROW MATCHES as well as when the table is unreadable, so
 *      merely binding the error would move the conflation one step along rather
 *      than remove it. The fix is therefore `.maybeSingle()` plus an interpreter
 *      that answers all three worlds — stated, stated nothing, could not be read
 *      — which is the same shape `senderLanguageFrom` took in §16.
 *
 *   2. THE QUOTED REPLY CONTEXT, ON THE WIRE. §14 made both reply reads LOG.
 *      The payload did not change: a reply whose quote could not be read and a
 *      message that quoted nothing are still the same JSON, and a reply whose
 *      `reply_to_id` could not be read is not even reported as a reply. §14.6
 *      named this as one of the two reasons T344 did not move.
 *
 *   3. THE RECIPIENTS' LANGUAGE PREFERENCES (`services/messageTranslation.ts`).
 *      Named by §16.4 inside the fix's own file: step 3 reads every recipient's
 *      profile with the error dropped, so an unreadable `profiles` gave EVERY
 *      recipient `preferredLanguage: 'en'`. When the source language is also
 *      'en' — the common case — the pipeline then wrote `status: 'skipped'` with
 *      `target_language: 'en'` for all of them, which is not a degraded
 *      translation but a durable stored claim that each recipient reads English.
 *      Step 1's thread-member read is the same shape with a worse ending: an
 *      unreadable `message_thread_members` yields zero recipients and the whole
 *      pipeline returns having written nothing and said nothing.
 *
 *   4. THE PER-VIEWER TRANSLATION READ IN `routes/groupChat.ts`. §14 fixed this
 *      exact read in `routes/messaging.ts` (an unreadable `message_translations`
 *      now reports §18's own word, `failed`, rather than inventing a monolingual
 *      thread). The group-chat reader is the same query in another file and was
 *      not fixed with it.
 *
 * WHAT IS NOT CLAIMED. None of this closes T344 or T363. §15.8's fifth bullet —
 * the rest of the messaging tree — is still open, and this suite's own lane
 * found further instances outside these four; see the census section that
 * accompanies it.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphContextReadHonesty.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _setTestTranslationProvider } from "../lib/translation.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";
import { translateMessageForThread } from "../services/messageTranslation.js";
import { actorHandleFrom } from "../lib/publicIdentity.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "70000000-0000-4000-8000-000000000001";
const BOB = "70000000-0000-4000-8000-000000000002";
const CAROL = "70000000-0000-4000-8000-000000000003";
const TRIP = "70000000-0000-4000-8000-0000000000a1";
const THREAD = "70000000-0000-4000-8000-0000000000d1";
const M_QUOTED = "70000000-0000-4000-8000-0000000000e1";
const M_REPLY = "70000000-0000-4000-8000-0000000000e2";

const TRANSLATIONS_DOWN = {
  message: "permission denied for relation message_translations",
  code: "42501",
};
const PROFILES_DOWN = { message: "permission denied for relation profiles", code: "42501" };
const MEMBERS_DOWN = {
  message: "permission denied for relation message_thread_members",
  code: "42501",
};

const PROVIDER_DOWN = {
  async detectLanguage(): Promise<{ language: string; confidence: "high" | "low" }> {
    throw new Error("detector_down");
  },
  async translateText(text: string, _source: string, target: string) {
    return { translatedText: `[${target}] ${text} and then some more words.`, provider: "stub" };
  },
};

/**
 * A trip thread ALICE and BOB share. M_REPLY quotes M_QUOTED, which is what
 * makes the reply-context cases reachable at all.
 */
function seed(over: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", account_status: null, auto_translate_messages: true },
      { id: BOB, handle: "bob", name: "Bob", account_status: null, preferred_language: "es", auto_translate_messages: true },
      { id: CAROL, handle: "carol", name: "Carol", account_status: null, auto_translate_messages: true },
    ],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [],
    user_privacy_settings: [],
    message_threads: [
      {
        id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Cebu crew", status: "active", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      { id: M_QUOTED, thread_id: THREAD, sender_id: BOB, body: "the ferry leaves at eight.",
        created_at: "2026-03-11T00:00:00.000Z", deleted_at: null, edited_at: null,
        original_language: "en", msg_type: "text", subtype: null, media_url: null,
        media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
      { id: M_REPLY, thread_id: THREAD, sender_id: BOB, body: "make it nine.",
        created_at: "2026-03-11T00:01:00.000Z", deleted_at: null, edited_at: null,
        original_language: "en", msg_type: "text", subtype: null, media_url: null,
        media_type: null, media_thumbnail_url: null, media_duration_seconds: null,
        reply_to_id: M_QUOTED },
    ],
    message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
    ],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
    meetup_polls: [],
    saved_messages: [],
    reports: [],
    notifications: [],
    ...over,
  };
}

let messagingHarness: RouterHarness;
let groupChatHarness: RouterHarness;

before(async () => {
  messagingHarness = await startRouter(messagingRouter);
  groupChatHarness = await startRouter(groupChatRouter);
});
after(async () => {
  _setTestTranslationProvider(null);
  await messagingHarness.close();
  await groupChatHarness.close();
});
beforeEach(() => {
  resetFakeIds();
  _resetRateLimit();
  _clearSendTierCache();
  _setTestTranslationProvider(PROVIDER_DOWN as any);
});

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

/**
 * How many operations hit `messages` BEFORE the reply-linkage read.
 *
 * Measured, never hardcoded, for the reason `messageLanguageProvenance.test.ts`
 * states about its own offset: `messages` is read several times on this path,
 * and failing the whole table aborts the handler above the code under test, so
 * the case would pass on a refusal produced somewhere else.
 */
function opIndexOfSelect(c: FakeClient, table: string, sel: string): number {
  const idx = c._observed.selects.findIndex((s) => s.table === table && s.sel === sel);
  assert.ok(idx >= 0, `no ${table} read selecting "${sel}" was observed — the call site moved`);
  const writes =
    c._observed.inserts.filter((w) => w.table === table).length +
    c._observed.updates.filter((w) => w.table === table).length +
    c._observed.upserts.filter((w) => w.table === table).length +
    c._observed.deletes.filter((w) => w.table === table).length;
  assert.equal(writes, 0, `this counter assumes ${table} is read-only on this path`);
  return c._observed.selects.filter((s, i) => s.table === table && i < idx).length;
}

// ── 1. The mention notification's three worlds ───────────────────────────────

describe("actorHandleFrom — 'we could not read who' is not 'they have no handle'", () => {
  it("a profile that carries a handle yields the handle", () => {
    assert.deepEqual(actorHandleFrom({ handle: "alice", username: null }, null), {
      handle: "alice",
      unreadable: false,
    });
  });

  it("the username is the documented fallback, as resolveHandle already treats it", () => {
    assert.deepEqual(actorHandleFrom({ handle: null, username: "alice_2" }, null), {
      handle: "alice_2",
      unreadable: false,
    });
  });

  it("a profile that was READ and carries no handle is 'no handle', not 'unreadable'", () => {
    assert.deepEqual(actorHandleFrom({ handle: null, username: null }, null), {
      handle: null,
      unreadable: false,
    });
  });

  it("no row at all is still a successful read", () => {
    assert.deepEqual(actorHandleFrom(null, null), { handle: null, unreadable: false });
  });

  it("a FAILED read is its own answer, and never carries a handle", () => {
    assert.deepEqual(actorHandleFrom({ handle: "alice", username: null }, PROFILES_DOWN), {
      handle: null,
      unreadable: true,
    });
  });

  it("a blank handle is a column that was written and says nothing", () => {
    assert.deepEqual(actorHandleFrom({ handle: "   ", username: null }, null), {
      handle: null,
      unreadable: false,
    });
  });
});

describe("POST /threads/:id/messages — the mention notification, driven", () => {
  /** Everything `processTagging` needs to reach the tagger-profile read. */
  function taggableSeed(): Record<string, any[]> {
    return seed({
      tags: [],
      user_tag_settings: [],
      notifications: [],
    });
  }

  it("CONTROL: a readable tagger is named by their handle", async () => {
    const c = use(taggableSeed());
    const r = await call(messagingHarness.base, "POST", `/threads/${THREAD}/messages`, ALICE, {
      body: "@bob where are you",
    });
    assert.equal(r.status, 201);
    const notif = (c._observed.inserts.find((w) => w.table === "notifications")?.rows ?? [])[0];
    assert.ok(notif, "a mention notification is written on the healthy path");
    assert.match(String((notif as any).title), /@alice/);
    assert.deepEqual(
      (notif as any).metadata,
      {},
      "and the healthy path carries no degradation marker at all",
    );
  });

  it("an unreadable tagger profile names NOBODY rather than '@someone'", async () => {
    // `profiles` is read repeatedly on the send path (the auth gate first of
    // all, which refuses outright when it is down), so the error is injected
    // from the tagger read onward and the offset is measured, never guessed.
    const probe = use(taggableSeed());
    await call(messagingHarness.base, "POST", `/threads/${THREAD}/messages`, ALICE, {
      body: "@bob where are you",
    });
    const taggerOp = opIndexOfSelect(probe, "profiles", "handle, username");

    const c = use(taggableSeed(), {
      errors: { profiles: { ...PROFILES_DOWN, afterOps: taggerOp } },
    });
    const r = await call(messagingHarness.base, "POST", `/threads/${THREAD}/messages`, ALICE, {
      body: "@bob where are you",
    });
    assert.equal(r.status, 201, "the message is still delivered — tagging is a side effect");

    const notif = (c._observed.inserts.find((w) => w.table === "notifications")?.rows ?? [])[0];
    assert.ok(notif, "and the mention is still notified — losing it would be worse");
    assert.ok(
      !String((notif as any).title).includes("@someone"),
      "'@someone' is TRUE of a tagger with no handle and FALSE of a profiles outage",
    );
    assert.ok(
      !String((notif as any).title).includes("@") && !String((notif as any).body).includes("@"),
      "and it names nobody at all — a handle we did not read is not a handle",
    );
    assert.deepEqual(
      (notif as any).metadata,
      { taggerHandleUnreadable: true },
      "the PERSISTED row says which of the two worlds this was; `params` renders " +
        "the template and is not stored",
    );
  });
});

// ── 2. The quoted reply context, on the wire ─────────────────────────────────

describe("GET /threads/:id/messages — an unreadable quote is not an absent quote", () => {
  it("CONTROL: a healthy read carries the reply link and its quoted body", async () => {
    use(seed());
    const r = await call(messagingHarness.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    assert.equal(r.status, 200);
    const reply = r.body.messages.find((m: any) => m.id === M_REPLY);
    assert.equal(reply.replyToId, M_QUOTED);
    assert.equal(reply.replyToBody, "the ferry leaves at eight.");
    assert.ok(
      !("replyContext" in reply),
      "the normal case must carry NO degradation marker — a marker that is always " +
        "present says nothing",
    );
    const plain = r.body.messages.find((m: any) => m.id === M_QUOTED);
    assert.equal(plain.replyToId, null, "a message that quoted nothing says so, with null");
  });

  it("an unreadable QUOTE omits the body rather than reporting it absent", async () => {
    // The linkage read succeeds and the quoted-body read fails, so the response
    // still knows this message IS a reply and must not claim its quote is empty.
    const probe = use(seed());
    await call(messagingHarness.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    const quoteOp = opIndexOfSelect(
      probe,
      "messages",
      "id, body, sender_id, profile:profiles!messages_sender_id_fkey(name, handle, username, full_name)",
    );

    use(seed(), { errors: { messages: { ...TRANSLATIONS_DOWN, message: "quote read failed", afterOps: quoteOp } } });
    const r = await call(messagingHarness.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    assert.equal(r.status, 200, "the thread still reads — a lost quote is not a lost thread");

    const reply = r.body.messages.find((m: any) => m.id === M_REPLY);
    assert.equal(reply.replyToId, M_QUOTED, "the linkage was readable and is still reported");
    assert.equal(
      reply.replyContext,
      "unavailable",
      "the one place the difference can survive is the payload, and it did not",
    );
    assert.ok(
      !("replyToBody" in reply),
      "omitted, not null: `undefined` is 'we do not know' and `null` is 'there is no " +
        "quote to show you' — §14 drew exactly this line for tripCity",
    );
    assert.ok(!("replyToSenderName" in reply));
  });

  it("an unreadable LINKAGE does not report every message as quoting nothing", async () => {
    const probe = use(seed());
    await call(messagingHarness.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    const linkOp = opIndexOfSelect(probe, "messages", "id, reply_to_id");

    use(seed(), { errors: { messages: { message: "linkage read failed", code: "57P01", afterOps: linkOp } } });
    const r = await call(messagingHarness.base, "GET", `/threads/${THREAD}/messages`, ALICE);
    assert.equal(r.status, 200);

    for (const m of r.body.messages) {
      assert.equal(
        m.replyContext,
        "unavailable",
        "with reply_to_id unreadable NOTHING is known about which messages are replies",
      );
      assert.ok(!("replyToId" in m), "and `replyToId: null` would be a claim that it is not one");
    }
  });
});

// ── 3. The recipients' language preferences ──────────────────────────────────

describe("translateMessageForThread — an unreadable recipient profile is not an English one", () => {
  it("CONTROL: a readable recipient preference still drives a real translation", async () => {
    const c = use(seed());
    await translateMessageForThread(c as any, {
      messageId: M_QUOTED,
      body: "the ferry leaves at eight.",
      senderId: ALICE,
      threadId: THREAD,
      senderPreferredLanguage: "en",
      senderPreferenceUnreadable: false,
    } as any);
    const row = c._store.message_translations.find((t: any) => t.recipient_id === BOB);
    assert.equal(row.status, "translated");
    assert.equal(row.target_language, "es");
  });

  it("an unreadable profiles does NOT write 'skipped' at the server's own default", async () => {
    // `profiles` is read for the recipients only; the sender-preference read is
    // not made here because the caller supplies it.
    const c = use(seed(), { errors: { profiles: PROFILES_DOWN } });
    await translateMessageForThread(c as any, {
      messageId: M_QUOTED,
      body: "the ferry leaves at eight.",
      senderId: ALICE,
      threadId: THREAD,
      senderPreferredLanguage: "en",
      senderPreferenceUnreadable: false,
    } as any);

    const row = c._store.message_translations.find((t: any) => t.recipient_id === BOB);
    assert.ok(row, "a row is still written — silence is the defect, not the row");
    assert.notEqual(
      row.status,
      "skipped",
      "'skipped' with target_language 'en' asserts this recipient reads English; " +
        "nothing was read about this recipient at all",
    );
    assert.equal(row.status, "failed");
    assert.equal(row.error_message, "recipient_preferences_unreadable");
    assert.equal(
      row.target_language,
      "und",
      "the tree's own code for an undetermined language — §14 already writes it " +
        "for exactly this case in routes/messaging.ts",
    );
  });

  it("an unreadable thread roster does not make a whole thread silently untranslated", async () => {
    const c = use(seed(), { errors: { message_thread_members: MEMBERS_DOWN } });
    let warned = 0;
    await translateMessageForThread(c as any, {
      messageId: M_QUOTED,
      body: "the ferry leaves at eight.",
      senderId: ALICE,
      threadId: THREAD,
      senderPreferredLanguage: "en",
      senderPreferenceUnreadable: false,
      logger: {
        warn() {},
        info() {},
        debug() {},
        error() { warned += 1; },
      },
    } as any);
    assert.equal(
      warned,
      1,
      "an unreadable roster returned as 'this thread has no other members' and " +
        "the pipeline finished without writing or saying anything",
    );
  });
});

// ── 4. The group-chat reader's per-viewer translation read ───────────────────

describe("GET /trips/:tripId/chat — the same translation read §14 fixed in messaging.ts", () => {
  it("CONTROL: a healthy read reports a real translation", async () => {
    use(
      seed({
        message_translations: [
          {
            id: "70000000-0000-4000-8000-0000000000f1",
            message_id: M_QUOTED, recipient_id: ALICE,
            source_language: "en", target_language: "es",
            translated_body: "el ferry sale a las ocho.", provider: "stub",
            status: "translated", error_message: null,
          },
        ],
      }),
    );
    const r = await call(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, ALICE);
    assert.equal(r.status, 200);
    const m = r.body.messages.find((x: any) => x.id === M_QUOTED);
    assert.equal(m.translationStatus, "translated");
  });

  it("an unreadable message_translations reports 'failed', not a monolingual thread", async () => {
    use(seed(), { errors: { message_translations: TRANSLATIONS_DOWN } });
    const r = await call(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, ALICE);
    assert.equal(r.status, 200, "messages are still delivered; only the claim changes");
    const m = r.body.messages.find((x: any) => x.id === M_QUOTED);
    assert.equal(
      m.translationStatus,
      "failed",
      "`translationStatus: null` is the payload a same-language thread produces, " +
        "and §18 already has a word for 'we did not translate this'",
    );
  });
});
