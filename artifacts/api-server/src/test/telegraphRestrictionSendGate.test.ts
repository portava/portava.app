/**
 * OD-TRUST-5 — the Trust restriction gate, driven through every Telegraph door.
 *
 * The ruling (docs/ops/owner-decisions-20261004.md, OD-TRUST-5) asks that a
 * restriction be enforced "on the server across all relevant APIs", limited "to
 * the actions and duration needed", with appeals preserved. Until this change a
 * Trust restriction was consulted on ONE Telegraph write (the message request)
 * and on none of the doors that write into `messages`, while the capabilities
 * projection announced `canSendMessage: false` for every messaging-restricted
 * person in every thread — a refusal announced and never performed.
 *
 * WHAT THIS SUITE DRIVES. Real routers (`routes/messaging.ts`, telegraphKinds,
 * telegraphVoice, telegraphShare, telegraphCoordination, the kernel command
 * route, `routes/highlights.ts`, blocks, moderation, appeals) and the real
 * `postPlainThreadMessage`, mounted over the certification harness's PostgREST
 * fake. Nothing here reads source text: every assertion is on a response AND on
 * the rows the door did or did not write, because a refusal from a handler that
 * wrote first is the worst of both.
 *
 * THE MAPPING IS LANE T2's READING, NOT AN OWNER DECISION (restrictionSendPolicy.ts
 * header): `messaging` refuses only a send that INITIATES contact — a direct
 * thread whose other member has never written in it and which no booking owns;
 * `hosting`, `private_plan_access` and `location_plan_join` refuse no send.
 *
 * Sections:
 *   1. the decision, pure
 *   2. every door x every gate (stop, membership, block, E2EE, restriction, rate)
 *   3. what a messaging restriction does and does not refuse, at every door
 *   4. safety sends and safety actions are never refused by a restriction
 *   5. the projection and the guard cannot disagree
 *   6. the highlight-reply door (it resolves its own thread)
 *
 * Run: node --import tsx/esm --test src/test/telegraphRestrictionSendGate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { SEND_LIMITS, _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { postPlainThreadMessage } from "../lib/threadMessage.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import {
  decideRestrictedSend, readRestrictionSendFacts,
  RESTRICTION_CAPABILITY_SCOPE,
  RESTRICTION_SEND_SCOPE,
  RESTRICTED_SEND_MESSAGE,
  RESTRICTION_UNKNOWN_MESSAGE,
} from "../domain/telegraph/policies/restrictionSendPolicy.js";
import type { RestrictionState, RestrictionType } from "../services/trust/TrustRestrictionService.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import highlightsRouter from "../routes/highlights.js";
import blocksRouter from "../routes/blocks.js";
import moderationRouter from "../routes/moderation.js";
import appealsRouter from "../routes/appeals.js";
import reportsRouter from "../routes/reports.js";
import mutesRouter from "../routes/mutes.js";
import restrictRouter from "../routes/restrict.js";
import {
  makeFakeClient,
  startRouter,
  type FakeClient,
  type FakeDbOptions,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // the sender in every case
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004"; // a highlight owner
const E = "eeeeeeee-0000-4000-8000-000000000005"; // accepted A's message request (re-verification 3)

const T = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const DM_NEW = T("a1"); //     direct, A+B; B has never written — a send here INITIATES contact
const DM_REPLY = T("a2"); //   direct, A+B; B has written
const DM_BOOKING = T("a3"); // direct, A+B; B has never written, a booking owns the thread
const TRIP = T("a4"); //       trip, A+B+C
const TRIP_PAIR = T("a5"); //  trip with exactly two members
const CIRCLE = T("a6"); //     circle, A+B
const DM_E2EE = T("a7"); //    direct, end-to-end encrypted, B has written
const DM_FOREIGN = T("a8"); // direct, B+C — A is not a member
const DM_D = T("b1"); //       direct, A+D (section 6)
const DM_ACCEPTED = T("b2"); // direct, A+E; E ACCEPTED A's message request and has not written yet

const M_REPLY = "11111111-0000-4000-8000-000000000001";
const M_E2EE = "11111111-0000-4000-8000-000000000002";
const M_TRIP = "11111111-0000-4000-8000-000000000003";
const M_D = "11111111-0000-4000-8000-000000000004";
const BOOKING = "22222222-0000-4000-8000-000000000001";
const GEM = "55550000-0000-4000-8000-000000000001";
const HIGHLIGHT = "77770000-0000-4000-8000-000000000001";

const member = (thread: string, user: string, over: Record<string, unknown> = {}) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, ...over,
});
const thread = (id: string, type: string, e2ee = false) => ({
  id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: e2ee,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
});
const message = (id: string, threadId: string, sender: string) => ({
  id, thread_id: threadId, sender_id: sender, body: "hello", created_at: "2026-05-02T00:00:00.000Z",
  deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null,
});

function seed(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    // The kernel flag is ON so the command door reaches its handlers; the
    // messaging stop has no row, which reads as "not engaged".
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    blocks: [],
    profiles: [A, B, C, D, E].map((id, i) => ({
      id, handle: `u${i}`, name: `U${i}`, preferred_language: "en", avatar_url: null, show_name_publicly: true,
    })),
    reports: [],
    moderation_reports: [],
    appeals: [],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trip_members: [],
    trust_profiles: [],
    trust_restrictions: [],
    // E accepted A's request: the accept route inserts only the REQUESTER's
    // preview (routes/messaging.ts), so E has engaged without writing.
    message_requests: [{ id: "66666666-0000-4000-8000-000000000001", sender_id: A, recipient_id: E, status: "accepted", preview_text: null }],
    message_threads: [
      thread(DM_NEW, "direct"), thread(DM_REPLY, "direct"), thread(DM_BOOKING, "direct"),
      thread(TRIP, "trip"), thread(TRIP_PAIR, "trip"), thread(CIRCLE, "circle"),
      thread(DM_E2EE, "direct", true), thread(DM_FOREIGN, "direct"), thread(DM_ACCEPTED, "direct"),
    ],
    message_thread_members: [
      member(DM_NEW, A), member(DM_NEW, B),
      member(DM_REPLY, A), member(DM_REPLY, B),
      member(DM_BOOKING, A), member(DM_BOOKING, B),
      member(TRIP, A), member(TRIP, B), member(TRIP, C),
      member(TRIP_PAIR, A), member(TRIP_PAIR, B),
      member(CIRCLE, A), member(CIRCLE, B),
      member(DM_E2EE, A), member(DM_E2EE, B),
      member(DM_FOREIGN, B), member(DM_FOREIGN, C),
      member(DM_ACCEPTED, A), member(DM_ACCEPTED, E),
    ],
    messages: [message(M_REPLY, DM_REPLY, B), message(M_E2EE, DM_E2EE, B), message(M_TRIP, TRIP, B)],
    message_translations: [],
    message_reactions: [],
    rent_buddy_bookings: [{ id: BOOKING, telegraph_thread_id: DM_BOOKING, status: "confirmed" }],
    hidden_gems: [{
      id: GEM, name: "Rooftop", city: "Hue", neighborhood: "Old town", category: "bar", status: "active",
      sensitivity_level: "public", merged_into: null, updated_at: "2026-05-02T00:00:00.000Z",
    }],
    ...over,
  };
}

/** The restriction worlds. `fail_closed` / `fail_open` are getRestrictionState's two degraded answers. */
type World = "none" | RestrictionType | "fail_closed" | "fail_open";
const RESTRICTION_TYPES: readonly RestrictionType[] = ["messaging", "hosting", "private_plan_access", "location_plan_join"];
const ALL_WORLDS: readonly World[] = ["none", ...RESTRICTION_TYPES, "fail_closed", "fail_open"];

