/**
 * `routes/telegraphChat.ts`: six reads that discarded their error, and one of
 * them was a FAIL-OPEN on the end-to-end-encryption invariant.
 *
 * ── THE ONE THAT MATTERS ────────────────────────────────────────────────────
 * The start-poll handler refuses to post into an E2EE thread, because a poll
 * body is JSON plaintext and the route has no encryption path. The refusal read
 * the flag like this:
 *
 *     const { data: threadMeta } = await client
 *       .from("message_threads").select("is_e2ee")...
 *     if ((threadMeta as any)?.is_e2ee === true) { refuse }
 *
 * supabase-js RESOLVES on a database error — it does not throw. So an
 * unreadable `message_threads` yields `{ data: null, error: <err> }`, the
 * discarded error is invisible, `null?.is_e2ee === true` is `false`, and the
 * plaintext poll body is written into a thread that may be end-to-end
 * encrypted. The gate that exists to prevent exactly that outcome opened.
 *
 * This is not an open design question. `routes/messaging.ts` makes the IDENTICAL
 * decision on the media path and binds the error, and its comment states the
 * reasoning in the same terms: an unreadable flag "read as `is_e2ee: false` and
 * let a plaintext media message through the one gate that exists to stop it".
 * Two files, one decision, two answers. This file settles it the way the
 * already-correct one does.
 *
 * ── THE OTHER FIVE ──────────────────────────────────────────────────────────
 * Same class, the shape §17.8/§18 closed twelve times elsewhere: an outage
 * became a confident statement about the world.
 *
 *   - `GET .../telegraph/suggestions` answered `{ suggestions: [] }` — "you have
 *     none" — from a read that never happened.
 *   - add-to-plan, create-meetup and start-poll each answered `not_found`
 *     — "no such suggestion" — from a read that never happened.
 *   - dismiss skipped its preference event silently; it is now logged at error.
 *     It is deliberately NOT refused: that event is best-effort by construction
 *     (the insert below it warns rather than failing), so turning a cosmetic
 *     outage into a failed dismiss would be a worse answer than the defect. It
 *     has no case here because the harness cannot fail one operation on a table
 *     without failing the UPDATE beside it, and a case that cannot isolate its
 *     subject asserts nothing.
 *
 * ── POSTURE, AND WHY EVERY CASE IS PAIRED ───────────────────────────────────
 * Routes bind the error, log it, and answer `degraded_unavailable` — this
 * codebase's code for "the check was NOT PERFORMED", and the only code marked
 * retryable in `lib/http.ts` RETRYABLE_CODES.
 *
 * A file that only asserted "an outage is not a 200" would pass against a route
 * that had been deleted, or one that refuses everything. So each outage case is
 * paired with CONTROLs on a healthy tree: the real suggestions arrive, a
 * genuinely absent suggestion still answers `not_found` (the refusal was
 * narrowed, not replaced), and a genuinely E2EE thread still answers
 * `e2ee_thread`.
 *
 * The E2EE outage case asserts on the STORE, not only the status: no `messages`
 * row may be inserted. A 503 with the plaintext already written would satisfy a
 * status assertion and violate the invariant.
 *
 * Run: node --import tsx/esm --test src/test/telegraphChatOutageHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import telegraphChatRouter from "../routes/telegraphChat.js";
import {
  makeFakeClient,
  startRouter,
  resetFakeIds,
  call,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-00000000000e";
const E2EE_THREAD = "00000000-0000-4000-8000-00000000001e";
const SUG = "55555555-0000-4000-8000-000000000005";
const GONE = "99999999-0000-4000-8000-000000000009";
const TRIP = "33333333-0000-4000-8000-000000000003";

const down = (t: string) => ({ message: `permission denied for relation ${t}`, code: "42501" });

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [{ id: A, handle: "a", name: "Ana", account_status: null }],
    profile_privacy_settings: [],
    trips: [{ id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: A }],
    trip_members: [{ trip_id: TRIP, user_id: A, status: "accepted", role: "owner" }],
    message_threads: [
      { id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null,
        title: "Lisbon", status: "active", is_e2ee: false },
      { id: E2EE_THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null,
        title: null, status: "active", is_e2ee: true },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: A, role: "owner", left_at: null },
      { thread_id: E2EE_THREAD, user_id: A, role: "member", left_at: null },
    ],
    messages: [],
    telegraph_chat_suggestions: [
      { id: SUG, user_id: A, thread_id: THREAD, status: "shown",
        intent_type: "food", title: "Tapas near the hotel", reason: "you asked about dinner",
        category: "food", action_type: "add_to_plan",
        location_context: "Baixa", time_context: "tonight",
        trip_id: TRIP, circle_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z" },
    ],
    telegraph_preference_events: [],
    ...over,
  };
}

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

let harness: RouterHarness;
before(async () => { harness = await startRouter(telegraphChatRouter); });
after(async () => { await harness.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); });

const SUGGESTIONS = `/threads/${THREAD}/telegraph/suggestions`;

describe("the E2EE gate on start-poll cannot be opened by an outage", () => {
  it("CONTROL — a non-E2EE thread accepts the poll, and a message row is written", async () => {
    const c = use(store());
    const r = await call(harness.base, "POST", `${SUGGESTIONS}/${SUG}/start-poll`, A,
      { options: ["Morning", "Evening"] });
    assert.notEqual(r.body?.error, "e2ee_thread", "a plain thread must not be refused as encrypted");
    assert.notEqual(r.body?.error, "degraded_unavailable", "a healthy tree must not report degradation");
    assert.equal(
      c._observed.inserts.filter((i) => i.table === "messages").length, 1,
      "the healthy path must actually post the poll — otherwise the outage case proves nothing",
    );
  });

  it("CONTROL — a genuinely E2EE thread is refused, and nothing is written", async () => {
    const c = use(store());
    const r = await call(harness.base, "POST",
      `/threads/${E2EE_THREAD}/telegraph/suggestions/${SUG}/start-poll`, A,
      { options: ["Morning", "Evening"] });
    assert.equal(r.body?.error, "e2ee_thread");
    assert.equal(r.status, 422);
    assert.equal(c._observed.inserts.filter((i) => i.table === "messages").length, 0);
  });

  it("an unreadable `message_threads` REFUSES, and writes no plaintext", async () => {
    const c = use(store(), { errors: { message_threads: down("message_threads") } });
    const r = await call(harness.base, "POST", `${SUGGESTIONS}/${SUG}/start-poll`, A,
      { options: ["Morning", "Evening"] });
    assert.equal(r.body?.error, "degraded_unavailable",
      "an unreadable is_e2ee flag must not be read as `false`");
    assert.equal(r.status, 503);
    assert.equal(
      c._observed.inserts.filter((i) => i.table === "messages").length, 0,
      "THE INVARIANT: no plaintext poll body may reach a thread whose E2EE flag could not be read",
    );
  });
});

describe("an unreadable suggestions table is not an empty suggestions list", () => {
  it("CONTROL — the real suggestion arrives on a healthy tree", async () => {
    use(store());
    const r = await call(harness.base, "GET", SUGGESTIONS, A);
    assert.equal(r.status, 200);
    assert.equal(r.body.suggestions.length, 1);
    assert.equal(r.body.suggestions[0].title, "Tapas near the hotel");
  });

  it("CONTROL — a user with no suggestions gets an empty list, not a refusal", async () => {
    use(store({ telegraph_chat_suggestions: [] }));
    const r = await call(harness.base, "GET", SUGGESTIONS, A);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.suggestions, [],
      "a genuine absence must still read as absence — the refusal is for outages only");
  });

  it("an outage REFUSES rather than answering that there are none", async () => {
    use(store(), { errors: { telegraph_chat_suggestions: down("telegraph_chat_suggestions") } });
    const r = await call(harness.base, "GET", SUGGESTIONS, A);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(r.status, 503);
  });
});

/**
 * §20.7, executed. Three sites in this tree answered `forbidden` — "You are not
 * an active member of this thread", "You are not an accepted member of that
 * trip" — from a membership read whose error was discarded. That is SAFE, so it
 * is not the T344/T363 defect and it did not count against those rows. It is
 * still false: the server does not know whether the caller is a member, and it
 * told them, by name, that they are not.
 *
 * Two properties are asserted together, and neither is sufficient alone. A
 * suite that only asserted "an outage is not a 200" would pass against a route
 * that refuses everybody, so each case is PAIRED with a control proving a
 * genuine non-member is still refused 403 with the same words. And the refusal
 * must not be `forbidden`: a 403 tells the client the answer is settled and
 * there is nothing to retry.
 */
