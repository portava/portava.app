/**
 * rabLifecycleCounters — every Rent-a-Buddy reliability counter must be driven
 * by the rows its WRITE changed, never by the rows an earlier READ selected.
 *
 * ── THE PATTERN ──────────────────────────────────────────────────────────────
 * The request sweeper had exactly this defect: it counted, notified and
 * event-logged over `staleRequests` — the rows a SELECT had found — while the
 * UPDATE that was supposed to move them could match fewer, or none at all.
 * supabase-js RESOLVES on a DB error and PostgREST answers a zero-row UPDATE
 * with the same 204 it uses for a successful one, so "matched nothing" and
 * "applied" are indistinguishable to a handler that reads only `error`.
 *
 * Three booking handlers carried the same shape into the counters that end up
 * on a buddy's public profile and in the search ranker:
 *
 *   POST /bookings/:id/complete          completed_count +1
 *   POST /bookings/:id/cancel            cancel_count    +1  (buddy cancels)
 *   POST /admin/…/resolve-dispute        completed_count -1, no_show_count +1
 *
 * Each read the booking, checked its status in JS, then wrote
 * `.update({status}).eq("id", …)` with no status predicate, no `.select()` and
 * no error check — and then adjusted the counter unconditionally. Two concurrent
 * requests both passed the JS check and both incremented; a failed write
 * incremented anyway. `adjustBuddyCounter` goes through an atomic SQL function,
 * so neither increment is lost: the drift is permanent, and nothing recomputes
 * these columns from the bookings table.
 *
 * ── WHY A REAL CLIENT ────────────────────────────────────────────────────────
 * The claim under test is about what the handler SENDS (does the UPDATE carry
 * its status predicate? is it RETURNING?) and about what it does with the
 * answer. A hand-written fake can be written around either. These tests drive
 * the real routes over a real `createClient(url, key, { global: { fetch } })`
 * whose fetch is recorded, so the PostgREST query string is the evidence and a
 * canned `[]` response is a genuine zero-row UPDATE.
 *
 * Run: node --import tsx/esm --test src/test/rabLifecycleCounters.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const SUPA_URL = "http://supabase.test";
const SUPA_KEY = "test-service-role-key";

const BOOKING_ID  = "11111111-1111-4111-8111-111111111111";
const TRAVELER_ID = "22222222-2222-4222-8222-222222222222";
const BUDDY_USER  = "33333333-3333-4333-8333-333333333333";
const BUDDY_PROF  = "44444444-4444-4444-8444-444444444444";
const ADMIN_ID    = "55555555-5555-4555-8555-555555555555";
const DISPUTE_ID  = "66666666-6666-4666-8666-666666666666";

interface Call { method: string; path: string; query: string; body: any }

let calls: Call[] = [];
type Responder = (c: Call) => unknown;

function makeRecordingFetch(respond: Responder): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const raw = typeof input === "string" ? input : (input?.url ?? String(input));
    const u = new URL(raw);
    let body: any = null;
    if (init?.body) { try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); } }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: u.search, body };
    calls.push(call);
    const payload = respond(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? []), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function realClient(respond: Responder): any {
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: makeRecordingFetch(respond) },
  });
}

/** Every rb_adjust_buddy_counter RPC the handler issued, with its arguments. */
function counterRpcCalls(): Array<{ column: string; delta: number }> {
  return calls
    .filter((c) => c.path === "/rest/v1/rpc/rb_adjust_buddy_counter" && c.method === "POST")
    .map((c) => ({ column: String(c.body?.p_column ?? ""), delta: Number(c.body?.p_delta ?? 0) }));
}

function bookingPatches(): Call[] {
  return calls.filter((c) => c.path === "/rest/v1/rent_buddy_bookings" && c.method === "PATCH");
}

function eventInserts(): Call[] {
  return calls.filter((c) => c.path === "/rest/v1/buddy_booking_events" && c.method === "POST");
}

/** Let the handler's fire-and-forget tail (trust, stamps, notifications) run. */
const settle = () => new Promise((r) => setTimeout(r, 120));

