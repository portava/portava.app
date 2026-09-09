/**
 * unissuedWrites — the ONE witness a hand-written fake cannot be.
 *
 * ── WHAT IS BEING PROVED ─────────────────────────────────────────────────────
 * `PostgrestBuilder` is a THENABLE, not a promise: it builds its headers and
 * calls `_fetch` inside `then()` (@supabase/postgrest-js@2.108.2,
 * `src/PostgrestBuilder.ts:267-311`). So
 *
 *     void sc.from("buddy_booking_events").insert({ … });
 *
 * constructs a request object and throws it away. Not a lost error, not an
 * unawaited race — NO HTTP CALL IS MADE and the row is never written.
 *
 * Twenty writes in this tree were written that way. A fake client cannot tell
 * the two apart: `src/test/rentABuddy.test.ts` used to capture inserted rows
 * EAGERLY inside `.insert()`, precisely because `_resolve()` was never reached,
 * so the suite proved the request was CONSTRUCTED and never that it was SENT.
 * The fake was written around the defect and passed either way.
 *
 * The only witness that can separate "constructed" from "sent" is the REAL
 * client with an instrumented `fetch`. `createClient(url, key, { global: { fetch } })`
 * is the seam, and every assertion below counts actual fetch invocations.
 *
 * ── WHAT THE FIVE GROUPS COVER ───────────────────────────────────────────────
 *   1. THE MECHANISM — the three forms measured side by side on a real client:
 *      bare `void` sends nothing; `.then(…)` and `await` each send once. If this
 *      group ever goes green with the bare form sending, the premise of the fix
 *      is wrong and everything below it is moot.
 *   2. PRODUCTION CODE, REAL CLIENT — `runBuddyRequestSweep` driven against a
 *      real supabase client whose fetch is recorded. Asserts that phase 1 and
 *      phase 2 actually POST to /rest/v1/buddy_booking_events with the right
 *      body. Restore the bare `void` in the sweeper and these fail.
 *   3. PRODUCTION ROUTE, REAL CLIENT — POST /api/location/exit-geofence driven
 *      end to end. Asserts the delayed_post_location_events row is POSTed.
 *   4. PRODUCTION ROUTE, REAL CLIENT — PATCH /api/posts/:postId. Asserts the
 *      post_edits row is POSTed (and that an unchanged caption writes none).
 *   5. PRODUCTION LIB, REAL CLIENT — `runReconciliation`. Asserts the
 *      needs_admin_review row for a failed catalog insert is POSTed.
 *
 * Every fix in this change has a case here or in rentABuddy.test.ts, and each
 * was hand-reverted to the bare `void` to confirm the RIGHT case turns red.
 *
 * Run: node --import tsx/esm --test src/test/unissuedWrites.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { runBuddyRequestSweep } from "../lib/rentBuddyRequestSweeper.js";
import locationRouter from "../routes/location.js";

const SUPA_URL = "http://supabase.test";
const SUPA_KEY = "test-service-role-key";

interface Call {
  method: string;
  path: string;
  query: string;
  body: any;
}

/** Every fetch the client makes, in order. */
let calls: Call[] = [];

/** Test-controlled responder: given a call, return the rows (or a Response). */
type Responder = (c: Call) => unknown;

function makeRecordingFetch(respond: Responder): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const raw = typeof input === "string" ? input : (input?.url ?? String(input));
    const u = new URL(raw);
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname,
      query: u.search,
      body,
    };
    calls.push(call);
    const payload = respond(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function realClient(respond: Responder = () => []) {
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: makeRecordingFetch(respond) },
  });
}

/** Calls that hit one PostgREST table with one method. */
function callsTo(table: string, method: string): Call[] {
  return calls.filter((c) => c.path === `/rest/v1/${table}` && c.method === method);
}

beforeEach(() => { calls = []; });

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE MECHANISM
// ─────────────────────────────────────────────────────────────────────────────

