/**
 * Telegraph §27.2 — the twelve adversarial fixtures, executed.
 *
 * §27.2 names twelve interleavings and abuses. Each is driven here against the
 * real route, resolver or bus. Where the outcome today is not the one the spec
 * wants, the fixture asserts TODAY'S outcome with the required outcome written
 * beside it in the message, so closing the gap turns this suite red rather than
 * leaving a passing test that describes a system nobody has any more.
 *
 * SHOWN RED BEFORE GREEN — deliberate, reverted mutations, one per family:
 *   - F-02: lib/blockGuard.ts `if (error) return true` → `return false`. The
 *     blocks-unreadable retry passed through; F-02 failed.
 *   - F-04: lib/telegraphEvents.ts — the try/catch around a subscriber callback
 *     removed, so one throwing subscriber aborted the fan-out. F-04 failed on
 *     the "the other subscribers still receive it" assertion.
 *   - F-06: routes/messaging.ts — the `markTranslationsPending` call in the EDIT
 *     handler deleted. Two corrections came out of this one. First, a row-state
 *     assertion stayed GREEN through the mutation, because the route fires the
 *     re-translation without awaiting it and the regeneration rewrites the row;
 *     the assertion now measures the invalidation WRITE. Second, there are two
 *     markTranslationsPending call sites (the edit path and the translate-retry
 *     path) and deleting the wrong one also left the suite green. The mutation
 *     that finally made F-06 fail was the edit handler's, which is the call site
 *     this fixture is about.
 *   - F-08: services/groupChatSync.ts — the departed-member reconciliation
 *     (`left_at` marking) short-circuited. F-08 failed.
 *   - F-01/F-03/F-07/F-09/F-12 are the DIVERGENT ones and went red the other way
 *     round: each was first written asserting the spec's required outcome and
 *     observed to fail on today's tree, and the assertion was then rewritten
 *     against the real outcome with the requirement quoted in the message.
 *     F-07's first version failed for the WRONG reason — it removed the sender
 *     before the handler's own membership check, so the 403 it got proved only
 *     that the check works. It now mutates the roster on the second read, after
 *     that check has passed, which is the window the fixture is about.
 *   - F-01's first run reported an unbounded flood that the real database does
 *     not have: the fake applied no column default, so message_requests.status
 *     came back undefined and the route's short-circuit could never fire. The
 *     harness grew `columnDefaults` for that reason, and the fixture now
 *     measures the dedupe instead of the fake's omission.
 *
 * Run: node --import tsx/esm --test src/test/telegraphAdversarialFixtures.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { SEND_LIMITS, _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import { syncTripChatMembers } from "../services/groupChatSync.js";
import {
  publishToUsersLocal,
  subscribe,
  telegraphEmitterStats,
  type TelegraphEvent,
} from "../lib/telegraphEvents.js";
import { isRabBookingCallEligible } from "../lib/calls/callGatewayAdapter.js";
import { isVisibleTo } from "../services/passport/OpenToPlansService.js";
import { TELEGRAPH_ADVERSARIAL_FIXTURES } from "../domain/telegraph/invariants/adversarialFixtures.js";
import {
  makeFakeClient,
  startRouter,
  call,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const DM = "00000000-0000-4000-8000-00000000000d";
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP = "00000000-0000-4000-8000-0000000000b1";
const MSG = "11111111-0000-4000-8000-000000000001";

function baseStore(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", preferred_language: "en" },
      { id: B, handle: "b", name: "B", preferred_language: "es" },
      { id: C, handle: "c", name: "C", preferred_language: "en" },
    ],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [],
    message_threads: [
      { id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null },
      { id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "T",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: TRIP_THREAD, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: TRIP_THREAD, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [],
    message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: A, role: "owner" },
      { trip_id: TRIP, user_id: B, role: "member" },
    ],
    ...over,
  };
}

/**
 * The database default this fixture family depends on. message_requests.status
 * defaults to 'pending', and the route's one-request-per-pair short-circuit
 * reads it back. Declared here rather than assumed, because without it the
 * anti-flood property below is unobservable.
 */
