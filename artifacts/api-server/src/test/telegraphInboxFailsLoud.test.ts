/**
 * Telegraph §29 / §30A.16 — census T344, T363 and T438.
 *
 * The requirement, in the addendum's own emphasis:
 *   "schema/permission failures must NEVER be swallowed into plausible empty
 *    inboxes."
 *
 * WHY THE CENSUS'S EVIDENCE WAS INCOMPLETE, and it matters. T344/T363/T438 all
 * cite the same four reads, spelled `const { data: x } = await …`, and the
 * ratchet that measures the class
 * (`src/test/telegraphRlsAuthorizationMatrix.test.ts:637#it("LDB-05: the divergence is still real — route handlers drop read errors into context"`)
 * counts that exact destructuring shape. The INBOX's three primary reads are
 * not spelled that way — they are a `Promise.all` whose results are used as
 * `threadsRes.data ?? []` — so neither the census nor the ratchet could see
 * them, and they are the worst instance in the file. supabase-js RESOLVES on a
 * database error, so an unreadable `message_threads` produced a 200 with an
 * empty inbox, and an unreadable `messages` produced every thread reporting
 * zero unread. Both are indistinguishable from the truth.
 *
 * WHAT IS ASSERTED. The real `messagingRouter`, driven through the
 * certification harness, with one table at a time made unreadable:
 *
 *   PRIMARY reads refuse. message_threads, messages, message_thread_members
 *   and the member `profiles` batch each turn the inbox into a refusal, never
 *   a 200 with fewer rows. The status is checked AND the body is checked to be
 *   empty of threads, because a 200 carrying `{threads: []}` is the exact
 *   failure and a test that only looked at one of the two could miss it.
 *
 *   SECONDARY reads degrade, and say so. Trip city and booking id are OMITTED
 *   (`undefined`, absent from the JSON) rather than sent as `null`, because
 *   `null` means "this trip has no city" and the caller acts on the
 *   difference. The preview carries `previewTranslationStatus: 'failed'` when
 *   translations could not be read, and carries NOTHING in the normal case.
 *
 *   The THREAD read reports `translationStatus: 'failed'`, not a monolingual
 *   thread, when `message_translations` is unreadable.
 *
 *   The message-request list refuses rather than listing requests from nobody.
 *
 * SHOWN RED before green (12 pass / 0 fail). Each mutation applied, run,
 * reverted, and `routes/messaging.ts` compared byte-for-byte with `cmp`:
 *
 *   D1  the three-read refusal loop deleted — the state before this change.
 *                                                       10 pass / 2 fail.
 *   D2  `tripCityDegraded ? undefined : tripCity` reverted to `tripCity`.
 *                                                       11 pass / 1 fail.
 *   D3  the synthesised `status: 'failed'` rows in the thread read deleted.
 *                                                       11 pass / 1 fail.
 *   D4  the member-profile refusal deleted.             11 pass / 1 fail.
 *   D5  `previewTranslationStatus` made unconditional — a marker that is
 *       always there says nothing.                      11 pass / 1 fail,
 *       and it is the assertion "carries NO such field in the normal case"
 *       that catches it, which is why that assertion is not decoration.
 *
 * WHAT THIS DOES NOT CLAIM. It does not claim the class is exhausted in
 * `routes/messaging.ts`. The file still holds dropped-error reads; the ones
 * that remain resolve to a refusal (a 403 or a 404), which the requirement
 * does not forbid, or default a value a caller cannot act on. The reads
 * covered here are the ones that produced an inbox or a thread context that
 * looked correct and was not.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphInboxFailsLoud.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type InjectedError,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP = "00000000-0000-4000-8000-0000000000b1";
const M_FROM_ALICE = "11111111-0000-4000-8000-000000000001";

const DOWN = { message: "permission denied for relation", code: "42501" };

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", show_name: true },
      { id: BOB, handle: "bob", name: "Bob", show_name: true },
    ],
    blocks: [],
    message_threads: [
      {
        id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Cebu crew", status: "active", is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      {
        thread_id: TRIP_THREAD, user_id: ALICE, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
        muted_at: null, archived_at: null, visible_from_at: null,
      },
      {
        thread_id: TRIP_THREAD, user_id: BOB, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
        muted_at: null, archived_at: null, visible_from_at: null,
      },
    ],
    messages: [
      {
        id: M_FROM_ALICE, thread_id: TRIP_THREAD, sender_id: ALICE,
        body: "nos vemos en el muelle", created_at: "2026-03-11T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: "es",
        msg_type: "text", subtype: null, media_url: null, media_type: null,
        media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
      },
    ],
    message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner" },
      { trip_id: TRIP, user_id: BOB, role: "member" },
    ],
    message_requests: [],
  };
}

let harness: RouterHarness;

function use(
  state: Record<string, any[]>,
  errors?: Record<string, InjectedError>,
): FakeClient {
  const c = makeFakeClient(state, errors ? { errors } : undefined);
  _setTestClient(c, true);
  return c;
}

before(async () => {
  harness = await startRouter(messagingRouter);
});
after(async () => {
  await harness.close();
});
beforeEach(() => {
  resetFakeIds();
});

// ── the inbox's primary reads refuse ──────────────────────────────────────────

describe("T344/T438 — an unreadable inbox is a REFUSAL, never an empty inbox", () => {
  it("sanity: with every table readable the inbox has the conversation in it", async () => {
    use(seed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.threads.length, 1);
    assert.equal(r.body.threads[0].id, TRIP_THREAD);
  });

  for (const table of ["message_threads", "messages"] as const) {
    it(`refuses when \`${table}\` is unreadable — no 200 with an empty list`, async () => {
      use(seed(), { [table]: DOWN });
      const r = await call(harness.base, "GET", "/me/threads", BOB);
      assert.notEqual(
        r.status, 200,
        `EXPECTED: a refusal. ACTUAL: 200 with ${JSON.stringify(r.body).slice(0, 120)} — ` +
          "an unreadable table is reporting as an empty inbox.",
      );
      assert.equal(r.body.error, "db_error");
      assert.equal(r.body.threads, undefined, "a refusal must not also carry a thread list");
    });
  }

  it("refuses when the member PROFILES batch is unreadable — no anonymous inbox", async () => {
    /*
      The comment above that read has always claimed it "would surface as a
      hard fetch error". Until T344 was executed it did not: the error was
      destructured away and every member came back with no profile at all.

      `afterOps` rather than a whole-table failure, and the distinction IS the
      assertion. `requireUser` already refuses at 503 `degraded_unavailable`
      when `profiles` cannot be read at all, so a whole-table error never
      reaches this batch and a test written that way would be green on a
      refusal produced by a different guard — the precise mistake §12's lane
      recorded against its own first version of RLS-04. Injecting from the
      SECOND profiles operation onward (the first is requireUser's
      account-status read) lands the failure on the batch itself, which is the
      case this change is about: a column or policy drift scoped to one query.
    */
    use(seed(), { profiles: { ...DOWN, afterOps: 1 } });
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.notEqual(
      r.status, 200,
      `EXPECTED: a refusal. ACTUAL: 200 with ${JSON.stringify(r.body).slice(0, 160)}`,
    );
    assert.equal(r.body.error, "db_error");
  });

  it("and a whole-table profiles outage is ALREADY a refusal, from an earlier guard", async () => {
    // Recorded so the test above cannot later be "simplified" back into a
    // whole-table failure that passes for the wrong reason.
    use(seed(), { profiles: DOWN });
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

// ── the inbox's secondary reads degrade, and say so ───────────────────────────

describe("T344 — context that cannot be read is OMITTED, not reported as absent", () => {
  it("omits tripCity when `trips` is unreadable — undefined, not null", async () => {
    use(seed(), { trips: DOWN });
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200, "a trip-context failure must not take the inbox down with it");
    const t = r.body.threads[0];
    assert.ok(!("tripCity" in t),
      `EXPECTED: tripCity absent (not known). ACTUAL: ${JSON.stringify(t.tripCity)} — ` +
        "null reads as 'this trip has no city', which is a different claim.");
  });

  it("and reports the real city when `trips` IS readable — the control", async () => {
    use(seed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.body.threads[0].tripCity, "Cebu");
  });

  it("marks the preview `failed` when translations are unreadable", async () => {
    use(seed(), { message_translations: DOWN });
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.threads[0].lastMessagePreview.previewTranslationStatus, "failed");
  });

  it("and carries NO such field in the normal case", async () => {
    // A marker that is always present says nothing. This is the assertion that
    // keeps the field meaningful.
    use(seed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.ok(!("previewTranslationStatus" in r.body.threads[0].lastMessagePreview));
  });
});

// ── the thread read ───────────────────────────────────────────────────────────

describe("T344 — an unreadable translation table is a FAILED translation, not a monolingual thread", () => {
  it("reports translationStatus 'failed' on an incoming message", async () => {
    use(seed(), { message_translations: DOWN });
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, BOB);
    assert.equal(r.status, 200, "the messages are real and are still delivered");
    const m = (r.body.messages as any[]).find((x) => x.id === M_FROM_ALICE);
    assert.equal(
      m.translationStatus, "failed",
      "EXPECTED: the §18 word for 'we did not translate this'. ACTUAL: " +
        `${JSON.stringify(m.translationStatus)} — null is what a same-language thread returns.`,
    );
    assert.equal(m.displayBody, "nos vemos en el muelle", "the original is still shown");
  });

  it("reports null — no claim — when the table is readable and empty", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, BOB);
    const m = (r.body.messages as any[]).find((x) => x.id === M_FROM_ALICE);
    assert.equal(m.translationStatus, null);
  });
});

