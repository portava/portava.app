/**
 * Block-state reads must fail CLOSED in the read routes.
 *
 * Every route in this file filtered (or gated) its response on a `blocks` read
 * whose `error` was discarded. supabase-js RESOLVES with `{ data: null, error }`
 * on a PostgREST failure, so each of these read an outage as "nobody is
 * blocked":
 *
 *   routes/follows.ts    `count ?? 0`  → the FULL public passport was served to
 *                        a caller the target had blocked (both the by-id and the
 *                        by-handle route), and `/users/suggestions` recommended
 *                        people the viewer had blocked.
 *   routes/stamps.ts     `.or(...).maybeSingle()` → fail-open on error AND on a
 *                        MUTUAL block, which is two rows and therefore PGRST116.
 *   routes/pulse.ts      the Live rail served blocked users, while the feed at
 *                        the top of the same file already failed closed.
 *   routes/airport.ts    the layover buddy list recommended MEETING a blocked
 *                        person, while the travellers count above it already
 *                        failed closed.
 *   routes/events.ts     the events feed listed events hosted by blocked users.
 *   routes/trips.ts · routes/friends.ts · routes/engagement.ts → mention/liker
 *                        lists served blocked people.
 *   routes/blocks.ts     the block-status API answered a confident "not blocked,
 *                        not blocked by" during an outage — the exact answer
 *                        clients gate "can I contact this person" on.
 *
 * Each site is asserted twice: the error read must withhold, and a CLEAN read
 * must still serve. Without the second half a route that answered nothing at all
 * would pass.
 *
 * Run: node --import tsx/esm --test src/test/blockGateFailClosedRoutes.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import followsRouter from "../routes/follows.js";
import stampsRouter from "../routes/stamps.js";
import pulseRouter from "../routes/pulse.js";
import airportRouter from "../routes/airport.js";
import eventsRouter from "../routes/events.js";
import tripsRouter from "../routes/trips.js";
import friendsRouter from "../routes/friends.js";
import engagementRouter from "../routes/engagement.js";
import blocksRouter from "../routes/blocks.js";

const TOKEN = "bfr-token";
const VIEWER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const TRIP_ID = "33333333-3333-3333-3333-333333333333";
const CIRCLE_ID = "44444444-4444-4444-4444-444444444444";
const TARGET_ID = "55555555-5555-5555-5555-555555555555";
const SESSION_ID = "66666666-6666-6666-6666-666666666666";
const EVENT_ID = "77777777-7777-7777-7777-777777777777";

const BLOCKS_ERROR = { code: "57014", message: "simulated blocks read failure" };

interface BlockRow { blocker_id: string; blocked_id: string }

interface State {
  blocksError: boolean;
  blockRows: BlockRow[];
  /** Every table the request touched — used as a fail-closed short-circuit probe. */
  touched: Set<string>;
}
let state: State;

function matchesOrFilter(row: BlockRow, expr: string): boolean {
  const terms: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { terms.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) terms.push(cur);
  const evalLeaf = (leaf: string): boolean => {
    const m = /^([a-z_]+)\.eq\.(.+)$/.exec(leaf.trim());
    if (!m) return false;
    return String((row as any)[m[1]]) === m[2];
  };
  return terms.some((t) => {
    const trimmed = t.trim();
    const and = /^and\((.*)\)$/.exec(trimmed);
    if (and) return and[1].split(",").every(evalLeaf);
    return evalLeaf(trimmed);
  });
}

const PROFILE = (id: string) => ({
  id,
  handle: `h_${id.slice(0, 4)}`,
  name: "Traveller",
  username: `h_${id.slice(0, 4)}`,
  avatar_url: null,
  account_status: "active",
  is_private: false,
  passport_visibility: "public",
  tag_permission: "anyone",
  role: "user",
  show_name: true,
  name_visibility: "everyone",
});

