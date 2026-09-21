/**
 * §17.8's list, closed: an unreadable table is not a missing object.
 *
 * ── THE DEFECT CLASS, AND WHY THIS ONE IS WORSE THAN A SILENT EMPTY ──────────
 * supabase-js RESOLVES on a database failure. So
 *
 *     const { data: mr } = await sc.from('message_requests')…maybeSingle();
 *     if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
 *
 * answers 404 for two different worlds: the row does not exist, and the table
 * could not be read. The second is a POSITIVE FALSE CLAIM about what exists —
 * and a 404 is the one refusal a caller acts on by GIVING UP. A client told
 * "Message request not found" removes the request from its list and stops
 * asking; a client told "try again shortly" retries. Fail-open authorization is
 * the more famous form of this bug, but this form is the one that destroys the
 * user's own model of their data.
 *
 * census-telegraph §17.8 enumerated the class rather than sampling it: every
 * `const { data: x } = await` in `routes/messaging.ts` was opened — 24 sites,
 * of which ELEVEN are refusals (a refusal is not a plausible empty state),
 * THREE are neither, and TEN turn an outage into a confident `not_found`. Two
 * more live in `routes/groupChat.ts`. Those TWELVE are this file's subject, and
 * §17.8 left them with the reason stated plainly: *"scope, not difficulty —
 * each is four lines, and doing twelve credibly means twelve behavioural cases
 * against twelve routes."* This is those twelve cases.
 *
 * ── THE SHAPE OF THE FIX, WHICH IS NOT THIS FILE'S INVENTION ─────────────────
 * §16 closed exactly one instance of this class, the circle-owner read in
 * `GET /circles/:id/chat`, and this file copies it rather than inventing a
 * second posture: bind the error, log it, and answer `degraded_unavailable` —
 * this codebase's own code for "the check was NOT PERFORMED" and the only code
 * marked retryable in `lib/http.ts` RETRYABLE_CODES. A genuinely absent object
 * still gets the 404 it deserves, and every case below asserts BOTH halves for
 * that reason.
 *
 * ── WHY EACH CASE IS PAIRED, AND WHY THE OFFSET IS MEASURED ──────────────────
 * A file that only asserted "an outage is not a 404" would pass just as well
 * against a route that had been deleted, or one that answers 500 for
 * everything. Each site therefore gets a CONTROL that a genuinely missing row
 * still produces `not_found`, so a blanket refusal fails the pair.
 *
 * Several handlers read the SAME table more than once before reaching the site
 * under test — the auth gate reads `profiles`, the membership gate reads
 * `message_thread_members`. Failing the whole table from operation 1 would stop
 * the request at the EARLIER read and the case would go green while proving
 * nothing about the site named. So every case MEASURES first: it runs clean,
 * finds the target read by its exact select string among that table's selects,
 * and only then re-runs with the error injected from that operation onward. If
 * a select string moves, the measurement fails loudly rather than silently
 * testing the wrong read — which is the failure mode `afterOps` was added to
 * this harness to prevent in the first place.
 *
 * Run: node --import tsx/esm --test src/test/telegraphNotFoundHonesty.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";
import {
  makeFakeClient,
  startRouter,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DM = "00000000-0000-4000-8000-00000000000d";
const MSG = "11111111-0000-4000-8000-000000000001";
const REQ = "22222222-0000-4000-8000-000000000002";
const TRIP = "33333333-0000-4000-8000-000000000003";
const TRIP_DM = "00000000-0000-4000-8000-00000000000e";
const ABSENT = "99999999-0000-4000-8000-000000000099";

const down = (t: string) => ({ message: `permission denied for relation ${t}`, code: "42501" });

/** `call` in the shared harness has no DELETE; this is the same request with any verb. */
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
    ],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [
      { id: REQ, sender_id: B, recipient_id: A, status: "pending", preview_text: "hello", created_at: "2026-01-01T00:00:00.000Z" },
    ],
    message_threads: [
      { id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null },
      { id: TRIP_DM, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "Trip Chat",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: TRIP_DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      { id: MSG, thread_id: DM, sender_id: A, body: "hello there friend",
        created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, edited_at: null,
        original_language: "en", language_detection_source: "provider",
        msg_type: "text", subtype: null, media_url: null, media_type: null,
        media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null },
    ],
    message_translations: [],
    saved_messages: [],
    trips: [{ id: TRIP, title: "Lisbon", destination_city: "Lisbon", created_by: A }],
    trip_members: [
      { trip_id: TRIP, user_id: A, status: "accepted", role: "owner" },
      // `GET /trips/:id/chat` gates on membership BEFORE it reads `trips`, so
      // without this the CONTROL would be refused at the gate and would never
      // reach the read it exists to prove still 404s. A membership row for a
      // trip that does not exist is exactly the state a deleted trip leaves
      // behind, so this is a real shape and not a convenience.
      { trip_id: ABSENT, user_id: A, status: "accepted", role: "member" },
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
  messagingHarness = await startRouter(messagingRouter);
  groupChatHarness = await startRouter(groupChatRouter);
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

/**
 * How many reads of `table` happen BEFORE the one selecting `sel`.
 * Fails loudly if that select is not observed — a moved call site must break
 * the measurement, not quietly redirect the case at some other read.
 */
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
  /** The request that REACHES the site — the object exists. */
  readonly path: string;
  readonly actor: string;
  readonly body?: any;
  /** The same request for an object that genuinely does not exist. */
  readonly absentPath: string;
  readonly table: string;
  readonly sel: string;
}

const SITES: Site[] = [
  { what: "POST /users/:userId/message-request — an unreadable `profiles` is not 'User not found'",
    harness: () => messagingHarness, method: "POST",
    path: `/users/${B}/message-request`, absentPath: `/users/${ABSENT}/message-request`,
    actor: A, body: { text: "hello, can we talk?" }, table: "profiles", sel: "id" },

  { what: "POST /message-requests/:id/accept — an unreadable `message_requests` is not 'not found'",
    harness: () => messagingHarness, method: "POST",
    path: `/message-requests/${REQ}/accept`, absentPath: `/message-requests/${ABSENT}/accept`,
    actor: A, table: "message_requests", sel: "id, sender_id, recipient_id, status, preview_text" },

  { what: "POST /message-requests/:id/decline — the same, on decline",
    harness: () => messagingHarness, method: "POST",
    path: `/message-requests/${REQ}/decline`, absentPath: `/message-requests/${ABSENT}/decline`,
    actor: A, table: "message_requests", sel: "id, sender_id, recipient_id, status" },

  { what: "POST /message-requests/:id/cancel — the same, on cancel",
    harness: () => messagingHarness, method: "POST",
    path: `/message-requests/${REQ}/cancel`, absentPath: `/message-requests/${ABSENT}/cancel`,
    actor: B, table: "message_requests", sel: "id, sender_id, status" },

  { what: "POST /threads/:id/e2ee — an unreadable `message_thread_members` is not 'Thread not found'",
    harness: () => messagingHarness, method: "POST",
    path: `/threads/${DM}/e2ee`, absentPath: `/threads/${ABSENT}/e2ee`,
    actor: A, table: "message_thread_members", sel: "user_id" },

  { what: "POST /threads/:id/e2ee — an unreadable `message_threads` is not 'Thread not found' either",
    harness: () => messagingHarness, method: "POST",
    path: `/threads/${DM}/e2ee`, absentPath: `/threads/${ABSENT}/e2ee`,
    actor: A, table: "message_threads", sel: "id, thread_type, is_e2ee" },

  { what: "POST /messages/:id/translate/retry — an unreadable `messages` is not 'Message not found'",
    harness: () => messagingHarness, method: "POST",
    path: `/messages/${MSG}/translate/retry`, absentPath: `/messages/${ABSENT}/translate/retry`,
    actor: A, table: "messages", sel: "id, thread_id, sender_id, body, deleted_at, original_language" },

  { what: "PATCH /threads/:t/messages/:m — the same, on edit",
    harness: () => messagingHarness, method: "PATCH",
    path: `/threads/${DM}/messages/${MSG}`, absentPath: `/threads/${DM}/messages/${ABSENT}`,
    actor: A, body: { body: "hello there friend, edited" },
    table: "messages", sel: "id, thread_id, sender_id, body, deleted_at" },

  { what: "GET /trips/:id/chat — an unreadable `trips` is not 'Trip not found'",
    harness: () => messagingHarness, method: "GET",
    path: `/trips/${TRIP}/chat`, absentPath: `/trips/${ABSENT}/chat`,
    actor: A, table: "trips", sel: "id, title, destination_city" },

  { what: "POST /threads/:t/messages/:m/save — the same, on save",
    harness: () => messagingHarness, method: "POST",
    path: `/threads/${DM}/messages/${MSG}/save`, absentPath: `/threads/${DM}/messages/${ABSENT}/save`,
    actor: A, table: "messages", sel: "id" },

  { what: "groupChat PATCH /messages/:id — an unreadable `messages` is not 'Message not found'",
    harness: () => groupChatHarness, method: "PATCH",
    path: `/messages/${MSG}`, absentPath: `/messages/${ABSENT}`,
    actor: A, body: { body: "hello there friend, edited" },
    table: "messages", sel: "id, thread_id, sender_id, body, deleted_at" },

  { what: "groupChat DELETE /messages/:id — the same, on delete",
    harness: () => groupChatHarness, method: "DELETE",
    path: `/messages/${MSG}`, absentPath: `/messages/${ABSENT}`,
    actor: A, table: "messages", sel: "id, thread_id, sender_id, deleted_at" },
];

describe("§17.8 — an unreadable table is not a missing object (twelve sites)", () => {
  for (const s of SITES) {
    describe(s.what, () => {
      it("CONTROL — an object that genuinely does not exist is still 404 not_found", async () => {
        use(store());
        const r = await req(s.harness().base, s.method, s.absentPath, s.actor, s.body);
        assert.equal(r.status, 404, `expected a 404 for an absent object: ${JSON.stringify(r.body)}`);
        assert.equal(r.body?.error, "not_found", JSON.stringify(r.body));
      });

      it("an unreadable table refuses RETRYABLY instead of reporting the object gone", async () => {
        // Measure where the read under test falls, so the error is injected at
        // THAT read and not at an earlier one on the same table.
        const probe = use(store());
        await req(s.harness().base, s.method, s.path, s.actor, s.body);
        const before = priorReadsOf(probe, s.table, s.sel);

        // `afterOps: N` means "inject once N operations on this table have ALREADY
        // happened", i.e. fail from operation N+1 onward — so the value that fails
        // the read under test is exactly the count of reads BEFORE it, not that
        // count plus one. Getting this off by one silently moves the case to the
        // NEXT read on the same table, which is how the first draft of this file
        // measured `profiles` correctly and then tested the permission gate.
        use(store(), { errors: { [s.table]: { ...down(s.table), afterOps: before } } });
        const r = await req(s.harness().base, s.method, s.path, s.actor, s.body);

        assert.notEqual(
          r.body?.error, "not_found",
          `a read that never happened was reported as a missing object — the caller acts on ` +
            `'not_found' by giving up. ${JSON.stringify(r.body)}`,
        );
        assert.notEqual(r.status, 404, JSON.stringify(r.body));
        assert.equal(
          r.body?.error, "degraded_unavailable",
          `the refusal must be the retryable code this codebase already uses for ` +
            `"the check was NOT PERFORMED": ${JSON.stringify(r.body)}`,
        );
      });
    });
  }
});