// ── server ────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function httpReq(method: string, path: string, body?: unknown, who = TRAVELER_ID): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${who}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
  const { default: rentABuddySpecRouter } = await import("../routes/rentABuddySpec.js");
  const { default: marketplaceRouter } = await import("../routes/rentABuddyMarketplace.js");
  const app = express();
  app.use(express.json());
  // req.log shim. Without it the handlers' error paths crash and a
  // 500-from-crash would masquerade as a refusal.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", rentABuddyRouter);
  app.use("/api", rentABuddySpecRouter);
  app.use("/api", marketplaceRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _clearTestClient();
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { calls = []; });

/** Answers GoTrue for whichever bearer token the request carried. */
function authUser(c: Call, token: string): unknown {
  return {
    id: token, aud: "authenticated", role: "authenticated", email: `${token}@t.test`,
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
  };
}

function install(respond: Responder): void {
  const client = realClient(respond);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. POST /bookings/:id/complete — completed_count
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `bookingUpdateRows` is what PostgREST answers the CAS UPDATE with:
 *   [{id}] — one row changed (the booking really moved to
 *            completed_pending_traveler_confirmation)
 *   []     — the predicate matched NOTHING (someone else moved it first, or it
 *            was never in_progress by the time the write landed)
 */
function completeResponder(bookingUpdateRows: unknown[]): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") return authUser(c, BUDDY_USER);
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        return [{
          id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF,
          status: "in_progress", category: "city", booking_date: "2026-08-01",
          start_time: "10:00", duration_h: 2, telegraph_thread_id: null,
          stay_connected_traveler: false, stay_connected_buddy: false,
        }];
      }
      if (c.method === "PATCH") return bookingUpdateRows;
    }
    if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
      return [{ id: BUDDY_PROF, user_id: BUDDY_USER, completed_count: 7 }];
    }
    if (c.path === "/rest/v1/rpc/rb_adjust_buddy_counter") return {};
    return [];
  };
}

