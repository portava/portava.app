/**
 * Telegraph — the doors into `public.messages`, driven as requests.
 *
 * `telegraphMessageDoors.test.ts` proves the RULE and the INVENTORY without a
 * server. This suite proves the same three defects are closed where a person
 * would have met them: the real `routes/messaging.ts`, `routes/telegraphKinds.ts`
 * and `server/telegraph/commandRoute.ts`, mounted on one express app over the
 * certification harness's PostgREST fake (which really parses the `and(…)`
 * groups the block guard builds — see the harness header).
 *
 * EVERY REFUSAL IS ASSERTED AS A STATE, NOT A STATUS. CONTRIBUTING.md: "a
 * successful call is not evidence that the intended side effect occurred", and
 * the converse holds for a refusal — a 403 from a handler that wrote the row
 * first is the worst of both. So each refusing case also reads the store back
 * and counts the rows that must not be there.
 *
 * WHAT EACH SECTION WOULD HAVE SHOWN AT `f71cfb85f` (the tree before this
 * change; none of it could be run in the authoring environment, which has no
 * express — CI is the first execution, and the handoff says so):
 *   1.1–1.4  201, with a `system` row stored under the forged subtype.
 *   2.1      201 on the twenty-first media send; 2.2 201 on a typed send.
 *   3.1      200, and a `messages` row from a sender the recipient had blocked.
 *   3.3      200, and a plaintext envelope stored in an E2EE thread.
 *   3.4      200 with the stop engaged.
 *   3.7      200, and a reaction row from the blocked sender.
 *   3.9      200, deleting a reaction on a message in another conversation.
 * The CONTROL cases (1.5, 2.4, 3.2, 3.6, 3.8) are green before and after by
 * design: they are what stops a guard that refuses everything from passing.
 *
 * Run: node --import tsx/esm --test src/test/telegraphMessageDoorRoutes.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { SEND_LIMITS, _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import {
  makeFakeClient,
  startRouter,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const DM = "00000000-0000-4000-8000-00000000000d";
const DM_E2EE = "00000000-0000-4000-8000-00000000000e";
const GROUP = "00000000-0000-4000-8000-00000000000a";
const M_DM = "11111111-0000-4000-8000-000000000001";
const M_GROUP = "11111111-0000-4000-8000-000000000002";

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});
const thread = (id: string, type: string, e2ee = false) => ({
  id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: e2ee,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
});
const message = (id: string, threadId: string, sender: string) => ({
  id, thread_id: threadId, sender_id: sender, body: "hello", created_at: "2026-05-02T00:00:00.000Z",
  deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null,
});

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    // The kernel flag is ON so the reaction commands reach their handlers; the
    // messaging stop has no row, which reads as "not engaged".
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", preferred_language: "en" },
      { id: B, handle: "b", name: "B", preferred_language: "en" },
      { id: C, handle: "c", name: "C", preferred_language: "en" },
    ],
    reports: [],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [],
    message_threads: [thread(DM, "direct"), thread(DM_E2EE, "direct", true), thread(GROUP, "trip")],
    message_thread_members: [
      member(DM, A), member(DM, B),
      member(DM_E2EE, A), member(DM_E2EE, B),
      member(GROUP, A), member(GROUP, B), member(GROUP, C),
    ],
    messages: [message(M_DM, DM, B), message(M_GROUP, GROUP, B)],
    message_translations: [],
    message_reactions: [],
    ...over,
  };
}

/** B has blocked A. The DM is 1:1, so the pairwise guard applies to it. */
const B_BLOCKED_A = { blocks: [{ blocker_id: B, blocked_id: A }] };

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  // The typed command door first, exactly as routes/index.ts mounts it.
  all.use(commandRouter);
  all.use(telegraphKindsRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(seed: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  // The limiter's buckets and the tier cache are PROCESS state. Reset per case,
  // or a 429 below would be measuring an earlier case's sends.
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed, opts);
  _setTestClient(c, true);
  return c;
}

async function post(path: string, asUser: string, body: unknown) {
  const res = await fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
}