function makeClient() {
  function chain(table: string) {
    state.touched.add(table);
    const obj: any = {
      _table: table,
      _filters: [] as Array<[string, any]>,
      _or: null as string | null,
      _limit: null as number | null,
      _single: false,
      _head: false,
      select(_c?: string, o?: any) { if (o?.head) obj._head = true; return obj; },
      insert() { return obj; },
      update() { return obj; },
      upsert() { return obj; },
      delete() { return obj; },
      eq(c: string, v: any) { obj._filters.push([c, v]); return obj; },
      neq() { return obj; }, is() { return obj; }, in() { return obj; },
      gt() { return obj; }, gte() { return obj; }, lt() { return obj; }, lte() { return obj; },
      not() { return obj; }, ilike() { return obj; }, like() { return obj; },
      contains() { return obj; }, overlaps() { return obj; }, filter() { return obj; },
      textSearch() { return obj; }, range() { return obj; },
      or(e: string) { obj._or = e; return obj; },
      limit(n: number) { obj._limit = n; return obj; },
      order() { return obj; },
      maybeSingle() { obj._single = true; return resolve(); },
      single() { obj._single = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };
    async function resolve(): Promise<any> {
      if (table === "blocks") {
        if (state.blocksError) return { data: null, error: BLOCKS_ERROR, count: null };
        let rows = state.blockRows.filter((r) =>
          obj._filters.every(([c, v]: [string, any]) => String((r as any)[c]) === String(v)),
        );
        if (obj._or) rows = rows.filter((r) => matchesOrFilter(r, obj._or));
        if (obj._limit != null) rows = rows.slice(0, obj._limit);
        if (obj._head) return { data: null, error: null, count: rows.length };
        if (obj._single) {
          if (rows.length > 1) {
            return { data: null, error: { code: "PGRST116", message: "multiple rows returned" }, count: null };
          }
          return { data: rows[0] ?? null, error: null, count: null };
        }
        return { data: rows, error: null, count: rows.length };
      }
      if (table === "profiles") {
        const id = obj._filters.find(([c]: [string, any]) => c === "id")?.[1];
        const handle = obj._filters.find(([c]: [string, any]) => c === "handle" || c === "username")?.[1];
        if (obj._single) return { data: PROFILE(id ?? (handle ? OTHER : OTHER)), error: null, count: null };
        return { data: [PROFILE(VIEWER), PROFILE(OTHER)], error: null, count: 2 };
      }
      if (table === "feature_flags") {
        const flag = obj._filters.find(([c]: [string, any]) => c === "flag")?.[1];
        // Everything the routes under test need turned ON.
        const on = new Set(["airport_mode_enabled", "airport_buddies_enabled", "stamp_system_v2_enabled"]);
        return { data: on.has(flag) ? { flag, enabled: true } : { flag, enabled: false }, error: null, count: null };
      }
      if (table === "trip_members") {
        const rows = [{ trip_id: TRIP_ID, user_id: VIEWER, role: "owner", status: "accepted" },
                      { trip_id: TRIP_ID, user_id: OTHER, role: "member", status: "accepted" }];
        return obj._single ? { data: rows[0], error: null, count: null } : { data: rows, error: null, count: rows.length };
      }
      if (table === "circle_memberships") {
        const rows = [{ user_id: CIRCLE_ID, other_id: OTHER }];
        return obj._single ? { data: rows[0], error: null, count: null } : { data: rows, error: null, count: rows.length };
      }
      if (table === "memories") {
        const row = { id: EVENT_ID, owner_id: OTHER, visibility: "public" };
        return obj._single ? { data: row, error: null, count: null } : { data: [row], error: null, count: 1 };
      }
      if (table === "memory_likes") {
        const rows = [{ user_id: OTHER, created_at: "2026-01-01T00:00:00.000Z" }];
        return obj._single ? { data: rows[0], error: null, count: null } : { data: rows, error: null, count: rows.length };
      }
      if (table === "post_reactions" || table === "reactions") {
        const rows = [{ user_id: OTHER, created_at: "2026-01-01T00:00:00.000Z" }];
        return obj._single ? { data: rows[0], error: null, count: null } : { data: rows, error: null, count: rows.length };
      }
      if (table === "layover_sessions") {
        const row = {
          id: SESSION_ID, user_id: VIEWER, airport_id: null, trip_id: null,
          arrival_time: "2099-01-01T00:00:00.000Z", departure_time: "2099-01-01T08:00:00.000Z",
          manual_city: "Bangkok", manual_country: "Thailand", manual_iata: "BKK",
          status: "active", share_city_status: false, flight_type: "international",
        };
        return obj._single ? { data: row, error: null, count: null } : { data: [row], error: null, count: 1 };
      }
      if (table === "rent_buddy_profiles") {
        const row = {
          id: "buddy-prof-1", user_id: OTHER, display_name: "Buddy", tagline: null,
          city: "Bangkok", country: "Thailand", categories: ["city"], hourly_rate_usd: 30,
          average_rating: 4.5, review_count: 10, verified: true, cover_photo_url: null,
          buddy_level: "new", available_now: true, status: "active", admin_status: "active",
        };
        return obj._single ? { data: row, error: null, count: null } : { data: [row], error: null, count: 1 };
      }
      if (table === "events") {
        const row = {
          id: EVENT_ID, host_id: OTHER, title: "Rooftop meetup", visibility: "public",
          state: "published", city: "Bangkok", country: "Thailand",
          starts_at: "2099-01-01T00:00:00.000Z", ends_at: "2099-01-01T02:00:00.000Z",
          category: "social", going_count: 1, max_attendees: null, age_min: null,
          verified_only: false, cover_url: null, created_at: "2026-01-01T00:00:00.000Z",
        };
        return obj._single ? { data: row, error: null, count: null } : { data: [row], error: null, count: 1 };
      }
      if (table === "user_follows" || table === "user_friendships") {
        if (obj._head) return { data: null, error: null, count: 0 };
        return obj._single ? { data: null, error: null, count: null } : { data: [], error: null, count: 0 };
      }
      if (obj._head) return { data: null, error: null, count: 0 };
      return obj._single ? { data: null, error: null, count: null } : { data: [], error: null, count: 0 };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: [], error: null }),
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
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
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  for (const r of [followsRouter, stampsRouter, pulseRouter, airportRouter,
                   eventsRouter, tripsRouter, friendsRouter, engagementRouter, blocksRouter]) {
    app.use("/api", r as any);
  }
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = { blocksError: false, blockRows: [], touched: new Set() };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── follows: the public passport ─────────────────────────────────────────────

describe("GET /users/:userId (passport) — block read fails closed", () => {
  it("refuses rather than serving the passport when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/users/${OTHER}`);
    assert.notEqual(r.status, 200,
      `the passport must not be served on unknown block state (got ${r.status} ${JSON.stringify(r.body)})`);
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: serves the passport when the blocks read is clean", async () => {
    const r = await get(`/api/users/${OTHER}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body?.error, "db_error");
  });
});

describe("GET /users/by-handle/:handle (passport) — block read fails closed", () => {
  it("refuses rather than serving the passport when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/users/by-handle/h_2222`);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: serves the passport when the blocks read is clean", async () => {
    const r = await get(`/api/users/by-handle/h_2222`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// ── follows: suggestions ─────────────────────────────────────────────────────

describe("GET /users/suggestions — block read fails closed", () => {
  it("stops before reading candidates when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get("/api/users/suggestions");
    assert.deepEqual(r.body?.users, [],
      "an unknown block set must serve NOTHING, not an unfiltered suggestion list");
    assert.equal(state.touched.has("user_follows"), false,
      "the handler must short-circuit before gathering candidates");
  });

  it("NEGATIVE CONTROL: gathers candidates when the blocks read is clean", async () => {
    await get("/api/users/suggestions");
    assert.equal(state.touched.has("user_follows"), true,
      "on a clean read the handler must get past the block gate");
  });
});

// ── stamps ───────────────────────────────────────────────────────────────────

describe("GET /stamps/user/:userId — block read fails closed", () => {
  it("refuses when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/stamps/user/${TARGET_ID}`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("refuses on a MUTUAL block (two rows — the PGRST116 shape)", async () => {
    // The strongest block state must not read as "not blocked". With
    // `.or(...).maybeSingle()` this pair errored and the stamps were served.
    state.blockRows = [
      { blocker_id: VIEWER, blocked_id: TARGET_ID },
      { blocker_id: TARGET_ID, blocked_id: VIEWER },
    ];
    const r = await get(`/api/stamps/user/${TARGET_ID}`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("NEGATIVE CONTROL: serves when the blocks read is clean and empty", async () => {
    const r = await get(`/api/stamps/user/${TARGET_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// ── pulse: the Live rail ─────────────────────────────────────────────────────

describe("GET /pulse/live — block read fails closed", () => {
  it("returns an empty rail and stops before gathering items when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get("/api/pulse/live?context=tripCity");
    assert.deepEqual(r.body?.items, [],
      "an unknown block set must serve an EMPTY rail, not an unfiltered one");
    assert.equal(state.touched.has("events"), false,
      "the handler must short-circuit before gathering rail items");
  });

  it("NEGATIVE CONTROL: gathers rail items when the blocks read is clean", async () => {
    await get("/api/pulse/live?context=tripCity");
    assert.equal(state.touched.has("events"), true,
      "on a clean read the handler must get past the block gate");
  });
});

// ── airport: the layover buddy list ──────────────────────────────────────────

describe("GET /airport/sessions/:id/buddies — block read fails closed", () => {
  it("returns no buddies when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/airport/sessions/${SESSION_ID}/buddies`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body?.buddies, [],
      "an unknown block set must not recommend anyone to MEET during a layover");
  });

  it("NEGATIVE CONTROL: returns the buddy when the blocks read is clean", async () => {
    const r = await get(`/api/airport/sessions/${SESSION_ID}/buddies`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body?.buddies ?? []).length, 1,
      `the fixture must produce a buddy on a clean read, got ${JSON.stringify(r.body)}`);
  });
});

// ── events feed ──────────────────────────────────────────────────────────────

describe("GET /events — block read fails closed", () => {
  it("withholds another host's events when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get("/api/events?city=Bangkok");
    const ids = ((r.body?.events ?? []) as any[]).map((e) => e.id);
    assert.ok(!ids.includes(EVENT_ID),
      `a host whose block state is unknown must not be listed (got ${JSON.stringify(r.body)})`);
  });

  it("NEGATIVE CONTROL: lists the event when the blocks read is clean", async () => {
    const r = await get("/api/events?city=Bangkok");
    const ids = ((r.body?.events ?? []) as any[]).map((e) => e.id);
    assert.ok(ids.includes(EVENT_ID),
      `the fixture must list the event on a clean read, got ${JSON.stringify(r.body)}`);
  });
});

// ── trip / circle mention candidates ─────────────────────────────────────────

describe("GET /trips/:tripId/invitable-users — block read fails closed", () => {
  it("refuses when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/trips/${TRIP_ID}/invitable-users`);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: answers when the blocks read is clean", async () => {
    const r = await get(`/api/trips/${TRIP_ID}/invitable-users`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("GET /circles/:circleOwnerId/invitable-users — block read fails closed", () => {
  it("refuses when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/circles/${CIRCLE_ID}/invitable-users`);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: answers when the blocks read is clean", async () => {
    const r = await get(`/api/circles/${CIRCLE_ID}/invitable-users`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// ── engagement: the liker list ───────────────────────────────────────────────

describe("GET /engagement/likes — block read fails closed", () => {
  const path = `/api/engagement/likes?targetType=memory_like&targetId=${EVENT_ID}`;

  it("refuses when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(path);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: answers when the blocks read is clean", async () => {
    const r = await get(path);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// ── the block-status API itself ──────────────────────────────────────────────

describe("GET /users/:userId/block-status — reports uncertainty, not 'not blocked'", () => {
  it("refuses when the blocks read ERRORS", async () => {
    state.blocksError = true;
    const r = await get(`/api/users/${TARGET_ID}/block-status`);
    assert.notEqual(r.status, 200,
      `a confident false/false during an outage is the bug (got ${JSON.stringify(r.body)})`);
    assert.equal(r.body?.error, "db_error");
  });

  it("NEGATIVE CONTROL: answers false/false when the blocks read is clean and empty", async () => {
    const r = await get(`/api/users/${TARGET_ID}/block-status`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.iBlocked, false);
    assert.equal(r.body.theyBlockedMe, false);
  });

  it("reports a real block when one exists", async () => {
    state.blockRows = [{ blocker_id: VIEWER, blocked_id: TARGET_ID }];
    const r = await get(`/api/users/${TARGET_ID}/block-status`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.iBlocked, true);
  });
});
