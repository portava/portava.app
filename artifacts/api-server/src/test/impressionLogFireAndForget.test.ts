/**
 * Impression logging fire-and-forget isolation
 *
 * Spec §8: logImpression is called with `void` (no await) in the events,
 * pulse, and discovery feed routes.  A DB write failure on rank_events must
 * never block or delay a feed response.
 *
 * Tests:
 *  A. GET /api/events returns 200 + events payload when rank_events insert throws
 *  B. The response body contains the ranked event list — not empty / not an error
 *  C. GET /api/pulse/live returns 200 when rank_events insert throws
 *  D. GET /api/discovery returns 200 when rank_events insert throws
 *  E. GET /api/events responds before a 2-second delayed rank_events insert resolves
 *     (timing proof: if the route ever awaits logImpression, this test hangs/fails)
 *  F. GET /api/pulse/live responds before a 2-second delayed rank_events insert resolves
 *  G. GET /api/discovery responds before a 2-second delayed rank_events insert resolves
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run: node --import tsx/esm --test src/test/impressionLogFireAndForget.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── IDs ────────────────────────────────────────────────────────────────────────

const USER_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const EVENT_ID = "eeeeeeee-eeee-eeee-eeee-000000000001";

// How long the stub holds rank_events.insert pending.  The feed response must
// arrive well before this deadline — proving the route does not await it.
const RANK_INSERT_DELAY_MS = 2_000;

// Maximum time we allow the HTTP response to take while rank_events is blocked.
// 1 000 ms is generous for a local in-process test.  If a route starts awaiting
// logImpression the response would arrive at ~RANK_INSERT_DELAY_MS instead.
const RESPONSE_MUST_ARRIVE_WITHIN_MS = 1_000;

// ── Seed data ──────────────────────────────────────────────────────────────────

const SEED_EVENT = {
  id:           EVENT_ID,
  host_id:      USER_ID,
  title:        "Test Event",
  description:  "A test event for fire-and-forget logging",
  state:        "open",
  visibility:   "public",
  city:         "testcity",
  category:     "social",
  starts_at:    new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  ends_at:      new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
  created_at:   new Date().toISOString(),
  going_count:  0,
  max_attendees: null,
  verified_only: false,
  trust_score_min: null,
  age_min:      null,
  age_max:      null,
  tags:         [],
  invite_only:  false,
  cover_url:    null,
  location_name: null,
  lat:          null,
  lng:          null,
};

// ── Fake client factories ──────────────────────────────────────────────────────

/**
 * Build a fake Supabase client.
 *
 * @param rankEventsInsertBehavior
 *   "throw"   — insert immediately rejects (tests A–D)
 *   "pending" — insert returns a promise that never resolves within the test
 *               window (tests E–G timing proof)
 */
function makeClient(rankEventsInsertBehavior: "throw" | "pending") {
  function chain(table: string, rows: any[] = []) {
    let filtered = [...rows];

    const obj: any = {
      select()               { return obj; },
      insert(_data: any) {
        if (table === "rank_events") {
          if (rankEventsInsertBehavior === "throw") {
            return Promise.reject(new Error("rank_events: simulated insert failure"));
          }
          // "pending": resolve only after RANK_INSERT_DELAY_MS — if the route
          // awaits this, the feed response will be delayed by that much.
          return new Promise<void>((resolve) =>
            setTimeout(resolve, RANK_INSERT_DELAY_MS),
          );
        }
        return obj;
      },
      upsert()               { return obj; },
      update()               { return obj; },
      delete()               { return obj; },
      eq(col: string, val: any) {
        filtered = filtered.filter((r: any) => r[col] === val);
        return obj;
      },
      neq(col: string, val: any) {
        filtered = filtered.filter((r: any) => r[col] !== val);
        return obj;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r: any) => vals.includes(r[col]));
        return obj;
      },
      not()                  { return obj; },
      gt()                   { return obj; },
      gte()                  { return obj; },
      lt()                   { return obj; },
      lte()                  { return obj; },
      ilike()                { return obj; },
      or()                   { return obj; },
      contains()             { return obj; },
      overlaps()             { return obj; },
      order()                { return obj; },
      limit()                { return obj; },
      range()                { return obj; },
      is(col: string, val: any) {
        filtered = filtered.filter((r: any) =>
          val === null ? r[col] == null : r[col] === val,
        );
        return obj;
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: [...filtered], error: null }).then(onF, onR);
      },
    };
    return obj;
  }

  const tables: Record<string, any[]> = {
    events:                   [SEED_EVENT],
    event_rsvps:              [],
    event_roles:              [],
    event_saves:              [],
    event_waitlist:           [],
    event_join_requests:      [],
    blocks:                   [],
    user_friendships:         [],
    profiles:                 [],
    trust_profiles:           [],
    trust_settings:           [],
    collections:              [],
    collection_items:         [],
    follows:                  [],
    compass_user_preferences: [],
    feature_flags:            [
      { flag: "events_enabled",             enabled: true  },
      { flag: "events_trust_gates_enabled", enabled: false },
      { flag: "discovery_enabled",          enabled: true  },
      { flag: "pulse_enabled",              enabled: true  },
      { flag: "rent_buddy_enabled",         enabled: false },
      { flag: "hidden_gems_enabled",        enabled: false },
    ],
    // pulse / discovery tables
    trip_members:             [],
    trips:                    [],
    trip_join_requests:       [],
    buddy_bookings:           [],
    rent_buddy_profiles:      [],
    hidden_gems:              [],
    safe_return_sessions:     [],
    circle_presence:          [],
    compass_user_profiles:    [],
    discovery_places:         [],
    rank_events:              [],
  };

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") {
          return { data: { user: { id: USER_ID } }, error: null };
        }
        return { data: null, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => chain(table, tables[table] ?? []),
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function timedGet(
  url: string,
  path: string,
): Promise<{ status: number; body: any; elapsedMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: "Bearer valid-token" },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, elapsedMs: Date.now() - t0 };
}