function inWorld(w: World, over: Partial<Record<string, any[]>> = {}): { tables: Record<string, any[]>; opts: FakeDbOptions } {
  if (w === "fail_closed") {
    return { tables: seed(over), opts: { errors: { trust_restrictions: { message: "trust_restrictions: connection reset" } } } };
  }
  if (w === "fail_open") {
    // The table was never migrated: not a restriction (the service's own contract).
    return { tables: seed(over), opts: { errors: { trust_restrictions: { message: 'relation "trust_restrictions" does not exist', code: "42P01" } } } };
  }
  const rows = w === "none" ? [] : [{
    id: "33333333-0000-4000-8000-000000000001", user_id: A, restriction_type: w,
    lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z",
  }];
  return { tables: seed({ trust_restrictions: rows, ...over }), opts: {} };
}

/* ── harness ──────────────────────────────────────────────────────────────── */

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  // routes/index.ts order: share, kinds, voice, coordination, the kernel command
  // door, messaging, highlights; then the safety routes section 4 drives.
  all.use(telegraphShareRouter);
  all.use(telegraphKindsRouter);
  all.use(telegraphVoiceRouter);
  all.use(telegraphCoordinationRouter);
  all.use(commandRouter);
  all.use(messagingRouter);
  all.use(highlightsRouter);
  all.use(blocksRouter);
  all.use(moderationRouter);
  all.use(appealsRouter);
  all.use(reportsRouter);
  all.use(mutesRouter);
  all.use(restrictRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(w: World, over: Partial<Record<string, any[]>> = {}, extra: FakeDbOptions = {}): FakeClient {
  // The limiter's buckets and the tier cache are PROCESS state: reset per case,
  // or a 429 below would be measuring an earlier case's sends.
  _resetRateLimit();
  _clearSendTierCache();
  const { tables, opts } = inWorld(w, over);
  const c = makeFakeClient(tables, {
    ...opts,
    ...extra,
    errors: { ...(opts.errors ?? {}), ...(extra.errors ?? {}) },
    // PostgREST hands back the row with the column defaults applied.
    columnDefaults: { message_threads: { thread_type: "direct", is_e2ee: false, status: "active" } },
  });
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
  return { status: res.status, body: parsed, raw: text };
}

/** A door's answer in one vocabulary, whatever the door's own wire shape. */
type Refusal = "stop" | "forbidden" | "e2ee" | "retryable" | "rate" | "invalid" | "other";
interface Outcome { ok: boolean; refusal: Refusal | null; message: string | null; reason: string | null; retryable: boolean; raw: string }

const HTTP_REFUSAL: Record<string, Refusal> = {
  feature_disabled: "stop", forbidden: "forbidden", e2ee_thread: "e2ee",
  degraded_unavailable: "retryable", rate_limited: "rate", invalid_payload: "invalid",
};
async function http(path: string, body: unknown, asUser = A): Promise<Outcome> {
  const r = await post(path, asUser, body);
  const ok = r.status >= 200 && r.status < 300;
  const err = typeof r.body?.error === "string" ? r.body.error : null;
  return {
    ok,
    refusal: ok ? null : (err && HTTP_REFUSAL[err]) || "other",
    message: typeof r.body?.message === "string" ? r.body.message : null,
    reason: typeof r.body?.reason === "string" ? r.body.reason : null,
    retryable: r.body?.retryable === true,
    raw: `${r.status} ${r.raw}`,
  };
}

const PLAIN_REFUSAL: Record<string, Refusal> = {
  feature_disabled: "stop", forbidden: "forbidden", e2ee: "e2ee", unverifiable: "retryable", rate_limited: "rate",
};
async function plain(c: FakeClient, threadId: string): Promise<Outcome> {
  const r = await postPlainThreadMessage(c as any, { threadId, senderId: A, body: "On a layover — any quick tips?" });
  if (r.ok) return { ok: true, refusal: null, message: null, reason: null, retryable: false, raw: JSON.stringify(r) };
  const message = "message" in r ? r.message : null;
  return {
    ok: false, refusal: PLAIN_REFUSAL[r.reason] ?? "other", message, reason: null,
    retryable: r.reason === "unverifiable", raw: JSON.stringify(r),
  };
}

let seq = 0;
interface Door {
  name: string;
  send(c: FakeClient, threadId: string): Promise<Outcome>;
  /** How this door refuses plaintext into an E2EE thread. */
  e2ee: Refusal;
}
const DOORS: readonly Door[] = [
  // The text door ACCEPTS an E2EE thread — with ciphertext. Plaintext is refused as a malformed send.
  { name: "text   POST /threads/:id/messages", e2ee: "invalid", send: (_c, t) => http(`/threads/${t}/messages`, { body: `hello ${++seq}` }) },
  { name: "media  POST /threads/:id/media", e2ee: "e2ee", send: (_c, t) => http(`/threads/${t}/media`, { mediaUrl: `post-media/${A}/p${++seq}.webp`, mediaType: "image" }) },
  { name: "typed  POST /threads/:id/typed-messages", e2ee: "e2ee", send: (_c, t) => http(`/threads/${t}/typed-messages`, { kind: "ANNOUNCEMENT", payload: { title: "Leaving at eight" } }) },
  {
    name: "voice  POST /threads/:id/voice", e2ee: "e2ee",
    send: (_c, t) => http(`/threads/${t}/voice`, { payload: {
      url: `post-media/${A}/voice/17000000${++seq}.m4a`, durationSeconds: 12, waveform: [0.1, 0.5, 0.9], mimeType: "audio/mp4", sizeBytes: 98_304,
    } }),
  },
  { name: "share  POST /threads/:id/share", e2ee: "e2ee", send: (_c, t) => http(`/threads/${t}/share`, { objectType: "HIDDEN_GEM", objectId: GEM }) },
  { name: "coord  POST /threads/:id/coordination", e2ee: "e2ee", send: (_c, t) => http(`/threads/${t}/coordination`, { kind: "COORDINATION", payload: { state: "ARRIVED" } }) },
  {
    name: "cmd    POST /telegraph/commands CREATE_COORDINATION_SESSION", e2ee: "e2ee",
    send: (_c, t) => http(`/telegraph/commands`, { type: "CREATE_COORDINATION_SESSION", conversationId: t, idempotency_key: `k-${++seq}`, params: { title: "Dinner run" } }),
  },
  { name: "lib    postPlainThreadMessage", e2ee: "e2ee", send: (c, t) => plain(c, t) },
];

const fromA = (c: FakeClient, threadId: string) =>
  (c._store.messages ?? []).filter((m) => m.thread_id === threadId && m.sender_id === A).length;

/** One send, and how many rows it left behind in that thread under A's name. */
async function attempt(door: Door, c: FakeClient, threadId: string): Promise<{ out: Outcome; written: number }> {
  const before = fromA(c, threadId);
  const out = await door.send(c, threadId);
  return { out, written: fromA(c, threadId) - before };
}

/** Spend A's whole ordinary allowance through the text door, into `threadId`. */
async function spendAllowance(threadId: string) {
  for (let i = 0; i < SEND_LIMITS.stranger; i += 1) {
    const r = await http(`/threads/${threadId}/messages`, { body: `burst ${i}` });
    assert.equal(r.ok, true, `send ${i + 1} of ${SEND_LIMITS.stranger} should be inside the allowance: ${r.raw}`);
  }
}

function assertRefused(label: string, got: { out: Outcome; written: number }, want: Refusal) {
  assert.equal(got.out.ok, false, `${label}: admitted — ${got.out.raw}`);
  assert.equal(got.out.refusal, want, `${label}: refused, but not by this gate — ${got.out.raw}`);
  assert.equal(got.written, 0, `${label}: refused AND written — the row is in the thread`);
}
function assertAdmitted(label: string, got: { out: Outcome; written: number }) {
  assert.equal(got.out.ok, true, `${label}: refused — ${got.out.raw}`);
  assert.ok(got.written >= 1, `${label}: answered ok and wrote nothing`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The decision, pure.
 * ════════════════════════════════════════════════════════════════════════ */

describe("1. decideRestrictedSend — the one decision the guard, the inline doors and the projection share", () => {
  const restriction = (types: RestrictionType[], degradedReason?: "fail_open" | "fail_closed") => ({
    activeRestrictions: types, degraded: degradedReason !== undefined, degradedReason,
  });

  it("1.1 the reading under confirmation: only `messaging` reaches a send, and only one that initiates contact", () => {
    assert.deepEqual({ ...RESTRICTION_SEND_SCOPE }, {
      messaging: "initiating_contact", hosting: "none", private_plan_access: "none", location_plan_join: "none",
    });
    for (const t of RESTRICTION_TYPES) {
      const v = decideRestrictedSend({ restriction: restriction([t]), initiatesContact: true }, { safety: false });
      assert.equal(v.allowed, t !== "messaging", `${t} on an initiating send`);
      const reply = decideRestrictedSend({ restriction: restriction([t]), initiatesContact: false }, { safety: false });
      assert.equal(reply.allowed, true, `${t} on a reply`);
    }
  });

  it("1.2 a safety send is admitted whatever the state — even one that could not be read", () => {
    for (const r of [restriction(["messaging"]), restriction([], "fail_closed"), restriction([...RESTRICTION_TYPES])]) {
      assert.equal(decideRestrictedSend({ restriction: r, initiatesContact: true }, { safety: true }).allowed, true);
      assert.equal(decideRestrictedSend({ restriction: r, initiatesContact: null }, { safety: true }).allowed, true);
    }
  });

  it("1.3 'we could not check' is never 'you are restricted': fail_closed and an unreadable fact are retryable", () => {
    const unread = decideRestrictedSend({ restriction: restriction([], "fail_closed"), initiatesContact: true }, { safety: false });
    assert.equal(unread.allowed, false);
    assert.ok(!unread.allowed && unread.refusal === "unknown");
    assert.ok(!unread.allowed && unread.reason === "TELEGRAPH_DEGRADED_TRUST_UNREADABLE");
    assert.ok(!unread.allowed && unread.message === RESTRICTION_UNKNOWN_MESSAGE);
    const factUnread = decideRestrictedSend({ restriction: restriction(["messaging"]), initiatesContact: null }, { safety: false });
    assert.ok(!factUnread.allowed && factUnread.refusal === "unknown" && factUnread.message !== RESTRICTED_SEND_MESSAGE);
    const restricted = decideRestrictedSend({ restriction: restriction(["messaging"]), initiatesContact: true }, { safety: false });
    assert.ok(!restricted.allowed && restricted.refusal === "restricted" && restricted.reason === "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
    assert.ok(!restricted.allowed && restricted.message === RESTRICTED_SEND_MESSAGE);
  });

  it("1.4 fail_open (the table was never migrated) is not a restriction", () => {
    assert.equal(decideRestrictedSend({ restriction: restriction([], "fail_open"), initiatesContact: true }, { safety: false }).allowed, true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Every door, every gate. A real send, refused by the gate, nothing written.
 * ════════════════════════════════════════════════════════════════════════ */

describe("2. every door x every gate", () => {
  describe("2.0 CONTROL — with nothing set, every door writes (so each refusal below is its gate's)", () => {
    for (const door of DOORS) {
      it(`${door.name}: a reply, a first message and a trip message are all admitted`, async () => {
        for (const t of [DM_REPLY, DM_NEW, TRIP]) {
          const c = use("none");
          assertAdmitted(`${door.name} -> ${t}`, await attempt(door, c, t));
        }
      });
    }
  });

  describe("2.1 the messaging stop", () => {
    for (const door of DOORS) {
      it(`${door.name}: refused while disable_messaging is engaged`, async () => {
        const c = use("none", { feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }, { flag: "disable_messaging", enabled: true }] });
        assertRefused(door.name, await attempt(door, c, DM_REPLY), "stop");
      });
    }
  });

  describe("2.2 active membership", () => {
    for (const door of DOORS) {
      it(`${door.name}: refused in a thread the sender is not in`, async () => {
        const c = use("none");
        assertRefused(door.name, await attempt(door, c, DM_FOREIGN), "forbidden");
      });
      it(`${door.name}: refused in a thread the sender has LEFT`, async () => {
        const c = use("none");
        const m = c._store.message_thread_members!.find((r) => r.thread_id === DM_REPLY && r.user_id === A)!;
        m.left_at = "2026-09-01T00:00:00.000Z";
        assertRefused(door.name, await attempt(door, c, DM_REPLY), "forbidden");
      });
    }
  });

  describe("2.3 the pairwise block", () => {
    for (const door of DOORS) {
      it(`${door.name}: refused in the 1:1 thread with someone who blocked the sender`, async () => {
        const c = use("none", { blocks: [{ blocker_id: B, blocked_id: A }] });
        const got = await attempt(door, c, DM_REPLY);
        assertRefused(door.name, got, "forbidden");
        assert.notEqual(got.out.message, RESTRICTED_SEND_MESSAGE, "a block must not be reported as the sender's restriction");
      });
    }
  });

  describe("2.4 the E2EE refusal", () => {
    for (const door of DOORS) {
      it(`${door.name}: no server-readable plaintext is stored in an E2EE thread`, async () => {
        const c = use("none");
        assertRefused(door.name, await attempt(door, c, DM_E2EE), door.e2ee);
      });
    }
  });

  describe("2.5 the Trust restriction (OD-TRUST-5)", () => {
    for (const door of DOORS) {
      it(`${door.name}: a messaging-restricted sender cannot start a conversation, and is told so`, async () => {
        const c = use("messaging");
        const got = await attempt(door, c, DM_NEW);
        assertRefused(door.name, got, "forbidden");
        assert.equal(got.out.message, RESTRICTED_SEND_MESSAGE, `${door.name}: ${got.out.raw}`);
      });
    }
  });

  describe("2.6 the burst limit", () => {
    for (const door of DOORS) {
      it(`${door.name}: refused once the sender's one allowance is spent`, async () => {
        const c = use("none");
        await spendAllowance(DM_REPLY);
        assertRefused(door.name, await attempt(door, c, DM_REPLY), "rate");
      });
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. What a restriction refuses — and the much longer list of what it does not.
 * ════════════════════════════════════════════════════════════════════════ */

describe("3. a restriction refuses no more than the ruling asks, at every door", () => {
  const admitted: Array<[string, World, string]> = [
    ["a reply to someone who has written", "messaging", DM_REPLY],
    ["a thread a booking owns", "messaging", DM_BOOKING],
    ["a DM opened by the recipient ACCEPTING the sender's request (re-verification 3)", "messaging", DM_ACCEPTED],
    ["a trip thread", "messaging", TRIP],
    ["a two-person trip thread (the roster is the trip's, not a DM)", "messaging", TRIP_PAIR],
    ["a circle thread", "messaging", CIRCLE],
    ["hosting restriction, first message", "hosting", DM_NEW],
    ["private_plan_access restriction, first message", "private_plan_access", DM_NEW],
    ["location_plan_join restriction, first message", "location_plan_join", DM_NEW],
    ["fail_open (table never migrated), first message", "fail_open", DM_NEW],
    // The state is not needed to decide a trip send, so it is not read: an
    // unreadable state cannot refuse what no restriction could refuse.
    ["fail_closed, trip thread", "fail_closed", TRIP],
  ];
  for (const door of DOORS) {
    it(`${door.name}: admitted in every world no restriction reaches`, async () => {
      for (const [label, w, t] of admitted) {
        const c = use(w);
        assertAdmitted(`${door.name} — ${label}`, await attempt(door, c, t));
      }
    });

    it(`${door.name}: an UNREADABLE restriction state refuses a first message as retryable, never as restricted`, async () => {
      const c = use("fail_closed");
      const got = await attempt(door, c, DM_NEW);
      assertRefused(door.name, got, "retryable");
      assert.notEqual(got.out.message, RESTRICTED_SEND_MESSAGE, "an unread state was reported as a restriction");
      if (door.name.startsWith("lib")) return; // the library result has no wire message; `unverifiable` is its retry answer
      assert.equal(got.out.message, RESTRICTION_UNKNOWN_MESSAGE, got.out.raw);
      assert.equal(got.out.retryable, true, got.out.raw);
    });

    it(`${door.name}: an unreadable FACT the decision needs (has the other person written?) refuses as retryable`, async () => {
      // The door's own reads of `messages` precede none of the gates, so the
      // first `messages` read is the restriction gate's reciprocity read.
      const c = use("messaging", {}, { errors: { messages: { message: "messages: timeout", ops: ["select"] } } });
      const got = await attempt(door, c, DM_NEW);
      assertRefused(door.name, got, "retryable");
      assert.notEqual(got.out.message, RESTRICTED_SEND_MESSAGE);
    });
  }

  it("3.x the command door says the sender is restricted — not 'not a member' (only a BLOCK is redacted)", async () => {
    use("messaging");
    const r = await http(`/telegraph/commands`, { type: "CREATE_COORDINATION_SESSION", conversationId: DM_NEW, idempotency_key: "cmd-restricted", params: { title: "x" } });
    assert.equal(r.reason, "TELEGRAPH_SAFETY_TRUST_RESTRICTED", r.raw);
    use("none", { blocks: [{ blocker_id: B, blocked_id: A }] });
    const blocked = await http(`/telegraph/commands`, { type: "CREATE_COORDINATION_SESSION", conversationId: DM_REPLY, idempotency_key: "cmd-blocked", params: { title: "x" } });
    assert.equal(blocked.reason, "TELEGRAPH_AUTH_NOT_MEMBER", "the block stays indistinguishable from not-a-member");
  });
});

describe("3c. an ACCEPTED message request is the recipient engaging (re-verification 3)", () => {
  const req = (status: string, from = A, to = E) =>
    ({ message_requests: [{ id: "66666666-0000-4000-8000-000000000001", sender_id: from, recipient_id: to, status, preview_text: null }] });
  for (const door of DOORS) {
    it(`${door.name}: a request that was NOT accepted (pending, declined, cancelled) is still starting contact`, async () => {
      for (const status of ["pending", "declined", "cancelled"]) {
        const c = use("messaging", req(status));
        const got = await attempt(door, c, DM_ACCEPTED);
        assertRefused(`${door.name} — ${status}`, got, "forbidden");
        assert.equal(got.out.message, RESTRICTED_SEND_MESSAGE);
      }
    });
    it(`${door.name}: the OTHER person's request, accepted by the sender, counts too`, async () => {
      const c = use("messaging", req("accepted", E, A));
      assertAdmitted(door.name, await attempt(door, c, DM_ACCEPTED));
    });
    it(`${door.name}: an unreadable message_requests read refuses retryably, never as restricted`, async () => {
      const c = use("messaging", {}, { errors: { message_requests: { message: "requests: timeout", ops: ["select"] } } });
      const got = await attempt(door, c, DM_ACCEPTED);
      assertRefused(door.name, got, "retryable");
      assert.notEqual(got.out.message, RESTRICTED_SEND_MESSAGE);
    });
  }
});

describe("3b. the inline doors' own reads for the restriction gate fail CLOSED (re-verification 2)", () => {
  // `refuseRestrictedSend` reads the thread's type and its roster itself. With
  // the roster unreadable, the other-member list would be EMPTY, no counterpart
  // would be found and a messaging-restricted FIRST message would be admitted —
  // so an unreadable read must refuse, retryably. The door's own membership and
  // block reads must SUCCEED, or the case would prove a refusal that came from
  // somewhere else: the answer is pinned to the restriction gate's own sentence.
  // The text door reads the roster three times before the gate (membership, the
  // burst limit's tier, the block guard); the media door twice (membership, the
  // block guard). A wrong count fails this case loudly — the door's own refusal
  // says "We could not verify this conversation", not the gate's sentence.
  const INLINE: Array<[Door, number]> = DOORS
    .filter((d) => d.name.startsWith("text") || d.name.startsWith("media"))
    .map((d) => [d, d.name.startsWith("text") ? 3 : 2]);
  for (const [door, rosterReadsBefore] of INLINE) {
    it(`${door.name}: the roster read fails under a messaging restriction — 503, the gate's own sentence, nothing written`, async () => {
      const c = use("messaging", {}, { errors: { message_thread_members: { message: "roster: timeout", ops: ["select"], afterOps: rosterReadsBefore } } });
      const got = await attempt(door, c, DM_NEW);
      assertRefused(door.name, got, "retryable");
      assert.equal(got.out.message, RESTRICTION_UNKNOWN_MESSAGE, got.out.raw);
    });
    it(`${door.name}: the thread-type read fails under a messaging restriction — 503, never the restriction sentence`, async () => {
      // The door's own is_e2ee read is the first message_threads operation.
      const c = use("messaging", {}, { errors: { message_threads: { message: "threads: timeout", ops: ["select"], afterOps: 1 } } });
      const got = await attempt(door, c, DM_NEW);
      assertRefused(door.name, got, "retryable");
      assert.equal(got.out.message, RESTRICTION_UNKNOWN_MESSAGE, got.out.raw);
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Never suppressible.
 * ════════════════════════════════════════════════════════════════════════ */

describe("4. safety sends and safety actions are never refused by a restriction", () => {
  const SAFETY_WORLDS: readonly World[] = ["none", ...RESTRICTION_TYPES, "fail_closed"];

  it("4.1 the §6.2 SAFETY kind reaches a thread the sender has never been written to in, in every world", async () => {
    for (const w of SAFETY_WORLDS) {
      const c = use(w);
      const r = await http(`/threads/${DM_NEW}/typed-messages`, { kind: "SAFETY", payload: { kind: "need_help", label: "I need help" } });
      assert.equal(r.ok, true, `${w}: ${r.raw}`);
      assert.equal(c._store.messages!.filter((m) => m.thread_id === DM_NEW && m.msg_type === "safety").length, 1, `${w}: not stored`);
    }
  });

  it("4.2 the §9.1 NEED_HELP quick state does too", async () => {
    for (const w of SAFETY_WORLDS) {
      const c = use(w);
      const r = await http(`/threads/${DM_NEW}/coordination`, { kind: "COORDINATION", payload: { state: "NEED_HELP" } });
      assert.equal(r.ok, true, `${w}: ${r.raw}`);
      assert.equal(fromA(c, DM_NEW), 1, `${w}: not stored`);
    }
  });

  it("4.3 CONTROL: the exemption is the message's, not the door's — ARRIVED through the same door is refused", async () => {
    const c = use("messaging");
    const r = await http(`/threads/${DM_NEW}/coordination`, { kind: "COORDINATION", payload: { state: "ARRIVED" } });
    assert.equal(r.ok, false, r.raw);
    assert.equal(r.message, RESTRICTED_SEND_MESSAGE);
    assert.equal(fromA(c, DM_NEW), 0);
  });

  // Blocking, reporting and appealing never pass the restriction gate. Driven
  // here under every restriction TYPE and an unreadable state, so a future
  // change that routes one of them through it goes red.
  //
  // FOUR MEASURED EXCEPTIONS, NOT ASSERTED AS CORRECT (re-verification 1,
  // 2026-10-06): POST /users/:id/block, POST /users/:id/mute,
  // POST /users/:id/restrict and POST /reports with target_type "user" answer
  // 500 "Permission check failed" when the restriction state cannot be read,
  // because resolveInteractionPermissions (services/interactionPermissions.ts)
  // throws DegradedPermissionCheckError on fail_closed and each route maps every
  // throw to db_error. Pre-existing, outside this gate; routed to the Trust lane
  // (lane B) — the permission engine and those four routes.
  const ACTIONS: Array<{ name: string; table: string; go: () => Promise<Outcome>; failClosedKnownRefused?: true }> = [
    { name: "block   POST /users/:id/block", table: "blocks", go: () => http(`/users/${B}/block`, {}), failClosedKnownRefused: true },
    { name: "mute    POST /users/:id/mute", table: "user_mutes", go: () => http(`/users/${B}/mute`, {}), failClosedKnownRefused: true },
    { name: "restrict POST /users/:id/restrict", table: "user_restrictions", go: () => http(`/users/${B}/restrict`, {}), failClosedKnownRefused: true },
    { name: "report  POST /reports (a user)", table: "reports", go: () => http(`/reports`, { target_type: "user", target_id: B, reason_code: "harassment" }), failClosedKnownRefused: true },
    { name: "report  POST /threads/:id/report", table: "reports", go: () => http(`/threads/${DM_REPLY}/report`, { reason: "harassment" }) },
    { name: "report  POST /messages/:id/report", table: "reports", go: () => http(`/messages/${M_REPLY}/report`, { reason: "spam" }) },
    { name: "report  POST /moderation/report", table: "moderation_reports", go: () => http(`/moderation/report`, { subjectType: "message", subjectId: M_REPLY, category: "harassment" }) },
    { name: "appeal  POST /appeals", table: "appeals", go: () => http(`/appeals`, { targetType: "account_warning", targetId: "44444444-0000-4000-8000-000000000001", reason: "This restriction was applied in error." }) },
  ];
  for (const a of ACTIONS) {
    it(`4.4 ${a.name}: succeeds under every restriction type${a.failClosedKnownRefused ? "" : " and an unreadable state"}`, async () => {
      for (const w of ["none", ...RESTRICTION_TYPES, ...(a.failClosedKnownRefused ? [] : ["fail_closed"])] as World[]) {
        const c = use(w);
        const r = await a.go();
        assert.equal(r.ok, true, `${w}: ${r.raw}`);
        assert.ok((c._store[a.table] ?? []).length >= 1, `${w}: answered ok, no ${a.table} row`);
      }
    });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. The projection and the guard read one decision — and are compared here.
 * ════════════════════════════════════════════════════════════════════════ */

describe("5. canSendMessage (the projection) and the send gates cannot disagree", () => {
  const THREADS = [DM_NEW, DM_REPLY, DM_BOOKING, TRIP, TRIP_PAIR, CIRCLE, DM_ACCEPTED];
  const WORLDS: Array<[World, Partial<Record<string, any[]>>, string]> = [
    ...ALL_WORLDS.map((w) => [w, {}, w] as [World, Partial<Record<string, any[]>>, string]),
    ["none", { blocks: [{ blocker_id: B, blocked_id: A }] }, "blocked"],
    ["messaging", { blocks: [{ blocker_id: B, blocked_id: A }] }, "messaging + blocked"],
  ];

  it("5.1 across every restriction world x thread shape, projection, shared guard and text door give one answer", async () => {
    let refusedCells = 0;
    for (const [w, over, label] of WORLDS) {
      for (const t of THREADS) {
        const cell = `${label} / ${t}`;
        const projection = await resolveConversationCapabilities(use(w, over) as any, { viewerId: A, conversationId: t });
        const guard = await guardTelegraphThreadWrite(use(w, over) as any, t, A);
        use(w, over);
        const text = await http(`/threads/${t}/messages`, { body: "agreement" });

        assert.equal(projection.capabilities.canSendMessage, guard.ok, `${cell}: projection ${projection.capabilities.canSendMessage}, guard ${guard.ok}`);
        assert.equal(text.ok, guard.ok, `${cell}: text door ${text.raw}, guard ${guard.ok}`);
        if (!guard.ok && guard.reason) {
          assert.equal(projection.reasons.canSendMessage, guard.reason, `${cell}: the two name different reasons`);
        }
        if (!guard.ok) refusedCells += 1;
      }
    }
    // Not vacuous: the matrix contains refusals of every kind it claims to compare.
    assert.ok(refusedCells >= 4, `only ${refusedCells} refused cells`);
  });

  it("5.2 a messaging restriction is still a CALL restriction in any thread (the call gateway's own rule)", async () => {
    const p = await resolveConversationCapabilities(use("messaging") as any, { viewerId: A, conversationId: TRIP });
    assert.equal(p.capabilities.canSendMessage, true);
    assert.equal(p.capabilities.canCall, false);
    assert.equal(p.reasons.canCall, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
  });
});

describe("5b. the projection's other restriction terms come from the same table (re-verification 5)", () => {
  // canCreatePlan ← hosting is MAIN's rule, kept while owner decision D-24 is open
  // (census-telegraph §45d.4; verification of a58aa01d3f, finding 2). The lanes'
  // narrower reading — a conversation plan is not hosting a group trip — is NOT shipped.
  const asDb = (c: FakeClient) => c as unknown as Parameters<typeof resolveConversationCapabilities>[0];
  it("5b.1 the table: canCall ← messaging, canCreatePlan ← hosting (status quo, pending D-24), canShareExactLocation ← location_plan_join", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(RESTRICTION_CAPABILITY_SCOPE).map(([k, v]) => [k, [...v]])),
      { canCall: ["messaging"], canCreatePlan: ["hosting"], canShareExactLocation: ["location_plan_join"] },
    );
  });

  it("5b.2 a hosting restriction refuses canCreatePlan in every thread type, as on main — and an unreadable state refuses it retryably", async () => {
    for (const t of [DM_REPLY, TRIP, CIRCLE]) {
      const p = await resolveConversationCapabilities(asDb(use("hosting")), { viewerId: A, conversationId: t });
      assert.equal(p.capabilities.canCreatePlan, false, `${t}: a hosting-restricted member may create a plan`);
      assert.equal(p.reasons.canCreatePlan, "TELEGRAPH_SAFETY_TRUST_RESTRICTED", t);
    }
    // "Could not check" is not "you are restricted": main answered TRUST_RESTRICTED here
    // (canHost false as a precaution); the table answers the degraded reason.
    const u = await resolveConversationCapabilities(asDb(use("fail_closed")), { viewerId: A, conversationId: TRIP });
    assert.equal(u.capabilities.canCreatePlan, false);
    assert.equal(u.reasons.canCreatePlan, "TELEGRAPH_DEGRADED_TRUST_UNREADABLE");
    // CONTROL: unrestricted, the same viewer in the same thread may.
    const none = await resolveConversationCapabilities(asDb(use("none")), { viewerId: A, conversationId: TRIP });
    assert.equal(none.capabilities.canCreatePlan, true, String(none.reasons.canCreatePlan));
  });

  it("5b.4 a location_plan_join restriction is the reason exact location is refused (lane B's crew live-share rule)", async () => {
    const p = await resolveConversationCapabilities(use("location_plan_join") as any, { viewerId: A, conversationId: TRIP });
    assert.equal(p.capabilities.canShareExactLocation, false);
    assert.equal(p.reasons.canShareExactLocation, "TELEGRAPH_SAFETY_TRUST_RESTRICTED");
    const none = await resolveConversationCapabilities(use("none") as any, { viewerId: A, conversationId: TRIP });
    assert.equal(none.reasons.canShareExactLocation, "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT");
  });

  it("5b.3 every world: each term is exactly the table's verdict, with the right reason", async () => {
    const expected = (cap: keyof typeof RESTRICTION_CAPABILITY_SCOPE, w: World): string | null => {
      const scope = RESTRICTION_CAPABILITY_SCOPE[cap];
      if (scope.length === 0) return null;
      if (w === "fail_closed") return "TELEGRAPH_DEGRADED_TRUST_UNREADABLE";
      return (scope as readonly string[]).includes(w) ? "TELEGRAPH_SAFETY_TRUST_RESTRICTED" : null;
    };
    for (const w of ALL_WORLDS) {
      const p = await resolveConversationCapabilities(use(w) as any, { viewerId: A, conversationId: TRIP });
      const call = expected("canCall", w);
      assert.equal(p.capabilities.canCall, call === null, `${w} canCall`);
      if (call) assert.equal(p.reasons.canCall, call, `${w} canCall reason`);
      const plan = expected("canCreatePlan", w);
      // Pinned literally as well as through the table: main's rule, pending D-24.
      assert.equal(plan, w === "hosting" ? "TELEGRAPH_SAFETY_TRUST_RESTRICTED" : w === "fail_closed" ? "TELEGRAPH_DEGRADED_TRUST_UNREADABLE" : null, `${w}: canCreatePlan's status quo`);
      assert.equal(p.capabilities.canCreatePlan, plan === null, `${w} canCreatePlan`);
      if (plan) assert.equal(p.reasons.canCreatePlan, plan, `${w} canCreatePlan reason`);
      const loc = expected("canShareExactLocation", w);
      // never TRUE today (§15.1); the table decides whether the REASON is the restriction
      assert.equal(p.reasons.canShareExactLocation, loc ?? "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT", `${w} canShareExactLocation reason`);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. The highlight-reply door resolves (or creates) its own DM.
 * ════════════════════════════════════════════════════════════════════════ */

describe("6. POST /highlights/:id/reply runs the six gates on the DM it resolves", () => {
  const highlight = {
    id: HIGHLIGHT, owner_id: D, media_url: `post-media/${D}/highlights/h.jpg`, media_type: "image",
    caption: "Rooftop at dusk", visibility: "public", location_name: null, location_city: "Hue", location_country: "Vietnam",
    created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
    deleted_at: null, archived_at: null, pinned_at: null,
  };
  const base = { highlights: [highlight], highlight_views: [], highlight_likes: [], highlight_replies: [], highlight_reports: [] };
  const withDm = (e2ee = false, dWrote = false, aLeft = false) => ({
    ...base,
    message_threads: [...seed().message_threads!, thread(DM_D, "direct", e2ee)],
    message_thread_members: [
      ...seed().message_thread_members!,
      member(DM_D, A, aLeft ? { left_at: "2026-09-01T00:00:00.000Z" } : {}), member(DM_D, D),
    ],
    messages: [...seed().messages!, ...(dWrote ? [message(M_D, DM_D, D)] : [])],
  });
  const reply = () => post(`/highlights/${HIGHLIGHT}/reply`, A, { message: "Where is this?" });
  const dmsWithD = (c: FakeClient) => {
    const withD = new Set(c._store.message_thread_members!.filter((m) => m.user_id === D).map((m) => m.thread_id));
    return c._store.message_threads!.filter((t) => withD.has(t.id));
  };
  const repliesFromA = (c: FakeClient) => c._store.messages!.filter((m) => m.sender_id === A && m.msg_type === "text" && m.body === "Where is this?");

  it("6.1 CONTROL: no DM yet, nothing set — the DM is created and the reply is in it", async () => {
    const c = use("none", base);
    const r = await reply();
    assert.equal(r.status, 200, r.raw);
    assert.equal(dmsWithD(c).length, 1);
    assert.equal(repliesFromA(c).length, 1);
  });

  it("6.2 a messaging-restricted replier cannot open a NEW conversation — and the thread it created is removed", async () => {
    const c = use("messaging", base);
    const r = await reply();
    assert.equal(r.status, 403, r.raw);
    assert.equal(r.body.message, RESTRICTED_SEND_MESSAGE);
    assert.equal(repliesFromA(c).length, 0);
    assert.equal(dmsWithD(c).length, 0, "a refused reply left an empty DM thread behind");
  });

  it("6.3 ...but may reply where the owner has already written to them", async () => {
    const c = use("messaging", withDm(false, true));
    const r = await reply();
    assert.equal(r.status, 200, r.raw);
    assert.equal(repliesFromA(c).length, 1);
  });

  it("6.4 an unreadable restriction state refuses retryably, and removes the created thread", async () => {
    const c = use("fail_closed", base);
    const r = await reply();
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.message, RESTRICTION_UNKNOWN_MESSAGE);
    assert.equal(r.body.retryable, true);
    assert.equal(dmsWithD(c).length, 0);
  });

  it("6.5 the messaging stop stops it, and removes the created thread", async () => {
    const c = use("none", { ...base, feature_flags: [{ flag: "disable_messaging", enabled: true }] });
    const r = await reply();
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(repliesFromA(c).length, 0);
    assert.equal(dmsWithD(c).length, 0);
  });

  it("6.6 no plaintext reply is written into an end-to-end encrypted DM", async () => {
    const c = use("none", withDm(true, true));
    const r = await reply();
    assert.equal(r.status, 422, r.raw);
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal(c._store.messages!.filter((m) => m.thread_id === DM_D && m.sender_id === A).length, 0);
    assert.equal(dmsWithD(c).length, 1, "an EXISTING thread is never removed");
  });

  it("6.7 a replier who LEFT the DM is refused rather than written back into it (behaviour change)", async () => {
    const c = use("none", withDm(false, true, true));
    const r = await reply();
    assert.equal(r.status, 403, r.raw);
    assert.equal(c._store.messages!.filter((m) => m.thread_id === DM_D && m.sender_id === A).length, 0);
  });

  it("6.8 the burst limit applies, and the created thread is removed", async () => {
    const c = use("none", base);
    await spendAllowance(DM_REPLY);
    const r = await reply();
    assert.equal(r.status, 429, r.raw);
    assert.equal(repliesFromA(c).length, 0);
    assert.equal(dmsWithD(c).length, 0);
  });

  it("6.9 a block still refuses (three layers: view access, canMessage, the guard)", async () => {
    const c = use("none", { ...withDm(false, true), blocks: [{ blocker_id: D, blocked_id: A }] });
    const r = await reply();
    assert.ok(r.status === 403 || r.status === 404, r.raw);
    assert.equal(c._store.messages!.filter((m) => m.thread_id === DM_D && m.sender_id === A).length, 0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. The third fact, and the id guard (verification of a58aa01d3f, findings 3
 *    and 5). Sections 3 and 3c drive an unreadable `messages` read and an
 *    unreadable `message_requests` read; this drives the last of the three —
 *    "does a booking own this thread?". Read as "no booking" it would only
 *    refuse; read as "a booking owns it" it would ADMIT a messaging-restricted
 *    first message. Either guess is wrong: unreadable is retryable.
 * ════════════════════════════════════════════════════════════════════════ */

describe("7. the booking read and the participant-id guard of readRestrictionSendFacts", () => {
  for (const door of DOORS) {
    it(`${door.name}: an unreadable rent_buddy_bookings read refuses a first message retryably, never as restricted`, async () => {
      const c = use("messaging", {}, { errors: { rent_buddy_bookings: { message: "bookings: timeout", ops: ["select"] } } });
      const got = await attempt(door, c, DM_NEW);
      assertRefused(door.name, got, "retryable");
      assert.notEqual(got.out.message, RESTRICTED_SEND_MESSAGE, "an unread booking was reported as a restriction");
    });
  }

  it("7.1 a participant id that is not a UUID is UNKNOWN — never built into the request filter", async () => {
    const restriction: RestrictionState = {
      canHost: true, canJoinPrivatePlans: true, canMessage: false, canJoinLocationPlans: true, activeRestrictions: ["messaging"],
    };
    for (const [senderId, counterpartId] of [["not-a-uuid", B], [A, `${E}),and(status.eq.accepted`]] as const) {
      const c = use("messaging");
      const facts = await readRestrictionSendFacts(c as unknown as Parameters<typeof readRestrictionSendFacts>[0], {
        threadId: DM_NEW, senderId, threadType: "direct", otherMemberIds: [counterpartId], safety: false, restriction,
      });
      assert.equal(facts.initiatesContact, null, `${senderId} -> ${counterpartId}: read as ${String(facts.initiatesContact)}`);
      assert.deepEqual(c._observed.or.filter((o) => o.table === "message_requests"), [], "a filter was built from a non-UUID id");
    }
  });
});