describe("an unreadable membership is not a non-membership — the thread gate", () => {
  it("CONTROL — a genuine non-member is still refused 403, by name", async () => {
    use(store({ message_thread_members: [] }));
    const r = await call(harness.base, "GET", SUGGESTIONS, A);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "forbidden");
  });

  it("CONTROL — a member who LEFT is still refused 403", async () => {
    use(store({
      message_thread_members: [
        { thread_id: THREAD, user_id: A, role: "owner", left_at: "2026-01-01T00:00:00.000Z" },
      ],
    }));
    assert.equal((await call(harness.base, "GET", SUGGESTIONS, A)).status, 403);
  });

  it("an unreadable `message_thread_members` REFUSES, and does not say they are not a member", async () => {
    use(store(), { errors: { message_thread_members: down("message_thread_members") } });
    const r = await call(harness.base, "GET", SUGGESTIONS, A);
    assert.equal(
      r.body?.error,
      "degraded_unavailable",
      "a membership read that never happened cannot state that the caller is not a member",
    );
    assert.equal(r.status, 503);
    assert.equal(
      String(r.body?.message ?? "").includes("not an active member"),
      false,
      "the outage still told the caller they are not a member of their own conversation",
    );
  });

  it("every handler behind this gate refuses the same way, not just the first", async () => {
    // `verifyThreadMember` is called from five handlers. A fix applied at one
    // call site and not the helper would pass a single-route case.
    for (const [method, path, body] of [
      ["GET", SUGGESTIONS, undefined],
      ["POST", `${SUGGESTIONS}/${SUG}/add-to-plan`, { tripId: TRIP, title: "Tapas near the hotel" }],
      ["POST", `${SUGGESTIONS}/${SUG}/create-meetup`, {}],
      ["POST", `${SUGGESTIONS}/${SUG}/start-poll`, { options: ["Morning", "Evening"] }],
    ] as const) {
      use(store(), { errors: { message_thread_members: down("message_thread_members") } });
      const r = await call(harness.base, method as any, path, A, body as any);
      assert.equal(r.body?.error, "degraded_unavailable", `${method} ${path} still claimed non-membership`);
    }
  });
});