describe("PostgrestBuilder is a thenable — a bare `void` write is never sent", () => {
  it("void …insert(…) with no continuation makes ZERO fetch calls", async () => {
    const sc = realClient();
    // Exactly the shape the twenty defective sites used.
    void sc.from("buddy_booking_events").insert({ booking_id: "b1", event: "x" });
    // Give any microtask/timer a chance to run — nothing is in flight to await.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      calls.length, 0,
      `a bare void write must issue no request; got ${JSON.stringify(calls)}`,
    );
  });

  it("void …insert(…).then(undefined, handler) makes EXACTLY ONE fetch call", async () => {
    const sc = realClient();
    void sc.from("buddy_booking_events").insert({ booking_id: "b1", event: "x" })
      .then(undefined, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 1, "the .then() continuation is what issues the request");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/rest/v1/buddy_booking_events");
    assert.deepEqual(calls[0]!.body, { booking_id: "b1", event: "x" });
  });

  it("await …insert(…) makes EXACTLY ONE fetch call", async () => {
    const sc = realClient();
    await sc.from("buddy_booking_events").insert({ booking_id: "b1", event: "x" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/rest/v1/buddy_booking_events");
  });

  it("the difference is the continuation, not the table or the verb", async () => {
    const sc = realClient();
    void sc.from("post_edits").insert({ post_id: "p1" });
    void sc.from("delayed_post_location_events").insert({ post_id: "p1" });
    void sc.from("stamp_reconciliation_log").insert({ source_id: "s1" });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls.length, 0, "three constructed writes, three requests never made");

    await sc.from("post_edits").insert({ post_id: "p1" }).then(undefined, () => {});
    assert.equal(calls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PRODUCTION CODE, REAL CLIENT — the sweeper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answers the sweeper's PostgREST traffic with just enough canned data to walk
 * one booking through phase 1 (expiry) and one through phase 2 (auto-complete).
 * Everything not matched answers `[]`, which makes phases 3 and 4 no-ops (the
 * feature-flag read for phase 4 comes back empty → fail-closed → skipped).
 */
function sweeperResponder(c: Call): unknown {
  if (c.path === "/rest/v1/rent_buddy_bookings") {
    if (c.method === "GET") {
      // Order matters: "dispute_window_expires_at=lt." and
      // "no_show_grace_expires_at=lt." both CONTAIN "expires_at=lt.", so the
      // two narrower phases are matched first. Phase 3 is left empty on
      // purpose — it already writes its event correctly and is not under test
      // here; letting it match would double-count the POSTs below.
      if (c.query.includes("no_show_grace_expires_at=lt.")) return [];
      if (c.query.includes("dispute_window_expires_at=lt.")) {
        return [{ id: "bk-auto-1", traveler_id: "trav-2", buddy_id: "prof-2" }];
      }
      if (c.query.includes("expires_at=lt.")) {
        return [{ id: "bk-expire-1", traveler_id: "trav-1", status: "requested" }];
      }
      return [];
    }
    if (c.method === "PATCH") {
      // RETURNING rows — the sweeper drives its events off these, not off the read.
      if (c.query.includes("bk-expire-1")) return [{ id: "bk-expire-1" }];
      if (c.query.includes("bk-auto-1")) return [{ id: "bk-auto-1" }];
      return [];
    }
  }
  if (c.path === "/rest/v1/rent_buddy_profiles" && c.method === "GET") {
    return [{ id: "prof-2", user_id: "buddy-user-2" }];
  }
  return [];
}

describe("runBuddyRequestSweep actually ISSUES its buddy_booking_events writes", () => {
  it("phase 1 POSTs a request_expired row for the booking it really expired", async () => {
    const sc = realClient(sweeperResponder);
    const r = await runBuddyRequestSweep(sc as any);

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.expired, 1, "phase 1 must have expired exactly the one seeded booking");

    const posts = callsTo("buddy_booking_events", "POST");
    const expired = posts.filter((p) => p.body?.event === "request_expired");
    assert.equal(
      expired.length, 1,
      `request_expired must reach the network exactly once; buddy_booking_events POSTs seen: ` +
        JSON.stringify(posts.map((p) => p.body)),
    );
    assert.equal(expired[0]!.body.booking_id, "bk-expire-1");
    assert.equal(expired[0]!.body.actor_user_id, "trav-1");
    assert.equal(expired[0]!.body.from_status, "requested");
    assert.equal(expired[0]!.body.to_status, "expired");
  });

  it("phase 2 POSTs an auto_completed row for the booking it really completed", async () => {
    const sc = realClient(sweeperResponder);
    const r = await runBuddyRequestSweep(sc as any);

    assert.equal(r.autoCompleted, 1, JSON.stringify(r));

    const auto = callsTo("buddy_booking_events", "POST")
      .filter((p) => p.body?.event === "auto_completed");
    assert.equal(auto.length, 1, "auto_completed must reach the network exactly once");
    assert.equal(auto[0]!.body.booking_id, "bk-auto-1");
    assert.equal(auto[0]!.body.from_status, "completed_pending_traveler_confirmation");
    assert.equal(auto[0]!.body.to_status, "completed");
    assert.deepEqual(auto[0]!.body.metadata, { reason: "dispute_window_expired" });
  });

  it("a DB error on the event insert is survived, not thrown, and the counts stand", async () => {
    // The audit row is best-effort: an unwritable buddy_booking_events must not
    // abort the phase or un-count the transition that already happened.
    const sc = realClient((c) => {
      if (c.path === "/rest/v1/buddy_booking_events" && c.method === "POST") {
        return new Response(JSON.stringify({ message: "boom", code: "23505" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return sweeperResponder(c);
    });

    const r = await runBuddyRequestSweep(sc as any);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.expired, 1);
    assert.equal(r.autoCompleted, 1);
    // It was still ISSUED — that is the point. It just failed at the server.
    assert.equal(callsTo("buddy_booking_events", "POST").length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRODUCTION ROUTE, REAL CLIENT — POST /api/location/exit-geofence
// ─────────────────────────────────────────────────────────────────────────────

const POST_ID = "11111111-1111-4111-8111-111111111111";
const AUTHOR_ID = "22222222-2222-4222-8222-222222222222";

let server: http.Server;
let base: string;

function httpReq(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
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

/**
 * Answers the exit-geofence route's traffic: GoTrue's /auth/v1/user (so
 * requireUser resolves a real User), the profiles read behind the ban gate, the
 * post read and the post update.
 */
function locationResponder(c: Call): unknown {
  if (c.path === "/auth/v1/user") {
    return { id: AUTHOR_ID, aud: "authenticated", role: "authenticated", email: "a@b.c",
             app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  }
  if (c.path === "/rest/v1/profiles" && c.method === "GET") {
    return [{ id: AUTHOR_ID, account_status: "active" }];
  }
  if (c.path === "/rest/v1/posts") {
    if (c.method === "GET") {
      return [{
        id: POST_ID, author_id: AUTHOR_ID,
        post_status: "pending_location_exit", geofence_radius_meters: 100,
      }];
    }
    if (c.method === "PATCH") return [{ id: POST_ID }];
  }
  return [];
}

describe("POST /location/exit-geofence actually ISSUES its delayed_post_location_events row", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    // req.log shim — without it the route's warn path would crash and a
    // 500-from-crash would masquerade as a refusal.
    app.use((req: any, _res, next) => {
      req.log = { info() {}, warn() {}, error() {}, debug() {} };
      next();
    });
    app.use("/api", locationRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns 200 and POSTs an exit_detected event to the network", async () => {
    const sc = realClient(locationResponder);
    _setTestClient(sc as any, true);

    const res = await httpReq("POST", "/api/location/exit-geofence", {
      postId: POST_ID, lat: 12.5, lng: -3.25,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(res.body.publishEligibleAt, "publishEligibleAt must be returned");

    // The write is fire-and-forget, so let its continuation run.
    await new Promise((r) => setTimeout(r, 50));

    const posts = callsTo("delayed_post_location_events", "POST");
    assert.equal(
      posts.length, 1,
      `exit_detected must reach the network exactly once; calls: ` +
        JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)),
    );
    assert.equal(posts[0]!.body.post_id, POST_ID);
    assert.equal(posts[0]!.body.user_id, AUTHOR_ID);
    assert.equal(posts[0]!.body.event_type, "exit_detected");
    assert.equal(posts[0]!.body.lat, 12.5);
    assert.equal(posts[0]!.body.lng, -3.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PRODUCTION ROUTE, REAL CLIENT — PATCH /posts/:postId writes post_edits
// ─────────────────────────────────────────────────────────────────────────────

const EDIT_POST_ID = "33333333-3333-4333-8333-333333333333";
const EDIT_AUTHOR = "44444444-4444-4444-8444-444444444444";

/**
 * post_edits has TWO readers, and both were reading a table this route never
 * wrote to:
 *   • GET /posts/:postId/edit-history — the author's own edit log, permanently
 *     empty for everyone.
 *   • CreatorActivityScoreService's `maintenance` component, whose ONLY source
 *     is post_edits (the file says so in its own header), plus its active-days
 *     set which counts post_edits.edited_at. Both read 0 for every creator.
 * Turning the write on changes both. This asserts the producing half.
 */
function postsResponder(c: Call): unknown {
  if (c.path === "/auth/v1/user") {
    return { id: EDIT_AUTHOR, aud: "authenticated", role: "authenticated", email: "a@b.c",
             app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  }
  if (c.path === "/rest/v1/profiles" && c.method === "GET") {
    return [{ id: EDIT_AUTHOR, account_status: "active" }];
  }
  if (c.path === "/rest/v1/posts") {
    if (c.method === "GET") {
      return [{
        id: EDIT_POST_ID, author_id: EDIT_AUTHOR, trip_id: null,
        visibility: "public", content: "before", status: "active",
      }];
    }
    if (c.method === "PATCH") {
      return [{ id: EDIT_POST_ID, author_id: EDIT_AUTHOR, content: "after", visibility: "public" }];
    }
  }
  return [];
}

describe("PATCH /posts/:postId actually ISSUES its post_edits row", () => {
  let postsServer: http.Server;
  let postsBase: string;

  before(async () => {
    const { default: postsRouter } = await import("../routes/posts.js");
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.log = { info() {}, warn() {}, error() {}, debug() {} };
      next();
    });
    app.use("/api", postsRouter);
    postsServer = http.createServer(app);
    await new Promise<void>((r) => postsServer.listen(0, "127.0.0.1", () => r()));
    postsBase = `http://127.0.0.1:${(postsServer.address() as any).port}`;
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((r) => postsServer.close(() => r()));
  });

  it("a changed caption POSTs old_content and new_content to post_edits", async () => {
    const sc = realClient(postsResponder);
    _setTestClient(sc as any, true);

    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const url = new URL(`/api/posts/${EDIT_POST_ID}`, postsBase);
      const payload = JSON.stringify({ content: "after" });
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "PATCH",
          headers: { "content-type": "application/json", authorization: "Bearer tok" } },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => {
            let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: inRes.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    await new Promise((r) => setTimeout(r, 50));

    const edits = callsTo("post_edits", "POST");
    assert.equal(
      edits.length, 1,
      `the edit-history row must reach the network exactly once; calls: ` +
        JSON.stringify(calls.map((c) => `${c.method} ${c.path}`)),
    );
    assert.equal(edits[0]!.body.post_id, EDIT_POST_ID);
    assert.equal(edits[0]!.body.user_id, EDIT_AUTHOR);
    assert.equal(edits[0]!.body.old_content, "before");
    assert.equal(edits[0]!.body.new_content, "after");
  });

  it("an unchanged caption writes no edit row at all", async () => {
    const sc = realClient(postsResponder);
    _setTestClient(sc as any, true);

    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/api/posts/${EDIT_POST_ID}`, postsBase);
      const payload = JSON.stringify({ content: "before" });
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "PATCH",
          headers: { "content-type": "application/json", authorization: "Bearer tok" } },
        (inRes) => { inRes.resume(); inRes.on("end", () => resolve()); },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(callsTo("post_edits", "POST").length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PRODUCTION LIB, REAL CLIENT — the stamp reconciler's admin-review row
// ─────────────────────────────────────────────────────────────────────────────

describe("runReconciliation actually ISSUES its stamp_reconciliation_log row", () => {
  it("a failed catalog insert leaves a needs_admin_review row on the network", async () => {
    const { runReconciliation } = await import("../lib/stamps/reconcileStampCatalog.js");

    const sc = realClient((c) => {
      if (c.path === "/rest/v1/user_stamps" && c.method === "GET") {
        // The reconciler reads user_stamps TWICE: the combo scan (selects
        // stamp_type via the definition join) and the later location-less pass
        // (selects the definition's slug). Only the first is seeded; letting the
        // second match too would flag a second, unrelated admin-review row.
        if (c.query.includes("slug")) return [];
        return [{ stamp_definition_id: "def-1", country: "Japan", city: "Tokyo",
                  stamp_definitions: { stamp_type: "city" } }];
      }
      if (c.path === "/rest/v1/universal_stamp_catalog") {
        if (c.method === "GET") return [];           // no existing entry
        if (c.method === "POST") {                   // …and creating one fails, non-23505
          return new Response(JSON.stringify({ message: "insert exploded", code: "42501" }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
      }
      return [];
    });

    const stats = await runReconciliation(sc as any);
    assert.equal(stats.flagged, 1, JSON.stringify(stats));

    const logs = callsTo("stamp_reconciliation_log", "POST")
      .filter((l) => l.body?.source_table === "universal_stamp_catalog");
    assert.equal(
      logs.length, 1,
      `the admin-review row must reach the network; stamp_reconciliation_log POSTs: ` +
        JSON.stringify(callsTo("stamp_reconciliation_log", "POST").map((l) => l.body?.source_table)),
    );
    assert.equal(logs[0]!.body.needs_admin_review, true);
    assert.equal(logs[0]!.body.review_reason, "insert exploded");
    assert.equal(logs[0]!.body.raw_city, "Tokyo");

    // The run-summary row (source_table "reconciliation_run") is a separate,
    // already-correct write — its presence here shows the two are distinct and
    // that the admin-review row is not being confused with it.
    assert.equal(
      callsTo("stamp_reconciliation_log", "POST").filter(
        (l) => l.body?.source_table === "reconciliation_run",
      ).length,
      1,
    );
  });
});
