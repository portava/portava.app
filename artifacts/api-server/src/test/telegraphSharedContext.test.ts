/**
 * Telegraph §3 Shared Context Rail — the projection, its ordering, its §3.2
 * refusal, and the route that serves it.
 *
 * Spec (v1 and v1_1; v1_1's shared body is byte-identical to v1):
 *   §3    "show mutually relevant events, plans, Trips and related Portava
 *          objects created or joined by both sides"
 *   §3.1  the four eligibility clauses + "Past shared objects remain available
 *          in the historical view only when still authorized"
 *   §3.2  "A place that one person merely sent in a message is shared content,
 *          not a mutual plan."
 *   §3.3  HAPPENING NOW -> STARTING SOON -> TODAY -> UPCOMING -> ACTIVE TRIP
 *          -> UNRESOLVED / WANT TO DO -> PAST
 *   §3.4  TelegraphSharedContextProjection / SharedContextItem
 *   §2.2  header: "User / Crew name · availability · safe presence"
 *   §11.2 rail behaviour: expanded NOW / compact upcoming / collapsed summary
 *
 * WHAT IS EXERCISED: the real `services/telegraph/sharedContext.ts` and the
 * real `routes/telegraphSharedContext.ts`, mounted in a real express app over
 * an in-memory PostgREST-shaped fake. Nothing here asserts against a mock of
 * the thing under test — the fake is the DATABASE, and every verdict below is
 * produced by the shipped resolver and the shipped route handler.
 *
 * SHOWN RED, twice, both observed before this file was committed:
 *   1. `mv src/services/telegraph/sharedContext.ts` aside — the whole file
 *      fails to import: `# tests 1 / # pass 0 / # fail 1`.
 *   2. Module restored, `admitCandidate`'s `non_canonical_source` branch
 *      deleted — `# pass 32 / # fail 1`, the one failure being
 *      "admitCandidate REFUSES a candidate sourced from the message table".
 *      Branch restored, 33/33.
 *
 * Run: node --import tsx/esm --test src/test/telegraphSharedContext.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphSharedContextRouter from "../routes/telegraphSharedContext.js";
import {
  admitCandidate,
  classifyBand,
  compareItems,
  railModeFor,
  collapsedSummary,
  availableActionsFor,
  CANONICAL_MUTUALITY_SOURCES,
  SHARED_CONTEXT_ORDER,
  type SharedContextCandidate,
  type SharedContextItem,
  type TelegraphSharedContextProjection,
} from "../services/telegraph/sharedContext.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the counterpart
const CAROL = "cccccccc-0000-4000-8000-000000000003"; // an outsider

const THREAD_D = "dddddddd-0000-4000-8000-00000000000d"; // direct, Alice + Bob
const THREAD_T = "dddddddd-0000-4000-8000-00000000000e"; // trip thread, Alice + Bob
const THREAD_N = "dddddddd-0000-4000-8000-00000000000f"; // Alice is NOT a member

const TRIP_ACTIVE = "10000000-0000-4000-8000-000000000001";
const TRIP_PAST = "10000000-0000-4000-8000-000000000002";
const TRIP_SOLO = "10000000-0000-4000-8000-000000000003";
const TRIP_REMOVED = "10000000-0000-4000-8000-000000000004";

const MEETUP_NOW = "20000000-0000-4000-8000-000000000001";
const MEETUP_SOON = "20000000-0000-4000-8000-000000000002";
const MEETUP_TODAY = "20000000-0000-4000-8000-000000000003";
const MEETUP_SOLO = "20000000-0000-4000-8000-000000000004";

const EVENT_UP = "30000000-0000-4000-8000-000000000001";

const PLACE_BOTH = "40000000-0000-4000-8000-000000000001";
const PLACE_ALICE_ONLY = "40000000-0000-4000-8000-000000000002";
/** A place Bob merely POSTED in the thread. §3.2 says it is not a mutual plan. */
const PLACE_ONLY_MENTIONED = "40000000-0000-4000-8000-000000000009";

