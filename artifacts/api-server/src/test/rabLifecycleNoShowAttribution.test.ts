/**
 * rabLifecycleNoShowAttribution — who reported a no-show must be a FACT that is
 * recorded, not a party that is assumed.
 *
 * ── THE CHAIN ────────────────────────────────────────────────────────────────
 *   producer  POST /rent-a-buddy/bookings/:id/no-show          (rentABuddy.ts)
 *   producer  POST /rent-a-buddy/bookings/:id/report-no-show   (rentABuddySpec.ts)
 *               ↓  buddy_booking_events { event: 'no_show_reported', actor_user_id }
 *   consumer  rentBuddyRequestSweeper phase 3
 *               reads the latest such event to set rent_buddy_disputes.raised_by
 *               ↓
 *   consumer  POST /admin/…/resolve-dispute
 *               increments the BUDDY's no_show_count only when
 *               raised_by === traveler_id
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * The spec route — the one the mobile client reaches through
 * /api/buddy-bookings/:id/report-no-show — never wrote the event. Not a dead
 * `void` this time: no producer existed on that path at all. The sweeper's
 * `?? bk.traveler_id` fallback therefore fired for every no-show filed there,
 * so a BUDDY reporting a traveller's no-show opened a dispute in the
 * TRAVELLER's name, and an admin resolving it in the traveller's favour charged
 * the BUDDY a no_show_count for the traveller's absence. The report was also
 * invisible in the evidence log GET /bookings/:id/events serves to both parties.
 *
 * The fix is two-sided, because a fire-and-forget producer can always be
 * missing: the route now writes the event, AND the sweeper consults
 * rent_buddy_safety_events (written, awaited and error-checked on that same
 * path) before it assumes anybody. When neither record exists the dispute is
 * still opened — the booking cannot sit in no_show_pending forever — but the
 * escalation event carries `raised_by_assumed: true` so the moderator can see
 * the attribution was not evidenced.
 *
 * Every assertion below is over a REAL supabase client with a recording fetch,
 * because "the row was never written" is precisely the claim a hand-written
 * fake cannot witness.
 *
 * Run: node --import tsx/esm --test src/test/rabLifecycleNoShowAttribution.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { runBuddyRequestSweep } from "../lib/rentBuddyRequestSweeper.js";

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

function posted(table: string): Call[] {
  return calls.filter((c) => c.path === `/rest/v1/${table}` && c.method === "POST");
}

const settle = () => new Promise((r) => setTimeout(r, 120));

// ─────────────────────────────────────────────────────────────────────────────
// A. the producer: the spec route must write no_show_reported
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function httpReq(method: string, path: string, body: unknown, who: string): Promise<{ status: number; body: any }> {
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
  const { default: rentABuddySpecRouter } = await import("../routes/rentABuddySpec.js");
  const app = express();
  app.use(express.json());
  // req.log shim — omitting it makes the route's log calls crash, and a
  // 500-from-crash would masquerade as a refusal.
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", rentABuddySpecRouter);
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

/** The buddy reports that the TRAVELLER did not turn up. */
function reportResponder(bookingStatus = "in_progress"): Responder {
  return (c) => {
    if (c.path === "/auth/v1/user") {
      return { id: BUDDY_USER, aud: "authenticated", role: "authenticated", email: "b@t.test",
               app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    }
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: true }];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        return [{ id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF, status: bookingStatus }];
      }
      if (c.method === "PATCH") return [{ id: BOOKING_ID }];
    }
    if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
      return [{ id: BUDDY_PROF, user_id: BUDDY_USER }];
    }
    if (c.path === "/rest/v1/rent_buddy_safety_events" && c.method === "POST") {
      return [{ id: "safety-ev-1", booking_id: BOOKING_ID, actor_user_id: BUDDY_USER }];
    }
    return [];
  };
}

