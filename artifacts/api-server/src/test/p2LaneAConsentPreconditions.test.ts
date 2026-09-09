/**
 * Lane A, part 2 — the write-precondition reads whose failure crosses a
 * CONSENT or a CONFIDENTIALITY boundary.
 *
 * Same defect as p2LaneAWritePreconditions.test.ts (supabase-js RESOLVES on a
 * DB error, so `{ data: null }` means both "no such row" and "unreadable
 * table"), but these three sites are the ones where reading the failure as "no
 * row" does something to ANOTHER PERSON that cannot be taken back:
 *
 *   messaging.ts  message_threads.is_e2ee   `?.is_e2ee === true` is FALSE on an
 *                                           unreadable row, so the plaintext
 *                                           preview is written into what may be
 *                                           an end-to-end-encrypted thread —
 *                                           server-readable plaintext persisted
 *                                           into an E2EE conversation (MSG-3).
 *   friends.ts    circle_invites            an unreadable row skips both the
 *                                           short-circuits AND the reactivate
 *                                           branch, so someone who DECLINED an
 *                                           invitation into a trusted circle is
 *                                           silently re-invited.
 *   rentABuddy.ts rent_buddy_tag_consents   likewise re-asks to photo-tag
 *                                           someone who already declined, and
 *                                           shows the requester a fresh
 *                                           "pending" over a settled refusal.
 *
 * Every case asserts the exact refusal AND that the specific row was NOT
 * written; `notEqual(status, 200)` would be satisfied by a request that died at
 * validation. Only ONE table is ever failed per case, because `requireUser`
 * itself answers 503 `degraded_unavailable` on an unreadable `profiles` and a
 * globally-failing fake would produce a green test that never entered the
 * handler. The `req.log` shim is installed for the same reason as in the
 * sibling file: without it the logging line each fix adds throws, and the
 * 500-from-crash would look like a refusal.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneAConsentPreconditions.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import messagingRouter from "../routes/messaging.js";
import friendsRouter from "../routes/friends.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

const ME      = "aaaaaaaa-3333-4000-a000-000000000001";
const SENDER  = "bbbbbbbb-3333-4000-a000-000000000002";
const REQUEST = "cccccccc-3333-4000-a000-000000000003";
const THREAD  = "dddddddd-3333-4000-a000-000000000004";
const BOOKING = "eeeeeeee-3333-4000-a000-000000000005";
const BUDDYP  = "ffffffff-3333-4000-a000-000000000006";
const TOK     = "tok-me";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

let server: http.Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", messagingRouter);
  app.use("/api", friendsRouter);
  app.use("/api", rentABuddyRouter);
  server = http.createServer(app);
  // 127.0.0.1 explicitly: a host-less listen(0) binds the IPv6 wildcard, and the
  // kernel may hand back a port a foreign process already holds on loopback —
  // the request then reaches the stranger and a random case in this file fails on
  // whatever it answered. The address makes the bind DEFERRED (node routes it
  // through lookupAndListen), so the callback, not the next line, is when
  // address() is readable. check:loopback-bind enforces this.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOK}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function install(spec: Parameters<typeof makeFailClosedClient>[0]) {
  const c = makeFailClosedClient(spec);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return spec;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

// ═════════════════════════════════════════════════════════════════════════════
// messaging.ts — the E2EE preview insert
// ═════════════════════════════════════════════════════════════════════════════
//
// Accepting a message request can reuse an EXISTING direct thread, and that
// thread may be e2ee. The `is_e2ee` read is what stops the request's plaintext
// preview_text from being written into it. The route responds before this runs,
// so the assertion is on what reached the `messages` table.

const PREVIEW = "meet me at the harbour at six";

/** Rows for an accept that reuses an existing 1:1 thread between SENDER and ME. */
function acceptRows(isE2ee: boolean) {
  return {
    profiles: [{ id: ME, account_status: "active" }, { id: SENDER, account_status: "active" }],
    message_requests: [{
      id: REQUEST, sender_id: SENDER, recipient_id: ME,
      status: "pending", preview_text: PREVIEW,
    }],
    message_thread_members: [
      { thread_id: THREAD, user_id: SENDER },
      { thread_id: THREAD, user_id: ME },
    ],
    message_threads: [{ id: THREAD, thread_type: "direct", is_e2ee: isE2ee }],
  };
}

/**
 * Fail ONLY the `.eq('id', threadId)` read of message_threads — i.e. exactly
 * the is_e2ee lookup. The thread-reuse lookup earlier in the same handler uses
 * `.in('id', …)`, and failing that too would send the route down the
 * create-a-new-thread branch instead of the one under test.
 */
const failIsE2eeLookup = (ctx: FakeReadContext) =>
  ctx.table === "message_threads" && ctx.filters.some((f) => f.col === "id" && f.op === "eq")
    ? READ_FAIL
    : null;