const REQUEST_DEFAULTS = { message_requests: { status: "pending" } };

let harness: RouterHarness;
before(async () => { harness = await startRouter(messagingRouter); });
after(async () => { await harness.close(); });

function use(store: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  // THE SEND LIMITER IS PROCESS-WIDE STATE AND MUST BE RESET HERE.
  // The §12–§22 lane gave the send path the rate limit §22 asks for, and its
  // bucket lives in a module-level Map keyed by user, not in the fake client.
  // Without this reset the twenty-first send in the FILE gets 429 no matter
  // which fixture issued it, and four fixtures below started failing for a
  // reason that had nothing to do with what they measure — F-02's blocked
  // retry came back 429 instead of 403, which is still a refusal but proves
  // nothing about the block guard. A fixture that cannot tell "refused because
  // blocked" from "refused because throttled" is not measuring anything.
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(store, opts);
  _setTestClient(c, true);
  return c;
}

// ── Shape ─────────────────────────────────────────────────────────────────────

describe("§27.2 fixtures — shape", () => {
  it("declares exactly the spec's twelve fixtures, one census row each", () => {
    assert.equal(TELEGRAPH_ADVERSARIAL_FIXTURES.length, 12);
    assert.deepEqual(
      TELEGRAPH_ADVERSARIAL_FIXTURES.map((f) => f.id),
      ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-08", "F-09", "F-10", "F-11", "F-12"],
    );
    assert.equal(new Set(TELEGRAPH_ADVERSARIAL_FIXTURES.map((f) => f.censusRow)).size, 12);
  });
});

// ── F-01 stranger spam and request flooding ──────────────────────────────────

describe("F-01 — stranger spam and request flooding", () => {
  it("a stranger firing requests at ONE recipient is bounded to one delivered request", async () => {
    const c = use(baseStore(), { columnDefaults: REQUEST_DEFAULTS });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await call(harness.base, "POST", `/users/${B}/message-request`, C, { message: `hi ${i}` });
      statuses.push(r.status);
    }
    assert.ok(statuses.every((s) => s < 400), `every attempt was accepted: ${statuses.join(",")}`);
    assert.equal(
      (c._store.message_requests ?? []).length,
      1,
      "the anti-harassment property: a pending request short-circuits, so eight " +
        "attempts deliver ONE request to the recipient",
    );
  });

  it("but the SAME stranger can flood many recipients unbounded — the divergence", async () => {
    const recipients = Array.from({ length: 12 }, (_, i) =>
      `dddddddd-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`);
    const store = baseStore();
    store.profiles = [...store.profiles, ...recipients.map((id) => ({ id, handle: id.slice(0, 6) }))];
    const c = use(store, { columnDefaults: REQUEST_DEFAULTS });
    for (const id of recipients) {
      const r = await call(harness.base, "POST", `/users/${id}/message-request`, C, { message: "hi" });
      assert.ok(r.status < 400, `recipient ${id} rejected with ${r.status}`);
    }
    assert.equal(
      (c._store.message_requests ?? []).length,
      12,
      "EXPECTED: request flooding constrained. ACTUAL: there is no per-sender rate " +
        "limit across recipients anywhere in the messaging tree, so one account " +
        "reaches as many strangers as it has time for.",
    );
  });

  it("an unreadable request table REFUSES rather than delivering a second request", async () => {
    use(baseStore(), { errors: { message_requests: { message: "down" } } });
    const r = await call(harness.base, "POST", `/users/${B}/message-request`, C, { message: "hi" });
    assert.ok(r.status >= 400, "unknown existing-request state must not deliver another one");
  });

  it("in-thread sends are NO LONGER unlimited: the absence this fixture recorded is closed", async () => {
    // REWRITTEN BY THE INTEGRATOR, and the rewrite is the point of the file's
    // own contract: "closing the gap turns this suite red rather than leaving a
    // passing test that describes a system nobody has any more." It went red on
    // exactly that. When this fixture was written, census T279 measured the two
    // halves of §22's rate limits separately and found the SEND half missing —
    // routes/messaging.ts contained no checkRateLimit call, so the case asserted
    // twenty-five accepted sends and named the absence. The §12–§22 lane then
    // built domain/telegraph/policies/sendRateLimit.ts and wired it into the
    // send path, so the absence is gone and asserting it would now be a lie.
    // What is asserted instead is the new behaviour, at the boundary: the
    // strictest tier's limit is honoured exactly, not approximately.
    const limit = SEND_LIMITS.stranger;
    const c = use(baseStore());
    const statuses: number[] = [];
    for (let i = 0; i < limit + 5; i++) {
      const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: `m${i}` });
      statuses.push(r.status);
    }
    assert.deepEqual(
      statuses.slice(0, limit),
      Array.from({ length: limit }, () => 201),
      `the first ${limit} sends are accepted — the limit bounds a burst, it is not a block`,
    );
    assert.deepEqual(
      statuses.slice(limit),
      Array.from({ length: 5 }, () => 429),
      "and every send past the tier's limit is refused with 429, not silently dropped",
    );
    assert.equal(
      c._store.messages.length,
      limit,
      "the refusal is a REFUSAL: no row is written for a send past the limit",
    );
  });
});