describe("A: POST /report-no-show writes the no_show_reported event the sweeper reads", () => {
  it("issues a buddy_booking_events row attributing the report to the BUDDY who filed it", async () => {
    const sc = realClient(reportResponder());
    _setTestClient(sc as any, true);
    _setTestServiceClient(sc as any);

    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, { notes: "traveller never arrived" }, BUDDY_USER);
    await settle();

    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

    const events = posted("buddy_booking_events");
    assert.equal(
      events.length, 1,
      "the spec route must write the event the sweeper reads to attribute the dispute; " +
      `got ${events.length} inserts`,
    );
    const row = Array.isArray(events[0]!.body) ? events[0]!.body[0] : events[0]!.body;
    assert.equal(row.event, "no_show_reported");
    assert.equal(
      row.actor_user_id, BUDDY_USER,
      "the actor is the party who FILED, which is the whole point of the row",
    );
    assert.equal(row.to_status, "no_show_pending");
    assert.equal(row.metadata?.reported_by, "buddy");
  });

  it("a booking that never started is refused — no safety event, no transition, no report", async () => {
    // The old denylist (no_show_pending | disputed | completed | cancelled)
    // admitted `requested`, so a no-show could be filed against a session that
    // had not been accepted, fabricating an incident the sweeper then escalated
    // into a real dispute.
    const sc = realClient(reportResponder("requested"));
    _setTestClient(sc as any, true);
    _setTestServiceClient(sc as any);

    const res = await httpReq("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/report-no-show`, {}, BUDDY_USER);
    await settle();

    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.error, "invalid_transition");
    assert.deepEqual(posted("rent_buddy_safety_events"), [], "no report row for a booking that cannot be reported");
    assert.deepEqual(posted("buddy_booking_events"), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. the consumer: the sweeper must not assume the traveller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shapes one full sweep pass. Phases 1, 2 and 4 find nothing; phase 3 finds one
 * booking that has been sitting in no_show_pending past its grace period.
 *
 * `eventRows`  — what buddy_booking_events answers the no_show_reported lookup.
 * `safetyRows` — what rent_buddy_safety_events answers the no_show lookup.
 */
function sweepResponder(eventRows: unknown[], safetyRows: unknown[]): Responder {
  return (c) => {
    if (c.path === "/rest/v1/feature_flags") return [{ flag: "rent_buddy_enabled", enabled: false }];
    if (c.path === "/rest/v1/rent_buddy_bookings") {
      if (c.method === "GET") {
        if (c.query.includes("status=eq.no_show_pending")) {
          return [{ id: BOOKING_ID, traveler_id: TRAVELER_ID, buddy_id: BUDDY_PROF }];
        }
        return []; // phases 1 and 2 find nothing
      }
      if (c.method === "PATCH") return [{ id: BOOKING_ID }];
    }
    if (c.path === "/rest/v1/buddy_booking_events") {
      if (c.method === "GET") return eventRows;
      if (c.method === "POST") return [{ id: "esc-1" }];
    }
    if (c.path === "/rest/v1/rent_buddy_safety_events" && c.method === "GET") return safetyRows;
    if (c.path === "/rest/v1/rent_buddy_disputes") {
      if (c.method === "GET") return [];                      // no dispute yet
      if (c.method === "POST") return [{ id: DISPUTE_ID }];
    }
    return [];
  };
}

/** The rent_buddy_disputes row the sweep actually POSTed. */
function insertedDispute(): any {
  const p = posted("rent_buddy_disputes");
  assert.equal(p.length, 1, `expected exactly one dispute insert, got ${p.length}`);
  return Array.isArray(p[0]!.body) ? p[0]!.body[0] : p[0]!.body;
}

/** The no_show_escalated event the sweep actually POSTed. */
function escalationEvent(): any {
  const rows = posted("buddy_booking_events").map((c) => (Array.isArray(c.body) ? c.body[0] : c.body));
  const esc = rows.find((r: any) => r?.event === "no_show_escalated");
  assert.ok(esc, `expected a no_show_escalated event, got ${JSON.stringify(rows)}`);
  return esc;
}

describe("B: the sweeper attributes the dispute to the party who actually reported", () => {
  it("uses the no_show_reported event's actor when it exists", async () => {
    const sc = realClient(sweepResponder([{ actor_user_id: BUDDY_USER }], []));
    const r = await runBuddyRequestSweep(sc);

    assert.equal(r.ok, true);
    assert.equal(r.noShowEscalated, 1);
    assert.equal(
      insertedDispute().raised_by, BUDDY_USER,
      "either party can file a no-show; raised_by must be the one who did",
    );
    assert.equal(escalationEvent().metadata?.raised_by_assumed, false);
  });

  it("falls back to the rent_buddy_safety_events actor when the booking event is MISSING", async () => {
    // Every no-show filed through /report-no-show before that route gained its
    // producer has no booking event at all. An absent row is not evidence that
    // the traveller filed it — and rent_buddy_safety_events, which that route
    // writes awaited and error-checked, says who did.
    const sc = realClient(sweepResponder([], [{ actor_user_id: BUDDY_USER }]));
    const r = await runBuddyRequestSweep(sc);

    assert.equal(r.noShowEscalated, 1);
    assert.equal(
      insertedDispute().raised_by, BUDDY_USER,
      "with no booking event, the safety-event actor is still a record of who filed — " +
      "assuming the traveller here is what charged the BUDDY a no_show_count for the traveller's absence",
    );
    assert.equal(escalationEvent().metadata?.raised_by_assumed, false);
  });

  it("marks the attribution as ASSUMED when neither record exists", async () => {
    const sc = realClient(sweepResponder([], []));
    const r = await runBuddyRequestSweep(sc);

    // The dispute is still opened — a booking cannot sit in no_show_pending
    // forever — but the record says the attribution was not evidenced.
    assert.equal(r.noShowEscalated, 1);
    assert.equal(insertedDispute().raised_by, TRAVELER_ID);
    assert.equal(
      escalationEvent().metadata?.raised_by_assumed, true,
      "a moderator adjudicating from this record must be able to see that raised_by was a guess",
    );
  });

  it("an unreadable rent_buddy_safety_events SKIPS the booking rather than assuming", async () => {
    const sc = realClient((c) => {
      if (c.path === "/rest/v1/rent_buddy_safety_events" && c.method === "GET") {
        return new Response(JSON.stringify({ message: "statement timeout" }), {
          status: 500, headers: { "content-type": "application/json" },
        });
      }
      return sweepResponder([], [])(c);
    });
    const r = await runBuddyRequestSweep(sc);

    assert.equal(r.ok, true, "one skipped booking must not abort the sweep");
    assert.equal(r.noShowEscalated, 0);
    assert.deepEqual(
      posted("rent_buddy_disputes"), [],
      "a table that could not be read is not evidence of anything — the next pass retries",
    );
  });
});