// ── message requests ──────────────────────────────────────────────────────────

describe("T344 — a request list that cannot name its senders refuses", () => {
  it("refuses rather than returning requests whose sender is null", async () => {
    const s = seed();
    s.message_requests = [
      {
        id: "99999999-0000-4000-8000-000000000009", sender_id: ALICE, recipient_id: BOB,
        status: "pending", preview_text: "hey", created_at: "2026-03-11T00:00:00.000Z",
      },
    ];
    // afterOps 1 for the same reason as the inbox case: requireUser's own
    // profiles read is operation 1, the sender batch is operation 2.
    use(s, { profiles: { ...DOWN, afterOps: 1 } });
    const r = await call(harness.base, "GET", "/me/message-requests", BOB);
    assert.notEqual(
      r.status, 200,
      `EXPECTED: a refusal. ACTUAL: 200 with ${JSON.stringify(r.body).slice(0, 160)}`,
    );
    assert.equal(r.body.error, "db_error");
  });
});

// ── an inbox past PostgREST's 1,000-row cap ───────────────────────────────────
//
// TELEGRAPH lane 2026-10-03. `GET /me/threads` and `GET /me/unread-counts` read
// EVERY message of EVERY thread the caller is in, with no limit, and took the
// newest row per thread from the result. PostgREST stops a range-less select at
// `db-max-rows` (1000 on Supabase) and says nothing, so once a person's threads
// held more than 1,000 messages between them, every thread whose newest message
// was older than the 1,000th-newest overall came back with NO preview and ZERO
// unread — a quiet DM under a busy trip chat looked empty and read. The same
// cut hit the member roster (every member of every thread, unbounded): past
// 1,000 rows a DM's other person fell off and the inbox named nobody.
//
// `maxRows: 1000` is the harness modelling that cap, so these cases are red on
// the pre-change route and are the only thing that can be: on an uncapped fake
// the old read is complete by construction.