// ── F-02 blocked sender retrying on a stale device ───────────────────────────

describe("F-02 — blocked sender retrying on a stale device", () => {
  it("every retry is refused: healthy, blocks-unreadable, and roster-unreadable", async () => {
    const blocked = baseStore({ blocks: [{ blocker_id: B, blocked_id: A }] });

    const c1 = use(blocked);
    for (let i = 0; i < 3; i++) {
      const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: `retry ${i}` });
      assert.equal(r.status, 403, `healthy retry ${i}`);
    }
    assert.equal(c1._store.messages.length, 0);

    const c2 = use(baseStore(), { errors: { blocks: { message: "down" } } });
    const r2 = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "retry" });
    assert.equal(r2.status, 403, "an unreadable blocks table denies");
    assert.equal(c2._store.messages.length, 0);

    const c3 = use(blocked, { errors: { message_thread_members: { message: "down", afterOps: 1 } } });
    const r3 = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "retry" });
    assert.equal(r3.body.error, "degraded_unavailable", "an unreadable roster refuses the send");
    assert.equal(c3._store.messages.length, 0);
  });

  it("the stale device's belief is CORRECT — blocking does not close the thread", async () => {
    const c = use(baseStore({ blocks: [{ blocker_id: B, blocked_id: A }] }));
    const membership = c._store.message_thread_members.filter(
      (m: any) => m.thread_id === DM && m.left_at === null,
    );
    assert.equal(membership.length, 2,
      "both parties are still active members after a block — which is exactly why " +
      "the per-send re-check is the only thing standing between them");
  });
});

// ── F-03 duplicate send and offline resend ───────────────────────────────────

describe("F-03 — duplicate send and offline resend", () => {
  it("the same clientId posted twice creates TWO canonical rows — the divergence", async () => {
    const c = use(baseStore());
    const payload = { body: "did that send?", clientId: "offline-retry-1" };
    const first = await call(harness.base, "POST", `/threads/${DM}/messages`, A, payload);
    const second = await call(harness.base, "POST", `/threads/${DM}/messages`, A, payload);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(
      c._store.messages.length,
      2,
      "EXPECTED BY §28: duplicate canonical messages = 0 under an idempotency " +
        "contract. ACTUAL: clientId is echoed for optimistic correlation and " +
        "nothing else — no uniqueness constraint, no upsert, no idempotency key.",
    );
    assert.notEqual(first.body.id, second.body.id, "and they are two distinct messages");
  });
});