describe("A: completed_count follows the completion write, not the status read", () => {
  it("a CAS that matches NOTHING returns 409 and adjusts no counter", async () => {
    install(completeResponder([]));
    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`, {}, BUDDY_USER);
    await settle();

    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "invalid_transition");
    assert.deepEqual(
      counterRpcCalls(), [],
      "a completion that moved no row must not increment completed_count",
    );
    assert.deepEqual(
      eventInserts().map((c) => c.body?.event), [],
      "and must not write buddy_marked_complete into the evidence log — " +
      "rentABuddySpec's dispute compensation reads that event and reverses exactly -1",
    );
  });

  it("a CAS that changes one row returns 200 and increments completed_count exactly once", async () => {
    install(completeResponder([{ id: BOOKING_ID }]));
    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`, {}, BUDDY_USER);
    await settle();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.status, "completed_pending_traveler_confirmation");
    assert.deepEqual(counterRpcCalls(), [{ column: "completed_count", delta: 1 }]);
    assert.deepEqual(
      eventInserts().map((c) => c.body?.event), ["buddy_marked_complete"],
      "exactly one mark-complete event for one completion",
    );
  });

  it("the UPDATE carries its status predicate and is RETURNING", async () => {
    install(completeResponder([{ id: BOOKING_ID }]));
    await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`, {}, BUDDY_USER);
    await settle();

    const patches = bookingPatches();
    assert.equal(patches.length, 1, "one completion, one booking UPDATE");
    const q = patches[0]!.query;
    assert.match(q, /id=eq\./, "the UPDATE must target this booking");
    assert.match(
      q, /status=eq\.in_progress/,
      "the required source status must ride in the SAME statement as the write — " +
      `checking it in JS first is the TOCTOU this fixes. query was: ${q}`,
    );
    assert.match(
      q, /select=id/,
      "the statement must be RETURNING, or a zero-row UPDATE is indistinguishable from a successful one",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. POST /bookings/:id/cancel — cancel_count
// ─────────────────────────────────────────────────────────────────────────────

function cancelResponder(bookingUpdateRows: unknown[]): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") return authUser(c, BUDDY_USER);
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        return [{
          id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF,
          status: "scheduled", booking_date: "2099-08-01", start_time: "10:00",
          duration_h: 2, telegraph_thread_id: null,
        }];
      }
      if (c.method === "PATCH") return bookingUpdateRows;
    }
    if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
      return [{ id: BUDDY_PROF, user_id: BUDDY_USER }];
    }
    if (c.path === "/rest/v1/rpc/rb_adjust_buddy_counter") return {};
    return [];
  };
}

describe("B: cancel_count follows the cancellation write", () => {
  it("a CAS that matches NOTHING returns 409 and does not charge the buddy a cancellation", async () => {
    install(cancelResponder([]));
    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, { cancellation_reason: "x" }, BUDDY_USER);
    await settle();

    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "invalid_transition");
    assert.deepEqual(
      counterRpcCalls(), [],
      "cancel_count feeds search ranking and is never recomputed — it must not move for a cancellation that did not happen",
    );
    assert.deepEqual(eventInserts().map((c) => c.body?.event), []);
  });

  it("a CAS that changes one row returns 200 and increments cancel_count exactly once", async () => {
    install(cancelResponder([{ id: BOOKING_ID }]));
    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, { cancellation_reason: "x" }, BUDDY_USER);
    await settle();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(counterRpcCalls(), [{ column: "cancel_count", delta: 1 }]);
    assert.deepEqual(eventInserts().map((c) => c.body?.event), ["cancelled_by_buddy"]);
  });

  it("the cancel UPDATE re-asserts the cancellable statuses and is RETURNING", async () => {
    install(cancelResponder([{ id: BOOKING_ID }]));
    await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, {}, BUDDY_USER);
    await settle();

    const patches = bookingPatches();
    assert.equal(patches.length, 1);
    const q = decodeURIComponent(patches[0]!.query);
    assert.match(q, /status=in\.\(/, `the cancellable set must ride in the write; query was ${q}`);
    assert.match(q, /select=id/, "and the statement must be RETURNING");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. POST /admin/bookings/:id/resolve-dispute — completed_count / no_show_count
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The admin path adjudicates a no_show dispute the TRAVELER raised, resolved in
 * the traveler's favour. That is the one combination that both compensates
 * completed_count (the buddy had marked the session complete) and charges
 * no_show_count.
 */
function disputeResponder(bookingUpdateRows: unknown[]): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") return authUser(c, ADMIN_ID);
    if (c.path === "/rest/v1/profiles" && c.method === "GET") return [{ id: ADMIN_ID, role: "admin" }];
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        return [{ id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, status: "disputed" }];
      }
      if (c.method === "PATCH") return bookingUpdateRows;
    }
    if (c.path === "/rest/v1/rent_buddy_disputes") {
      const row = { id: DISPUTE_ID, booking_id: BOOKING_ID, reason: "no_show", raised_by: TRAVELER_ID, status: "open" };
      if (c.method === "GET") return [row];
      if (c.method === "PATCH") return [{ ...row, status: "resolved" }];
    }
    if (c.path === "/rest/v1/buddy_booking_events" && c.method === "GET") {
      // The buddy DID mark the session complete, so completed_count owes a -1.
      return [{ id: "ev-1" }];
    }
    if (c.path === "/rest/v1/rpc/rb_adjust_buddy_counter") return {};
    return [];
  };
}

describe("C: dispute-resolution counters follow the booking transition", () => {
  it("a booking that left 'disputed' first returns 409 and adjusts NO counter", async () => {
    install(disputeResponder([]));
    const res = await httpReq(
      "POST", `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { resolution: "refund", favorTraveler: true }, ADMIN_ID,
    );
    await settle();

    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "invalid_transition");
    assert.deepEqual(
      counterRpcCalls(), [],
      "no adjudication happened, so neither completed_count nor no_show_count may move",
    );
  });

  it("a resolved dispute over a real transition adjusts both counters exactly once", async () => {
    install(disputeResponder([{ id: BOOKING_ID }]));
    const res = await httpReq(
      "POST", `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { resolution: "refund", favorTraveler: true }, ADMIN_ID,
    );
    await settle();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.bookingStatus, "cancelled");
    assert.deepEqual(counterRpcCalls(), [
      { column: "completed_count", delta: -1 },
      { column: "no_show_count",   delta: 1  },
    ]);
  });

  it("the booking UPDATE re-asserts status=disputed and is RETURNING", async () => {
    install(disputeResponder([{ id: BOOKING_ID }]));
    await httpReq(
      "POST", `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { resolution: "refund", favorTraveler: true }, ADMIN_ID,
    );
    await settle();

    const patches = bookingPatches();
    assert.equal(patches.length, 1, "one resolution, one booking UPDATE");
    const q = patches[0]!.query;
    assert.match(q, /status=eq\.disputed/, `query was ${q}`);
    assert.match(q, /select=id/);
  });

  it("an unreadable mark-complete event log refuses the resolution instead of skipping the compensation", async () => {
    // `{ data: null }` on buddy_booking_events is byte-identical to "this
    // booking never passed through mark-complete". Taking that branch silently
    // skips a compensation that is owed, and answers 200 as though the
    // adjudication had been carried out in full.
    install((c) => {
      if (c.path === "/rest/v1/buddy_booking_events" && c.method === "GET") {
        return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), {
          status: 500, headers: { "content-type": "application/json" },
        });
      }
      return disputeResponder([{ id: BOOKING_ID }])(c);
    });
    const res = await httpReq(
      "POST", `/api/rent-a-buddy/admin/bookings/${BOOKING_ID}/resolve-dispute`,
      { resolution: "refund", favorTraveler: true }, ADMIN_ID,
    );
    await settle();

    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "precondition_unavailable");
    assert.deepEqual(counterRpcCalls(), []);
    assert.deepEqual(bookingPatches(), [], "nothing may be written when the evidence cannot be read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. GET /me/earnings/summary — the cancellation bucket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `statusBreakdown.cancelled` filtered on `b.status === "cancelled"`. That value
 * is written ONLY by admin dispute resolution; every user-initiated cancellation
 * writes `cancelled_by_traveler` or `cancelled_by_buddy`. So the bucket counted
 * almost every real cancellation as zero — the identical undercount
 * CANCELLED_BOOKING_STATUSES was created for in rentABuddyRollout.ts, where it
 * had made the city graduation gate falsely lenient.
 */
describe("D: the earnings summary counts the cancellations that were actually written", () => {
  it("counts cancelled_by_traveler and cancelled_by_buddy, not only bare 'cancelled'", async () => {
    const BUDDY_ROWS = [
      { id: "bk-1", status: "cancelled_by_traveler", booking_date: "2020-01-01", total_usd: 100, deposit_usd: 0, cash_balance_usd: 0, tip_usd: 0, pricing_type: "hourly", category: "city", city: "Cebu", duration_h: 2 },
      { id: "bk-2", status: "cancelled_by_buddy",    booking_date: "2020-01-02", total_usd: 100, deposit_usd: 0, cash_balance_usd: 0, tip_usd: 0, pricing_type: "hourly", category: "city", city: "Cebu", duration_h: 2 },
      { id: "bk-3", status: "cancelled",             booking_date: "2020-01-03", total_usd: 100, deposit_usd: 0, cash_balance_usd: 0, tip_usd: 0, pricing_type: "hourly", category: "city", city: "Cebu", duration_h: 2 },
      { id: "bk-4", status: "completed",             booking_date: "2020-01-04", total_usd: 200, deposit_usd: 0, cash_balance_usd: 0, tip_usd: 0, pricing_type: "hourly", category: "city", city: "Cebu", duration_h: 2 },
    ];

    const client = realClient((c) => {
      if (c.path === "/auth/v1/user") return authUser(c, BUDDY_USER);
      if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
      if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
        return [{ id: BUDDY_PROF, user_id: BUDDY_USER, buddy_level: "new", profile_views: 0,
                  search_appearances: 0, repeat_client_count: 0, city_ranking: null,
                  average_rating: null, review_count: 0 }];
      }
      if (c.path === "/rest/v1/rent_buddy_fee_rules") {
        return [{ buddy_level: "new", platform_fee_percent: 20, traveler_service_fee_percent: 0 }];
      }
      if (c.path === "/rest/v1/rent_buddy_bookings" && c.method === "GET") return BUDDY_ROWS;
      if (c.path === "/rest/v1/rent_buddy_tips" && c.method === "GET") return [];
      if (c.path === "/rest/v1/trust_scores") return [];
      return [];
    });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const res = await httpReq("GET", "/api/rent-a-buddy/me/earnings/summary", undefined, BUDDY_USER);
    await settle();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(
      res.body?.statusBreakdown?.cancelled, 3,
      "all three cancellation statuses must be counted; filtering on bare 'cancelled' reports 1 of 3",
    );
    assert.equal(res.body?.statusBreakdown?.completed, 1);
  });
});