describe("an unreadable membership is not a non-membership — the trip gate", () => {
  const ADD = `${SUGGESTIONS}/${SUG}/add-to-plan`;
  const BODY = { tripId: TRIP, title: "Tapas near the hotel" };

  it("CONTROL — somebody genuinely not on the trip is still refused 403", async () => {
    use(store({ trip_members: [] }));
    const r = await call(harness.base, "POST", ADD, A, BODY);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "forbidden");
  });

  it("an unreadable `trip_members` REFUSES rather than denying trip membership", async () => {
    use(store(), { errors: { trip_members: down("trip_members") } });
    const r = await call(harness.base, "POST", ADD, A, BODY);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(r.status, 503);
    assert.equal(
      String(r.body?.message ?? "").includes("not an accepted member"),
      false,
    );
  });
});

// Each handler validates its own body before it reads the suggestion, so the
// body has to be VALID for that route or the case never reaches the read it is
// about — it would assert `invalid_payload` and prove nothing. Measured: with a
// poll body on add-to-plan, both of its cases reported `invalid_payload`.
const BODIES: Record<string, any> = {
  "add-to-plan": { tripId: TRIP, title: "Tapas near the hotel" },
  "create-meetup": {},
  "start-poll": { options: ["Morning", "Evening"] },
};

for (const [path, label] of [
  ["add-to-plan", "add-to-plan"],
  ["create-meetup", "create-meetup"],
  ["start-poll", "start-poll"],
] as const) {
  describe(`an unreadable suggestion is not a missing suggestion — ${label}`, () => {
    it("CONTROL — a suggestion that genuinely does not exist still answers not_found", async () => {
      use(store());
      const r = await call(harness.base, "POST", `${SUGGESTIONS}/${GONE}/${path}`, A, BODIES[path]);
      assert.equal(r.body?.error, "not_found",
        "the narrowed refusal must not swallow the real not_found");
      assert.equal(r.status, 404);
    });

    it("an outage REFUSES rather than reporting the suggestion as nonexistent", async () => {
      use(store(), { errors: { telegraph_chat_suggestions: down("telegraph_chat_suggestions") } });
      const r = await call(harness.base, "POST", `${SUGGESTIONS}/${SUG}/${path}`, A, BODIES[path]);
      assert.equal(r.body?.error, "degraded_unavailable",
        `${label}: a read that never happened cannot say the suggestion does not exist`);
      assert.equal(r.status, 503);
    });
  });
}