// ── F-04 out-of-order realtime events ────────────────────────────────────────

describe("F-04 — out-of-order realtime events", () => {
  it("per-subscriber order is the publish order, and one throwing subscriber cannot silence the rest", () => {
    const received: string[] = [];
    const alsoReceived: string[] = [];
    const before = telegraphEmitterStats();

    const offBad = subscribe(A, () => { throw new Error("this connection is wedged"); });
    const offGood = subscribe(A, (e: TelegraphEvent) => { received.push(String(e.payload?.seq)); });
    const offOther = subscribe(B, (e: TelegraphEvent) => { alsoReceived.push(String(e.payload?.seq)); });

    try {
      for (const seq of [3, 1, 2]) {
        publishToUsersLocal([A, B], {
          type: "message.created",
          threadId: DM,
          payload: { seq },
          ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
        });
      }
    } finally {
      offBad(); offGood(); offOther();
    }

    assert.deepEqual(received, ["3", "1", "2"],
      "the bus introduces no reordering of its own — what it was handed is what arrives");
    assert.deepEqual(alsoReceived, ["3", "1", "2"], "and every audience member sees the same order");

    const after = telegraphEmitterStats();
    assert.ok(after.subscriberErrors - before.subscriberErrors >= 3,
      "a swallowed subscriber failure must be COUNTED, or a realtime outage is a rumour");
    assert.ok(after.delivered - before.delivered >= 6, "the healthy subscribers still received every event");
  });

  it("a reordered event cannot lose a message: the canonical row is committed before any publish", async () => {
    const c = use(baseStore());
    const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "canonical" });
    assert.equal(r.status, 201);
    assert.equal(c._store.messages.length, 1,
      "the row exists whatever the bus did with the event — the client's poll re-reads it");
  });
});

// ── F-05 location expires while the owner's device is offline ────────────────

describe("F-05 — location expires while the owner's device is offline", () => {
  it("an availability window expires on the READ, with no writer and no sweep", () => {
    const w = {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-06-01T00:00:00.000Z",
      expiresAt: null,
      source: "explicit" as const,
      visibility: "public" as const,
    };
    const justBefore = Date.parse("2026-05-31T23:59:59.000Z");
    const justAfter = Date.parse("2026-06-01T00:00:01.000Z");
    assert.equal(isVisibleTo(w as any, "follower", justBefore), true);
    assert.equal(isVisibleTo(w as any, "follower", justAfter), false,
      "nothing ran in between — the predicate recomputes expiry on every call");
  });

  it("the safe-return live share refuses after its expiry with the owner offline", async () => {
    const express = (await import("express")).default;
    const { createServer } = await import("node:http");
    const { requireSafeReturnRecipient } = await import("../services/safeReturn/SafeReturnPrivacyGuard.js");
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error() {}, warn() {} }; next(); });
    app.get("/api/share/:shareId", requireSafeReturnRecipient, (_req: any, res: any) => res.json({ reached: true }));
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const SHARE = "eeeeeeee-0000-4000-8000-000000000009";
    use({ safe_return_live_shares: [{
      id: SHARE, user_id: A, recipient_user_id: B, recipient_contact_id: null,
      status: "active", expires_at: "2020-01-01T00:00:00.000Z",
    }] });
    const r = await call(`http://127.0.0.1:${port}/api`, "GET", `/share/${SHARE}`, B);
    assert.equal(r.status, 404);
    assert.ok(!r.body.reached, "the handler never ran, so no coordinates were even assembled");
    await new Promise<void>((res) => server.close(() => res()));
  });
});

// ── F-06 edit while translation is generating ────────────────────────────────

