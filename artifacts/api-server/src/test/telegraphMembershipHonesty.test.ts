/**
 * §20.7's class, closed in the two files §22.3 could not reach.
 *
 * ── THE DEFECT, AND WHY IT IS NOT THE §18 DEFECT ────────────────────────────
 * supabase-js RESOLVES on a database failure. So
 *
 *     const { data: membership } = await client.from('message_thread_members')…
 *     if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }
 *
 * answers 403 for two different worlds: the caller is genuinely not a member,
 * and the membership table could not be read. That is SAFE — it denies rather
 * than admits — and it is still FALSE: the server does not know whether the
 * caller is a member and says it does, by name, to a person looking at their
 * own conversation. §20.7 named this precisely and declined to fix it because
 * `degraded_unavailable` is the only code `lib/http.ts` marks retryable, so the
 * change alters the retry behaviour of live routes.
 *
 * §22.3 answered that hesitation rather than overruling it, and closed the
 * three sites in `routes/telegraphChat.ts` and `routes/telegraphStream.ts`. It
 * could not reach `routes/messaging.ts` and `routes/groupChat.ts`, which hold
 * the other FOURTEEN — including every gate on the conversation screen the app
 * actually opens. This file is those fourteen.
 *
 * A 403 tells the client the answer is settled. A member locked out by a
 * database blip is told they are not in their own conversation, and the app
 * will not recover when the table does. `degraded_unavailable` is this
 * codebase's own code for "the check was NOT PERFORMED", and it is the only
 * code in `lib/http.ts` RETRYABLE_CODES.
 *
 * ── TWO SITES ARE NOT MEMBERSHIP, AND ARE HERE FOR THE SAME REASON ──────────
 * `POST /threads/:id/e2ee` refuses with "Cannot enable encryption before the
 * key-exchange message has been delivered" from a `messages` read whose error
 * was dropped — an unreadable table asserts that the Welcome was never
 * delivered. `POST /messages/:id/translate/retry` refuses with "No failed
 * translation to retry" from an unreadable `message_translations`. Neither is a
 * membership answer; both are the same false statement about a read that never
 * happened, and both refuse a person's own action on evidence nobody has.
 *
 * ── EVERY CASE IS PAIRED, BECAUSE A SUITE THAT ONLY ASSERTS "NOT A 403"
 *    WOULD PASS AGAINST A ROUTE THAT REFUSES EVERYBODY ────────────────────────
 * Each site gets a CONTROL proving a GENUINE non-member is still refused 403
 * with the same words. The refusal is narrowed, not removed. Several sites also
 * carry a MEMBER control, because a route that 503s unconditionally would
 * satisfy both halves of a weaker pair.
 *
 * ── THE OFFSET IS MEASURED, NEVER GUESSED ───────────────────────────────────
 * Several handlers read the same table more than once before the site under
 * test (the send path reads `message_thread_members` for the caller and again
 * for the roster). Failing the whole table stops the request at the EARLIER
 * read and the case goes green proving nothing. So every case runs clean first,
 * finds the read by its exact select string, and injects from that read onward.
 * This is `telegraphNotFoundHonesty.test.ts`'s device and it is copied, not
 * reinvented.
 *
 * Run: node --import tsx/esm --test src/test/telegraphMembershipHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";
import express from "express";
import { createServer } from "node:http";

import { globalErrorHandler } from "../lib/errorEnvelope.js";
import {
  makeFakeClient,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

/**
 * The shared harness mounts a router with NO error middleware, so a guard that
 * refuses by THROWING (`TripAccessUnavailableError`, lib/http.ts) reaches the
 * test as Express's default HTML page rather than as the envelope the app
 * actually sends. `globalErrorHandler` is what `routes/index.ts` mounts in
 * production and it is what makes a thrown refusal indistinguishable from a
 * hand-sent `degraded_unavailable`. A suite measuring refusal CODES must mount
 * it or it is measuring a different application.
 */
