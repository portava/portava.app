/**
 * rabLifecycleTransitions — every booking status transition must be a
 * compare-and-set, and a zero-row result must be a 409, not a 200.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * Nothing enforces the Rent-a-Buddy booking state machine in the database:
 * `rent_buddy_bookings.status` is a plain column, there is no trigger and no
 * transition table. The ONLY thing standing between the lifecycle and an
 * arbitrary status write is each handler's own guard — and seven handlers
 * checked the status in JS and then wrote it unconditionally:
 *
 *   accept            requested|pending  → scheduled
 *   decline           requested|pending  → declined
 *   start             confirmed|scheduled→ in_progress
 *   traveler-confirm  completed_pending… → completed
 *   no-show           confirmed|scheduled|in_progress → no_show_pending
 *   dispute           in_progress|completed_pending… → disputed
 *   confirm-cash      in_progress|completed_pending… → disputed
 *
 * Between the read and the write anything can happen, and supabase-js RESOLVES
 * on a DB error, so each of these could (a) answer 200 for a write that never
 * landed and (b) apply its status over whatever the booking had actually
 * become. Concretely: an accept landing after the sweeper expired the request
 * RESURRECTED it into `scheduled`; a start landing after a cancellation
 * resurrected it into `in_progress`; a traveler-confirm landing after a dispute
 * wrote `completed` straight over `disputed`, taking the outcome away from the
 * admin resolution route — the same abuse /safety/end-early's guard was added
 * to close, on a different handler.
 *
 * The two dispute openers were worse than a lost race. Each inserts a dispute
 * row and then moved the booking; two concurrent calls both passed the JS check
 * and both INSERTED, leaving TWO open disputes on one booking. Dispute
 * resolution reads the open dispute with
 * `.in("status", ["open","reviewing"]).maybeSingle()`, and maybeSingle RAISES
 * on more than one row — so the second dispute made the booking permanently
 * unresolvable through the API.
 *
 * Assertions are over REAL supabase clients with a recording fetch, so the
 * PostgREST query string is the evidence that the predicate really rides in the
 * write, and a canned `[]` is a genuine zero-row UPDATE.
 *
 * Run: node --import tsx/esm --test src/test/rabLifecycleTransitions.test.ts
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
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: decodeURIComponent(u.search), body };
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

const bookingPatches = () => calls.filter((c) => c.path === "/rest/v1/rent_buddy_bookings" && c.method === "PATCH");
const disputeDeletes = () => calls.filter((c) => c.path === "/rest/v1/rent_buddy_disputes" && c.method === "DELETE");
const settle = () => new Promise((r) => setTimeout(r, 120));

let server: http.Server;
let base: string;

function httpReq(path: string, body: unknown, who: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = JSON.stringify(body ?? {});
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
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
    r.write(payload);
    r.end();
  });
}

before(async () => {
  const { default: rentABuddyRouter } = await import("../routes/rentABuddy.js");
  const app = express();
  app.use(express.json());
  // req.log shim — without it the handlers' error branches crash, and a
  // 500-from-crash would masquerade as a refusal.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", rentABuddyRouter);
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

/**
 * Everything the transition handlers read, permissive, so the only variable is
 * what the booking UPDATE comes back with.
 *
 * `bookingStatus`      the status the READ reports.
 * `patchRows`          what PostgREST answers the transition UPDATE with:
 *                      [{id}] = one row changed, [] = the predicate matched
 *                      nothing (someone else moved the booking first).
 */
function responder(bookingStatus: string, patchRows: unknown[], actor: string): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") {
      return { id: actor, aud: "authenticated", role: "authenticated", email: "x@t.test",
               app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    }
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
    if (c.path === "/rest/v1/rent_buddy_user_limits") return [];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        // The accept handler's conflict-detection query asks for OTHER bookings
        // of this buddy; it must come back empty or the accept 409s early.
        if (c.query.includes("neq.")) return [];
        return [{
          id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF,
          status: bookingStatus, booking_date: "2099-08-01", start_time: "10:00",
          duration_h: 2, telegraph_thread_id: null, created_at: "2099-07-01T00:00:00Z",
          expires_at: "2099-07-30T00:00:00Z", dispute_window_expires_at: null,
          stay_connected_traveler: false, stay_connected_buddy: false,
        }];
      }
      if (c.method === "PATCH") return patchRows;
    }
    if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
      return [{ id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active", completed_count: 0 }];
    }
    if (c.path === "/rest/v1/rent_buddy_disputes" && c.method === "POST") return [{ id: DISPUTE_ID }];
    if (c.path === "/rest/v1/message_threads" && c.method === "POST") return [{ id: "thread-1" }];
    return [];
  };
}