describe("F-06 — edit while translation/transcript is generating", () => {
  it("an edit invalidates the in-flight translations of the OLD body rather than merging them", async () => {
    const store = baseStore({
      messages: [{
        id: MSG, thread_id: DM, sender_id: A, body: "meet at 7", created_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: "en", msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
      }],
      message_translations: [
        // Mid-flight: a translation of the PREVIOUS body, already marked done.
        { id: "t1", message_id: MSG, recipient_id: B, source_language: "en", target_language: "es",
          translated_body: "nos vemos a las 7", status: "done" },
      ],
    });
    const c = use(store);
    const r = await call(harness.base, "PATCH", `/threads/${DM}/messages/${MSG}`, A, { body: "meet at 9" });
    assert.equal(r.status, 200);
    assert.equal(r.body.body, "meet at 9");

    // Measured on the OBSERVED write, not on the row's final state: the route
    // fires the re-translation without awaiting it, so by the time an assertion
    // runs the row may have been rewritten by the regeneration — which means a
    // row-state assertion stays green even with the invalidation deleted.
    // Confirmed: with `markTranslationsPending` removed from the edit handler,
    // a row-state assertion passed and this one fails.
    const invalidations = c._observed.updates.filter(
      (u) => u.table === "message_translations" && u.patch?.status === "pending",
    );
    assert.equal(invalidations.length, 1,
      "the edit must invalidate the in-flight translations of the previous body");
    assert.equal(invalidations[0].patch.translated_body, null,
      "and clear the stale translated text rather than leaving it beside a new original");
    assert.equal(c._store.messages[0].body, "meet at 9", "the ORIGINAL field carries the new original");
    assert.ok(c._store.messages[0].edited_at, "and the edit is marked, not hidden");
  });

  it("the original is never overwritten by a derived translation (§29)", async () => {
    const c = use(baseStore({
      messages: [{
        id: MSG, thread_id: DM, sender_id: A, body: "original text", created_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null, edited_at: null, original_language: "en", msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
      }],
      message_translations: [
        { id: "t2", message_id: MSG, recipient_id: B, source_language: "en", target_language: "es",
          translated_body: "texto original", status: "done" },
      ],
    }));
    const r = await call(harness.base, "GET", `/threads/${DM}/messages`, B);
    assert.equal(r.status, 200);
    const m = (r.body.messages as any[]).find((x) => x.id === MSG);
    assert.equal(c._store.messages[0].body, "original text",
      "the canonical row still holds the sender's words");
    assert.ok(m, "and the message is returned to the recipient");
  });
});

// ── F-07 participant removed mid-send ────────────────────────────────────────

describe("F-07 — participant removed mid-send", () => {
  it("a removal landing between the membership check and the insert does NOT stop the send", async () => {
    let reads = 0;
    const c = use(baseStore(), {
      onRead: (table, store) => {
        if (table !== "message_thread_members") return;
        reads++;
        // reads === 2 is the roster read, which happens AFTER the handler's own
        // membership check has already passed. Mutating on read 1 would remove
        // the sender before that check and prove nothing but that the check
        // works — measured, the first version of this fixture did exactly that
        // and reported 403.
        if (reads === 2) {
          for (const m of store.message_thread_members) {
            if (m.thread_id === DM && m.user_id === A) m.left_at = "2026-01-02T00:00:00.000Z";
          }
        }
      },
    });
    const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "slipping through" });
    assert.equal(
      r.status,
      201,
      "EXPECTED: a participant removed mid-send does not deliver. ACTUAL: membership " +
        "is checked once at the top of the handler and the insert that follows is " +
        "not conditioned on it, so a removal inside that window produces a message " +
        "from a non-member. Closing it needs a conditional insert or a " +
        "membership-scoped write path, not a test change.",
    );
    assert.equal(c._store.messages.length, 1);
    const senderRow = c._store.message_thread_members.find((m: any) => m.thread_id === DM && m.user_id === A);
    assert.ok(senderRow.left_at, "and the sender was no longer a member when the row was written");
  });

  it("the very next read by that same sender denies, so the window is exactly one request wide", async () => {
    const store = baseStore();
    for (const m of store.message_thread_members) {
      if (m.thread_id === DM && m.user_id === A) m.left_at = "2026-01-02T00:00:00.000Z";
    }
    use(store);
    const r = await call(harness.base, "GET", `/threads/${DM}/messages`, A);
    assert.equal(r.status, 403);
  });
});

