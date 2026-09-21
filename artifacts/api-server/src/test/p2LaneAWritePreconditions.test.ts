/**
 * WRITE-PRECONDITION reads on the Lane A route surfaces must fail CLOSED.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. It does not throw and it does not
 * reject, so
 *
 *     const { data: existing } = await sc.from("t").select(...).maybeSingle();
 *     if (!existing) { …INSERT… }
 *
 * treats "the table could not be read" and "there is no such row" as the same
 * answer — and on every route below the second reading is the one that WRITES.
 * A try/catch around any of these reads is dead code; only binding `error`
 * distinguishes the two.
 *
 * Each case here proves BOTH halves:
 *
 *   failure   the ONE table errors  → the route refuses AND writes nothing
 *   healthy   every table reads     → the normal answer is unchanged
 *
 * The healthy half is not padding: a "fix" that refused unconditionally would
 * satisfy every failure case in this file and be a total outage.
 *
 * ── THE THREE VACUITY TRAPS THIS FILE AVOIDS DELIBERATELY ────────────────────
 *  1. Never `assert.notEqual(status, 200)`. A request rejected at VALIDATION
 *     never reaches the code under test and would satisfy that. Every case
 *     asserts the exact `error` code AND matches the specific message.
 *  2. `requireUser` ITSELF answers 503 `degraded_unavailable` when `profiles`
 *     is unreadable. That is the same status and the same code these fixes
 *     send, so a fake that failed reads globally would produce a green test
 *     that never entered the handler at all. Every `failOn` below fails
 *     exactly ONE table, and every assertion matches the handler's own message
 *     text, which differs from requireUser's "Could not verify account status".
 *  3. The `req.log` shim the real server installs is present. Without it these
 *     handlers throw a TypeError on the logging line the fix adds, and the
 *     resulting 500-from-crash would masquerade as a deliberate refusal.
 *
 * The fake is src/test/helpers/failClosedSupabase.ts, whose `failOn` injects
 * the RESOLVED `{ data: null, error }` shape rather than throwing — a fake that
 * threw would be exercising a path production never takes.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneAWritePreconditions.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";
import eventsRouter from "../routes/events.js";
import tripsRouter from "../routes/trips.js";
import compassRouter from "../routes/compass.js";

const ME    = "aaaaaaaa-2222-4000-a000-000000000001";
const HOST  = "bbbbbbbb-2222-4000-a000-000000000002";
const OTHER = "cccccccc-2222-4000-a000-000000000003";
const EVENT = "dddddddd-2222-4000-a000-000000000004";
const TRIP  = "eeeeeeee-2222-4000-a000-000000000005";
const TOK   = "tok-me";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

// ── Server ───────────────────────────────────────────────────────────────────

let server: http.Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs. The fixes under test log through
  // `req.log` before refusing; without this every one of them would crash and
  // the 500 would look like a refusal.
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", eventsRouter);
  app.use("/api", tripsRouter);
  app.use("/api", compassRouter);
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

/** Fail exactly ONE table; every other read stays healthy (trap 2 above). */
function only(table: string) {
  return (ctx: { table: string }) => (ctx.table === table ? READ_FAIL : null);
}

// ═════════════════════════════════════════════════════════════════════════════
// events.ts — seating someone on an event waitlist
// ═════════════════════════════════════════════════════════════════════════════
//
// Two reads decide the INSERT: "already queued?" and "highest position taken?".
// Both resolve as `{ data: null }` on an unreadable event_waitlist, which the
// old code read as "not queued" / "queue empty" and then
//   - inserted a SECOND row for a user already on the list,
//   - at position 1, ahead of everyone genuinely waiting, and
//   - stamped events.waitlist_count = 1 over a queue of any length.

const WAITLIST_EVENT = {
  id: EVENT,
  host_id: HOST,
  state: "waitlist",
  waitlist_enabled: true,
  visibility: "public",
  circle_id: null,
  trip_id: null,
  age_min: null,
  age_max: null,
  trust_score_min: null,
  verified_only: false,
};