async function startRouterWithGlobalHandler(router: express.Router): Promise<RouterHarness> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", router);
  app.use(globalErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${addr.port}/api`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // member of everything
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // the other DM member
const C = "cccccccc-0000-4000-8000-000000000003"; // member of NOTHING — the control actor
const DM = "00000000-0000-4000-8000-00000000000d";
const TRIP_DM = "00000000-0000-4000-8000-00000000000e";
const CIRCLE_DM = "00000000-0000-4000-8000-00000000000f";
const MSG = "11111111-0000-4000-8000-000000000001";
const TRIP = "33333333-0000-4000-8000-000000000003";
const T0 = "2026-01-01T00:00:00.000Z";

const down = (t: string) => ({ message: `permission denied for relation ${t}`, code: "42501" });

async function req(
  base: string,
  method: string,
  path: string,
  asUser: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${asUser}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", account_status: null },
      { id: B, handle: "b", name: "B", account_status: null },
      { id: C, handle: "c", name: "C", account_status: null },
    ],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [],
    message_threads: [
      { id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: T0, updated_at: T0, last_message_at: null },
      { id: TRIP_DM, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "Trip Chat",
        status: "active", is_e2ee: false, created_at: T0, updated_at: T0, last_message_at: null },
      { id: CIRCLE_DM, thread_type: "circle", trip_id: null, circle_owner_id: A, title: "Trusted Circle",
        status: "active", is_e2ee: false, created_at: T0, updated_at: T0, last_message_at: null },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", joined_at: T0, left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", joined_at: T0, left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: TRIP_DM, user_id: A, role: "member", joined_at: T0, left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: CIRCLE_DM, user_id: A, role: "member", joined_at: T0, left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      { id: MSG, thread_id: DM, sender_id: A, body: "hello there friend",
        created_at: T0, deleted_at: null, edited_at: null,
        original_language: "en", language_detection_source: "provider",
        msg_type: "text", subtype: null, media_url: null, media_type: null,
        media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
    ],
    message_translations: [
      { id: "44444444-0000-4000-8000-000000000004", message_id: MSG, recipient_id: A, status: "failed" },
    ],
    saved_messages: [],
    circle_memberships: [{ user_id: A, other_id: B }],
    circle_invites: [],
    trips: [{ id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: A }],
    trip_members: [
      { trip_id: TRIP, user_id: A, status: "accepted", role: "owner" },
      { trip_id: TRIP, user_id: B, status: "accepted", role: "member" },
    ],
    ...over,
  };
}

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

let messagingHarness: RouterHarness;
let groupChatHarness: RouterHarness;

before(async () => {
  messagingHarness = await startRouterWithGlobalHandler(messagingRouter);
  groupChatHarness = await startRouterWithGlobalHandler(groupChatRouter);
});
after(async () => {
  await messagingHarness.close();
  await groupChatHarness.close();
});
beforeEach(() => {
  resetFakeIds();
  _resetRateLimit();
  _clearSendTierCache();
});

/** How many reads of `table` happen BEFORE the one selecting `sel`. */
function priorReadsOf(c: FakeClient, table: string, sel: string): number {
  const idx = c._observed.selects.findIndex((s) => s.table === table && s.sel === sel);
  assert.ok(
    idx >= 0,
    `no ${table} read selecting "${sel}" was observed — the call site moved or its select changed, ` +
      `so this case would otherwise have tested a different read. Observed on ${table}: ` +
      JSON.stringify(c._observed.selects.filter((s) => s.table === table).map((s) => s.sel)),
  );
  return c._observed.selects.filter((s, i) => s.table === table && i < idx).length;
}

interface Site {
  readonly what: string;
  readonly harness: () => RouterHarness;
  readonly method: string;
  readonly path: string;
  readonly body?: any;
  /** The actor who IS entitled — used for the outage case and the member control. */
  readonly actor: string;
  /**
   * The request a genuinely-unentitled caller makes. When `strangerActor` is
   * set the SAME path is used by somebody with no membership row; otherwise
   * `strangerPath` names a different object.
   */
  readonly strangerActor?: string;
  readonly strangerPath?: string;
  /** The words the genuine refusal uses — asserted so the refusal is narrowed, not replaced. */
  readonly refusalCode: string;
  readonly table: string;
  readonly sel: string;
  /** When set, the member control asserts this status for a healthy request. */
  readonly healthyStatus?: number;
}

const SITES: Site[] = [
  // ── routes/messaging.ts — nine membership gates ──────────────────────────
  { what: "GET /threads/:id/messages — an unreadable `message_thread_members` is not 'Not a member of this thread'",
    harness: () => messagingHarness, method: "GET", path: `/threads/${DM}/messages`,
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id, left_at", healthyStatus: 200 },

  { what: "POST /threads/:id/messages — the same, on send",
    harness: () => messagingHarness, method: "POST", path: `/threads/${DM}/messages`,
    body: { body: "hello there friend" },
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id, left_at" },

  { what: "POST /threads/:id/media — the same, on the media send",
    harness: () => messagingHarness, method: "POST", path: `/threads/${DM}/media`,
    body: { mediaUrl: `post-media/${A}/p.webp`, mediaType: "image" },
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id, left_at" },

  { what: "POST /messages/:id/translate/retry — the same, on the translation retry",
    harness: () => messagingHarness, method: "POST", path: `/messages/${MSG}/translate/retry`,
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id" },

  { what: "PATCH /threads/:t/messages/:m — the same, on edit",
    harness: () => messagingHarness, method: "PATCH", path: `/threads/${DM}/messages/${MSG}`,
    body: { body: "hello there friend, edited" },
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id" },

  { what: "GET /trips/:id/chat — an unreadable `trip_members` is not 'You must be an accepted trip member'",
    harness: () => messagingHarness, method: "GET", path: `/trips/${TRIP}/chat`,
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "trip_members", sel: "role" },

  { what: "GET /circles/:id/chat — an unreadable `circle_memberships` is not 'You must be a member of this circle'",
    harness: () => messagingHarness, method: "GET", path: `/circles/${A}/chat`,
    actor: B, strangerActor: C, refusalCode: "forbidden",
    table: "circle_memberships", sel: "other_id" },

  { what: "PATCH /threads/:id/mute — the same, on mute",
    harness: () => messagingHarness, method: "PATCH", path: `/threads/${DM}/mute`,
    body: { muted: true },
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id" },

  { what: "POST /threads/:t/messages/:m/save — the same, on save",
    harness: () => messagingHarness, method: "POST", path: `/threads/${DM}/messages/${MSG}/save`,
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id" },

  // ── routes/groupChat.ts — five gates ─────────────────────────────────────
  { what: "groupChat GET /circles/:id/chat — an unreadable `circle_memberships` is not 'not_member'",
    harness: () => groupChatHarness, method: "GET", path: `/circles/${A}/chat`,
    actor: B, strangerActor: C, refusalCode: "not_member",
    table: "circle_memberships", sel: "other_id" },

  { what: "groupChat PATCH /messages/:id — an unreadable `message_thread_members` is not 'You no longer have access'",
    harness: () => groupChatHarness, method: "PATCH", path: `/messages/${MSG}`,
    body: { body: "hello there friend, edited" },
    actor: A, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id, left_at" },

  { what: "groupChat DELETE /messages/:id — the same, on delete",
    harness: () => groupChatHarness, method: "DELETE", path: `/messages/${MSG}`,
    actor: A, refusalCode: "forbidden",
    table: "message_thread_members", sel: "user_id, left_at" },

  { what: "groupChat POST /trips/:id/chat/sync — an unreadable `trip_members` is not 'Only the trip owner'",
    harness: () => groupChatHarness, method: "POST", path: `/trips/${TRIP}/chat/sync`,
    actor: A, strangerActor: C, refusalCode: "forbidden",
    table: "trip_members", sel: "role" },
];

describe("§20.7 — an unreadable authorization table is not a settled refusal (fourteen sites)", () => {
  for (const s of SITES) {
    describe(s.what, () => {
      if (s.strangerActor || s.strangerPath) {
        it("CONTROL — a genuine non-member is still refused, with the same words", async () => {
          use(store());
          const r = await req(
            s.harness().base,
            s.method,
            s.strangerPath ?? s.path,
            s.strangerActor ?? s.actor,
            s.body,
          );
          assert.equal(r.status, 403, `expected a 403 for a genuine non-member: ${JSON.stringify(r.body)}`);
          assert.equal(r.body?.error, s.refusalCode, JSON.stringify(r.body));
        });
      }

      it("an unreadable table refuses RETRYABLY instead of asserting the caller is not entitled", async () => {
        const probe = use(store());
        await req(s.harness().base, s.method, s.path, s.actor, s.body);
        const before = priorReadsOf(probe, s.table, s.sel);

        use(store(), { errors: { [s.table]: { ...down(s.table), afterOps: before } } });
        const r = await req(s.harness().base, s.method, s.path, s.actor, s.body);

        assert.notEqual(
          r.status, 403,
          `a read that never happened was reported as a settled refusal — the caller acts on a ` +
            `403 by giving up. ${JSON.stringify(r.body)}`,
        );
        assert.equal(
          r.body?.error, "degraded_unavailable",
          `the refusal must be the retryable code this codebase already uses for ` +
            `"the check was NOT PERFORMED": ${JSON.stringify(r.body)}`,
        );
      });

      if (s.healthyStatus !== undefined) {
        it("CONTROL — a healthy request from an entitled member still succeeds", async () => {
          use(store());
          const r = await req(s.harness().base, s.method, s.path, s.actor, s.body);
          assert.equal(r.status, s.healthyStatus, JSON.stringify(r.body));
        });
      }
    });
  }
});

describe("§20.7 — two refusals that are not membership and make the same false claim", () => {
  it("CONTROL — POST /threads/:id/e2ee still refuses when the Welcome genuinely has not been sent", async () => {
    use(store());
    const r = await req(messagingHarness.base, "POST", `/threads/${DM}/e2ee`, A);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
  });

  it("POST /threads/:id/e2ee — an unreadable `messages` is not 'the Welcome has not been delivered'", async () => {
    const probe = use(store());
    await req(messagingHarness.base, "POST", `/threads/${DM}/e2ee`, A);
    const before = priorReadsOf(probe, "messages", "id");

    use(store(), { errors: { messages: { ...down("messages"), afterOps: before } } });
    const r = await req(messagingHarness.base, "POST", `/threads/${DM}/e2ee`, A);
    assert.equal(
      r.body?.error, "degraded_unavailable",
      `an unreadable messages table asserted the key-exchange message was never delivered: ` +
        JSON.stringify(r.body),
    );
  });

  it("CONTROL — translate/retry still refuses when there is genuinely no failed translation", async () => {
    use(store({ message_translations: [] }));
    const r = await req(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, A);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, "invalid_payload", JSON.stringify(r.body));
  });

  it("CONTROL — translate/retry still accepts a genuinely failed translation", async () => {
    use(store());
    const r = await req(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, A);
    assert.equal(r.status, 202, JSON.stringify(r.body));
  });

  it("POST /messages/:id/translate/retry — an unreadable `message_translations` is not 'nothing to retry'", async () => {
    const probe = use(store());
    await req(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, A);
    const before = priorReadsOf(probe, "message_translations", "id, status");

    use(store(), { errors: { message_translations: { ...down("message_translations"), afterOps: before } } });
    const r = await req(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, A);
    assert.equal(
      r.body?.error, "degraded_unavailable",
      `an unreadable message_translations asserted there was no failed translation: ` +
        JSON.stringify(r.body),
    );
  });
});

/**
 * The two invite fallbacks: a person who HAS a pending invite is told they do
 * not, from a read that never happened.
 *
 * Both group-chat entry routes answer one of two 403s — `pending_invite`
 * ("Accept the invite to join this chat") and `not_member` ("You must be an
 * accepted member"). The first is an instruction the caller can act on; the
 * second is a dead end. The read that decides between them dropped its error,
 * so an unreadable table sent a person with a live invite to the dead end.
 *
 * These cannot use the SITES table above, because the read under test is only
 * reached on the REFUSAL path — a healthy request from an entitled member never
 * performs it, so there is nothing to measure an offset against. The offset is
 * therefore derived from the gate above it, which is stated rather than
 * guessed: `isAcceptedTripMember` reads `trip_members` once (`lib/http.ts`
 * `requireTripMember`), so the invite read is operation 2.
 */
describe("§20.7 — an unreadable table must not send a person with an invite to the dead end", () => {
  const INVITED_TRIP = { trip_id: TRIP, user_id: C, status: "invited", role: "invited" };
  const INVITED_CIRCLE = {
    id: "55555555-0000-4000-8000-000000000005",
    owner_id: A, recipient_id: C, status: "pending",
  };

  it("CONTROL — groupChat GET /trips/:id/chat tells a genuinely invited caller to accept", async () => {
    use(store({ trip_members: [...store().trip_members, INVITED_TRIP] }));
    const r = await req(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, C);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "pending_invite", JSON.stringify(r.body));
  });

  it("CONTROL — groupChat GET /trips/:id/chat still refuses a caller with no invite at all", async () => {
    use(store());
    const r = await req(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, C);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "not_member", JSON.stringify(r.body));
  });

  it("groupChat GET /trips/:id/chat — an unreadable invite read is not 'you are not a member'", async () => {
    use(store({ trip_members: [...store().trip_members, INVITED_TRIP] }), {
      errors: { trip_members: { ...down("trip_members"), afterOps: 1 } },
    });
    const r = await req(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, C);
    assert.notEqual(
      r.body?.error, "not_member",
      `a caller with a live invite was told they are not a member, from a read that never ` +
        `happened: ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  it("CONTROL — groupChat GET /circles/:id/chat tells a genuinely invited caller to accept", async () => {
    use(store({ circle_invites: [INVITED_CIRCLE] }));
    const r = await req(groupChatHarness.base, "GET", `/circles/${A}/chat`, C);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "pending_invite", JSON.stringify(r.body));
  });

  it("groupChat GET /circles/:id/chat — an unreadable `circle_invites` is not 'you are not a member'", async () => {
    use(store({ circle_invites: [INVITED_CIRCLE] }), {
      errors: { circle_invites: down("circle_invites") },
    });
    const r = await req(groupChatHarness.base, "GET", `/circles/${A}/chat`, C);
    assert.notEqual(
      r.body?.error, "not_member",
      `a caller with a live circle invite was told they are not a member, from a read that ` +
        `never happened: ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });

  /**
   * The gate ABOVE those two already behaves correctly, and that is asserted
   * rather than assumed: `isAcceptedTripMember` THROWS on an unreadable
   * `trip_members` and the global handler turns the throw into the same
   * retryable envelope. If that ever regresses to `false`, the route would
   * answer `not_member` for an outage and this case is where it shows.
   */
  it("CONTROL — the trip gate above it already refuses retryably on a whole-table outage", async () => {
    use(store(), { errors: { trip_members: down("trip_members") } });
    const r = await req(groupChatHarness.base, "GET", `/trips/${TRIP}/chat`, A);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});