// ── F-08 trip membership revoked while the thread is open ────────────────────

describe("F-08 — trip membership revoked while the thread is open", () => {
  it("after the real sync reconciles, the open thread denies both read and send", async () => {
    const store = baseStore();
    store.trip_members = store.trip_members.filter((m: any) => m.user_id !== B);
    const c = use(store);

    const beforeRead = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, B);
    assert.equal(beforeRead.status, 200, "the client's open thread still works until the sync lands");

    await syncTripChatMembers(c as any, TRIP);

    const afterRead = await call(harness.base, "GET", `/threads/${TRIP_THREAD}/messages`, B);
    const afterSend = await call(harness.base, "POST", `/threads/${TRIP_THREAD}/messages`, B, { body: "still here" });
    assert.equal(afterRead.status, 403);
    assert.equal(afterSend.status, 403);
    assert.equal(c._store.messages.length, 0, "and nothing was written on the way out");
  });

  it("the sync is idempotent: running it twice converges rather than flapping", async () => {
    const store = baseStore();
    store.trip_members = store.trip_members.filter((m: any) => m.user_id !== B);
    const c = use(store);
    await syncTripChatMembers(c as any, TRIP);
    const firstLeftAt = c._store.message_thread_members.find(
      (m: any) => m.thread_id === TRIP_THREAD && m.user_id === B,
    ).left_at;
    await syncTripChatMembers(c as any, TRIP);
    const secondLeftAt = c._store.message_thread_members.find(
      (m: any) => m.thread_id === TRIP_THREAD && m.user_id === B,
    ).left_at;
    assert.ok(firstLeftAt);
    assert.equal(firstLeftAt, secondLeftAt, "a second reconciliation does not re-stamp the departure");
  });
});

// ── F-09 buddy booking cancelled during coordination ─────────────────────────