// ── Suite A–D: immediate-reject stub ──────────────────────────────────────────

describe("Impression logging — rank_events immediate-reject: no error propagation", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    _setTestClient(makeClient("throw"), true);
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    await closeServer(server);
    _setTestClient(null as any, false);
  });

  it("A: GET /api/events returns 200 even when rank_events insert throws", async () => {
    const { status, body } = await timedGet(url, "/api/events");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
  });

  it("B: GET /api/events response body contains ranked events — not an error shape", async () => {
    const { status, body } = await timedGet(url, "/api/events");
    assert.equal(status, 200);
    assert.ok(
      Array.isArray(body?.events),
      `Expected body.events to be an array but got: ${JSON.stringify(body)}`,
    );
    const ids = (body.events as any[]).map((e: any) => e.id);
    assert.ok(
      ids.includes(EVENT_ID),
      `Expected seeded event ${EVENT_ID} in response but got ids: ${JSON.stringify(ids)}`,
    );
  });

  it("C: GET /api/pulse/live returns 200 even when rank_events insert throws", async () => {
    const { status, body } = await timedGet(url, "/api/pulse/live");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
  });

  it("D: GET /api/discovery returns 200 even when rank_events insert throws", async () => {
    const { status, body } = await timedGet(url, "/api/discovery?destination=testcity");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
  });
});

// ── Suite E–G: delayed stub — timing proof ────────────────────────────────────
//
// rank_events.insert resolves only after RANK_INSERT_DELAY_MS (2 s).
// If any route awaits logImpression the HTTP response will be delayed by ~2 s,
// which exceeds RESPONSE_MUST_ARRIVE_WITHIN_MS (1 s) and fails the assertion.
// Under the correct void (no-await) pattern the response arrives in < 100 ms.

describe("Impression logging — rank_events delayed stub: response arrives before insert settles", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    _setTestClient(makeClient("pending"), true);
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    await closeServer(server);
    _setTestClient(null as any, false);
  });

  it("E: GET /api/events responds well before the 2-second rank_events insert settles", async () => {
    const { status, body, elapsedMs } = await timedGet(url, "/api/events");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      elapsedMs < RESPONSE_MUST_ARRIVE_WITHIN_MS,
      `Feed response took ${elapsedMs}ms — expected < ${RESPONSE_MUST_ARRIVE_WITHIN_MS}ms. ` +
        "The route may be awaiting logImpression.",
    );
  });

  it("F: GET /api/pulse/live responds well before the 2-second rank_events insert settles", async () => {
    const { status, body, elapsedMs } = await timedGet(url, "/api/pulse/live");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      elapsedMs < RESPONSE_MUST_ARRIVE_WITHIN_MS,
      `Feed response took ${elapsedMs}ms — expected < ${RESPONSE_MUST_ARRIVE_WITHIN_MS}ms. ` +
        "The route may be awaiting logImpression.",
    );
  });

  it("G: GET /api/discovery responds well before the 2-second rank_events insert settles", async () => {
    const { status, body, elapsedMs } = await timedGet(url, "/api/discovery?destination=testcity");
    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      elapsedMs < RESPONSE_MUST_ARRIVE_WITHIN_MS,
      `Feed response took ${elapsedMs}ms — expected < ${RESPONSE_MUST_ARRIVE_WITHIN_MS}ms. ` +
        "The route may be awaiting logImpression.",
    );
  });
});