function install(bookingStatus: string, patchRows: unknown[], actor: string): void {
  const client = realClient(responder(bookingStatus, patchRows, actor));
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

/**
 * One row per transition: the route, who may perform it, the status the booking
 * is in beforehand, and the predicate the UPDATE must carry.
 *
 * `predicate` is matched against the decoded PostgREST query string. `eq.` for
 * a single required source status, `in.(` for a set.
 */
const TRANSITIONS: Array<{
  name: string;
  path: string;
  actor: string;
  from: string;
  predicate: RegExp;
  body?: unknown;
}> = [
  { name: "accept",           path: "accept",           actor: BUDDY_USER,  from: "requested",                                  predicate: /status=in\.\(.*requested.*\)/ },
  { name: "decline",          path: "decline",          actor: BUDDY_USER,  from: "requested",                                  predicate: /status=in\.\(.*requested.*\)/ },
  { name: "start",            path: "start",            actor: BUDDY_USER,  from: "scheduled",                                  predicate: /status=in\.\(.*scheduled.*\)/ },
  { name: "traveler-confirm", path: "traveler-confirm", actor: TRAVELER_ID, from: "completed_pending_traveler_confirmation",    predicate: /status=eq\.completed_pending_traveler_confirmation/ },
  { name: "no-show",          path: "no-show",          actor: TRAVELER_ID, from: "in_progress",                                predicate: /status=in\.\(.*in_progress.*\)/ },
  { name: "dispute",          path: "dispute",          actor: TRAVELER_ID, from: "in_progress",                                predicate: /status=in\.\(.*in_progress.*\)/, body: { reason: "other" } },
];

describe("A: every transition rides its source status in the write", () => {
  for (const t of TRANSITIONS) {
    it(`${t.name} — the UPDATE carries its source-status predicate and is RETURNING`, async () => {
      install(t.from, [{ id: BOOKING_ID }], t.actor);
      const res = await httpReq(`/api/rent-a-buddy/bookings/${BOOKING_ID}/${t.path}`, t.body ?? {}, t.actor);
      await settle();

      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      const patches = bookingPatches();
      assert.ok(patches.length >= 1, `${t.name} must issue a booking UPDATE`);
      const q = patches[0]!.query;
      assert.match(
        q, t.predicate,
        `${t.name}: the required source status must ride in the SAME statement as the write, ` +
        `not be checked in JS beforehand. query was: ${q}`,
      );
      assert.match(q, /select=id/, `${t.name}: the statement must be RETURNING so zero rows is visible`);
    });
  }
});

describe("B: a transition that matches nothing is a 409, never a 200", () => {
  for (const t of TRANSITIONS) {
    it(`${t.name} — zero rows changed returns 409 invalid_transition`, async () => {
      install(t.from, [], t.actor);
      const res = await httpReq(`/api/rent-a-buddy/bookings/${BOOKING_ID}/${t.path}`, t.body ?? {}, t.actor);
      await settle();

      assert.equal(
        res.status, 409,
        `${t.name}: a write that changed no row must not answer success. got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.equal(res.body?.error, "invalid_transition");
    });
  }
});

describe("C: a failed transition is reported, not answered 200", () => {
  for (const t of TRANSITIONS) {
    it(`${t.name} — a DB error on the UPDATE returns 500, not ok`, async () => {
      // supabase-js RESOLVES on a DB error, so without an explicit `error`
      // check the handler carried straight on and answered 200 for a write the
      // database refused.
      const inner = responder(t.from, [], t.actor);
      const client = realClient((c) => {
        if (c.path === "/rest/v1/rent_buddy_bookings" && c.method === "PATCH") {
          return new Response(JSON.stringify({ message: "deadlock detected" }), {
            status: 500, headers: { "content-type": "application/json" },
          });
        }
        return inner(c);
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const res = await httpReq(`/api/rent-a-buddy/bookings/${BOOKING_ID}/${t.path}`, t.body ?? {}, t.actor);
      await settle();

      assert.equal(
        res.status, 500,
        `${t.name}: a failed transition must be reported. got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.equal(res.body?.error, "update_failed");
    });
  }
});

describe("D: a dispute that opened nothing leaves no orphan dispute row", () => {
  it("deletes the just-created dispute when the booking transition matched nothing", async () => {
    // The dispute row is inserted BEFORE the transition so a booking can never
    // reach `disputed` with nothing to resolve it. That leaves the reverse
    // hole: a lost race used to leave an open dispute attached to a booking
    // that was never disputed — and a SECOND open dispute makes dispute
    // resolution's `.maybeSingle()` raise, so the booking becomes permanently
    // unresolvable through the API.
    install("in_progress", [], TRAVELER_ID);
    const res = await httpReq(`/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, TRAVELER_ID);
    await settle();

    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    const deletes = disputeDeletes();
    assert.equal(deletes.length, 1, `the orphan dispute must be removed; deletes were ${JSON.stringify(deletes)}`);
    assert.match(deletes[0]!.query, /id=eq\./, "and it must be the row this request created, by id");
    assert.match(
      deletes[0]!.query, /status=eq\.open/,
      "guarded on `open`, so a dispute someone has already started working is never deleted",
    );
  });

  it("keeps the dispute when the transition really happened", async () => {
    install("in_progress", [{ id: BOOKING_ID }], TRAVELER_ID);
    const res = await httpReq(`/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, TRAVELER_ID);
    await settle();

    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.disputeId, DISPUTE_ID);
    assert.deepEqual(disputeDeletes(), [], "a dispute that was really opened must survive");
  });
});