describe("F-09 — buddy booking cancelled during coordination", () => {
  it("the NEXT call start after a cancellation is refused; the live one rides out by policy", () => {
    assert.equal(isRabBookingCallEligible({ status: "in_progress" }), true);
    assert.equal(isRabBookingCallEligible({ status: "cancelled" }), false,
      "the next start attempt is denied — eligibility is re-derived from the booking row");
    assert.equal(isRabBookingCallEligible({ status: "disputed" }), true,
      "a dispute deliberately keeps messaging and calling, which is a stated policy");
  });

  it("the booking card rendered into the thread re-checks nothing — the divergence", () => {
    const src = readFileSync(
      resolve(process.cwd(), "../../travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx"),
      "utf8",
    );
    assert.equal(/\bfetch\s*\(/.test(src), false,
      "EXPECTED: booking-only actions disabled immediately. ACTUAL: the card performs no fetch.");
    assert.equal(/useEffect\s*\(/.test(src), false, "and no effect re-resolves the booking state");
  });
});

// ── F-10 AI summary sees conflicting messages ────────────────────────────────

describe("F-10 — AI summary sees conflicting messages", () => {
  const src = () => readFileSync(resolve(process.cwd(), "src/routes/telegraphCommands.ts"), "utf8");

  it("every proposed action is a PROPOSAL: requires_confirmation is a literal type, not a flag", () => {
    const s = src();
    assert.ok(/requires_confirmation:\s*true;/.test(s),
      "the interface must pin the literal `true`, so an unconfirmable action is unrepresentable");
    assert.equal(/requires_confirmation:\s*(false|boolean)/.test(s), false,
      "nothing may declare an action that skips confirmation");
  });

  it("confirmation re-verifies trip membership at execution rather than trusting the proposal", () => {
    const s = src();
    const registry = readFileSync(resolve(process.cwd(), "src/services/telegraph/actionRegistry.ts"), "utf8");
    /*
     * §30A.10 moved the four hooks out of this handler and into
     * `services/telegraph/actionRegistry.ts`. The REQUIREMENT is unchanged and
     * this assertion follows it rather than the line it used to live on: the
     * confirm path must RE-DERIVE membership from the source domain at
     * execution time. It now does so twice — once to authorize, and once as
     * §30A.11's post-write recheck, which is what makes `compensate` reachable.
     * Each clause below fails if that chain is broken at a different link.
     */
    assert.ok(/isAcceptedTripMember\(ctx\.client, ctx\.tripId, ctx\.userId\)/.test(registry),
      "the registry's authorize hook must re-derive membership from trip_members");
    assert.ok(/const authorization = await registration\.authorize\(ctx\);/.test(s),
      "the confirm path must call the authorize hook before writing anything");
    assert.ok(/const recheck = await registration\.authorize\(ctx\);/.test(s),
      "…and recheck it AFTER the write, so a membership lost mid-flight fails safely (§30A.11)");
    assert.ok(/compensateFor\(registration, ctx, execution\)/.test(s),
      "…compensating the record it had already written");
    assert.ok(/stored\._userId !== user\.id/.test(s),
      "and a command may only be confirmed by the user who issued it");
  });

  it("so a thread the model read wrongly can produce a wrong SUGGESTION and never a wrong trip", () => {
    const s = src();
    // The safety property is structural: no write to a canonical trip table
    // happens on the command path before a human confirms.
    const beforeConfirm = s.slice(0, s.indexOf("confirm-action"));
    assert.equal(/\.from\("trip_plan_items"\)[\s\S]{0,80}\.insert/.test(beforeConfirm), false);
    assert.equal(/\.from\("trips"\)[\s\S]{0,80}\.(insert|update)/.test(beforeConfirm), false);
  });
});

// ── F-11 unsend races recipient seen update ──────────────────────────────────

describe("F-11 — unsend races recipient seen update", () => {
  it("there is no unsend operation, so there is no race to run", () => {
    const s = readFileSync(resolve(process.cwd(), "src/routes/messaging.ts"), "utf8");
    assert.equal(/router\.(post|delete|patch)\([^)]*unsend/i.test(s), false);
    assert.equal(/telegraph_unsend_message_before_seen/.test(s), false);
  });

  it("the receipt the race would turn on DOES exist, which is why a competing one was not invented", () => {
    const s = readFileSync(resolve(process.cwd(), "src/routes/messaging.ts"), "utf8");
    assert.ok(/last_read_at/.test(s));
  });
});

// ── F-12 source object revoked while a cached share card is open ─────────────

describe("F-12 — source object revoked while a cached share card is open", () => {
  const component = (name: string) =>
    readFileSync(resolve(process.cwd(), `../../travel-buddy-standalone/src/components/${name}`), "utf8");

  it("the share cards render frozen JSON and cannot notice a revocation", () => {
    for (const name of ["DiscoveryCardMessage.tsx", "PostCardMessage.tsx"]) {
      const src = component(name);
      assert.equal(/\bfetch\s*\(/.test(src), false,
        `EXPECTED BY §29: no source-object revocation bypass via a cached card. ` +
        `ACTUAL: ${name} performs no fetch — it re-renders the payload that was ` +
        `frozen into messages.body when the card was sent.`);
      assert.equal(/useEffect\s*\(/.test(src), false, `${name} has no effect that could re-resolve`);
    }
  });

  it("and the payload that IS carried is a source id with no capability beside it", () => {
    const src = component("DiscoveryCardMessage.tsx");
    assert.ok(/sourceId/.test(src), "a source id travels…");
    assert.equal(/capabilit/i.test(src), false, "…with no capability vocabulary to revoke against");
  });
});
