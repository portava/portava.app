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