describe("POST /events/:id/waitlist — event_waitlist is a write precondition", () => {
  it("REFUSES and inserts nothing when event_waitlist cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        events: [WAITLIST_EVENT],
        // The queue really does hold three people. The route must not be able
        // to see that, and must not overwrite it.
        event_waitlist: [
          { event_id: EVENT, user_id: OTHER, position: 1 },
          { event_id: EVENT, user_id: HOST, position: 2 },
          { event_id: EVENT, user_id: ME, position: 3 },
        ],
      },
      failOn: only("event_waitlist"),
    });

    const r = await req("POST", `/api/events/${EVENT}/waitlist`);

    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    // Specifically THIS handler's refusal, not requireUser's account-status one.
    assert.match(r.body.message, /waitlist could not be updated/i);
    assert.equal(r.body.retryable, true);
    // Nothing was written: no duplicate row, and no waitlist_count = 1 stamped
    // over a three-deep queue.
    assert.equal(spec.inserted?.event_waitlist, undefined);
    assert.equal(spec.updated?.events, undefined);
  });

  it("still seats a new user at the end of the queue when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        events: [WAITLIST_EVENT],
        event_waitlist: [
          { event_id: EVENT, user_id: OTHER, position: 1 },
          { event_id: EVENT, user_id: HOST, position: 2 },
        ],
      },
    });

    const r = await req("POST", `/api/events/${EVENT}/waitlist`);

    assert.equal(r.status, 201);
    assert.equal(r.body.position, 3);
    assert.deepEqual(spec.inserted?.event_waitlist, [{ event_id: EVENT, user_id: ME, position: 3 }]);
  });

  it("still reports the existing position for someone already queued", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        events: [WAITLIST_EVENT],
        event_waitlist: [{ event_id: EVENT, user_id: ME, position: 2 }],
      },
    });

    const r = await req("POST", `/api/events/${EVENT}/waitlist`);

    assert.equal(r.status, 200);
    assert.equal(r.body.position, 2);
    assert.match(r.body.message, /already on waitlist/i);
    assert.equal(spec.inserted?.event_waitlist, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// trips.ts — POST /trips/:tripId/members
// ═════════════════════════════════════════════════════════════════════════════
//
// `existing` does not merely pick the response, it picks the WRITE: UPDATE the
// row's role when a membership exists, INSERT a new one when it does not. An
// unreadable trip_members reads as "not a member", so an intended role CHANGE
// becomes an attempted ADD: the existing row keeps its old role while the
// caller is told "added".

describe("POST /trips/:tripId/members — trip_members is a write precondition", () => {
  it("REFUSES and writes nothing when trip_members cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        trips: [{ id: TRIP, owner_id: ME }],
        // OTHER is already a full member. The route must not be able to see it.
        trip_members: [{ trip_id: TRIP, user_id: OTHER, role: "member" }],
      },
      failOn: only("trip_members"),
    });

    const r = await req("POST", `/api/trips/${TRIP}/members`, { userId: OTHER, role: "invited" });

    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /could not check this trip's members/i);
    assert.equal(spec.inserted?.trip_members, undefined);
    assert.equal(spec.updated?.trip_members, undefined);
  });

  it("still UPDATES the role of an existing member when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        trips: [{ id: TRIP, owner_id: ME }],
        trip_members: [{ trip_id: TRIP, user_id: OTHER, role: "invited" }],
      },
    });

    const r = await req("POST", `/api/trips/${TRIP}/members`, { userId: OTHER, role: "member" });

    assert.equal(r.status, 200);
    assert.equal(r.body.status, "updated");
    assert.deepEqual(spec.updated?.trip_members, [{ role: "member" }]);
    assert.equal(spec.inserted?.trip_members, undefined);
  });

  it("still INSERTS a brand-new member when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        trips: [{ id: TRIP, owner_id: ME }],
        trip_members: [],
      },
    });

    const r = await req("POST", `/api/trips/${TRIP}/members`, { userId: OTHER, role: "member" });

    assert.equal(r.status, 201);
    assert.equal(r.body.status, "added");
    assert.deepEqual(spec.inserted?.trip_members, [{ trip_id: TRIP, user_id: OTHER, role: "member" }]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// trips.ts — POST /trips/:tripId/plan/items duplicate guard
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /trips/:tripId/plan/items — the duplicate guard is a write precondition", () => {
  const ITEM = {
    title: "Louvre", category: "activity", status: "tentative",
    sourceType: "place", sourceId: "22222222-2222-4000-a000-000000000022",
  };

  it("REFUSES and inserts nothing when trip_plan_items cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        trips: [{ id: TRIP, owner_id: ME }],
        trip_members: [{ trip_id: TRIP, user_id: ME, role: "owner" }],
        // The item IS already in the plan — invisible while the table errors.
        trip_plan_items: [{
          id: "item-1", trip_id: TRIP, source_type: "place",
          source_id: ITEM.sourceId, removed_at: null,
        }],
      },
      failOn: only("trip_plan_items"),
    });

    const r = await req("POST", `/api/trips/${TRIP}/plan/items`, ITEM);

    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /check the plan for duplicates/i);
    assert.equal(spec.inserted?.trip_plan_items, undefined);
  });

  it("still answers 409 for a real duplicate when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        trips: [{ id: TRIP, owner_id: ME }],
        trip_members: [{ trip_id: TRIP, user_id: ME, role: "owner" }],
        trip_plan_items: [{
          id: "item-1", trip_id: TRIP, source_type: "place",
          source_id: ITEM.sourceId, removed_at: null,
        }],
      },
    });

    const r = await req("POST", `/api/trips/${TRIP}/plan/items`, ITEM);

    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate");
    assert.equal(spec.inserted?.trip_plan_items, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// compass.ts — POST /compass/signals/search
// ═════════════════════════════════════════════════════════════════════════════
//
// This one is a read-modify-WRITE of an entire JSON map, and the failure is
// destructive rather than merely permissive: `?? {}` on an unreadable
// compass_user_preferences makes the upsert replace every learned category
// weight the user has with a single `{ [category]: 1 }`. A skipped nudge costs
// +1; a clobbered map cannot be recovered.
//
// The route responds 202 BEFORE the nudge runs, so the assertion is on what was
// written, after letting the detached task settle.

const settle = () => new Promise((r) => setTimeout(r, 40));

describe("POST /compass/signals/search — the weight map must not be clobbered", () => {
  it("does NOT upsert when compass_user_preferences cannot be read", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        compass_user_preferences: [{
          user_id: ME,
          category_weights: { food: 7, nightlife: -3, outdoors: 5 },
        }],
      },
      failOn: only("compass_user_preferences"),
    });

    const r = await req("POST", "/api/compass/signals/search", { query: "ramen", category: "food" });
    assert.equal(r.status, 202);
    await settle();

    // The learned map survives untouched: no upsert was attempted at all.
    assert.equal(spec.inserted?.compass_user_preferences, undefined);
  });

  it("still nudges the searched category when the table reads fine", async () => {
    const spec = install({
      users: { [TOK]: ME },
      rows: {
        profiles: [{ id: ME, account_status: "active" }],
        compass_user_preferences: [{
          user_id: ME,
          category_weights: { food: 7, nightlife: -3, outdoors: 5 },
        }],
      },
    });

    const r = await req("POST", "/api/compass/signals/search", { query: "ramen", category: "food" });
    assert.equal(r.status, 202);
    await settle();

    const written = spec.inserted?.compass_user_preferences?.[0];
    assert.ok(written, "expected the nudge to upsert compass_user_preferences");
    // +1 on the searched category, and — the point of the fix — the OTHER
    // learned weights are still there.
    assert.deepEqual(written.category_weights, { food: 8, nightlife: -3, outdoors: 5 });
  });
});