const rowsIn = (c: FakeClient, table: string, where: (r: any) => boolean = () => true) =>
  (c._store[table] ?? []).filter(where);

/** Every sender in these fixtures resolves to the strictest tier: no `created_at` on the profile. */
const LIMIT = SEND_LIMITS.stranger;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The text door does not let the client choose the renderer.
 * ════════════════════════════════════════════════════════════════════════ */

describe("1. POST /threads/:id/messages — a client cannot post in the platform's voice", () => {
  const forged: Array<[string, Record<string, unknown>]> = [
    ["1.1 a booking milestone banner", { msgType: "system", subtype: "rent_buddy_payment_released", body: "Payment released to your buddy" }],
    ["1.2 a missed-call line (it renders a call-back button)", { msgType: "system", subtype: "call_missed", body: "Missed voice call" }],
    ["1.3 a centred platform notice — `system` with no subtype at all", { msgType: "system", body: "Portava: this traveller is verified. Pay them directly." }],
    ["1.4 a subtype on an ordinary message", { msgType: "text", subtype: "meetup_confirmed", body: "see you there" }],
  ];
  for (const [name, payload] of forged) {
    it(`${name} is refused 400 and NOTHING is written`, async () => {
      const c = use(store());
      const before = rowsIn(c, "messages").length;
      const r = await post(`/threads/${GROUP}/messages`, A, payload);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, "invalid_payload");
      assert.equal(rowsIn(c, "messages").length, before, "a refused message was stored");
      assert.equal(c._observed.inserts.filter((i) => i.table === "messages").length, 0, "the insert was issued and only then refused");
    });
  }

  it("1.5 CONTROL: the subtypes the app itself authors are still accepted, and stored as named", async () => {
    const c = use(store());
    for (const subtype of ["discovery_card", "post_card", "compass_card", "meetup", "e2ee_welcome"]) {
      const r = await post(`/threads/${GROUP}/messages`, A, { msgType: "system", subtype, body: JSON.stringify({ title: "x" }) });
      assert.equal(r.status, 201, `${subtype}: ${JSON.stringify(r.body)}`);
      const row = rowsIn(c, "messages", (m) => m.id === r.body.id)[0];
      assert.ok(row, `${subtype}: the accepted message is not in the store`);
      assert.equal(row.msg_type, "system");
      assert.equal(row.subtype, subtype);
    }
    const plain = await post(`/threads/${GROUP}/messages`, A, { body: "an ordinary message" });
    assert.equal(plain.status, 201);
    const plainRow = rowsIn(c, "messages", (m) => m.id === plain.body.id)[0];
    assert.equal(plainRow.msg_type, "text");
    assert.equal(plainRow.subtype, null);
  });

  it("1.6 the refusal does not reflect the supplied subtype", async () => {
    use(store());
    const marker = "zz_attacker_chosen_zz";
    const r = await post(`/threads/${GROUP}/messages`, A, { msgType: "system", subtype: marker, body: "x" });
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.body).includes(marker));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. One burst allowance for every door.
 * ════════════════════════════════════════════════════════════════════════ */

async function spendOrdinaryBucket(asUser: string, threadId: string) {
  for (let i = 0; i < LIMIT; i += 1) {
    const r = await post(`/threads/${threadId}/messages`, asUser, { body: `message ${i}` });
    assert.equal(r.status, 201, `send ${i + 1} of ${LIMIT} should be inside the allowance: ${JSON.stringify(r.body)}`);
  }
}

describe("2. §22's send limit is one allowance, not one per door", () => {
  it("2.1 THE POINT: after the text door spends the allowance, the MEDIA door is refused 429 with Retry-After", async () => {
    const c = use(store());
    await spendOrdinaryBucket(A, GROUP);
    const stored = rowsIn(c, "messages").length;
    const r = await post(`/threads/${GROUP}/media`, A, { mediaUrl: `post-media/${A}/p.webp`, mediaType: "image" });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.equal(r.body.error, "rate_limited");
    assert.ok(Number(r.retryAfter) >= 1, `Retry-After was ${r.retryAfter}`);
    assert.equal(rowsIn(c, "messages").length, stored, "the over-limit media message was stored");
  });

  it("2.2 THE POINT: and so is a typed-kind send — the shared guard carries the same gate", async () => {
    const c = use(store());
    await spendOrdinaryBucket(A, GROUP);
    const stored = rowsIn(c, "messages").length;
    const r = await post(`/threads/${GROUP}/typed-messages`, A, { kind: "ANNOUNCEMENT", payload: { title: "Leaving at eight" } });
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.equal(r.body.error, "rate_limited");
    assert.ok(Number(r.retryAfter) >= 1);
    assert.equal(rowsIn(c, "messages").length, stored);
  });

  it("2.3 a SAFETY message is not starved by ordinary traffic — and is itself bounded", async () => {
    const c = use(store());
    await spendOrdinaryBucket(A, GROUP);
    const safety = { kind: "SAFETY", payload: { kind: "need_help", label: "I need help" } };
    const first = await post(`/threads/${GROUP}/typed-messages`, A, safety);
    assert.equal(first.status, 201, `a safety message was paused by an argument: ${JSON.stringify(first.body)}`);
    assert.ok(rowsIn(c, "messages", (m) => m.msg_type === "safety").length === 1);
    for (let i = 1; i < LIMIT; i += 1) {
      assert.equal((await post(`/threads/${GROUP}/typed-messages`, A, safety)).status, 201);
    }
    const over = await post(`/threads/${GROUP}/typed-messages`, A, safety);
    assert.equal(over.status, 429, "the safety bucket is separate, not unlimited");
  });

  it("2.4 CONTROL: one sender's allowance is not another's", async () => {
    use(store());
    await spendOrdinaryBucket(A, GROUP);
    const r = await post(`/threads/${GROUP}/typed-messages`, B, { kind: "ANNOUNCEMENT", payload: { title: "still here" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it("2.5 a send refused by an earlier gate does not spend the allowance", async () => {
    const c = use(store());
    // Refused by gate 4 (E2EE) every time: more refusals than the allowance holds.
    for (let i = 0; i < LIMIT + 5; i += 1) {
      const r = await post(`/threads/${DM_E2EE}/typed-messages`, A, { kind: "ANNOUNCEMENT", payload: { title: "x" } });
      assert.equal(r.status, 422, JSON.stringify(r.body));
    }
    // The whole allowance is still there.
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await post(`/threads/${GROUP}/typed-messages`, A, { kind: "ANNOUNCEMENT", payload: { title: `n${i}` } });
      assert.equal(r.status, 201, `send ${i + 1}: refused sends were counted — ${JSON.stringify(r.body)}`);
    }
    assert.equal(rowsIn(c, "messages", (m) => m.thread_id === DM_E2EE).length, 0, "a plaintext envelope was written to the E2EE thread");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The command door holds the write guard.
 * ════════════════════════════════════════════════════════════════════════ */

const createSession = (conversationId: string, key: string) => ({
  type: "CREATE_COORDINATION_SESSION",
  conversationId,
  idempotency_key: key,
  params: { title: "Dinner run", note: "free text the other member will read" },
});
const sessionRows = (c: FakeClient, threadId: string) =>
  rowsIn(c, "messages", (m) => m.thread_id === threadId && String(m.body ?? "").includes("COORDINATION_SESSION"));

describe("3. POST /telegraph/commands — a command that writes passes the same gates as a send", () => {
  it("3.1 THE POINT: a BLOCKED sender cannot open a session in the 1:1 thread, and nothing is written", async () => {
    const c = use(store(B_BLOCKED_A));
    const r = await post(`/telegraph/commands`, A, createSession(DM, "blocked-1"));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    // Told what a non-member is told: the refusal must not confirm the block.
    assert.equal(r.body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
    assert.equal(sessionRows(c, DM).length, 0, "the blocked sender's title and note reached the thread");
    assert.equal(c._observed.inserts.filter((i) => i.table === "messages").length, 0);
  });

  it("3.2 CONTROL: with no block the same command opens the session (the guard does not refuse everything)", async () => {
    const c = use(store());
    const r = await post(`/telegraph/commands`, A, createSession(DM, "open-1"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sessionRows(c, DM).length, 1);
  });

  it("3.3 THE POINT: no plaintext session is stored in an end-to-end encrypted thread", async () => {
    const c = use(store());
    const r = await post(`/telegraph/commands`, A, createSession(DM_E2EE, "e2ee-1"));
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal(sessionRows(c, DM_E2EE).length, 0, "the server stored plaintext in an E2EE thread");
  });

  it("3.4 THE POINT: the messaging stop stops it — engaged, and unreadable", async () => {
    const engaged = use(store({ feature_flags: [{ flag: "disable_messaging", enabled: true }] }));
    const r1 = await post(`/telegraph/commands`, A, createSession(GROUP, "stop-1"));
    assert.equal(r1.status, 404, JSON.stringify(r1.body));
    assert.equal(r1.body.error, "feature_disabled");
    assert.equal(sessionRows(engaged, GROUP).length, 0);

    // An unreadable stop is an engaged stop: "we could not look" must not write.
    const unreadable = use(store(), { errors: { feature_flags: { message: "flags down" } } });
    const r2 = await post(`/telegraph/commands`, A, createSession(GROUP, "stop-2"));
    assert.ok(r2.status === 404 || r2.status === 503, `unreadable stop answered ${r2.status}`);
    assert.equal(sessionRows(unreadable, GROUP).length, 0);
  });

  it("3.5 an unreadable guard read refuses 503 rather than writing blind", async () => {
    // The route's own membership read is this table's first operation and must
    // succeed, or the case would prove a refusal that came from somewhere else.
    const c = use(store(), { errors: { message_thread_members: { message: "roster down", afterOps: 1 } } });
    const r = await post(`/telegraph/commands`, A, createSession(DM, "blind-1"));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(sessionRows(c, DM).length, 0);
  });

  it("3.6 CONTROL: a group thread is not subject to a pairwise block", async () => {
    // A trip chat is governed by trip membership; one member blocking another
    // does not remove either from it. Same rule as the ordinary send path.
    const c = use(store(B_BLOCKED_A));
    const r = await post(`/telegraph/commands`, A, createSession(GROUP, "group-1"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sessionRows(c, GROUP).length, 1);
  });

  it("3.7 THE POINT: a blocked sender cannot react to the other person's message", async () => {
    const c = use(store(B_BLOCKED_A));
    const r = await post(`/telegraph/commands`, A, { type: "ADD_REACTION", conversationId: DM, params: { messageId: M_DM, emoji: "👍" } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
    assert.equal(rowsIn(c, "message_reactions").length, 0, "a blocked sender's reaction was stored");
  });

  it("3.8 CONTROL: a retraction outlives a block — REMOVE_REACTION is not refused by it", async () => {
    const c = use(store({ ...B_BLOCKED_A, message_reactions: [{ message_id: M_DM, user_id: A, emoji: "👍" }] }));
    const r = await post(`/telegraph/commands`, A, { type: "REMOVE_REACTION", conversationId: DM, params: { messageId: M_DM, emoji: "👍" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rowsIn(c, "message_reactions").length, 0, "the sender could not take their own reaction back");
  });

  it("3.9 REMOVE_REACTION is bound to the conversation the caller was authorized for", async () => {
    // A is a member of DM. The message named is in GROUP. Before this change the
    // handler ended `void conversationId;` and deleted by message id alone.
    const c = use(store({ message_reactions: [{ message_id: M_GROUP, user_id: A, emoji: "👍" }] }));
    const r = await post(`/telegraph/commands`, A, { type: "REMOVE_REACTION", conversationId: DM, params: { messageId: M_GROUP, emoji: "👍" } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
    assert.equal(rowsIn(c, "message_reactions").length, 1, "a reaction in another conversation was deleted");
  });

  it("3.10 a command that writes spends the same allowance as a send", async () => {
    const c = use(store());
    await spendOrdinaryBucket(A, GROUP);
    const r = await post(`/telegraph/commands`, A, createSession(GROUP, "rate-1"));
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.ok(Number(r.retryAfter) >= 1);
    assert.equal(sessionRows(c, GROUP).length, 0);
  });
});