describe("an inbox past PostgREST's 1,000-row cap is still complete", () => {
  const CAROL = "cccccccc-0000-4000-8000-000000000003";
  const DM_THREAD = "00000000-0000-4000-8000-00000000000d";
  const M_FROM_CAROL = "33333333-0000-4000-8000-000000000003";
  const BUSY = 1001;

  function busySeed(opts: { members?: number } = {}): Record<string, any[]> {
    const s = seed();
    s.profile_privacy_settings = [];
    s.message_threads.push({
      id: DM_THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null,
      title: null, status: "active", is_e2ee: false,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z",
      last_message_at: "2026-02-01T00:00:00.000Z",
    });
    // A busy trip chat: BUSY messages from Alice, every one newer than Carol's DM.
    for (let i = 0; i < BUSY; i++) {
      s.messages.push({
        id: `22222222-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
        thread_id: TRIP_THREAD, sender_id: ALICE, body: `busy ${i}`,
        created_at: new Date(Date.parse("2026-03-12T00:00:00.000Z") + i * 1000).toISOString(),
        deleted_at: null, edited_at: null, original_language: "en", msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null,
        reply_to_id: null,
      });
    }
    s.message_threads[0].last_message_at =
      new Date(Date.parse("2026-03-12T00:00:00.000Z") + (BUSY - 1) * 1000).toISOString();
    // A big trip roster, inserted BEFORE the DM's memberships so a cut lands on them.
    for (let i = 0; i < (opts.members ?? 0); i++) {
      const uid = `44444444-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
      s.profiles.push({ id: uid, handle: `m${i}`, name: `Member ${i}`, show_name: true });
      s.profile_privacy_settings.push({ user_id: uid, show_real_name: true });
      s.message_thread_members.push({
        thread_id: TRIP_THREAD, user_id: uid, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
        muted_at: null, archived_at: null, visible_from_at: null,
      });
    }
    // Carol's profile and name setting come AFTER the big roster's, so a batch read that is not
    // chunked is cut exactly at her.
    s.profiles.push({ id: CAROL, handle: "carol", name: "Carol", show_name: true });
    s.profile_privacy_settings.push({ user_id: CAROL, show_real_name: true });
    for (const uid of [BOB, CAROL]) {
      s.message_thread_members.push({
        thread_id: DM_THREAD, user_id: uid, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null,
        muted_at: null, archived_at: null, visible_from_at: null,
      });
    }
    // The quiet DM: one message, older than every busy-thread message.
    s.messages.push({
      id: M_FROM_CAROL, thread_id: DM_THREAD, sender_id: CAROL, body: "are you still coming?",
      created_at: "2026-02-01T00:00:00.000Z", deleted_at: null, edited_at: null,
      original_language: "en", msg_type: "text", subtype: null, media_url: null, media_type: null,
      media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
    });
    return s;
  }

  function useCapped(state: Record<string, any[]>): FakeClient {
    const c = makeFakeClient(state, { maxRows: 1000 });
    _setTestClient(c, true);
    return c;
  }

  it("THE POINT: a quiet DM under a busy trip chat keeps its preview and its unread message", async () => {
    useCapped(busySeed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    const dm = (r.body.threads as any[]).find((t) => t.id === DM_THREAD);
    assert.ok(dm, "the DM is still listed");
    assert.ok(
      dm.lastMessagePreview,
      "EXPECTED: Carol's message as the preview. ACTUAL: no preview — the inbox read stopped at " +
        "1,000 rows and the DM's only message was past the cut.",
    );
    assert.equal(dm.lastMessagePreview.body, "are you still coming?");
    assert.equal(dm.unreadCount, 1, "Carol's message is unread; a cut read reported it read");
  });

  it("THE POINT: the busy thread's unread count is exact, not the size of the page", async () => {
    useCapped(busySeed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    const trip = (r.body.threads as any[]).find((t) => t.id === TRIP_THREAD);
    // The seed's own message in this thread is from Alice too, so every one of BUSY + 1 is unread by Bob.
    assert.equal(trip.unreadCount, BUSY + 1, `EXPECTED ${BUSY + 1} unread. ACTUAL ${trip.unreadCount}.`);
    assert.equal(trip.lastMessagePreview.body, `busy ${BUSY - 1}`, "the preview is still the newest message");
  });

  it("THE POINT: past 1,000 roster rows a DM still names the other person", async () => {
    useCapped(busySeed({ members: 1000 }));
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    const dm = (r.body.threads as any[]).find((t) => t.id === DM_THREAD);
    assert.equal(
      dm.otherMembers?.[0]?.id, CAROL,
      `EXPECTED Carol as the DM's other member. ACTUAL ${JSON.stringify(dm.otherMembers)} — ` +
        "the roster read stopped at 1,000 rows.",
    );
    // `handle` comes from her profile row whatever her name setting is, so it proves the profile batch
    // reached her: a profile cut from the batch leaves the member with no handle at all.
    assert.equal(dm.otherMembers[0].handle, "carol", "and her profile is read, not cut from the batch");
    assert.equal(dm.otherMembers[0].name, "Carol", "and her name setting is read, not cut from its batch");
    const trip = (r.body.threads as any[]).find((t) => t.id === TRIP_THREAD);
    // Alice + 1000 members; Bob is the caller and is not listed.
    assert.equal(trip.otherMembers.length, 1001, "the big roster is complete too");
  });

  it("THE POINT: the unread BADGE counts the quiet DM as well as the busy chat", async () => {
    useCapped(busySeed());
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.messages, 2,
      `EXPECTED 2 unread conversations. ACTUAL ${r.body.messages} — the badge's message read ` +
        "stopped at 1,000 rows and the DM fell off it.",
    );
  });

  it("CONTROL: an inbox under the cap is unchanged", async () => {
    useCapped(seed());
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.threads.length, 1);
    assert.equal(r.body.threads[0].unreadCount, 1);
    assert.equal(r.body.threads[0].lastMessagePreview.body, "nos vemos en el muelle");
  });

  it("a catch-up PREVIEW read that fails refuses, even when nothing in the thread is unread", async () => {
    // Bob has read Carol's DM, so no count is needed for it; only its preview has to be read past the page.
    const s = busySeed();
    for (const m of s.message_thread_members) {
      if (m.thread_id === DM_THREAD && m.user_id === BOB) m.last_read_at = "2026-02-02T00:00:00.000Z";
    }
    // Every thread read: no count query for the trip either (Bob read past its last message).
    for (const m of s.message_thread_members) {
      if (m.thread_id === TRIP_THREAD && m.user_id === BOB) m.last_read_at = "2026-04-01T00:00:00.000Z";
    }
    const c = makeFakeClient(s, { maxRows: 1000, errors: { messages: { ...DOWN, afterOps: 1 } } });
    _setTestClient(c, true);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.notEqual(r.status, 200, `EXPECTED a refusal. ACTUAL 200 ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.body.error, "db_error");
  });

  it("a catch-up COUNT read that fails refuses, even when every preview was read", async () => {
    // Operation 1 is the page, operation 2 the DM's preview; from 3 on, the exact counts fail.
    const c = makeFakeClient(busySeed(), { maxRows: 1000, errors: { messages: { ...DOWN, afterOps: 2 } } });
    _setTestClient(c, true);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.notEqual(r.status, 200, `EXPECTED a refusal. ACTUAL 200 ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.body.error, "db_error");
  });

  it("the BADGE's catch-up read that fails refuses rather than under-counting", async () => {
    const c = makeFakeClient(busySeed(), { maxRows: 1000, errors: { messages: { ...DOWN, afterOps: 1 } } });
    _setTestClient(c, true);
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.notEqual(r.status, 200, `EXPECTED a refusal. ACTUAL 200 ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "db_error");
  });

  it("the inbox is still ordered by latest activity when threads are read in chunks", async () => {
    // Insert the QUIET thread first, so read order and activity order disagree.
    const s = busySeed();
    s.message_threads.reverse();
    useCapped(s);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.deepEqual(
      (r.body.threads as any[]).map((t) => t.id), [TRIP_THREAD, DM_THREAD],
      "the busy trip chat (newest activity) is first",
    );
  });

  it("an exact count excludes the caller's own messages", async () => {
    const s = busySeed();
    s.messages.push({
      id: "22222222-0000-4000-8000-ffffffffffff", thread_id: TRIP_THREAD, sender_id: BOB, body: "on my way",
      created_at: "2026-03-13T00:00:00.000Z", deleted_at: null, edited_at: null, original_language: "en",
      msg_type: "text", subtype: null, media_url: null, media_type: null, media_thumbnail_url: null,
      media_duration_seconds: null, reply_to_id: null,
    });
    useCapped(s);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    const trip = (r.body.threads as any[]).find((t) => t.id === TRIP_THREAD);
    assert.equal(trip.unreadCount, BUSY + 1, "Bob's own message is never unread to Bob");
  });

  it("an exact count starts at the caller's read marker, not at the beginning", async () => {
    const s = busySeed();
    // Read past the seed's own message (03-11T00:00) and before every busy one (03-12) — and
    // before the page's cutoff, so the count has to be read directly.
    for (const m of s.message_thread_members) {
      if (m.thread_id === TRIP_THREAD && m.user_id === BOB) m.last_read_at = "2026-03-11T12:00:00.000Z";
    }
    useCapped(s);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    const trip = (r.body.threads as any[]).find((t) => t.id === TRIP_THREAD);
    assert.equal(trip.unreadCount, BUSY, "only the busy messages are newer than the marker");
  });

  it("an exact count and a caught-up preview both honour the §14.3 window", async () => {
    const s = busySeed();
    s.feature_flags = [{ flag: "telegraph_history_bound_enabled", enabled: true }];
    for (const m of s.message_thread_members) {
      // Bob joined the trip chat at busy message #5, and Carol's DM after her only message.
      if (m.thread_id === TRIP_THREAD && m.user_id === BOB) {
        m.visible_from_at = new Date(Date.parse("2026-03-12T00:00:00.000Z") + 5 * 1000).toISOString();
      }
      if (m.thread_id === DM_THREAD && m.user_id === BOB) m.visible_from_at = "2026-02-15T00:00:00.000Z";
    }
    useCapped(s);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    const trip = (r.body.threads as any[]).find((t) => t.id === TRIP_THREAD);
    assert.equal(trip.unreadCount, BUSY - 5, "messages before Bob's window are not his to count");
    const dm = (r.body.threads as any[]).find((t) => t.id === DM_THREAD);
    assert.equal(dm.lastMessagePreview, null, "a message before Bob's window is not his to preview");
    assert.equal(dm.unreadCount, 0);
  });

  it("a thread read past its last message costs no count query", async () => {
    const s = busySeed();
    for (const m of s.message_thread_members) {
      // The DM's marker is OLDER than the page's cutoff, so only its own last activity says it is read.
      if (m.user_id === BOB) m.last_read_at = m.thread_id === DM_THREAD ? "2026-02-02T00:00:00.000Z" : "2026-04-01T00:00:00.000Z";
    }
    const c = useCapped(s);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.equal(r.status, 200);
    const reads = c._observed.selects.filter((x) => x.table === "messages").length;
    assert.equal(reads, 2, `EXPECTED the page and the DM's preview only. ACTUAL ${reads} messages reads.`);
  });

  it("a targeted catch-up read that FAILS refuses the inbox rather than showing the DM empty", async () => {
    // Operation 1 is the bulk read; every later `messages` read is a catch-up.
    const c = makeFakeClient(busySeed(), { maxRows: 1000, errors: { messages: { ...DOWN, afterOps: 1 } } });
    _setTestClient(c, true);
    const r = await call(harness.base, "GET", "/me/threads", BOB);
    assert.notEqual(r.status, 200, `EXPECTED a refusal. ACTUAL 200 ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.body.error, "db_error");
  });
});

// ── the badge: a count that could not be read is named, not passed off as zero ─
//
// TELEGRAPH lane 2026-10-03. Five notification counts were summed as
// `count ?? 0` with their errors never bound, and the meetup-invite count the
// same: an unreadable table and "nothing pending" produced the same badge. The
// numbers stay numbers (an older client reads them exactly as before); the
// buckets that could not be measured are NAMED in `degraded`, so the app can
// keep what it last measured instead of drawing a false "nothing new".

describe("GET /me/unread-counts names a count it could not read", () => {
  it("THE POINT: an unreadable notification count is in `degraded`, and the field is still a number", async () => {
    use(seed(), { friend_requests: DOWN });
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.equal(r.status, 200, "one unreadable bucket must not take the badge down");
    assert.equal(typeof r.body.notifications, "number");
    assert.ok(
      Array.isArray(r.body.degraded) && r.body.degraded.includes("notifications"),
      `EXPECTED degraded to name 'notifications'. ACTUAL ${JSON.stringify(r.body)} — a failed count ` +
        "and a real zero are the same badge.",
    );
  });

  it("THE POINT: an unreadable meetup-invite count is in `degraded`", async () => {
    const s = seed();
    s.meetups = [{ id: "55555555-0000-4000-8000-000000000005", status: "confirmed", starts_at: "2999-01-01T00:00:00.000Z" }];
    use(s, { meetup_invites: DOWN });
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.meetups, 0, "the field keeps its old value for an older client");
    assert.ok(r.body.degraded?.includes("meetups"), `EXPECTED 'meetups' in degraded. ACTUAL ${JSON.stringify(r.body)}`);
  });

  it("THE POINT: an unreadable highlights count is in `degraded`", async () => {
    const s = seed();
    s.circle_memberships = [{ user_id: BOB, other_id: ALICE }];
    use(s, { highlights: DOWN });
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.newHighlights, 0);
    assert.ok(r.body.degraded?.includes("newHighlights"), `EXPECTED 'newHighlights' in degraded. ACTUAL ${JSON.stringify(r.body)}`);
  });

  it("CONTROL: a badge whose every count was read carries no `degraded` at all", async () => {
    use(seed());
    const r = await call(harness.base, "GET", "/me/unread-counts", BOB);
    assert.equal(r.status, 200);
    assert.ok(!("degraded" in r.body), `a marker that is always present says nothing: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.messages, 1, "Alice's message is unread by Bob");
  });
});