/**
 * TWO CLOCKS, on purpose.
 *
 * `PIN_MS` is a frozen instant (06:00 UTC, so "+8h" is unambiguously the same
 * UTC day) and is used ONLY where a band is asserted by name — those are pure
 * calls into `classifyBand`, which takes `nowMs` as an argument.
 *
 * The ROUTE takes no clock: it calls `new Date()` like production does. So the
 * fixture is built relative to the REAL now, and the route tests assert
 * ORDER — which is invariant under the one boundary that can move (a "+3h"
 * plan bands TODAY before 21:00 UTC and UPCOMING after, and sorts into the
 * same position either way, because within a band the sooner start wins).
 */
const PIN = "2026-05-10T06:00:00.000Z";
const PIN_MS = Date.parse(PIN);
const pMinutes = (n: number) => new Date(PIN_MS + n * 60_000).toISOString();
const pHours = (n: number) => new Date(PIN_MS + n * 3600_000).toISOString();
const pDays = (n: number) => new Date(PIN_MS + n * 86_400_000).toISOString();

const NOW_MS = Date.now();
const minutes = (n: number) => new Date(NOW_MS + n * 60_000).toISOString();
const hours = (n: number) => new Date(NOW_MS + n * 3600_000).toISOString();
const days = (n: number) => new Date(NOW_MS + n * 86_400_000).toISOString();
/** A `date` column value n days from now, in UTC. */
const dayString = (n: number) => new Date(NOW_MS + n * 86_400_000).toISOString().slice(0, 10);

// ── fixture ──────────────────────────────────────────────────────────────────