describe("POST /message-requests/:requestId/accept — is_e2ee gates a plaintext write", () => {
  it("does NOT write the plaintext preview when is_e2ee cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      // The thread really IS e2ee. The route must not be able to see that — and
      // must not write plaintext into it regardless.
      rows: acceptRows(true),
      failOn: failIsE2eeLookup,
    });

    const r = await req("POST", `/api/message-requests/${REQUEST}/accept`);
    assert.equal(r.status, 200);
    assert.equal(r.body.threadId, THREAD);
    await settle();

    assert.equal(
      spec.inserted?.messages, undefined,
      "plaintext preview was persisted into a thread whose e2ee flag could not be read",
    );
  });

  it("still refuses the preview for a thread known to be e2ee", async () => {
    const spec = install({ users: { [TOK]: ME }, rows: acceptRows(true) });

    const r = await req("POST", `/api/message-requests/${REQUEST}/accept`);
    assert.equal(r.status, 200);
    await settle();

    assert.equal(spec.inserted?.messages, undefined);
  });

  it("still writes the preview for a plain, non-e2ee thread", async () => {
    const spec = install({ users: { [TOK]: ME }, rows: acceptRows(false) });

    const r = await req("POST", `/api/message-requests/${REQUEST}/accept`);
    assert.equal(r.status, 200);
    await settle();

    const written = spec.inserted?.messages?.[0];
    assert.ok(written, "expected the preview message to be inserted on a non-e2ee thread");
    assert.equal(written.body, PREVIEW);
    assert.equal(written.thread_id, THREAD);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// friends.ts — POST /circle-invites
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /circle-invites — circle_invites is a write precondition", () => {
  it("REFUSES and inserts nothing when circle_invites cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        // SENDER already DECLINED this invite. Unreadable, that decline would
        // be neither seen nor reactivated — they would simply be re-invited.
        circle_invites: [{ id: "inv-1", owner_id: ME, recipient_id: SENDER, status: "declined" }],
      },
      failOn: (ctx: FakeReadContext) => (ctx.table === "circle_invites" ? READ_FAIL : null),
    });

    const r = await req("POST", "/api/circle-invites", { recipientId: SENDER });

    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /existing circle invites/i);
    assert.equal(spec.inserted?.circle_invites, undefined);
    assert.equal(spec.updated?.circle_invites, undefined);
  });

  it("still REACTIVATES a declined invite when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        circle_invites: [{ id: "inv-1", owner_id: ME, recipient_id: SENDER, status: "declined" }],
      },
    });

    const r = await req("POST", "/api/circle-invites", { recipientId: SENDER });

    assert.equal(r.status, 200);
    assert.equal(r.body.reactivated, true);
    assert.equal(spec.inserted?.circle_invites, undefined);
  });

  it("still creates a first-time invite when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: { profiles: [{ id: ME, account_status: "active" }], circle_invites: [] },
    });

    const r = await req("POST", "/api/circle-invites", { recipientId: SENDER });

    assert.equal(r.status, 201);
    assert.equal(r.body.status, "pending");
    assert.deepEqual(spec.inserted?.circle_invites, [{ owner_id: ME, recipient_id: SENDER }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// rentABuddy.ts — POST /rent-a-buddy/bookings/:bookingId/tag-consent
// ═════════════════════════════════════════════════════════════════════════════

function tagConsentRows(consentStatus: string | null) {
  return {
    profiles: [{ id: ME, account_status: "active" }],
    feature_flags: [{ flag: "rent_buddy_enabled", enabled: true }],
    rent_buddy_bookings: [{
      id: BOOKING, traveler_id: ME, buddy_id: BUDDYP,
      status: "completed", safety_status: null,
    }],
    rent_buddy_profiles: [{ id: BUDDYP, user_id: SENDER }],
    rent_buddy_tag_consents: consentStatus === null
      ? []
      : [{
          id: "consent-1", booking_id: BOOKING, requester_id: ME,
          target_id: SENDER, consent_status: consentStatus,
        }],
  };
}

describe("POST /rent-a-buddy/bookings/:id/tag-consent — a decline must not be overwritten", () => {
  it("REFUSES and inserts nothing when rent_buddy_tag_consents cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      // SENDER already DECLINED being tagged. Invisible while the table errors.
      rows: tagConsentRows("declined"),
      failOn: (ctx: FakeReadContext) => (ctx.table === "rent_buddy_tag_consents" ? READ_FAIL : null),
    });

    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING}/tag-consent`, { targetUserId: SENDER });

    assert.equal(r.status, 503);
    assert.equal(r.body.error, "precondition_unavailable");
    assert.equal(r.body.retryable, true);
    assert.match(r.body.message, /existing tagging consent/i);
    assert.equal(spec.inserted?.rent_buddy_tag_consents, undefined);
  });

  it("still surfaces the existing decline when the table reads fine", async () => {
    const spec = install({ users: { [TOK]: ME }, rows: tagConsentRows("declined") });

    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING}/tag-consent`, { targetUserId: SENDER });

    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.equal(r.body.alreadyExists, true);
    assert.equal(spec.inserted?.rent_buddy_tag_consents, undefined);
  });

  it("still creates a first-time consent request when the table reads fine", async () => {
    const spec = install({ users: { [TOK]: ME }, rows: tagConsentRows(null) });

    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING}/tag-consent`, { targetUserId: SENDER });

    assert.equal(r.status, 201);
    const written = spec.inserted?.rent_buddy_tag_consents?.[0];
    assert.ok(written, "expected a consent row to be inserted");
    assert.equal(written.target_id, SENDER);
    assert.equal(written.consent_status, "pending");
  });
});
