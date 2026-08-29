/**
 * GET /api/pulse/live — rank_events serve telemetry (Live Pulse impressions).
 *
 * WHAT MAKES THESE TESTS NON-VACUOUS
 * ----------------------------------
 * Two properties, both of which an earlier version of this file lacked:
 *
 *  (a) The fake Supabase `insert` is a SCHEMA-VALIDATING fake.  It knows the
 *      real rank_events column set, the three live CHECK vocabularies
 *      (surface / outcome / item_kind), and which columns are NOT NULL without
 *      a DB default.  A row that could not physically land in Postgres is
 *      recorded as a violation and the insert resolves with a PostgREST-shaped
 *      error, exactly as the database would answer.  Every test asserts the
 *      violation list is empty, so "the builder produced these keys" is no
 *      longer the whole claim — "these rows could actually be stored" is.
 *      The validator itself is tested against known-bad rows (see
 *      "rank_events schema fake — the validator can actually reject"), so it
 *      cannot silently degrade into an accept-everything stub again.
 *
 *  (b) Every assertion reads objects that the PRODUCTION code path handed to
 *      `sc.from("rank_events").insert(...)`.  `captured` holds those exact
 *      object references — nothing here rebuilds a row locally and then checks
 *      its own arithmetic.
 *
 * The nine required cases:
 *  1. event  — the emitted item_id is item.item_id (events.id), NOT item.id
 *  2. trip   — item_kind 'plan', item_id = trips.id
 *  3. buddy  — item_kind 'buddy', item_id = the buddy's USER_ID (see below)
 *  4. gem    — item_kind 'gem',  item_id = hidden_gems.id
 *  5. circle       — emits no attributable ranking impression
 *  6. safe_return  — emits none
 *  7. compass      — emits none
 *  8. composite ids ("event:<uuid>") can NEVER reach rank_events.item_id
 *  9. duplicate entities in one response cannot produce duplicate impressions
 * plus: rows land on Live Pulse's OWN surface ('live_pulse', never 'pulse');
 * session_id is minted per response and returned to the client; buddy_request
 * (booking PKs) is deliberately excluded; positions are the served indices with
 * gaps preserved; features is never written; rows are outcome='impression' +
 * event_type='live_pulse_serve'.
 *
 * SURFACE SEPARATION — the load-bearing invariant.  These rows once carried
 * surface='pulse', the SAME key space the ranked /pulse writer uses, with the
 * same canonical entity ids.  The outcome lookup in routes/rankEvents.ts
 * resolves an outcome by (user_id, item_id, surface, outcome='impression')
 * ordered by served_at DESC LIMIT 1, so the newer Live Pulse row stole outcomes
 * belonging to genuine ranked impressions.  session_id does not fix that — that
 * filter is skipped entirely whenever the client omits it.  A distinct surface
 * is a distinct key space, so the collision cannot occur at all.  Reverting
 * surface to 'pulse' re-opens the hijack, so it has its own dedicated test in
 * BOTH the end-to-end and the pure-builder blocks.
 *
 * BUDDY NAMESPACE (test 3).  The rail's client-facing `item_id` for
 * available_buddy is rent_buddy_profiles.id, because both card actions
 * navigate by profile id.  rank_events must NOT store that: the ranked /pulse
 * writer builds buddy candidates as `id: b.user_id`, so every
 * (surface='pulse', item_kind='buddy') row in the corpus is keyed by user_id.
 * The separate surface means a profile id here could no longer COLLIDE with a
 * ranked row — but it would still be the wrong id for every cross-surface
 * rollup.  routes/pulse.ts therefore attaches an internal `_rankItemId` =
 * user_id, and buildLivePulseServeRows emits NOTHING for a buddy without it
 * (fail closed).
 *
 * Tests 1-9 run END-TO-END through the route so that swapping `item.item_id`
 * for `item.id` in routes/pulse.ts or lib/rankLog.ts breaks them.  The pure
 * builder is also exercised directly for the same invariants.
 *
 * The last describe block covers routes/adminRankingMetrics.ts's
 * `nonLivePulse = all.filter((r) => r.surface !== "live_pulse")` split, which is
 * what keeps these rows out of the SURFACE-BLIND ranker-quality metrics.  Note
 * the split is scoped to SURFACE, not to `event_type == null`: five of the six
 * computations it feeds have no surface dimension at all and aggregate every
 * surface into one number, so the separate surface does NOT make the filter
 * redundant.  The sixth, `by_surface`, deliberately keeps counting every row —
 * it is the one breakdown keyed by surface, and therefore the only place a
 * distinct surface value can actually be seen.
 *
 * NOTE on conventions: api-server has no jest, so the mobile trees'
 * check-test-mocks.mjs NOTE-comment rule does not apply here — the fake
 * Supabase client is injected via _setTestClient, not via a module mock.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 *
 * Run: node --import tsx/esm --test src/test/livePulseImpressions.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { livePulseItemKind, buildLivePulseServeRows } from "../lib/rankLog.js";
import adminRankingMetricsRouter from "../routes/adminRankingMetrics.js";

// ── IDs — canonical entity ids never contain ':' ──────────────────────────────

const ALICE_ID  = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const BOB_ID    = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002"; // rent_buddy_profiles.user_id

const EVENT_ID  = "e1111111-1111-4111-8111-111111111111"; // events.id
const TRIP_A_ID = "70000001-1111-4111-8111-111111111111"; // trips.id — rail 'trip'
const TRIP_B_ID = "70000002-2222-4222-8222-222222222222"; // trips.id — circle only
const BUDDY_PROFILE_ID = "b0000001-1111-4111-8111-111111111111"; // rent_buddy_profiles.id
const BOOKING_ID  = "bc000001-1111-4111-8111-111111111111";      // buddy_bookings.id
const GEM_MNL_ID  = "6e000001-1111-4111-8111-111111111111";      // hidden_gems.id (Manila)
const GEM_CEB_ID  = "6e000002-2222-4222-8222-222222222222";      // hidden_gems.id (Cebu)
const SAFE_RETURN_ID = "5a000001-1111-4111-8111-111111111111";   // safe_return_sessions.id

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// rank_events schema — migrations 0153 + 0154 + 0197 + 0199
// ─────────────────────────────────────────────────────────────────────────────
//
//   id           uuid        PK  DEFAULT gen_random_uuid()
//   user_id      uuid        NOT NULL
//   item_id      text        NOT NULL
//   item_kind    text        NULL  CHECK IN ('post','event','plan','buddy','place','gem')
//   position     smallint    NULL
//   features     jsonb       NOT NULL DEFAULT '{}'
//   outcome      text        NOT NULL DEFAULT 'impression'
//                            CHECK IN ('impression','tap','save','join','rsvp','attended','analytics')
//   served_at    timestamptz NOT NULL DEFAULT now()
//   outcome_at   timestamptz NULL
//   surface      text        NOT NULL
//                            CHECK IN ('pulse','discovery','events','compass','search',
//                                      'nearby','story','event','trip','profile','explore',
//                                      'live_pulse')
//   session_id   uuid        NULL
//   event_type   text        NULL
//   content_type text        NULL

const RANK_EVENTS_COLUMNS = new Set([
  "id", "user_id", "item_id", "item_kind", "position", "features", "outcome",
  "served_at", "outcome_at", "surface", "session_id", "event_type", "content_type",
]);

/** NOT NULL and no DB default — the insert MUST supply these. */
const REQUIRED_COLUMNS = ["user_id", "item_id", "surface"] as const;

/** NOT NULL but DB-defaulted — may be omitted, must never be explicitly null. */
const DEFAULTED_NOT_NULL = ["id", "features", "outcome", "served_at"] as const;

const ITEM_KIND_VALUES = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
const OUTCOME_VALUES   = new Set([
  "impression", "tap", "save", "join", "rsvp", "attended", "analytics",
]);
/**
 * The live rank_events_surface_check vocabulary.
 *
 * The first eleven values are migration 0197's list, verbatim.  'live_pulse' is
 * added by 0199_rank_events_live_pulse_surface.sql; 'living_page' and
 * 'watch_feed' by 0202_rank_events_living_page_watch_feed_surfaces.sql.  This
 * set is a mirror of a live CHECK constraint, not a wish list.  It may only
 * grow when a migration widening the real constraint has been written AND
 * applied (verify with `pnpm run check:rank-events-surfaces`, which prints one
 * `GATE <surface>: PERMITTED` line per required surface once the live
 * constraint accepts it).
 *
 * 'living_page' and 'watch_feed' were deliberately absent until 0202.  Both were
 * being written by production code — routes/rankEvents.ts and routes/mediaFeed.ts
 * respectively — and silently rejected, so every Living Page and Watch Feed
 * impression was dropped on the floor.  0202 admitted them formally on the
 * grounds that recording the signal beats continuing to lose it.  They are now
 * asserted PRESENT below, and the gate probes them behaviourally.
 *
 * Deliberately still ABSENT, and asserted to be rejected below:
 *   'pulse_live'   — never a real value; the transposition an author reaching
 *                    for 'live_pulse' from memory is most likely to write.
 *   'livepulse' / 'Live_Pulse' — spelling and case variants of a real value.
 */
const SURFACE_VALUES   = new Set([
  "pulse", "discovery", "events", "compass", "search",
  "nearby", "story", "event", "trip", "profile", "explore",
  "live_pulse",
  "living_page", "watch_feed",
]);