interface State {
  /** Inject a read error on this table. */
  errorTable?: string;
  /** open_to_plans_windows_enabled */
  windowsFlag?: boolean;
  /** Bob's availability window rows, verbatim. */
  bobWindows?: any[];
  /** Bob has consented to circle presence sharing. */
  bobPresenceConsent?: boolean;
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "open_to_plans_windows_enabled", enabled: state.windowsFlag === true },
    ],
    message_threads: [
      { id: THREAD_D, thread_type: "direct", trip_id: null, circle_owner_id: null },
      { id: THREAD_T, thread_type: "trip", trip_id: TRIP_ACTIVE, circle_owner_id: null },
      { id: THREAD_N, thread_type: "direct", trip_id: null, circle_owner_id: null },
    ],
    message_thread_members: [
      { thread_id: THREAD_D, user_id: ALICE, left_at: null },
      { thread_id: THREAD_D, user_id: BOB, left_at: null },
      { thread_id: THREAD_T, user_id: ALICE, left_at: null },
      { thread_id: THREAD_T, user_id: BOB, left_at: null },
      { thread_id: THREAD_N, user_id: BOB, left_at: null },
      { thread_id: THREAD_N, user_id: CAROL, left_at: null },
    ],
    // §3.2's trap: a place Bob posted into the direct thread as a card. No
    // resolver may promote it, and nothing in the rail may name it.
    messages: [
      {
        id: "90000000-0000-4000-8000-000000000001",
        thread_id: THREAD_D,
        sender_id: BOB,
        msg_type: "system",
        subtype: "discovery_card",
        body: JSON.stringify({ sourceType: "place", sourceId: PLACE_ONLY_MENTIONED, title: "Bar Bob mentioned" }),
        created_at: hours(-2),
        deleted_at: null,
      },
    ],
    trip_members: [
      { trip_id: TRIP_ACTIVE, user_id: ALICE, status: "accepted", role: "owner" },
      { trip_id: TRIP_ACTIVE, user_id: BOB, status: "accepted", role: "member" },
      { trip_id: TRIP_PAST, user_id: ALICE, status: "accepted", role: "member" },
      { trip_id: TRIP_PAST, user_id: BOB, status: "accepted", role: "owner" },
      { trip_id: TRIP_SOLO, user_id: ALICE, status: "accepted", role: "owner" },
      // §3.1 last bullet: Alice was REMOVED. The trip must not appear at all,
      // not even in PAST.
      { trip_id: TRIP_REMOVED, user_id: ALICE, status: "removed", role: "member" },
      { trip_id: TRIP_REMOVED, user_id: BOB, status: "accepted", role: "owner" },
    ],
    trips: [
      { id: TRIP_ACTIVE, owner_id: ALICE, title: "Da Nang", start_date: dayString(-2), end_date: dayString(10), status: "active", updated_at: days(-1) },
      { id: TRIP_PAST, owner_id: BOB, title: "Hanoi last winter", start_date: dayString(-120), end_date: dayString(-113), status: "completed", updated_at: days(-112) },
      { id: TRIP_SOLO, owner_id: ALICE, title: "Solo trip", start_date: dayString(30), end_date: dayString(40), status: "planning", updated_at: days(-2) },
      { id: TRIP_REMOVED, owner_id: BOB, title: "Trip Alice was removed from", start_date: dayString(-60), end_date: dayString(-56), status: "completed", updated_at: days(-55) },
    ],
    meetup_invites: [
      { meetup_id: MEETUP_NOW, user_id: ALICE, status: "going" },
      { meetup_id: MEETUP_NOW, user_id: BOB, status: "going" },
      { meetup_id: MEETUP_SOON, user_id: ALICE, status: "going" },
      { meetup_id: MEETUP_SOON, user_id: BOB, status: "maybe" },
      { meetup_id: MEETUP_TODAY, user_id: ALICE, status: "pending" },
      { meetup_id: MEETUP_TODAY, user_id: BOB, status: "going" },
      { meetup_id: MEETUP_SOLO, user_id: ALICE, status: "going" },
    ],
    meetups: [
      { id: MEETUP_NOW, creator_id: BOB, title: "Dinner with Bob", starts_at: minutes(-30), ends_at: minutes(60), status: "confirmed", updated_at: hours(-3) },
      { id: MEETUP_SOON, creator_id: ALICE, title: "Coffee", starts_at: minutes(45), ends_at: minutes(105), status: "active", updated_at: hours(-4) },
      // "+3h": TODAY before 21:00 UTC, UPCOMING after. Either way it sorts
      // after the 45-minute coffee and before the event three days out, which
      // is what the route test asserts.
      { id: MEETUP_TODAY, creator_id: BOB, title: "Night market", starts_at: hours(3), ends_at: hours(5), status: "active", updated_at: hours(-5) },
      { id: MEETUP_SOLO, creator_id: ALICE, title: "Alone time", starts_at: hours(20), ends_at: hours(21), status: "draft", updated_at: hours(-6) },
    ],
    event_attendees: [
      { event_id: EVENT_UP, user_id: ALICE },
      { event_id: EVENT_UP, user_id: BOB },
    ],
    events: [
      { id: EVENT_UP, host_id: CAROL, title: "Rooftop set", starts_at: days(3), ends_at: days(3), state: "published", updated_at: days(-1) },
    ],
    rent_buddy_bookings: [],
    collections: [
      { id: "c-alice", owner_id: ALICE },
      { id: "c-bob", owner_id: BOB },
    ],
    collection_items: [
      { collection_id: "c-alice", entity_type: "place", entity_id: PLACE_BOTH, saved_at: days(-5) },
      { collection_id: "c-bob", entity_type: "place", entity_id: PLACE_BOTH, saved_at: days(-4) },
      { collection_id: "c-alice", entity_type: "place", entity_id: PLACE_ALICE_ONLY, saved_at: days(-3) },
    ],
    availability_windows: state.bobWindows ?? [],
    circle_visibility_settings: state.bobPresenceConsent
      ? [{ user_id: BOB, global_enabled: true, visibility_mode: "status_only", trip_sharing_default: null, event_sharing_default: null, is_paused: false, consent_version: "v1", consented_at: days(-30) }]
      : [],
    circle_context_settings: [],
    blocks: [],
    user_account_states: [],
    circle_presence: [
      {
        user_id: BOB,
        id: "p1",
        context_type: "trip",
        context_id: TRIP_ACTIVE,
        status: "arrived",
        status_label: "At the bar",
        approximate_label: "An Thuong",
        venue_label: "Bar Bien",
        checked_in: true,
        last_seen_at: minutes(-5),
        expires_at: null,
        stale_after_secs: 1800,
        is_stale: false,
        needs_help: true, // must NEVER leave the server
        updated_at: minutes(-5),
      },
    ],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const observed: Array<{ table: string; sel: string }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () =>
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;

    const target: any = {
      select(sel?: string) {
        observed.push({ table, sel: sel ?? "" });
        return proxy;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        return Promise.resolve(e ? { data: null, error: e } : { data: rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        return Promise.resolve(e ? { data: null, error: e } : { data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        return Promise.resolve(
          e ? { data: null, error: e, count: null } : { data: rowsNow(), error: null, count: rowsNow().length },
        ).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _observed: observed,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function get(path: string, asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphSharedContextRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const idsOf = (arr: SharedContextItem[]) => arr.map((i) => i.objectId);

// ── §3.3 banding, pure ───────────────────────────────────────────────────────

describe("§3.3 banding", () => {
  it("classifies each band from the object's own dates", () => {
    assert.equal(classifyBand({ objectType: "MEETUP", startsAt: pMinutes(-30), endsAt: pMinutes(60) }, PIN_MS), "HAPPENING_NOW");
    assert.equal(classifyBand({ objectType: "MEETUP", startsAt: pMinutes(45), endsAt: pMinutes(105) }, PIN_MS), "STARTING_SOON");
    assert.equal(classifyBand({ objectType: "MEETUP", startsAt: pHours(8), endsAt: pHours(10) }, PIN_MS), "TODAY");
    assert.equal(classifyBand({ objectType: "EVENT", startsAt: pDays(3), endsAt: pDays(3) }, PIN_MS), "UPCOMING");
    assert.equal(classifyBand({ objectType: "MEETUP", startsAt: pDays(-2), endsAt: pDays(-2) }, PIN_MS), "PAST");
    assert.equal(classifyBand({ objectType: "WANT_TO_DO", startsAt: null, endsAt: null }, PIN_MS), "UNRESOLVED");
  });

  it("a TRIP spanning now is ACTIVE_TRIP, which §3.3 ranks BELOW a plan starting soon", () => {
    assert.equal(
      classifyBand({ objectType: "TRIP", startsAt: pDays(-2), endsAt: pDays(10) }, PIN_MS),
      "ACTIVE_TRIP",
      "the two-week trip must not outrank the meetup in 45 minutes",
    );
    assert.ok(
      SHARED_CONTEXT_ORDER.indexOf("ACTIVE_TRIP") > SHARED_CONTEXT_ORDER.indexOf("STARTING_SOON"),
    );
  });

  it("§3.3's order is exactly the spec's seven bands in the spec's order", () => {
    assert.deepEqual([...SHARED_CONTEXT_ORDER], [
      "HAPPENING_NOW", "STARTING_SOON", "TODAY", "UPCOMING", "ACTIVE_TRIP", "UNRESOLVED", "PAST",
    ]);
  });

  it("compareItems sorts by band, then by the sooner start", () => {
    const mk = (id: string, band: any, startsAt?: string): SharedContextItem => ({
      objectType: "MEETUP", objectId: id, title: id, relationship: "BOTH_PARTICIPANTS",
      status: "active", availableActions: [], orderBand: band, startsAt,
    });
    const sorted = [mk("c", "UPCOMING", days(1)), mk("a", "HAPPENING_NOW"), mk("b", "UPCOMING", hours(9))]
      .sort(compareItems)
      .map((i) => i.objectId);
    assert.deepEqual(sorted, ["a", "b", "c"]);
  });
});

// ── §3.2 refusal ─────────────────────────────────────────────────────────────

describe("§3.2 — mutuality may never be inferred from chat", () => {
  const base_: SharedContextCandidate = {
    objectType: "PLACE",
    objectId: PLACE_ONLY_MENTIONED,
    title: "Bar Bob mentioned",
    status: "shared",
    relationship: "BOTH_PARTICIPANTS",
    source: "trip_members",
    counterpartIds: [BOB],
    viewerStillAuthorized: true,
  };

  it("`messages` is not a canonical mutuality source", () => {
    assert.ok(!(CANONICAL_MUTUALITY_SOURCES as readonly string[]).includes("messages"));
    assert.deepEqual([...CANONICAL_MUTUALITY_SOURCES], [
      "trip_members", "meetup_invites", "event_attendees", "rent_buddy_bookings", "collection_items",
    ]);
  });

  it("admitCandidate REFUSES a candidate sourced from the message table", () => {
    const r = admitCandidate({ ...base_, source: "messages" as any }, NOW_MS);
    assert.equal(r.admitted, false);
    assert.equal(r.admitted === false && r.refusal, "non_canonical_source");
  });

  it("the projection module never reads the message table", () => {
    const src = readFileSync(new URL("../services/telegraph/sharedContext.ts", import.meta.url), "utf8");
    const fromCalls = [...src.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]);
    assert.ok(fromCalls.length > 0, "the resolvers must actually read tables");
    assert.ok(!fromCalls.includes("messages"), `§3.2: read of messages found in resolvers: ${fromCalls.join(", ")}`);
    for (const t of fromCalls) {
      assert.ok(
        ["trip_members", "trips", "meetup_invites", "meetups", "event_attendees", "events",
          "rent_buddy_bookings", "collections", "collection_items"].includes(t),
        `unexpected table in the rail resolver: ${t}`,
      );
    }
  });

  it("refuses an object nobody else in the conversation is on (§3: BOTH sides)", () => {
    const r = admitCandidate({ ...base_, counterpartIds: [] }, NOW_MS);
    assert.equal(r.admitted === false && r.refusal, "no_counterpart");
  });

  it("refuses an object the viewer is no longer authorized on (§3.1 last bullet)", () => {
    const r = admitCandidate({ ...base_, viewerStillAuthorized: false }, NOW_MS);
    assert.equal(r.admitted === false && r.refusal, "viewer_unauthorized");
  });
});

// ── §3.4 availableActions ────────────────────────────────────────────────────

describe("§3.4 availableActions come from §8.1's fourteen", () => {
  it("a happening-now plan offers the coordination actions", () => {
    assert.deepEqual(availableActionsFor("MEETUP", "HAPPENING_NOW"), [
      "MEET_HERE", "SHARE_LOCATION", "CHECK_IN_SAFE", "RETURN_TO_GROUP",
    ]);
  });
  it("a PAST object offers none", () => {
    assert.deepEqual(availableActionsFor("MEETUP", "PAST"), []);
    assert.deepEqual(availableActionsFor("TRIP", "PAST"), []);
  });
});

// ── the route ────────────────────────────────────────────────────────────────

describe("GET /threads/:threadId/shared-context", () => {
  it("a non-member is refused, and told so — not handed an empty rail", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_N}/shared-context`, ALICE);
    assert.equal(r.status, 403);
    assert.equal(r.body.sharedContext, undefined);
  });

  it("an invalid thread id is a 400", async () => {
    useState({});
    const r = await get(`/threads/not-a-uuid/shared-context`, ALICE);
    assert.equal(r.status, 400);
  });

  it("builds §3.4's four arrays from canonical mutual state", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    assert.equal(r.status, 200);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;

    assert.equal(p.conversationId, THREAD_D);
    assert.ok(typeof p.generatedAt === "string" && !Number.isNaN(Date.parse(p.generatedAt)));

    assert.deepEqual(idsOf(p.now), [MEETUP_NOW], "the dinner that is happening right now");
    assert.deepEqual(
      idsOf(p.upcoming),
      [MEETUP_SOON, MEETUP_TODAY, EVENT_UP, TRIP_ACTIVE],
      "§3.3 order: STARTING SOON, TODAY, UPCOMING, then ACTIVE TRIP",
    );
    assert.deepEqual(idsOf(p.unresolved), [PLACE_BOTH], "both saved it — §3.1 clause 4");
    assert.deepEqual(idsOf(p.past), [TRIP_PAST]);
  });

  it("§3.2: a place merely POSTED in the thread never enters the rail", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    const all = [...p.now, ...p.upcoming, ...p.unresolved, ...p.past];
    assert.ok(
      !all.some((i) => i.objectId === PLACE_ONLY_MENTIONED),
      "the discovery card Bob posted is shared CONTENT, not a mutual plan",
    );
    assert.ok(!all.some((i) => i.title.includes("mentioned")));
  });

  it("§3: an object only the viewer is on is absent (no counterpart)", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    const all = [...p.now, ...p.upcoming, ...p.unresolved, ...p.past].map((i) => i.objectId);
    assert.ok(!all.includes(TRIP_SOLO));
    assert.ok(!all.includes(MEETUP_SOLO));
    assert.ok(!all.includes(PLACE_ALICE_ONLY));
  });

  it("§3.1: a past trip the viewer was REMOVED from is absent even from PAST", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    assert.ok(!idsOf(p.past).includes(TRIP_REMOVED));
    assert.ok(!p.past.some((i) => i.title.includes("removed")));
  });

  it("§3.1: relationship names which side created it", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    const byId = new Map(
      [...p.now, ...p.upcoming, ...p.unresolved, ...p.past].map((i) => [i.objectId, i]),
    );
    assert.equal(byId.get(TRIP_ACTIVE)!.relationship, "CREATED_BY_ME_JOINED_BY_THEM");
    assert.equal(byId.get(MEETUP_NOW)!.relationship, "CREATED_BY_THEM_JOINED_BY_ME");
    assert.equal(byId.get(EVENT_UP)!.relationship, "BOTH_PARTICIPANTS", "host Carol is in neither seat");
    assert.equal(byId.get(PLACE_BOTH)!.relationship, "BOTH_PROMOTED");
  });

  it("carries §3.4's currentVersion from the source object", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    const trip = p.upcoming.find((i) => i.objectId === TRIP_ACTIVE)!;
    assert.equal(trip.currentVersion, days(-1));
  });

  it("§11.2: an active plan puts the rail in EXPANDED_NOW", async () => {
    useState({});
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    assert.equal(r.body.railMode, "EXPANDED_NOW");
  });

  it("a failed read reports INCOMPLETE rather than presenting an empty rail as truth", async () => {
    useState({ errorTable: "trip_members" });
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.incomplete, true, "the caller must be able to tell 'unknown' from 'nothing shared'");
    const p = r.body.sharedContext as TelegraphSharedContextProjection;
    assert.ok(!idsOf(p.upcoming).includes(TRIP_ACTIVE), "the trip could not be read");
    assert.ok(idsOf(p.now).includes(MEETUP_NOW), "the resolvers that DID succeed still contribute");
  });

  it("a failed MEMBERSHIP read is a 500, never a silent 403", async () => {
    useState({ errorTable: "message_thread_members" });
    const r = await get(`/threads/${THREAD_D}/shared-context`, ALICE);
    assert.equal(r.status, 500);
  });
});

// ── §11.2 rail modes, pure ───────────────────────────────────────────────────

describe("§11.2 rail behaviour", () => {
  const empty: TelegraphSharedContextProjection = {
    conversationId: THREAD_D, generatedAt: PIN, now: [], upcoming: [], unresolved: [], past: [],
  };
  const item = (id: string, band: any, type: any = "MEETUP"): SharedContextItem => ({
    objectType: type, objectId: id, title: id, relationship: "BOTH_PARTICIPANTS",
    status: "active", availableActions: [], orderBand: band,
  });

  it("no shared context at all → EMPTY", () => {
    assert.equal(railModeFor(empty), "EMPTY");
  });
  it("upcoming only → COMPACT_UPCOMING", () => {
    assert.equal(railModeFor({ ...empty, upcoming: [item("u", "UPCOMING")] }), "COMPACT_UPCOMING");
  });
  it("neither active nor upcoming → COLLAPSED_SUMMARY", () => {
    assert.equal(railModeFor({ ...empty, past: [item("p", "PAST", "TRIP")] }), "COLLAPSED_SUMMARY");
  });
  it("renders §11.2's summary string", () => {
    const p = {
      ...empty,
      unresolved: [item("a", "UNRESOLVED"), item("b", "UNRESOLVED"), item("c", "UNRESOLVED")],
      past: [item("t", "PAST", "TRIP")],
    };
    assert.equal(collapsedSummary(p), "3 shared plans · 1 past trip");
  });
});

// ── §2.2 conversation header ─────────────────────────────────────────────────

describe("GET /threads/:threadId/conversation-header", () => {
  const explicitWindow = {
    id: "w1", user_id: BOB, type: "one_time",
    start_at: hours(-1), end_at: hours(5), trip_id: null,
    open_to_plans: true, intents: ["Food", "Drinks"], group_preference: "small_group",
    max_travel_minutes: 20, visibility: "crew", source: "explicit",
    social_availability: "open", expires_at: hours(5),
    created_at: hours(-1), updated_at: hours(-1),
  };

  it("with the windows flag OFF, availability is reported as not enabled and carries no state", async () => {
    useState({ windowsFlag: false, bobWindows: [explicitWindow] });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.availabilityEnabled, false);
    assert.equal(r.body.participants[0].availability.enabled, false);
    assert.equal(r.body.participants[0].availability.state, null);
  });

  it("with the flag ON, Telegraph reads the counterpart's explicit window", async () => {
    useState({ windowsFlag: true, bobWindows: [explicitWindow] });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.status, 200);
    const p = r.body.participants[0];
    assert.equal(p.userId, BOB);
    assert.equal(p.availability.state, "open");
    assert.deepEqual(p.availability.intents, ["Food", "Drinks"]);
    assert.equal(p.availability.expiresAt, hours(5));
  });

  it("§4.3 revocation-on-read: an EXPIRED window never renders as current", async () => {
    useState({
      windowsFlag: true,
      bobWindows: [{ ...explicitWindow, end_at: hours(-2), expires_at: hours(-2) }],
    });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.body.participants[0].availability.state, null);
  });

  it("§7 of Passport, honoured here: an INFERRED window is never shown to a counterpart", async () => {
    useState({
      windowsFlag: true,
      bobWindows: [{ ...explicitWindow, source: "plan_derived", visibility: "public" }],
    });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.body.participants[0].availability.state, null);
  });

  it("safe presence appears only with consent, and NEVER carries needs_help", async () => {
    useState({ windowsFlag: false, bobPresenceConsent: true });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.status, 200);
    const p = r.body.participants[0];
    assert.equal(p.safePresence.label, "At the bar");
    assert.equal(p.safePresence.venue, "Bar Bien");
    assert.equal(p.safePresence.checkedIn, true);
    assert.equal(JSON.stringify(r.body).includes("needs_help"), false);
    assert.equal(JSON.stringify(r.body).includes("needsHelp"), false);
  });

  it("without consent there is no presence, and availability is still answered", async () => {
    useState({ windowsFlag: false, bobPresenceConsent: false });
    const r = await get(`/threads/${THREAD_T}/conversation-header`, ALICE);
    assert.equal(r.body.participants[0].safePresence, null);
  });

  it("a direct thread has no canonical context, so it exposes no presence at all", async () => {
    useState({ windowsFlag: false, bobPresenceConsent: true });
    const r = await get(`/threads/${THREAD_D}/conversation-header`, ALICE);
    assert.equal(r.body.participants[0].safePresence, null);
  });
});