const SMALLINT_MIN = -32768;
const SMALLINT_MAX = 32767;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIsoTimestamp(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

/**
 * Validate one candidate rank_events row the way Postgres would.
 *
 * Returns a list of human-readable constraint violations; an empty list means
 * the row could physically be stored.  This deliberately does NOT encode
 * product rules (e.g. "item_id must not be composite") — item_id is plain
 * `text` and Postgres would happily accept "event:<uuid>".  Product rules are
 * asserted by the tests themselves (notably test 8), which is the right split:
 * the fake models the database, the tests model the design.
 */
export function validateRankEventRow(row: unknown): string[] {
  const v: string[] = [];
  if (!isPlainObject(row)) return ["row is not an object"];

  // 1. Unknown columns — PostgREST rejects the whole request on these.
  for (const key of Object.keys(row)) {
    if (!RANK_EVENTS_COLUMNS.has(key)) {
      v.push(`unknown column "${key}" is not in the rank_events schema`);
    }
  }

  // 2. NOT NULL without a default — must be present and non-null.
  for (const col of REQUIRED_COLUMNS) {
    if (!(col in row) || row[col] === null || row[col] === undefined) {
      v.push(`null value in column "${col}" violates NOT NULL (no DB default)`);
    }
  }

  // 3. NOT NULL with a default — omitting is fine, explicit null is not.
  for (const col of DEFAULTED_NOT_NULL) {
    if (col in row && (row[col] === null || row[col] === undefined)) {
      v.push(`explicit null in NOT NULL column "${col}" (omit it to use the DB default)`);
    }
  }

  // 4. CHECK vocabularies.
  if (row.item_kind !== undefined && row.item_kind !== null &&
      !ITEM_KIND_VALUES.has(row.item_kind as string)) {
    v.push(`item_kind "${String(row.item_kind)}" violates rank_events_item_kind_check`);
  }
  if (row.outcome !== undefined && row.outcome !== null &&
      !OUTCOME_VALUES.has(row.outcome as string)) {
    v.push(`outcome "${String(row.outcome)}" violates rank_events_outcome_check`);
  }
  if (row.surface !== undefined && row.surface !== null &&
      !SURFACE_VALUES.has(row.surface as string)) {
    v.push(`surface "${String(row.surface)}" violates rank_events_surface_check`);
  }

  // 5. Column types.
  if ("user_id" in row && row.user_id != null && !UUID_RE.test(String(row.user_id))) {
    v.push(`user_id "${String(row.user_id)}" is not a uuid`);
  }
  if ("id" in row && row.id != null && !UUID_RE.test(String(row.id))) {
    v.push(`id "${String(row.id)}" is not a uuid`);
  }
  if ("session_id" in row && row.session_id != null && !UUID_RE.test(String(row.session_id))) {
    v.push(`session_id "${String(row.session_id)}" is not a uuid`);
  }
  if ("item_id" in row && row.item_id != null) {
    // Stricter than Postgres on purpose: `text NOT NULL` accepts '', but an
    // empty item_id joins to nothing and buildLivePulseServeRows already
    // refuses to emit one, so an empty id reaching insert is a real defect.
    if (typeof row.item_id !== "string" || row.item_id.length === 0) {
      v.push("item_id must be non-empty text");
    }
  }
  if ("position" in row && row.position != null) {
    const p = row.position;
    if (typeof p !== "number" || !Number.isInteger(p) || p < SMALLINT_MIN || p > SMALLINT_MAX) {
      v.push(`position ${String(p)} is not a smallint`);
    }
  }
  if ("features" in row && row.features != null && !isPlainObject(row.features)) {
    v.push("features must be a jsonb object");
  }
  for (const col of ["served_at", "outcome_at"] as const) {
    if (col in row && row[col] != null && !isIsoTimestamp(row[col])) {
      v.push(`${col} "${String(row[col])}" is not a timestamptz`);
    }
  }
  for (const col of ["event_type", "content_type"] as const) {
    if (col in row && row[col] != null && typeof row[col] !== "string") {
      v.push(`${col} must be text or null`);
    }
  }

  return v;
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Modelled on src/test/livePulse.test.ts's builder, with one addition that file
// lacks: `insert`.  Without it the rank_events write throws
// "b.insert is not a function" and every assertion below would be vacuous —
// and with a permissive insert the assertions would only describe the builder's
// output, never whether it is storable.  Hence the validating insert.

interface FakeState {
  events?: any[];
  event_rsvps?: any[];
  event_saves?: any[];
  trip_members?: any[];
  trips?: any[];
  trip_join_requests?: any[];
  buddy_bookings?: any[];
  rent_buddy_profiles?: any[];
  hidden_gems?: any[];
  blocks?: any[];
  safe_return_sessions?: any[];
  circle_presence?: any[];
  feature_flags?: any[];
  compass_user_profiles?: any[];
  profiles?: any[];
}

function makeClient(
  state: FakeState,
  captured: any[],
  violations: string[],
  callerUserId = ALICE_ID,
) {
  const db: Record<string, any[]> = {
    events:                state.events                ?? [],
    event_rsvps:           state.event_rsvps           ?? [],
    event_saves:           state.event_saves           ?? [],
    trip_members:          state.trip_members          ?? [],
    trips:                 state.trips                 ?? [],
    trip_join_requests:    state.trip_join_requests    ?? [],
    buddy_bookings:        state.buddy_bookings        ?? [],
    rent_buddy_profiles:   state.rent_buddy_profiles   ?? [],
    hidden_gems:           state.hidden_gems           ?? [],
    blocks:                state.blocks                ?? [],
    safe_return_sessions:  state.safe_return_sessions  ?? [],
    circle_presence:       state.circle_presence       ?? [],
    feature_flags:         state.feature_flags         ?? [],
    compass_user_profiles: state.compass_user_profiles ?? [],
    // requireUser probes profiles/account_status — seed it so the guard passes.
    profiles:              state.profiles              ?? [{ id: callerUserId, account_status: "active" }],
    rank_events:           [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = rows.map((r) => ({ ...r }));

    const b: any = {
      select: (_cols?: string) => builder(table, filtered),
      /**
       * Schema-validating insert.  Rows are captured BY REFERENCE (so tests
       * inspect exactly what the production path passed, not a copy) and then
       * checked against the real rank_events schema.  A violating batch
       * resolves with a PostgREST-shaped error, like the database would.
       */
      insert: (data: any) => {
        const inserted = Array.isArray(data) ? data : [data];
        if (table !== "rank_events") {
          return Promise.resolve({ data: null, error: null });
        }
        const before = violations.length;
        inserted.forEach((row, i) => {
          captured.push(row);
          for (const msg of validateRankEventRow(row)) {
            violations.push(`rank_events row[${i}]: ${msg}`);
          }
        });
        if (violations.length > before) {
          return Promise.resolve({
            data: null,
            error: { code: "23514", message: violations.slice(before).join("; ") },
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      gt: (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] > val);
        return b;
      },
      lt: (_col: string, _val: any) => b,
      gte: (_col: string, _val: any) => b,
      lte: (_col: string, _val: any) => b,
      ilike: (col: string, pattern: string) => {
        const rx = new RegExp("^" + pattern.replace(/%/g, ".*") + "$", "i");
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      like: (col: string, pattern: string) => {
        const rx = new RegExp("^" + pattern.replace(/%/g, ".*") + "$");
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      or: (_f: string) => b,
      contains: (_c: string, _v: any) => b,
      overlaps: (_c: string, _v: any) => b,
      order: (_col: string, _opts?: any) => b,
      limit: (_n: number) => b,
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-token") return { data: { user: { id: callerUserId } }, error: null };
        return { data: null, error: { message: "invalid" } };
      },
    },
    from: (table: string) => builder(table, db[table] ?? []),
  };
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

/**
 * Bind AND connect on the same explicit address.  Both halves matter.
 *
 * `server.listen(0)` with no host binds the IPv6 wildcard `[::]`, and node sets
 * SO_REUSEADDR, so the kernel will hand out an ephemeral port that a FOREIGN
 * process already holds on `127.0.0.1` — a dev server, an LSP, a local proxy,
 * anything in 49152-65535.  The bind succeeds; the two sockets are on different
 * address families and never collide.  `fetch("http://localhost:<port>")` then
 * resolves the NAME to both families and, on this platform, reaches the IPv4
 * one — the foreign process.  Our server sees zero requests and the assertion
 * fails on whatever that stranger answered: a bare `TypeError: fetch failed`
 * with an empty cause when it replies 407, an unrelated body otherwise.
 *
 * That lands on a uniformly random test in this file, roughly once per few
 * hundred runs, and never reproduces in isolation — the exact signature of the
 * "3b" intermittent.  Binding 127.0.0.1 makes the port genuinely exclusive
 * (the kernel will not assign one already bound on the same address), and
 * dialling 127.0.0.1 by literal removes the name resolution that crossed the
 * families in the first place.
 *
 * The address is spelled inline at every site rather than hoisted into a
 * constant, because `loopbackBindGuard.test.ts` verifies the literal that is
 * actually passed — an identifier tells it nothing about the value.
 *
 * This is now what the whole api-server suite does; this file was the first one
 * fixed.  Do not revert either half to `listen(0, r)` / `localhost`.
 */

async function makeApp(): Promise<Express> {
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express();
  app.use(express.json());
  app.use("/api", pulseRouter);
  return app;
}

async function get(app: Express, path: string): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: "Bearer valid-token" },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * The rank_events write is fire-and-forget (`void`), so it is not ordered
 * against the response.  Poll briefly rather than assuming it already landed.
 */
async function settle(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Seeds ─────────────────────────────────────────────────────────────────────

const in30min = new Date(Date.now() + 30 * 60_000).toISOString();
const in45min = new Date(Date.now() + 45 * 60_000).toISOString();
const in2h    = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const in3days = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
const in20days = new Date(Date.now() + 20 * 24 * 60 * 60_000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();

/**
 * One response carrying every item type at once:
 *   safe_return, event, buddy_request, circle, trip, available_buddy,
 *   hidden_gem, compass.
 * TRIP_B is a member trip with status 'completed', so it yields a circle item
 * but NOT a trip item — that keeps the circle's item_id (a trips.id) out of the
 * emitted set, which is what makes test 5 meaningful.
 */
const FULL_RAIL: FakeState = {
  feature_flags: [
    { flag: "safe_return_enabled",      enabled: true },
    { flag: "hidden_gems_enabled",      enabled: true },
    { flag: "find_your_circle_enabled", enabled: true },
  ],
  safe_return_sessions: [{
    id: SAFE_RETURN_ID, user_id: ALICE_ID, status: "active",
    timer_end_at: in45min, trip_id: null, escalation_level: 0,
  }],
  events: [{
    id: EVENT_ID, host_id: ALICE_ID, title: "Beach Meetup",
    starts_at: in30min, ends_at: in3days, city: "Manila",
    state: "open", visibility: "public", going_count: 5, max_attendees: 20,
  }],
  trip_members: [
    { trip_id: TRIP_A_ID, user_id: ALICE_ID, role: "owner" },
    { trip_id: TRIP_B_ID, user_id: ALICE_ID, role: "member" },
  ],
  trips: [
    {
      id: TRIP_A_ID, owner_id: ALICE_ID, title: "Manila Trip",
      destination_city: "Manila", start_date: in3days, end_date: in20days,
      status: "planning", visibility: "private",
    },
    {
      id: TRIP_B_ID, owner_id: BOB_ID, title: "Finished Trip",
      destination_city: "Cebu", start_date: longAgo, end_date: longAgo,
      status: "completed", visibility: "private",
    },
  ],
  circle_presence: [
    { context_type: "trip", context_id: TRIP_B_ID, user_id: BOB_ID, updated_at: oneHourAgo },
  ],
  buddy_bookings: [{
    id: BOOKING_ID, buddy_id: BUDDY_PROFILE_ID, traveler_id: ALICE_ID,
    booking_date: in2h, city: "Manila", status: "requested",
  }],
  // user_id (BOB_ID) is the id the ranked /pulse writer uses for buddies; `id`
  // is the rent_buddy_profiles PK the CARD navigates by.  Both are present and
  // different, so a test asserting one cannot accidentally pass on the other.
  rent_buddy_profiles: [{
    id: BUDDY_PROFILE_ID, user_id: BOB_ID, city: "Manila",
    bio: "Local guide", admin_status: "active",
  }],
  hidden_gems: [
    { id: GEM_MNL_ID, name: "Secret Beach", city: "Manila", category: "nature", save_count: 40, status: "active" },
    { id: GEM_CEB_ID, name: "Hidden Cave",  city: "Cebu",   category: "nature", save_count: 30, status: "active" },
  ],
  compass_user_profiles: [{ user_id: ALICE_ID, current_city: "Cebu", preferred_cities: [] }],
};

const FULL_RAIL_PATH = "/api/pulse/live?context=currentCity&citySlug=manila";

/** Same trips.id arrives twice in one response: as 'trip' and as 'trip_request'. */
const DUPLICATE_TRIP_RAIL: FakeState = {
  trip_members: [{ trip_id: TRIP_A_ID, user_id: ALICE_ID, role: "owner" }],
  trips: [{
    id: TRIP_A_ID, owner_id: ALICE_ID, title: "Manila Trip",
    destination_city: "Manila", start_date: in3days, end_date: in20days,
    status: "planning", visibility: "private",
  }],
  trip_join_requests: [
    { id: "7a000001-1111-4111-8111-111111111111", trip_id: TRIP_A_ID, user_id: BOB_ID, status: "pending", created_at: oneHourAgo },
  ],
};

// ── Test state ────────────────────────────────────────────────────────────────

let app: Express;
let captured: any[] = [];
let violations: string[] = [];

/** Reset capture, inject the fake, issue one request, wait for the async write. */
async function serve(
  state: FakeState,
  path: string,
  expectRows = true,
): Promise<{ body: any; rows: any[] }> {
  captured = [];
  violations = [];
  _setTestClient(makeClient(state, captured, violations), true);
  const { status, body } = await get(app, path);
  assert.equal(status, 200, "route must return 200");
  // Positive case: wait until the write lands. Negative case: wait a short
  // fixed window to catch a late write that should never happen.
  await settle(() => (expectRows ? captured.length > 0 : false), expectRows ? 1_000 : 200);
  // Every emitted row must be storable in the real table. A violation here
  // means the route built a row Postgres would reject — the whole batch would
  // be lost in production, silently, because the write is fire-and-forget.
  assert.deepEqual(violations, [], "rank_events schema violations");
  return { body, rows: captured };
}

const COMPOSITE_RE = /^[a-z_]+:/;

// ─────────────────────────────────────────────────────────────────────────────
// The validator itself must be able to say "no". Without this block the
// schema-validating fake could rot back into an accept-everything stub and
// every assertion above would quietly go vacuous again.
// ─────────────────────────────────────────────────────────────────────────────

describe("rank_events schema fake — the validator can actually reject", () => {
  const VALID = {
    user_id:      ALICE_ID,
    item_id:      EVENT_ID,
    item_kind:    "event",
    position:     0,
    outcome:      "impression",
    served_at:    "2026-01-01T00:00:00.000Z",
    surface:      "live_pulse",
    session_id:   "5e551011-1111-4111-8111-111111111111",
    event_type:   "live_pulse_serve",
    content_type: "event",
  };

  it("accepts a row shaped exactly like the Live Pulse serve row", () => {
    assert.deepEqual(validateRankEventRow(VALID), []);
  });

  it("accepts omitted DB-defaulted columns (features, id, outcome, served_at)", () => {
    const { outcome: _o, served_at: _s, ...minimal } = VALID;
    assert.deepEqual(validateRankEventRow(minimal), []);
    assert.ok(!("features" in minimal));
  });

  it("rejects a column that does not exist on rank_events", () => {
    // `item_type` is the Live Pulse field name; the DB column is content_type.
    const v = validateRankEventRow({ ...VALID, item_type: "event" });
    assert.equal(v.length, 1);
    assert.match(v[0], /unknown column "item_type"/);
    // …and a plausible-but-wrong one.
    assert.match(validateRankEventRow({ ...VALID, urgency: 3 })[0], /unknown column "urgency"/);
  });

  it("rejects item_kind outside the CHECK vocabulary", () => {
    for (const bad of ["buddy_request", "circle", "safe_return", "compass", "trip", "hidden_gem"]) {
      const v = validateRankEventRow({ ...VALID, item_kind: bad });
      assert.equal(v.length, 1, `${bad} should produce exactly one violation`);
      assert.match(v[0], /item_kind_check/);
    }
    // 'place' and 'post' are legal even though Live Pulse never emits them.
    assert.deepEqual(validateRankEventRow({ ...VALID, item_kind: "place" }), []);
  });

  it("rejects outcome outside the CHECK vocabulary", () => {
    assert.match(validateRankEventRow({ ...VALID, outcome: "served" })[0], /outcome_check/);
    assert.match(validateRankEventRow({ ...VALID, outcome: "view" })[0], /outcome_check/);
    // 'analytics' is legal at the DB level — the design rejects it for a
    // different reason (the attribution lookup hard-filters 'impression'),
    // which is a product rule, not a constraint.
    assert.deepEqual(validateRankEventRow({ ...VALID, outcome: "analytics" }), []);
  });

  it("rejects surface outside the CHECK vocabulary", () => {
    // MUTATION CAUGHT: widening SURFACE_VALUES into an accept-anything set to
    // make 'live_pulse' pass. The vocabulary must still be ENFORCED, not merely
    // widened — otherwise the fake stops modelling a CHECK constraint at all
    // and the surface assertions everywhere else go vacuous.
    //
    // The negatives below are now the near-miss spellings rather than
    // 'living_page'/'watch_feed'. Those two were the sharpest negatives until
    // migration 0202 admitted them; keeping them here after the constraint
    // widened would assert a REJECTION the database no longer performs, which
    // is the same class of lie in the opposite direction.
    assert.match(validateRankEventRow({ ...VALID, surface: "pulse_live" })[0],  /surface_check/);
    assert.match(validateRankEventRow({ ...VALID, surface: "livepulse" })[0],   /surface_check/);
    assert.match(validateRankEventRow({ ...VALID, surface: "Live_Pulse" })[0],  /surface_check/);
    assert.match(validateRankEventRow({ ...VALID, surface: "watchfeed" })[0],   /surface_check/);
    assert.match(validateRankEventRow({ ...VALID, surface: "livingpage" })[0],  /surface_check/);

    // Permitted: the ranked surfaces, Live Pulse's own (0199), and the two
    // surfaces 0202 admitted after they had been silently dropped in production.
    assert.deepEqual(validateRankEventRow({ ...VALID, surface: "discovery" }),   []);
    assert.deepEqual(validateRankEventRow({ ...VALID, surface: "pulse" }),       []);
    assert.deepEqual(validateRankEventRow({ ...VALID, surface: "live_pulse" }),  []);
    assert.deepEqual(validateRankEventRow({ ...VALID, surface: "living_page" }), []);
    assert.deepEqual(validateRankEventRow({ ...VALID, surface: "watch_feed" }),  []);

    // The fake's vocabulary must be exactly 0197's eleven values, plus 0199's
    // one, plus 0202's two. A stray addition here would grant a permission the
    // database does not.
    assert.deepEqual([...SURFACE_VALUES].sort(), [
      "compass", "discovery", "event", "events", "explore", "live_pulse",
      "living_page", "nearby", "profile", "pulse", "search", "story", "trip",
      "watch_feed",
    ]);
  });

  it("rejects NOT NULL columns that have no DB default", () => {
    for (const col of ["user_id", "item_id", "surface"]) {
      const missing: any = { ...VALID };
      delete missing[col];
      assert.match(validateRankEventRow(missing)[0], new RegExp(`NOT NULL.*no DB default`));
      const nulled = validateRankEventRow({ ...VALID, [col]: null });
      assert.ok(nulled.length >= 1, `${col}: null must be rejected`);
    }
  });

  it("rejects an explicit null in a NOT NULL column that does have a default", () => {
    assert.match(validateRankEventRow({ ...VALID, features: null })[0], /omit it to use the DB default/);
    assert.match(validateRankEventRow({ ...VALID, outcome: null })[0], /omit it to use the DB default/);
  });

  it("rejects wrong column types", () => {
    assert.match(validateRankEventRow({ ...VALID, user_id: "alice" })[0], /not a uuid/);
    assert.match(validateRankEventRow({ ...VALID, session_id: "sess-1" })[0], /not a uuid/);
    assert.match(validateRankEventRow({ ...VALID, item_id: "" })[0], /non-empty text/);
    assert.match(validateRankEventRow({ ...VALID, position: 40_000 })[0], /not a smallint/);
    assert.match(validateRankEventRow({ ...VALID, position: 1.5 })[0], /not a smallint/);
    assert.match(validateRankEventRow({ ...VALID, features: "{}" })[0], /jsonb object/);
    assert.match(validateRankEventRow({ ...VALID, served_at: "yesterday" })[0], /timestamptz/);
  });

  it("the fake's insert records violations and answers with a DB-shaped error", async () => {
    const cap: any[] = [];
    const viol: string[] = [];
    const client = makeClient({}, cap, viol) as any;
    const res = await client.from("rank_events").insert([
      { ...VALID },
      // Two independent CHECK violations on one row. NOT surface:'live_pulse'
      // any more — 0199 makes that legal, and a row that violates on only one
      // count would silently weaken the `viol.length === 2` assertion below
      // into something that passes for the wrong reason. Nor 'living_page',
      // which 0202 has since made legal for exactly the same reason; 'pulse_live'
      // is a near-miss spelling no migration will ever grant.
      { ...VALID, surface: "pulse_live", item_kind: "safe_return" },
    ]);
    assert.equal(cap.length, 2, "both rows are captured for inspection");
    assert.equal(viol.length, 2, "only the second row violates, and on two counts");
    assert.ok(viol.some((m) => /surface_check/.test(m)),   "the surface violation is reported");
    assert.ok(viol.some((m) => /item_kind_check/.test(m)), "the item_kind violation is reported");
    assert.ok(viol.every((m) => m.startsWith("rank_events row[1]:")));
    assert.ok(res.error, "a violating batch must not resolve as success");
    assert.equal(res.error.code, "23514");
  });

  it("inserts into other tables are not schema-checked (only rank_events is modelled)", async () => {
    const cap: any[] = [];
    const viol: string[] = [];
    const client = makeClient({}, cap, viol) as any;
    const res = await client.from("blocks").insert({ anything: true });
    assert.equal(res.error, null);
    assert.deepEqual(cap, []);
    assert.deepEqual(viol, []);
  });
});

describe("Live Pulse serve telemetry — rank_events rows", () => {
  before(async () => {
    app = await makeApp();
  });

  after(() => {
    _setTestClient(null, false);
  });

  // ── 1-4: included kinds use the CANONICAL entity id ────────────────────────

  it("1 — event uses item_id (events.id), not the composite id", async () => {
    // MUTATION CAUGHT: `item_id: item.id` (or `${item_type}:${item_id}`) in
    // buildLivePulseServeRows — the row would carry "event:<uuid>".
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "event");
    assert.ok(served, "fixture must actually serve an event item");
    assert.equal(served.item_id, EVENT_ID);
    assert.equal(served.id, `event:${EVENT_ID}`, "served composite id is the trap value");

    const eventRows = rows.filter((r) => r.item_kind === "event");
    assert.equal(eventRows.length, 1, `expected exactly one event row, got ${eventRows.length}`);
    assert.equal(eventRows[0].item_id, EVENT_ID);
    assert.notEqual(eventRows[0].item_id, served.id);
    assert.equal(eventRows[0].content_type, "event");
  });

  it("2 — trip maps to item_kind 'plan' and uses item_id (trips.id)", async () => {
    // MUTATION CAUGHT: mapping trip → 'trip' (not a legal item_kind: the
    // validating fake rejects it), or emitting item.id instead of item_id.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "trip");
    assert.ok(served, "fixture must actually serve a trip item");
    assert.equal(served.id, `trip:${TRIP_A_ID}`);

    const planRows = rows.filter((r) => r.item_kind === "plan");
    assert.equal(planRows.length, 1, `expected exactly one plan row, got ${planRows.length}`);
    assert.equal(planRows[0].item_id, TRIP_A_ID);
    assert.notEqual(planRows[0].item_id, served.id);
    assert.equal(planRows[0].content_type, "trip");
  });

  it("3 — buddy maps to item_kind 'buddy' and uses item_id = the buddy's user_id", async () => {
    // MUTATION CAUGHT: dropping `_rankItemId` from routes/pulse.ts, or making
    // buildLivePulseServeRows fall back to item.item_id for buddies. Either
    // writes rent_buddy_profiles.id under item_kind='buddy', a namespace the
    // ranked /pulse writer keys by user_id. The separate surface means that
    // can no longer COLLIDE with a ranked row — but it is still the wrong id,
    // and every cross-surface rollup comparing live_pulse to pulse exposure
    // would silently miss. One entity, one id, everywhere.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "available_buddy");
    assert.ok(served, "fixture must actually serve an available_buddy item");
    assert.equal(served.id, `available_buddy:${BUDDY_PROFILE_ID}`);
    assert.equal(served.item_id, BUDDY_PROFILE_ID,
      "the CARD still navigates by rent_buddy_profiles.id — that must not change");
    assert.ok(!("_rankItemId" in served), "the internal telemetry id is stripped from the response");

    const buddyRows = rows.filter((r) => r.item_kind === "buddy");
    assert.equal(buddyRows.length, 1, `expected exactly one buddy row, got ${buddyRows.length}`);
    assert.equal(buddyRows[0].item_id, BOB_ID,
      "rank_events must key buddies by user_id, like the ranked /pulse writer");
    assert.notEqual(buddyRows[0].item_id, BUDDY_PROFILE_ID,
      "the profile PK is a DIFFERENT namespace and must never be written here");
    assert.notEqual(buddyRows[0].item_id, served.id);
    // A booking PK must never be laundered into the buddy namespace either.
    assert.notEqual(buddyRows[0].item_id, BOOKING_ID);
    assert.equal(buddyRows[0].content_type, "available_buddy");
  });

  it("3b — a buddy profile with no user_id emits NO row rather than the profile id", async () => {
    // MUTATION CAUGHT: replacing the fail-closed guard with
    // `_rankItemId ?? item.item_id`. Wrong data is worse than no data.
    const noUserId: FakeState = {
      ...FULL_RAIL,
      rent_buddy_profiles: [{
        id: BUDDY_PROFILE_ID, user_id: null, city: "Manila",
        bio: "Local guide", admin_status: "active",
      }],
    };
    const { body, rows } = await serve(noUserId, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "available_buddy");
    assert.ok(served, "the card is still served to the client");
    assert.equal(served.item_id, BUDDY_PROFILE_ID);

    assert.equal(rows.filter((r) => r.item_kind === "buddy").length, 0,
      "no buddy row at all when the user_id is unavailable");
    assert.equal(rows.filter((r) => r.item_id === BUDDY_PROFILE_ID).length, 0,
      "and certainly not the profile id under a user_id namespace");
    assert.ok(rows.length > 0, "the rest of the rail is still logged");
  });

  it("4 — gem maps to item_kind 'gem' and uses item_id (hidden_gems.id)", async () => {
    // MUTATION CAUGHT: mapping hidden_gem → 'place' (silently wrong kind, and
    // the compass exclusion would stop being distinguishable), or item.id.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "hidden_gem");
    assert.ok(served, "fixture must actually serve a hidden_gem item");
    assert.equal(served.id, `hidden_gem:${GEM_MNL_ID}`);

    const gemRows = rows.filter((r) => r.item_kind === "gem");
    assert.equal(gemRows.length, 1, `expected exactly one gem row, got ${gemRows.length}`);
    assert.equal(gemRows[0].item_id, GEM_MNL_ID);
    assert.notEqual(gemRows[0].item_id, served.id);
    assert.equal(gemRows[0].content_type, "hidden_gem");
  });

  // ── 5-7: excluded types emit NOTHING ───────────────────────────────────────
  //
  // Each of these first proves the item really was served (otherwise "no row"
  // would be trivially true), then proves no row references it.

  it("5 — circle emits no attributable ranking impression", async () => {
    // MUTATION CAUGHT: adding `circle: 'plan'` to LIVE_PULSE_ITEM_KIND. The
    // circle's item_id is a trips.id, so it would collide with a real plan.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "circle");
    assert.ok(served, "fixture must actually serve a circle item");
    assert.equal(served.item_id, TRIP_B_ID);

    assert.ok(rows.length > 0, "other items must still be logged");
    assert.equal(rows.filter((r) => r.content_type === "circle").length, 0);
    assert.equal(rows.filter((r) => r.item_id === TRIP_B_ID).length, 0,
      "the circle's trips.id must not appear in rank_events");
  });

  it("6 — safe_return emits no attributable ranking impression", async () => {
    // MUTATION CAUGHT: mapping safe_return to any kind — a safety session id
    // would enter the ranking corpus and become a training signal.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "safe_return");
    assert.ok(served, "fixture must actually serve a safe_return item");
    assert.equal(served.item_id, SAFE_RETURN_ID);

    assert.ok(rows.length > 0, "other items must still be logged");
    assert.equal(rows.filter((r) => r.content_type === "safe_return").length, 0);
    assert.equal(rows.filter((r) => r.item_id === SAFE_RETURN_ID).length, 0,
      "safety session ids must never enter the ranking corpus");
  });

  it("7 — compass emits no attributable ranking impression", async () => {
    // MUTATION CAUGHT: adding `compass: 'gem'`. Its item_id IS a real
    // hidden_gems.id, so nothing about the value itself would look wrong —
    // only the per-type exclusion catches it.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "compass");
    assert.ok(served, "fixture must actually serve a compass item");
    assert.equal(served.item_id, GEM_CEB_ID);

    assert.ok(rows.length > 0, "other items must still be logged");
    assert.equal(rows.filter((r) => r.content_type === "compass").length, 0);
    assert.equal(rows.filter((r) => r.item_id === GEM_CEB_ID).length, 0,
      "compass picks are excluded even though they carry a real hidden_gems.id");
  });

  // ── 8: the composite id can never reach rank_events.item_id ────────────────

  it("8 — composite ids like \"event:<uuid>\" can NEVER reach rank_events.item_id", async () => {
    // MUTATION CAUGHT: swapping item_id → item.id anywhere on the path. The
    // assertion is the NEGATIVE (no emitted item_id matches /^[a-z_]+:/), so
    // it fails on any composite leak, for any item type, present or future.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const servedItems = body.items as any[];
    // Non-vacuity guard 1: the response really does carry composite ids, so the
    // negative assertions below are testing something that could go wrong.
    assert.ok(servedItems.length > 0, "response must contain items");
    for (const i of servedItems) {
      assert.match(i.id, COMPOSITE_RE, `served id ${i.id} should be composite`);
      assert.equal(i.id, `${i.item_type}:${i.item_id}`);
    }
    // Non-vacuity guard 2: rows were actually written.
    assert.ok(rows.length >= 4, `expected >= 4 emitted rows, got ${rows.length}`);

    const compositeIds = new Set(servedItems.map((i) => i.id));
    for (const r of rows) {
      assert.doesNotMatch(
        String(r.item_id), COMPOSITE_RE,
        `item_id ${r.item_id} has the composite shape "<type>:<id>"`,
      );
      assert.ok(!String(r.item_id).includes(":"), `item_id ${r.item_id} must not contain ':'`);
      assert.ok(!compositeIds.has(r.item_id),
        `item_id ${r.item_id} equals a served presentation id — item.id leaked into item_id`);
      assert.match(String(r.item_id), UUID_RE, "every emitted item_id is a bare entity uuid");
    }
    // And every emitted item_id is a real canonical entity id from the fixture.
    // BOB_ID (not BUDDY_PROFILE_ID) is the buddy's canonical rank_events id.
    const canonical = new Set([EVENT_ID, TRIP_A_ID, BOB_ID, GEM_MNL_ID]);
    for (const r of rows) {
      assert.ok(canonical.has(r.item_id), `unexpected item_id ${r.item_id}`);
    }
    assert.equal(new Set(rows.map((r) => r.item_id)).size, canonical.size,
      "every canonical id in the fixture is represented exactly once");
  });

  // ── 9: duplicate entities in one response ──────────────────────────────────

  it("9 — duplicate entities inside one server response cannot produce duplicate impressions", async () => {
    // MUTATION CAUGHT: deleting the `emitted` Set in buildLivePulseServeRows,
    // or keying it on `${item_type}:${item_id}` instead of
    // `${item_kind}:${item_id}` — trip and trip_request both map to 'plan',
    // so a type-keyed dedup would let two rows through and make the
    // "most recent impression for user+item" attribution lookup a coin flip.
    const { body, rows } = await serve(DUPLICATE_TRIP_RAIL, "/api/pulse/live?context=myPlans");

    // Non-vacuity: the SAME trips.id is served twice, under two item_types.
    const servedForTrip = (body.items as any[]).filter((i) => i.item_id === TRIP_A_ID);
    assert.equal(servedForTrip.length, 2,
      `fixture must serve the same trips.id twice, got ${servedForTrip.length}`);
    const servedTypes = servedForTrip.map((i) => i.item_type).sort();
    assert.deepEqual(servedTypes, ["trip", "trip_request"]);
    // Their composite ids differ, which is exactly why addItem() does not dedup them.
    assert.equal(new Set(servedForTrip.map((i) => i.id)).size, 2);

    // …but only ONE rank_events row exists for that entity.
    assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
    assert.equal(rows[0].item_id, TRIP_A_ID);
    assert.equal(rows[0].item_kind, "plan");
    // First occurrence wins — trip_request is urgency 3, so it sorts first.
    assert.equal(rows[0].content_type, "trip_request");
    assert.equal(rows[0].position, 0);

    const keys = rows.map((r) => `${r.item_kind}:${r.item_id}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate (item_kind, item_id) pairs");
  });

  // ── Supporting invariants ──────────────────────────────────────────────────

  it("buddy_request (a buddy_bookings PK) is deliberately excluded", async () => {
    // MUTATION CAUGHT: adding `buddy_request: 'buddy'`. Booking PKs would be
    // written into the buddy namespace, asserting an impression of a person
    // the rail never recommended.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    const served = (body.items as any[]).find((i) => i.item_type === "buddy_request");
    assert.ok(served, "fixture must actually serve a buddy_request item");
    assert.equal(served.item_id, BOOKING_ID);

    assert.equal(rows.filter((r) => r.item_id === BOOKING_ID).length, 0,
      "booking PKs must not be written under item_kind='buddy'");
    assert.equal(rows.filter((r) => r.content_type === "buddy_request").length, 0);
  });

  it("no fabricated ranker features — rows omit `features` entirely", async () => {
    // MUTATION CAUGHT: adding `features: {}` or any synthetic vector. The
    // column is NOT NULL DEFAULT '{}', so omission is both correct and the
    // only way to signal "this row was never scored".
    const { rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(!("features" in r),
        "features must be absent so the DB default '{}' applies — never a synthetic vector");
    }
  });

  it("SURFACE — every emitted row carries surface='live_pulse', NEVER 'pulse'", async () => {
    // MUTATION CAUGHT: reverting `surface: "live_pulse"` to `"pulse"` in
    // lib/rankLog.ts (either the LivePulseServeRow field type at the interface
    // or the `as const` in buildLivePulseServeRows).
    //
    // This is the whole point of the re-cut, so it gets its own test rather
    // than riding along in the general shape assertion below. A revert puts
    // these rows back into the ranked /pulse key space with the same canonical
    // entity ids, where the attribution lookup in routes/rankEvents.ts —
    //   .eq(user_id).eq(item_id).eq(surface).eq(outcome,'impression')
    //   .order(served_at, desc).limit(1)
    // — resolves to the MOST RECENT row. Live Pulse is polled continuously, so
    // its row is almost always the most recent one, and it silently steals the
    // outcome belonging to a genuine ranked impression. session_id does not
    // save this: that filter is applied only when the client sends one, so a
    // null sessionId re-opens the hijack permanently.
    const { rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);

    // Non-vacuity: the same fixture also produces the ids a ranked /pulse row
    // would carry, so "no collision" is a claim about the surface alone.
    assert.ok(rows.length >= 4, `expected >= 4 emitted rows, got ${rows.length}`);

    for (const r of rows) {
      assert.equal(r.surface, "live_pulse",
        "Live Pulse serve rows belong to their own surface key space");
      assert.notEqual(r.surface, "pulse",
        "surface='pulse' is the ranked writer's key space — the hijack this re-cut closes");
    }
    assert.equal(new Set(rows.map((r) => r.surface)).size, 1,
      "one response must not straddle two surfaces");

    // The surface is a real value the live CHECK grants, not a free-text label:
    // migration 0199 is what makes it storable, and the validating fake models
    // that constraint (serve() already asserted zero violations).
    assert.ok(SURFACE_VALUES.has("live_pulse"));
    assert.ok(!SURFACE_VALUES.has("pulse_live"),
      "the fake still rejects surfaces no migration has granted");
  });

  it("every row is outcome='impression' + event_type='live_pulse_serve'", async () => {
    // MUTATION CAUGHT: outcome='analytics' (the attribution lookup hard-filters
    // 'impression', so outcomes would 404), or dropping event_type (the rows
    // lose the provenance marker that lets a consumer fitting ranker weights
    // select the ranked corpus with `event_type IS NULL`).
    const { rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      // outcome='impression' is what makes the row reachable at all by the
      // attribution lookup in routes/rankEvents.ts; the surface decides WHICH
      // key space it is reachable in (see the dedicated surface test above).
      assert.equal(r.outcome, "impression");
      assert.equal(r.surface, "live_pulse");
      assert.equal(r.event_type, "live_pulse_serve");
      assert.equal(r.user_id, ALICE_ID);
      assert.equal(typeof r.served_at, "string");
      assert.ok(!("outcome_at" in r), "outcome_at is set later by the outcome route, not here");
      // event_type must NOT look like a RankingEvent member: a registered test
      // (ranking-explanation-analytics.test.ts) asserts every RankingEvent
      // value starts with "ranking_", and these rows are not ranker events.
      assert.ok(!String(r.event_type).startsWith("ranking_"),
        "live_pulse_serve must never be renamed into the ranking_* namespace");
    }
    // One session id and one served_at shared by the whole serve.
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 1);
    assert.equal(new Set(rows.map((r) => r.served_at)).size, 1);
  });

  it("position is the served index, with gaps left by excluded items", async () => {
    // MUTATION CAUGHT: re-indexing positions over emitted rows only (a `let
    // n = 0; position: n++`), which would silently misreport where the viewer
    // saw each item and shift rows into/out of the `position % 7 === 6`
    // exploration bucket.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);
    const served = body.items as any[];

    // Every row points back at the item that actually occupied that slot.
    // The link is content_type (the raw LivePulseItemType), not item_id:
    // for available_buddy the row's item_id is the buddy's user_id while the
    // served card's item_id is the profile id — different namespaces on
    // purpose (see test 3).
    for (const r of rows) {
      const at = served[r.position];
      assert.ok(at, `position ${r.position} out of range (served ${served.length})`);
      assert.equal(at.item_type, r.content_type,
        `row at position ${r.position} should describe the item served there`);
      if (r.item_kind === "buddy") {
        assert.equal(at.item_id, BUDDY_PROFILE_ID);
        assert.equal(r.item_id, BOB_ID);
      } else {
        assert.equal(at.item_id, r.item_id);
      }
    }

    // Positions are NOT re-indexed: slot 0 is safe_return, which emits nothing.
    assert.equal(served[0].item_type, "safe_return");
    assert.ok(!rows.some((r) => r.position === 0),
      "excluded lead item must leave a gap at position 0");
    assert.ok(rows.length < served.length, "some served items are excluded");
    // Positions are strictly increasing — emitted in served order.
    const positions = rows.map((r) => r.position);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  it("the response returns the sessionId used for the serve rows", async () => {
    // MUTATION CAUGHT: dropping `sessionId` from the res.json() payload, or
    // minting a second UUID for the response that differs from the one written
    // to the rows. Either leaves the client unable to narrow its outcome report
    // to the exact serve it acted on.
    //
    // NOTE ON WHAT THIS IS FOR, post-re-cut: session_id is precision, NOT the
    // mechanism that prevents the cross-surface hijack — the separate surface
    // is. routes/rankEvents.ts applies `.eq("session_id")` only when the client
    // sends one, so a null sessionId must never be able to cause WRONG
    // attribution; it may only cost the ability to distinguish one Live Pulse
    // poll from another within the live_pulse surface. Keep this test: without
    // it, dropping the plumbing would be invisible.
    const { body, rows } = await serve(FULL_RAIL, FULL_RAIL_PATH);
    assert.equal(typeof body.sessionId, "string");
    assert.match(body.sessionId, UUID_RE);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.session_id, body.sessionId,
        "the client must be able to send back the same session_id for attribution");
    }
  });

  it("each /pulse/live response mints a fresh sessionId", async () => {
    // MUTATION CAUGHT: hoisting the randomUUID() call to module scope, which
    // would make every poll share one session id and re-collapse the
    // disambiguation the sessionId exists to provide.
    const first  = await serve(FULL_RAIL, FULL_RAIL_PATH);
    const second = await serve(FULL_RAIL, FULL_RAIL_PATH);
    assert.match(first.body.sessionId, UUID_RE);
    assert.match(second.body.sessionId, UUID_RE);
    assert.notEqual(first.body.sessionId, second.body.sessionId);
  });

  it("a response with only excluded items writes nothing at all", async () => {
    // MUTATION CAUGHT: removing the `rows.length === 0` early return in
    // logLivePulseServe, which would issue an empty insert on every poll.
    const onlyExcluded: FakeState = {
      feature_flags: [{ flag: "safe_return_enabled", enabled: true }],
      safe_return_sessions: [{
        id: SAFE_RETURN_ID, user_id: ALICE_ID, status: "active",
        timer_end_at: in45min, trip_id: null, escalation_level: 0,
      }],
    };
    const { body, rows } = await serve(onlyExcluded, "/api/pulse/live?context=myPlans", false);
    assert.equal((body.items as any[]).length, 1);
    assert.equal(body.items[0].item_type, "safe_return");
    assert.equal(rows.length, 0, "no rank_events insert for an all-excluded response");
    // The sessionId is still returned — the client may need it for a later poll.
    assert.match(body.sessionId, UUID_RE);
  });
});

// ── Pure mapping / builder unit tests ─────────────────────────────────────────

describe("livePulseItemKind — pure mapping", () => {
  it("maps the five included item_types to the four permitted item_kind values", () => {
    assert.equal(livePulseItemKind("event"), "event");
    assert.equal(livePulseItemKind("trip"), "plan");
    assert.equal(livePulseItemKind("trip_request"), "plan");
    assert.equal(livePulseItemKind("available_buddy"), "buddy");
    assert.equal(livePulseItemKind("hidden_gem"), "gem");

    for (const t of ["event", "trip", "trip_request", "available_buddy", "hidden_gem"]) {
      assert.ok(ITEM_KIND_VALUES.has(livePulseItemKind(t) as string),
        `${t} → ${livePulseItemKind(t)} is outside the rank_events CHECK vocabulary`);
    }
  });

  it("returns null for every excluded item_type", () => {
    for (const t of ["circle", "safe_return", "compass", "buddy_request"]) {
      assert.equal(livePulseItemKind(t), null, `${t} must be excluded`);
    }
  });

  it("fails closed on an unknown / newly added item_type", () => {
    assert.equal(livePulseItemKind("living_page"), null);
    assert.equal(livePulseItemKind("some_future_type"), null);
    assert.equal(livePulseItemKind(""), null);
    // Prototype keys must not leak through the Record lookup.
    assert.equal(livePulseItemKind("toString"), null);
    assert.equal(livePulseItemKind("constructor"), null);
  });
});

describe("buildLivePulseServeRows — pure row builder", () => {
  const SERVED_AT = "2026-01-01T00:00:00.000Z";
  const SESSION   = "5e551011-1111-4111-8111-111111111111";

  /** Every builder output must also be storable, not merely well-shaped. */
  function assertStorable(rows: any[]): void {
    const all: string[] = [];
    rows.forEach((r, i) => {
      for (const m of validateRankEventRow(r)) all.push(`row[${i}]: ${m}`);
    });
    assert.deepEqual(all, [], "builder produced a row rank_events would reject");
  }

  it("reads item_id and never item.id, even when the two disagree", () => {
    // MUTATION CAUGHT: `item_id: item.id`.
    const rows = buildLivePulseServeRows(
      [
        // `id` is deliberately a DIFFERENT, wrong value: if the implementation
        // ever reads item.id this assertion fails loudly.
        { id: "event:WRONG-COMPOSITE", item_type: "event", item_id: EVENT_ID },
        { id: "trip:WRONG-COMPOSITE",  item_type: "trip",  item_id: TRIP_A_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.deepEqual(rows.map((r) => r.item_id), [EVENT_ID, TRIP_A_ID]);
    for (const r of rows) {
      assert.doesNotMatch(r.item_id, COMPOSITE_RE);
      assert.ok(!r.item_id.includes("WRONG"));
    }
  });

  it("emits nothing for excluded types and keeps the served index as position", () => {
    // MUTATION CAUGHT: re-indexed positions, or any excluded type gaining a
    // mapping. Note available_buddy carries _rankItemId — see the next test
    // for what happens without it.
    const rows = buildLivePulseServeRows(
      [
        { item_type: "safe_return",     item_id: SAFE_RETURN_ID },                              // 0 — skip
        { item_type: "event",           item_id: EVENT_ID },                                    // 1 — keep
        { item_type: "buddy_request",   item_id: BOOKING_ID },                                  // 2 — skip
        { item_type: "circle",          item_id: TRIP_B_ID },                                   // 3 — skip
        { item_type: "available_buddy", item_id: BUDDY_PROFILE_ID, _rankItemId: BOB_ID },       // 4 — keep
        { item_type: "compass",         item_id: GEM_CEB_ID },                                  // 5 — skip
        { item_type: "hidden_gem",      item_id: GEM_MNL_ID },                                  // 6 — keep
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.deepEqual(rows.map((r) => r.position), [1, 4, 6], "positions must not be re-indexed");
    assert.deepEqual(rows.map((r) => r.item_kind), ["event", "buddy", "gem"]);
    assert.deepEqual(rows.map((r) => r.item_id), [EVENT_ID, BOB_ID, GEM_MNL_ID]);
    assert.deepEqual(rows.map((r) => r.content_type),
      ["event", "available_buddy", "hidden_gem"]);
  });

  it("a buddy WITHOUT _rankItemId emits no row (fail closed on namespace)", () => {
    // MUTATION CAUGHT: deleting RANK_ID_REQUIRED_KINDS, or replacing the guard
    // with a fallback to item.item_id. The profile id would then be written
    // under the user_id-keyed 'buddy' namespace.
    const rows = buildLivePulseServeRows(
      [
        { item_type: "available_buddy", item_id: BUDDY_PROFILE_ID },                 // 0 — dropped
        { item_type: "available_buddy", item_id: BUDDY_PROFILE_ID, _rankItemId: "" }, // 1 — dropped
        { item_type: "available_buddy", item_id: "x", _rankItemId: null },            // 2 — dropped
        { item_type: "event",           item_id: EVENT_ID },                          // 3 — kept
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.equal(rows.length, 1, "only the event survives");
    assert.equal(rows[0].item_kind, "event");
    assert.equal(rows.filter((r) => r.item_id === BUDDY_PROFILE_ID).length, 0);
  });

  it("_rankItemId is honoured only where it is supplied, never applied blindly", () => {
    // MUTATION CAUGHT: reading item.item_id unconditionally (ignoring the
    // override), or reading _rankItemId unconditionally (which would break
    // every non-buddy kind the moment one is added).
    const rows = buildLivePulseServeRows(
      [
        { item_type: "event",           item_id: EVENT_ID },
        { item_type: "available_buddy", item_id: BUDDY_PROFILE_ID, _rankItemId: BOB_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.deepEqual(rows.map((r) => r.item_id), [EVENT_ID, BOB_ID]);
  });

  it("collapses a duplicate entity to one row, keeping the first (highest-urgency) slot", () => {
    // MUTATION CAUGHT: removing the dedup Set — two 'plan' rows for the same
    // trips.id in one batch make the attribution lookup nondeterministic.
    const rows = buildLivePulseServeRows(
      [
        { item_type: "trip_request", item_id: TRIP_A_ID },
        { item_type: "trip",         item_id: TRIP_A_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].position, 0);
    assert.equal(rows[0].item_kind, "plan");
    assert.equal(rows[0].content_type, "trip_request");
  });

  it("does not collapse different entities that share a kind", () => {
    // MUTATION CAUGHT: over-eager dedup keyed on item_kind alone.
    const rows = buildLivePulseServeRows(
      [
        { item_type: "trip",         item_id: TRIP_A_ID },
        { item_type: "trip_request", item_id: TRIP_B_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.item_id), [TRIP_A_ID, TRIP_B_ID]);
  });

  it("writes no features key and stamps the shared session/served_at", () => {
    // MUTATION CAUGHT: fabricating features, or stamping per-row timestamps /
    // session ids instead of the shared ones.
    const rows = buildLivePulseServeRows(
      [{ item_type: "event", item_id: EVENT_ID }, { item_type: "trip", item_id: TRIP_A_ID }],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(!("features" in r), "no fabricated feature vector");
      assert.equal(r.outcome, "impression");
      assert.equal(r.surface, "live_pulse");
      assert.equal(r.event_type, "live_pulse_serve");
      assert.equal(r.session_id, SESSION);
      assert.equal(r.served_at, SERVED_AT);
      assert.equal(r.user_id, ALICE_ID);
    }
  });

  it("SURFACE — stamps 'live_pulse' on every row, for every included kind", () => {
    // MUTATION CAUGHT: `surface: "pulse" as const` in buildLivePulseServeRows,
    // or the LivePulseServeRow interface field reverting to "pulse".
    //
    // The end-to-end test asserts the same invariant through the route; this
    // one pins it at the builder so the failure names the exact line, and so a
    // partial revert (one kind put back on 'pulse') cannot hide behind the
    // route fixture's item mix.
    const rows = buildLivePulseServeRows(
      [
        { item_type: "event",           item_id: EVENT_ID },
        { item_type: "trip",            item_id: TRIP_A_ID },
        { item_type: "available_buddy", item_id: BUDDY_PROFILE_ID, _rankItemId: BOB_ID },
        { item_type: "hidden_gem",      item_id: GEM_MNL_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    // Non-vacuity: all four included kinds are present, so "every row" is a
    // claim about four different code paths, not one.
    assert.deepEqual(rows.map((r) => r.item_kind), ["event", "plan", "buddy", "gem"]);
    assert.deepEqual(rows.map((r) => r.surface),
      ["live_pulse", "live_pulse", "live_pulse", "live_pulse"]);
    for (const r of rows) {
      assert.notEqual(r.surface, "pulse",
        "reverting to the ranked writer's surface re-opens the outcome hijack");
    }
    // …and 'live_pulse' is storable only because 0199 grants it. If someone
    // reverts the migration but not the code, this is the state production
    // lands in — every row silently rejected, which is exactly where
    // 'living_page' and 'watch_feed' sat until 0202 admitted them.
    assert.deepEqual(validateRankEventRow({ ...rows[0] }), []);
    assert.match(
      validateRankEventRow({ ...rows[0], surface: "pulse_live" })[0],
      /surface_check/,
    );
  });

  it("emits only columns that exist on rank_events", () => {
    // MUTATION CAUGHT: leaking an internal field (item_type, _urgency,
    // _rankItemId, urgency) into the row. PostgREST rejects the WHOLE batch on
    // one unknown column, so a leak would silently lose all Live Pulse
    // telemetry rather than just one field.
    const rows = buildLivePulseServeRows(
      [
        { id: `event:${EVENT_ID}`, item_type: "event", item_id: EVENT_ID },
        { id: `available_buddy:${BUDDY_PROFILE_ID}`, item_type: "available_buddy",
          item_id: BUDDY_PROFILE_ID, _rankItemId: BOB_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assertStorable(rows);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      for (const key of Object.keys(r)) {
        assert.ok(RANK_EVENTS_COLUMNS.has(key), `"${key}" is not a rank_events column`);
      }
      assert.ok(!("item_type" in r), "item_type is a Live Pulse field, not a DB column");
      assert.ok(!("_rankItemId" in r), "internal override must not be written");
      assert.ok(!("id" in r), "the PK is DB-generated; never send the composite presentation id");
    }
  });

  it("returns an empty array when every item is excluded", () => {
    const rows = buildLivePulseServeRows(
      [
        { item_type: "safe_return", item_id: SAFE_RETURN_ID },
        { item_type: "circle",      item_id: TRIP_B_ID },
        { item_type: "compass",     item_id: GEM_CEB_ID },
      ],
      ALICE_ID, SESSION, SERVED_AT,
    );
    assert.deepEqual(rows, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// routes/adminRankingMetrics.ts — the Live Pulse exclusion
//
//   const nonLivePulse = all.filter((r) => r.surface !== "live_pulse");
//
// WHY THE FILTER SURVIVES THE SURFACE SPLIT — AND WHERE IT DELIBERATELY STOPS.
//
// It is tempting to think that giving Live Pulse its own surface makes this
// redundant. It does not, for five of the six computations fed from these rows:
// totals, tap_through_by_kind, the exploration-slot bucket, both diversity
// concentration ratios and new_user_exposure_rate have NO surface dimension and
// aggregate every surface into one number. Without the explicit exclusion, Live
// Pulse serves still inflate totals.impressions, depress the tap-through rate
// of every kind they touch, land in the `position % 7 === 6` exploration bucket
// (Live Pulse `position` is a plain urgency index, not an exploration slot),
// skew both concentration ratios, and count as new-user ranker exposure.
//
// `by_surface` is the SIXTH, and the exclusion deliberately does NOT apply to
// it. It is the only computation keyed by surface, so it is the only place the
// new surface value can be seen at all — and being seen and separable is the
// entire reason the value exists. Applying the exclusion there would pay for a
// distinct key space and then hide the result, leaving Live Pulse volume
// unobservable and a collapse of the rail indistinguishable from a quiet day.
// Its own test pins both halves: live_pulse appears with its own counts, and
// 'pulse' is unchanged at 1/1 (before the split those rows inflated 'pulse' to
// 4 impressions — visibility must not cost separability).
//
// WHY IT IS SCOPED TO SURFACE AND NOT `event_type == null`. Two reasons, each
// with its own test below:
//   1. The route selects "outcome, item_kind, position, surface, user_id,
//      served_at" — event_type is NOT selected. So in production every row
//      arrives with event_type undefined and an `event_type == null` filter is
//      a silent no-op that excludes nothing. The fixture for
//      "rows arrive exactly as the route selects them" reproduces that.
//   2. `event_type == null` also dropped every OTHER provenance-tagged row,
//      notably the 'watch_impression' rows written by routes/mediaFeed.ts —
//      a behaviour change unrelated to Live Pulse. Pinned by "a provenance-
//      tagged row that is not Live Pulse is still counted".
//
// One computation deliberately keeps using `all` (returning-user recovery, an
// activity signal); that exception is pinned too, so "fix" it and this fails.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID       = "ad000001-1111-4111-8111-111111111111";
const RANKED_VIEWER  = "cc000001-1111-4111-8111-111111111111";
const LIVEPULSE_ONLY = "cc000002-2222-4222-8222-222222222222";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Window rows (default `days=7`, so cutoff is 7 days ago):
 *   2 RANKED rows     (surface 'pulse'):      1 impression + 1 tap, kind 'event',
 *                                             positions 0 and 1
 *   3 LIVE PULSE rows (surface 'live_pulse'): impressions, kinds 'gem'/'plan',
 *                                             position 6 (the exploration slot)
 * Pre-window (15 days ago): one row for RANKED_VIEWER only, so LIVEPULSE_ONLY
 * counts as a "returning" viewer.
 *
 * The Live Pulse rows sit at position 6 and carry kinds the ranked rows do not,
 * so every one of the five FILTERED computations has a distinct observable
 * signature: unfiltered this fixture reports impressions=4, tap_through_rate
 * =0.25, exploration_slot.impressions=3, 'gem'+'plan' entries in
 * tap_through_by_kind, category_concentration=0.5 and new_user_exposure_rate=1.
 * Filtered, every one of those changes.
 *
 * `by_surface` is the UNFILTERED sixth and reports both buckets from the same
 * fixture — pulse {1,1} and live_pulse {3,0}. Its numbers are the ones that must
 * NOT change when the filter is applied elsewhere.
 *
 * `event_type` is carried here as provenance documentation only. It is NOT what
 * the route filters on, and the route does not even select the column — see
 * ROUTE_SELECTED_ROWS below, which reproduces production's actual row shape.
 */
const ADMIN_RANK_EVENTS: any[] = [
  { outcome: "impression", item_kind: "event", position: 0, surface: "pulse",
    user_id: RANKED_VIEWER, served_at: daysAgo(2), event_type: null },
  { outcome: "tap",        item_kind: "event", position: 1, surface: "pulse",
    user_id: RANKED_VIEWER, served_at: daysAgo(2), event_type: null },

  { outcome: "impression", item_kind: "gem",   position: 6, surface: "live_pulse",
    user_id: LIVEPULSE_ONLY, served_at: daysAgo(2), event_type: "live_pulse_serve" },
  { outcome: "impression", item_kind: "gem",   position: 6, surface: "live_pulse",
    user_id: LIVEPULSE_ONLY, served_at: daysAgo(2), event_type: "live_pulse_serve" },
  { outcome: "impression", item_kind: "plan",  position: 6, surface: "live_pulse",
    user_id: LIVEPULSE_ONLY, served_at: daysAgo(2), event_type: "live_pulse_serve" },

  // Pre-window: excluded from the main query by .gte("served_at", cutoff),
  // and included in the pre-window query by .gte(cutoffPreWindow).lt(cutoff).
  { outcome: "impression", item_kind: "event", position: 0, surface: "discovery",
    user_id: RANKED_VIEWER, served_at: daysAgo(15), event_type: null },
];

/**
 * The SAME window rows as the route actually receives them.
 *
 * adminRankingMetrics.ts selects "outcome, item_kind, position, surface,
 * user_id, served_at" — `event_type` is not in that list, so PostgREST never
 * returns it and `r.event_type` is `undefined` on every row in production.
 * That makes an `event_type == null` filter a no-op which excludes NOTHING,
 * while the fixture above (which carries event_type for documentation) would
 * let such a revert keep passing. This fixture removes that escape hatch.
 */
const ROUTE_SELECTED_ROWS: any[] = ADMIN_RANK_EVENTS.map(
  ({ event_type: _dropped, ...selected }) => selected,
);

const ADMIN_PROFILES: any[] = [
  { id: ADMIN_ID,       role: "admin",  account_status: "active", created_at: daysAgo(60) },
  { id: RANKED_VIEWER,  role: "member", account_status: "active", created_at: daysAgo(60) },
  // Joined 5 days ago → inside the 14-day new-user window.
  { id: LIVEPULSE_ONLY, role: "member", account_status: "active", created_at: daysAgo(5) },
];

/** Minimal builder with working gte/lt/eq/in — the metrics route needs real ranges. */
function makeAdminClient(rankEvents: any[] = ADMIN_RANK_EVENTS) {
  const tables: Record<string, any[]> = {
    rank_events:                 rankEvents,
    profiles:                    ADMIN_PROFILES,
    creator_activity_scores:     [],
    content_distribution_stats:  [],
    feature_flags:               [],
    job_health:                  [],
  };

  function builder(rows: any[]) {
    let filtered = rows.map((r) => ({ ...r }));
    const b: any = {
      select: (_c?: string, _o?: any) => b,
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      // The metrics route excludes ranking-analytics rows with
      // .neq("outcome","analytics"). Without this the builder threw
      // "neq is not a function", the route 500'd, and all ten tests in this
      // suite failed at once — a fixture gap that is indistinguishable from a
      // real regression until you read the stack.
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      gte: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] != null && r[col] >= val); return b; },
      lt:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] != null && r[col] <  val); return b; },
      order: (_c: string, _o?: any) => b,
      limit: (_n: number) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: filtered, error: null }).then(resolve),
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === "valid-token"
          ? { data: { user: { id: ADMIN_ID } }, error: null }
          : { data: null, error: { message: "invalid" } },
    },
    from: (table: string) => builder(tables[table] ?? []),
  };
}

async function getMetrics(): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use("/api", adminRankingMetricsRouter);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/ranking/metrics`, {
      headers: { Authorization: "Bearer valid-token" },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("GET /admin/ranking/metrics — Live Pulse serves are excluded from ranker metrics", () => {
  after(() => {
    _setTestClient(null, false);
  });

  it("totals exclude Live Pulse serves", async () => {
    // MUTATION CAUGHT: `for (const r of all)` in the totals loop — impressions
    // would be 4, not 1, and every derived rate would be diluted.
    _setTestClient(makeAdminClient(), true);
    const { status, body } = await getMetrics();
    assert.equal(status, 200);
    assert.equal(body.impressions, 1, "3 surface='live_pulse' impressions must not be counted");
    assert.equal(body.taps, 1);
    assert.equal(body.tap_through_rate, 1, "1 tap / 1 ranked impression");
    assert.equal(body.realized_connection_rate, 0);
  });

  it("tap_through_by_kind has no entry for a kind only Live Pulse produced", async () => {
    // MUTATION CAUGHT: `for (const r of all)` in the by-kind loop — 'gem' and
    // 'plan' buckets would appear with 0% tap-through and drag the dashboard.
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.deepEqual(Object.keys(body.tap_through_by_kind).sort(), ["event"]);
    assert.deepEqual(body.tap_through_by_kind.event, { impressions: 1, taps: 1, rate: 1 });
  });

  it("the exploration slot is not polluted by Live Pulse positions", async () => {
    // MUTATION CAUGHT: `all.filter(... position % 7 === 6)`. Live Pulse
    // positions are urgency indices, not exploration slots; three of them sit
    // at position 6 and would be read as exploration impressions with 0 taps.
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.deepEqual(body.exploration_slot, { impressions: 0, taps: 0, rate: 0 });
  });

  it("by_surface SHOWS live_pulse in its own bucket, separate from the ranked surface", async () => {
    // MUTATION CAUGHT: swapping this one loop to `nonLivePulse` like its five
    // neighbours. That is a natural-looking "consistency" edit and it destroys
    // the deliverable: `by_surface` is the only computation on this endpoint
    // with a surface dimension, so it is the only place the new surface value
    // can be observed at all. Filtered, Live Pulse volume becomes invisible and
    // a total collapse of the rail is indistinguishable from normal operation.
    //
    // Note the two claims are independent and both matter:
    //   - live_pulse APPEARS, with its own counts (3 impressions, 0 taps)
    //   - 'pulse' is UNCHANGED at 1/1 — separability, not just visibility.
    // Before the surface split these rows carried surface='pulse' and inflated
    // that bucket to 4 impressions with a collapsed tap rate. The whole point of
    // a distinct key space is that showing one no longer corrupts the other.
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.deepEqual(body.by_surface, {
      pulse:      { impressions: 1, taps: 1 },
      live_pulse: { impressions: 3, taps: 0 },
    });
  });

  it("diversity uses ranked impressions only", async () => {
    // MUTATION CAUGHT: `all.filter(r => r.outcome === "impression")` for
    // impRows. With Live Pulse rows included the top kind share would be
    // 2/4 = 0.5 instead of 1.
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.equal(body.diversity.category_concentration, 1);
    assert.equal(body.diversity.city_concentration, 1);
  });

  it("new_user_exposure_rate does not credit a Live Pulse serve as ranker exposure", async () => {
    // MUTATION CAUGHT: `all.filter(...)` in the new-user block. LIVEPULSE_ONLY
    // is the only new user and every one of its rows is surface='live_pulse',
    // so the unfiltered version reports 1.0 — "every new user is being reached
    // by the ranker" — which is exactly false.
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.equal(body.new_user_exposure_rate, 0);
  });

  it("returning_user_recovery_rate DELIBERATELY still uses all rows", async () => {
    // MUTATION CAUGHT: "tidying up" the last `all` into `nonLivePulse`. This
    // metric measures whether a returning viewer was reached at all; a Live
    // Pulse serve is genuine activity, and the pre-window query it is compared
    // against is likewise unfiltered. LIVEPULSE_ONLY has no pre-window row and
    // one in-window surface='live_pulse' impression → it counts as recovered.
    // Under the mutation it has no in-window row left, so returningIds is
    // empty, the `if (returningIds.length > 0)` block never runs, and the rate
    // reports a flat 0 — indistinguishable from "nobody came back".
    _setTestClient(makeAdminClient(), true);
    const { body } = await getMetrics();
    assert.equal(body.returning_user_recovery_rate, 1);
  });

  it("the exclusion survives the route's own column selection (event_type is NOT selected)", async () => {
    // MUTATION CAUGHT: reverting the filter to `all.filter(r => r.event_type == null)`.
    //
    // This is the one mutation the main fixture CANNOT catch, and it is the
    // most likely one — it is what the code said before the re-cut. The route
    // selects "outcome, item_kind, position, surface, user_id, served_at", so
    // PostgREST never returns event_type and `r.event_type` is `undefined` on
    // every row in production. `undefined == null` is true, so that filter
    // excludes NOTHING and all five filtered metrics silently go back to
    // counting Live Pulse serves — while the dashboard keeps rendering and
    // nothing alerts.
    //
    // These rows are byte-identical to ADMIN_RANK_EVENTS minus event_type, so
    // the assertions here must match the filtered numbers exactly.
    _setTestClient(makeAdminClient(ROUTE_SELECTED_ROWS), true);
    const { status, body } = await getMetrics();
    assert.equal(status, 200);
    // Non-vacuity: the fixture really does lack the column the old filter read.
    for (const r of ROUTE_SELECTED_ROWS) {
      assert.ok(!("event_type" in r), "the route never selects event_type");
    }
    assert.equal(body.impressions, 1, "surface is what excludes them, not event_type");
    assert.equal(body.taps, 1);
    assert.deepEqual(body.exploration_slot, { impressions: 0, taps: 0, rate: 0 });
    // by_surface is the one computation that intentionally keeps every row, so
    // it is unaffected by which predicate the other five use.
    assert.deepEqual(body.by_surface, {
      pulse:      { impressions: 1, taps: 1 },
      live_pulse: { impressions: 3, taps: 0 },
    });
    assert.deepEqual(Object.keys(body.tap_through_by_kind).sort(), ["event"]);
    assert.equal(body.new_user_exposure_rate, 0);
  });

  it("a provenance-tagged row that is NOT Live Pulse is still counted", async () => {
    // MUTATION CAUGHT: re-broadening the filter to `r.event_type == null`.
    //
    // That formulation excluded EVERY provenance-tagged row, not just Live
    // Pulse — including the 'watch_impression' rows written by
    // routes/mediaFeed.ts, which are genuine impressions this dashboard has
    // always counted. Dropping them is a behaviour change unrelated to this
    // work, and an invisible one: the number just gets smaller.
    //
    // The row below now uses mediaFeed's REAL surface, 'watch_feed'. It used to
    // substitute 'discovery' because 'watch_feed' was outside the CHECK
    // vocabulary this file models; migration 0202 admitted it, so the test can
    // finally exercise the actual value the writer emits instead of a stand-in.
    // The filter is scoped to `surface !== 'live_pulse'`, so both exercise it
    // identically — this is a fidelity improvement, not a behaviour change.
    const withTaggedNonLivePulse = [
      ...ROUTE_SELECTED_ROWS,
      { outcome: "impression", item_kind: "post", position: 2, surface: "watch_feed",
        user_id: RANKED_VIEWER, served_at: daysAgo(2), event_type: "watch_impression" },
    ];
    _setTestClient(makeAdminClient(withTaggedNonLivePulse), true);
    const { body } = await getMetrics();
    assert.equal(body.impressions, 2,
      "an event_type-tagged row on a non-live_pulse surface is a real impression");
    assert.deepEqual(Object.keys(body.tap_through_by_kind).sort(), ["event", "post"]);
    // by_surface is the one breakdown keyed by surface, so it is where the
    // switch from the 'discovery' stand-in to mediaFeed's real 'watch_feed'
    // (legal since 0202) is visible. The counts are unchanged; only the key is.
    assert.deepEqual(body.by_surface, {
      pulse:      { impressions: 1, taps: 1 },
      live_pulse: { impressions: 3, taps: 0 },
      watch_feed: { impressions: 1, taps: 0 },
    });
    // …and Live Pulse is STILL excluded from the surface-blind totals above
    // (impressions === 2, not 5), so this is a narrowing of that exclusion, not
    // a removal of it. by_surface buckets every row by its own surface, which is
    // why all three keys appear here and only here.
  });

  it("with no live_pulse rows at all the endpoint behaves exactly as before", async () => {
    // Non-vacuity control: every assertion above must be caused by the
    // surface value, not by the fixture's shape. Same rows, same kinds, same
    // positions, same users — only surface='live_pulse' rewritten to 'pulse'.
    // If these numbers did not move, the filter would be doing nothing and the
    // whole block would be vacuous.
    const noLivePulse = ROUTE_SELECTED_ROWS.map((r) => ({
      ...r,
      surface: r.surface === "live_pulse" ? "pulse" : r.surface,
    }));
    _setTestClient(makeAdminClient(noLivePulse), true);
    const { body } = await getMetrics();
    assert.equal(body.impressions, 4);
    assert.equal(body.exploration_slot.impressions, 3);
    assert.deepEqual(Object.keys(body.tap_through_by_kind).sort(), ["event", "gem", "plan"]);
    assert.equal(body.new_user_exposure_rate, 1);
    assert.deepEqual(body.by_surface, { pulse: { impressions: 4, taps: 1 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// routes/rankEvents.ts — the INBOUND zod widening
//
//   const SURFACE_VALUES = ["pulse", "discovery", "events", "live_pulse"];
//
// This block exists because that one-word edit was the only part of the Live
// Pulse surface split with no test at all, and it is the part a user actually
// feels. Everything else here exercises the WRITE path (pulse.ts / rankLog.ts
// producing rows) or the READ path (adminRankingMetrics.ts aggregating them).
// SURFACE_VALUES is the READ-BACK path: it is the only server-side validation
// of a client-supplied `surface`, and POST /api/rank-events/outcome is where a
// Live Pulse save or rsvp arrives.
//
// Without 'live_pulse' in that enum the failure is total and silent from the
// product's point of view: every Live Pulse outcome 400s at the zod boundary
// before any lookup runs, so the rail serves impressions forever and records
// not one outcome against them. The rows land; nothing ever upgrades them.
//
// The four things pinned here, and why each is not redundant:
//   1. ACCEPT   'live_pulse' reaches the handler and upgrades the matching row.
//   2. REJECT   an unknown surface still 400s — widening one value must not
//               have degraded the enum into a free-for-all. 'pulse_live' is the
//               transposition an author reaching for 'live_pulse' from memory
//               writes; 'living_page' is a real server-written surface that is
//               deliberately NOT client-reportable.
//   3. NON-VACUITY  'live_pulse' with no matching row returns 404, not 400. A
//               400 and a 404 are both "not 200", so without this the accept
//               test could pass for the wrong reason and the reject test could
//               be asserting a lookup miss rather than a schema rejection.
//   4. SEPARATION  the lookup hard-filters .eq("surface", surface), so an
//               outcome posted as 'pulse' cannot claim a 'live_pulse'
//               impression. This is the hijack the whole surface split exists
//               to prevent, asserted from the client's side of the wire.
// Plus: the analytics insert echoes `surface` verbatim into a NEW row, so
// 'live_pulse' hits the live CHECK constraint a second time on this path —
// migration 0199 covers both, and that insert only warns on failure.
// ─────────────────────────────────────────────────────────────────────────────

/** A live_pulse impression row, exactly as buildLivePulseServeRows writes it. */
const lpImpressionRow = () => ({
  id:         "07000001-1111-4111-8111-111111111111",
  user_id:    ALICE_ID,
  item_id:    GEM_MNL_ID,
  item_kind:  "gem",
  surface:    "live_pulse",
  outcome:    "impression",
  position:   0,
  features:   {},
  served_at:  new Date().toISOString(),
  session_id: null,
  outcome_at: null,
});

interface OutcomeCaptures {
  updates: Array<{ table: string; patch: any; id: any }>;
  inserts: Array<{ table: string; row: any }>;
}

/**
 * Captures are filtered by table at every assertion site. The handler also
 * fires two other side-effects at the same client (linkOutcomeSignal, which
 * touches compass_outcome_events, and upsertDistributionStats, which is
 * RPC-only). Both are fire-and-forget and neither is under test here; scoping
 * the assertions to rank_events keeps this block from failing for a reason
 * that has nothing to do with `surface`.
 */
const rankEventWrites = (cap: OutcomeCaptures) => ({
  updates: cap.updates.filter((u) => u.table === "rank_events"),
  inserts: cap.inserts.filter((i) => i.table === "rank_events"),
});

function makeOutcomeClient(rankEventsRows: any[], cap: OutcomeCaptures) {
  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: rankEventsRows,
  };

  function selectBuilder(table: string) {
    let filtered = (db[table] ?? []).map((r) => ({ ...r }));
    const b: any = {
      eq:    (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      order: (_c: string, _o?: any) => b,
      limit: (_n: number) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any, reject?: any) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === "valid-token"
          ? { data: { user: { id: ALICE_ID } }, error: null }
          : { data: null, error: { message: "invalid" } },
    },
    from: (table: string) => ({
      select: (_cols?: string) => selectBuilder(table),
      update: (patch: any) => ({
        eq: (_col: string, val: any) => {
          cap.updates.push({ table, patch, id: val });
          return Promise.resolve({ data: null, error: null });
        },
      }),
      insert: (row: any) => {
        cap.inserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      },
    }),
    rpc: (_name: string, _params?: any) => Promise.resolve({ data: null, error: null }),
  };
}

async function postOutcome(
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  const app = express();
  app.use(express.json());
  app.use("/api", rankEventsRouter);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rank-events/outcome`, {
      method:  "POST",
      headers: {
        Authorization:  "Bearer valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("POST /rank-events/outcome — surface='live_pulse' is accepted, unknown surfaces are not", () => {
  after(() => {
    _setTestClient(null, false);
  });

  it("ACCEPTS surface='live_pulse' and upgrades the matching Live Pulse impression", async () => {
    // MUTATION CAUGHT: dropping 'live_pulse' from SURFACE_VALUES in
    // routes/rankEvents.ts. The request would 400 at the zod boundary with
    // invalid_payload and never reach the lookup, so no update would be
    // recorded — every Live Pulse save/rsvp lost, with the rail still serving.
    const cap: OutcomeCaptures = { updates: [], inserts: [] };
    const row = lpImpressionRow();
    _setTestClient(makeOutcomeClient([row], cap), true);

    const { status, body } = await postOutcome({
      item_id: GEM_MNL_ID,
      surface: "live_pulse",
      outcome: "save",
    });

    assert.equal(status, 200, "a Live Pulse outcome must not 400 at the zod boundary");
    assert.equal(body.ok, true);
    const { updates } = rankEventWrites(cap);
    assert.equal(updates.length, 1, "exactly one rank_events row upgraded");
    assert.equal(updates[0]!.id, row.id,
      "must upgrade the live_pulse impression row, not some other row");
    assert.equal(updates[0]!.patch.outcome, "save");
    assert.ok(typeof updates[0]!.patch.outcome_at === "string");
  });

  it("still REJECTS an unknown surface with 400 invalid_payload", async () => {
    // MUTATION CAUGHT: replacing z.enum(SURFACE_VALUES) with z.string(). That
    // would make the accept test above pass while letting any string through to
    // the analytics insert, which echoes `surface` verbatim into a new row and
    // only warns when the CHECK constraint rejects it.
    // 'living_page' was in this list until 0202 made it a legal surface; keeping
    // it would assert a rejection the database no longer performs.
    for (const surface of ["pulse_live", "livingpage", "not_a_surface"]) {
      const cap: OutcomeCaptures = { updates: [], inserts: [] };
      _setTestClient(makeOutcomeClient([lpImpressionRow()], cap), true);

      const { status, body } = await postOutcome({
        item_id: GEM_MNL_ID,
        surface,
        outcome: "save",
      });

      assert.equal(status, 400, `surface='${surface}' must be rejected`);
      assert.equal(body.error, "invalid_payload", `surface='${surface}'`);
      assert.equal(cap.updates.length, 0, `surface='${surface}' must not touch any row`);
      assert.equal(cap.inserts.length, 0, `surface='${surface}' must not write analytics`);
    }
  });

  it("NON-VACUITY: 'live_pulse' with no matching impression is 404, not 400", async () => {
    // Without this, the two tests above are compatible with a much weaker
    // reality. 400 and 404 are both "not 200": if 'live_pulse' were still
    // rejected by the enum, the accept test would fail — but a reviewer reading
    // only the reject test could not tell a schema rejection from a lookup
    // miss. This pins that 'live_pulse' clears the schema and is decided by the
    // DATA, which is the behaviour every already-permitted surface has.
    const cap: OutcomeCaptures = { updates: [], inserts: [] };
    _setTestClient(makeOutcomeClient([], cap), true);

    const { status, body } = await postOutcome({
      item_id: GEM_MNL_ID,
      surface: "live_pulse",
      outcome: "save",
    });

    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
    assert.equal(cap.updates.length, 0, "no phantom row is created");
  });

  it("SEPARATION: a 'pulse' outcome cannot claim a 'live_pulse' impression", async () => {
    // MUTATION CAUGHT: dropping `.eq("surface", surface)` from the lookup, or
    // reverting logLivePulseServe to write surface='pulse'. Either re-opens the
    // hijack the split exists to prevent — and this asserts it from the client's
    // side of the wire, where a real outcome actually arrives.
    const cap: OutcomeCaptures = { updates: [], inserts: [] };
    _setTestClient(makeOutcomeClient([lpImpressionRow()], cap), true);

    const { status } = await postOutcome({
      item_id: GEM_MNL_ID,   // same entity id…
      surface: "pulse",      // …different key space
      outcome: "save",
    });

    assert.equal(status, 404, "a ranked-surface outcome must not resolve to a Live Pulse row");
    assert.equal(cap.updates.length, 0);
  });

  it("the fire-and-forget analytics row echoes surface='live_pulse' verbatim", async () => {
    // This is the SECOND time this value meets the live CHECK constraint on the
    // outcome path: the handler updates the existing row, then inserts a new
    // analytics row carrying the same `surface`. Migration 0199 must be applied
    // for BOTH, and this insert only warns on failure — so if 0199 were missing
    // the ranking corpus would quietly lose every Live Pulse analytics row while
    // the endpoint kept returning 200.
    const cap: OutcomeCaptures = { updates: [], inserts: [] };
    _setTestClient(makeOutcomeClient([lpImpressionRow()], cap), true);

    const { status } = await postOutcome({
      item_id: GEM_MNL_ID,
      surface: "live_pulse",
      outcome: "save",
    });
    assert.equal(status, 200);

    await settle(() => rankEventWrites(cap).inserts.length > 0);
    const { inserts } = rankEventWrites(cap);
    assert.equal(inserts.length, 1, "exactly one analytics row");
    const analytics = inserts[0]!;
    assert.equal(analytics.row.surface, "live_pulse",
      "the analytics row must stay in Live Pulse's key space");
    assert.equal(analytics.row.outcome, "analytics",
      "the sentinel that keeps this row out of the impression-finding query");
    assert.equal(analytics.row.item_id, GEM_MNL_ID);
    assert.ok(SURFACE_VALUES.has(analytics.row.surface),
      "the emitted surface must be in the live rank_events_surface_check vocabulary");
  });
});
