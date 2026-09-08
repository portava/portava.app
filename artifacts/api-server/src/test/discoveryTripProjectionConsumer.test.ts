/**
 * Discovery consumes the Trip-owned TripDiscoveryProjection — behind
 * discovery_trip_projection_enabled (migration 2550, seeded FALSE).
 * routes/discoverySearch.ts searchTrips / searchPlans;
 * lib/discoveryTripProjectionConsumer.ts; lib/tripDiscoveryProjection.ts
 * (Trips spec §19.1, §25; census-discovery A10 / D3).
 *
 * WHAT IS PROVEN HERE
 * ===================
 *  1. Flag OFF — absent row, explicit false, unreadable table, thrown client:
 *     searchTrips and searchPlans issue the SAME `trips` reads they issued
 *     before this lane, pinned as the exact (table, columns, chain of
 *     predicate calls with their arguments) the fake client observed; no read
 *     ever carries TRIP_DISCOVERY_SOURCE_COLUMNS; a database that 42703s on
 *     `version` (production today) changes nothing. That is the "gated-off
 *     byte-identity" claim, measured rather than asserted — the model is
 *     src/test/tripKernelExpansion.test.ts.
 *  2. Flag ON, on a database WITH trips.version: the response body is
 *     deepEqual to the flag-OFF body for the same fixtures — Discovery's
 *     blocked / age-restricted / active-owner filters still apply, on ownerId.
 *  3. Flag ON, projection read fails (resolved error or thrown client): `[]`,
 *     status 200, no trip id in the body. Never a crash, never a leak.
 *  4. The policy consequence, pinned rather than buried: with the flag ON the
 *     owner's show_exact_dates / show_destination_city / show_header_publicly
 *     toggles reach a searcher's card; OFF they do not. And the by-id reader
 *     carries no separate bounding date, so a hidden-date parent trip passes
 *     the plans time-intent bound ON where OFF excludes it.
 *  5. §19.1: a projection of a schema version the consumer cannot read is
 *     dropped, and counted.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/discoveryTripProjectionConsumer.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import discoverySearchRouter, { dispatchSearch } from "../routes/discoverySearch.js";
import {
  DISCOVERY_TRIP_PROJECTION_FLAG,
  DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION,
  DISCOVERY_TRIP_PROJECTION,
  DISCOVERY_TRIP_PROJECTION_COLUMNS,
  acceptTripDiscoveryProjections,
  discoveryTripProjectionEnabled,
  discoveryTripProjectionGate,
  invalidateDiscoveryTripProjectionFlagCache,
  readDiscoveryTripSourceDecisions,
  tripCardSourceFromProjection,
} from "../lib/discoveryTripProjectionConsumer.js";
import { resetSchemaCapabilityMemo } from "../lib/capability/schemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID } from "../lib/capability/schemaRequirement.js";
import {
  TRIP_DISCOVERY_SOURCE_COLUMNS,
  projectTripForDiscovery,
} from "../lib/tripDiscoveryProjection.js";
import { PRIVATE_TRIP_COVER_PLACEHOLDER } from "../lib/privacy/coverPlaceholders.js";

// ── IDs ───────────────────────────────────────────────────────────────────────
const ME    = "aa000000-0000-4000-a000-000000000001"; // the searcher
const ALICE = "bb000000-0000-4000-a000-000000000002"; // active owner of public trips
const BOB   = "cc000000-0000-4000-a000-000000000003"; // ME blocked BOB
const CARL  = "dd000000-0000-4000-a000-000000000004"; // age-restricted
const DAN   = "ee000000-0000-4000-a000-000000000005"; // suspended

const T_PUB      = "ff000000-0000-4000-a000-000000000010";
const T_PUB2     = "ff000000-0000-4000-a000-000000000011";
const T_BLOCKED  = "ff000000-0000-4000-a000-000000000012";
const T_AGE      = "ff000000-0000-4000-a000-000000000013";
const T_SUSP     = "ff000000-0000-4000-a000-000000000014";
const T_PRIV     = "ff000000-0000-4000-a000-000000000015"; // ME's own private trip
const T_DRAFT    = "ff000000-0000-4000-a000-000000000016";
const T_OPTOUT   = "ff000000-0000-4000-a000-000000000017";
const T_TOGGLES  = "ff000000-0000-4000-a000-000000000018"; // discoverable, every toggle OFF

const P_PUB      = "ab000000-0000-4000-a000-000000000020";
const P_PUB2     = "ab000000-0000-4000-a000-000000000021";
const P_PRIV     = "ab000000-0000-4000-a000-000000000022";
const P_DRAFT    = "ab000000-0000-4000-a000-000000000023";
const P_BLOCKED  = "ab000000-0000-4000-a000-000000000024";
const P_OPTOUT   = "ab000000-0000-4000-a000-000000000025";
const P_SUSP     = "ab000000-0000-4000-a000-000000000026";
const P_AGE      = "ab000000-0000-4000-a000-000000000027";
const P_TOGGLES  = "ab000000-0000-4000-a000-000000000028";

const ME_TOK = "tok-me";

/** The legacy searchTrips select, verbatim from routes/discoverySearch.ts before this lane. */
const LEGACY_TRIPS_COLUMNS = "id, title, destination_city, destination_country, owner_id, cover_url, start_date, status, visibility, created_at";
/** The legacy searchPlans parent-trip select, verbatim. */
const LEGACY_PLAN_TRIPS_COLUMNS = "id, visibility, show_in_discovery, owner_id, status, start_date";
const EXCLUDED_STATUS_LITERAL = '("draft","cancelled","archived")';

// ── Fixtures ──────────────────────────────────────────────────────────────────
function trip(over: Record<string, any>): Record<string, any> {
  return {
    owner_id: ALICE, title: null, destination_city: "Lisbon", destination_country: "PT",
    cover_url: "https://img/cover.jpg", start_date: "2026-10-01", end_date: "2026-10-05", status: "upcoming",
    visibility: "public", show_in_discovery: true, show_exact_dates: true, show_destination_city: true,
    show_header_publicly: true, precise_location_visible: false, trip_type: "leisure", open_to_meet: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z", version: 3,
    // never to reach a card, either path
    internal_notes: "NEVER-TO-CLIENT", trip_notes: "hotel: Rua X 12", destination_lat: 38.7, destination_lng: -9.1,
    ...over,
  };
}

function baseTrips(): Record<string, any>[] {
  return [
    trip({ id: T_PUB,     title: "Lisbon in October" }),
    trip({ id: T_PUB2,    title: "Lisbon again", start_date: "2026-12-01", end_date: "2026-12-03", cover_url: null, version: 0 }),
    trip({ id: T_BLOCKED, title: "Lisbon by Bob",  owner_id: BOB }),
    trip({ id: T_AGE,     title: "Lisbon by Carl", owner_id: CARL }),
    trip({ id: T_SUSP,    title: "Lisbon by Dan",  owner_id: DAN }),
    trip({ id: T_PRIV,    title: "Lisbon private", owner_id: ME, visibility: "private", show_in_discovery: false }),
    trip({ id: T_DRAFT,   title: "Lisbon draft",   status: "draft" }),
    trip({ id: T_OPTOUT,  title: "Lisbon optout",  show_in_discovery: false }),
  ];
}

function basePlans(): Record<string, any>[] {
  const p = (id: string, trip_id: string, title: string, creator_id = ALICE) =>
    ({ id, trip_id, title, creator_id, removed_at: null, created_at: "2026-01-01T00:00:00Z" });
  return [
    p(P_PUB,     T_PUB,     "Belem tower"),
    p(P_PUB2,    T_PUB2,    "Belem again"),
    p(P_PRIV,    T_PRIV,    "Belem secret", ME),
    p(P_DRAFT,   T_DRAFT,   "Belem draft"),
    p(P_BLOCKED, T_BLOCKED, "Belem on Bob's trip"),
    p(P_OPTOUT,  T_OPTOUT,  "Belem optout"),
    p(P_SUSP,    T_SUSP,    "Belem on Dan's trip"),
    p(P_AGE,     T_AGE,     "Belem on Carl's trip"),
  ];
}

function baseState(flag: "absent" | true | false): Record<string, any[]> {
  return {
    profiles: [
      { id: ME,    account_status: "active" },
      { id: ALICE, account_status: "active" },
      { id: BOB,   account_status: "active" },
      { id: CARL,  account_status: "active" },
      { id: DAN,   account_status: "suspended" },
    ],
    blocks: [{ blocker_id: ME, blocked_id: BOB }],
    user_privacy_settings: [{ user_id: CARL, age_restriction_enabled: true }],
    feature_flags: flag === "absent" ? [] : [{ flag: DISCOVERY_TRIP_PROJECTION_FLAG, enabled: flag }],
    trips: baseTrips(),
    trip_plan_items: basePlans(),
    rank_events: [],
  };
}

// ── Recording fake client ─────────────────────────────────────────────────────
interface Recorded { table: string; select: string | null; calls: Array<[string, any[]]> }
type Answer = { data: any; error: any } | "throw";
/** Per-table override, consulted with the select string: models a database that rejects a query shape. */
type Override = (table: string, select: string | null, rec: Recorded) => Answer | undefined;

const QUERIES: Recorded[] = [];

function makeFakeClient(state: Record<string, any[]>, override: Override = () => undefined) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      const rec: Recorded = { table, select: null, calls: [] };
      QUERIES.push(rec);
      const rows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let rangeStart = 0, rangeEnd = Infinity, limitN = Infinity;
      let verb: "select" | "insert" = "select";
      const like = (pat: string) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      const answer = (): Promise<{ data: any; error: any }> => {
        const o = override(table, rec.select, rec);
        if (o === "throw") throw new Error(`fake client: ${table} threw`);
        if (o) return Promise.resolve(o);
        if (verb === "insert") return Promise.resolve({ data: null, error: null });
        const matched = rows.filter((r) => filters.every((f) => f(r)))
          .slice(rangeStart, rangeEnd < Infinity ? rangeEnd + 1 : limitN < Infinity ? limitN : undefined);
        return Promise.resolve({ data: matched, error: null });
      };
      const b: any = {};
      const chain = (m: string, fn: (...a: any[]) => void) => { b[m] = (...args: any[]) => { rec.calls.push([m, args]); fn(...args); return b; }; };
      chain("select", (cols?: string) => { rec.select = cols ?? "*"; });
      chain("insert", () => { verb = "insert"; });
      chain("eq",  (c: string, v: any) => filters.push((r) => r[c] === v));
      chain("neq", (c: string, v: any) => filters.push((r) => r[c] !== v));
      chain("in",  (c: string, vs: any[]) => filters.push((r) => vs.includes(r[c])));
      chain("is",  (c: string, v: any) => filters.push((r) => (v === null ? r[c] == null : r[c] === v)));
      chain("gte", (c: string, v: any) => filters.push((r) => r[c] != null && r[c] >= v));
      chain("lt",  (c: string, v: any) => filters.push((r) => r[c] != null && r[c] < v));
      chain("ilike", (c: string, pat: string) => { const re = like(pat); filters.push((r) => re.test(String(r[c] ?? ""))); });
      chain("not", (c: string, op: string, v: any) => {
        if (op === "is") { filters.push((r) => r[c] !== v && r[c] != null); return; }
        if (op === "in") {
          const vals = new Set(String(v).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")));
          filters.push((r) => !vals.has(String(r[c] ?? "")));
          return;
        }
        throw new Error(`fake client: unmodelled .not(${c}, "${op}")`);
      });
      chain("or", (expr: string) => {
        const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.+)$/)).filter(Boolean) as RegExpMatchArray[];
        filters.push((r) => parts.some((m) => {
          const cell = String(r[m[1]!] ?? "");
          if (m[2] === "ilike") return like(m[3]!).test(cell);
          if (m[2] === "eq") return cell === m[3];
          return false;
        }));
      });
      chain("order", () => {});
      chain("limit", (n: number) => { limitN = n; });
      chain("range", (s: number, e: number) => { rangeStart = s; rangeEnd = e; });
      b.maybeSingle = async () => { rec.calls.push(["maybeSingle", []]); const a = await answer(); return { data: Array.isArray(a.data) ? (a.data[0] ?? null) : a.data, error: a.error }; };
      b.single = b.maybeSingle;
      b.then = (onF: any, onR: any) => { let p: Promise<any>; try { p = answer(); } catch (e) { p = Promise.reject(e); } return p.then(onF, onR); };
      return b;
    },
  };
}

/**
 * Models production today: any `trips` read that names `version` is a 42703 —
 * the capability probe included, which is exactly how the gate learns that
 * this database cannot serve the projection.
 */
const PRODUCTION_NO_VERSION: Override = (table, select) =>
  table === "trips" && select !== null && /\bversion\b/.test(select)
    ? { data: null, error: { code: "42703", message: 'column trips.version does not exist' } }
    : undefined;

/**
 * The same absence, worded the way PostgreSQL words it when it quotes the
 * column rather than qualifying it. `missingObjectsNamedBy` matches `'c'`,
 * `"c"` or ` c `, so THIS shape names `trips.version` where the dotted shape
 * above can only name `trips` — the "floor" the capability contract documents,
 * pinned here in both directions rather than assumed away.
 */
const PRODUCTION_NO_VERSION_QUOTED: Override = (table, select) =>
  table === "trips" && select !== null && /\bversion\b/.test(select)
    ? { data: null, error: { code: "42703", message: 'column "version" of relation "trips" does not exist' } }
    : undefined;

/**
 * A database that HAS trips.version — so the capability probe passes — but
 * whose actual projection SELECT fails anyway (a revoked grant, a transient
 * error, a PostgREST schema-cache lag). The probe is the read filtered to the
 * sentinel id; the search read is any other read of the same column list.
 */
const PROBE_OK_BUT_READ_FAILS = (answer: Answer): Override => (table, select, rec) =>
  table === "trips" && select === TRIP_DISCOVERY_SOURCE_COLUMNS && !isProbeRead(rec) ? answer : undefined;

// ── Server ────────────────────────────────────────────────────────────────────
let base: string;
let server: Server;

function setup(state: Record<string, any[]>, override?: Override) {
  QUERIES.length = 0;
  invalidateDiscoveryTripProjectionFlagCache();
  resetSchemaCapabilityMemo();
  _resetRateLimit();
  _setTestClient(makeFakeClient(state, override) as any, true);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", discoverySearchRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => { server.close(); invalidateDiscoveryTripProjectionFlagCache(); });
beforeEach(() => setup(baseState("absent")));

async function search(type: "trips" | "plans", q = "lisbon"): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/discovery/search?q=${encodeURIComponent(q)}&type=${type}`, { headers: { Authorization: `Bearer ${ME_TOK}` } });
  return { status: r.status, body: await r.json() };
}
const ids = (body: any): string[] => (body.results as any[]).map((r) => r.id as string);
/** The capability probe: the required column list, pinned to a sentinel id no row can hold. */
function isProbeRead(rec: Recorded): boolean {
  return (
    rec.table === "trips" &&
    rec.select === TRIP_DISCOVERY_SOURCE_COLUMNS &&
    rec.calls.some(([m, a]) => m === "eq" && a[0] === "id" && a[1] === SCHEMA_PROBE_SENTINEL_ID)
  );
}
const probeReads = () => QUERIES.filter(isProbeRead);
/** Reads of `trips` that serve a search — the probe is schema inspection, not a read of user data. */
const tripsReads = () => QUERIES.filter((q) => q.table === "trips" && !isProbeRead(q));
const projectionReads = () => QUERIES.filter((q) => q.select === TRIP_DISCOVERY_SOURCE_COLUMNS && !isProbeRead(q));
const flagReads = () => QUERIES.filter((q) => q.table === "feature_flags" && q.calls.some(([m, a]) => m === "eq" && a[0] === "flag" && a[1] === DISCOVERY_TRIP_PROJECTION_FLAG));

/** The whole legacy searchTrips read, call by call. `pat` is sqlPattern("lisbon"). */
function assertLegacyTripsSearchRead(rec: Recorded, extra: { gte?: string; lt?: string; range: [number, number] }) {
  assert.equal(rec.table, "trips");
  assert.equal(rec.select, LEGACY_TRIPS_COLUMNS);
  const pat = "%lisbon%";
  const expected: Array<[string, any[]]> = [
    ["select", [LEGACY_TRIPS_COLUMNS]],
    ["or", [`title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`]],
    ["eq", ["visibility", "public"]],
    ["eq", ["show_in_discovery", true]],
    ["not", ["status", "in", EXCLUDED_STATUS_LITERAL]],
    ["order", ["start_date", { ascending: true }]],
  ];
  if (extra.gte) expected.push(["gte", ["start_date", extra.gte]]);
  if (extra.lt)  expected.push(["lt",  ["start_date", extra.lt]]);
  expected.push(["range", extra.range]);
  assert.deepEqual(rec.calls, expected, "the legacy trips search read, byte for byte");
}

/** The whole legacy searchPlans parent-trip read. */
function assertLegacyPlanTripsRead(rec: Recorded, tripIds: string[]) {
  assert.equal(rec.table, "trips");
  assert.equal(rec.select, LEGACY_PLAN_TRIPS_COLUMNS);
  assert.deepEqual(rec.calls, [
    ["select", [LEGACY_PLAN_TRIPS_COLUMNS]],
    ["in", ["id", tripIds]],
    ["not", ["status", "in", EXCLUDED_STATUS_LITERAL]],
  ], "the legacy plans parent-trip read, byte for byte");
}

/** What a searcher is owed for the fixtures, either path: only ALICE's discoverable trips. */
const EXPECTED_TRIP_IDS = [T_PUB, T_PUB2];
const EXPECTED_PLAN_IDS = [P_PUB, P_PUB2, P_PRIV];
const NEVER_TRIP_IDS = [T_BLOCKED, T_AGE, T_SUSP, T_PRIV, T_DRAFT, T_OPTOUT];
const NEVER_PLAN_IDS = [P_DRAFT, P_BLOCKED, P_OPTOUT, P_SUSP, P_AGE];

function assertExpectedTrips(body: any) {
  assert.deepEqual(ids(body).sort(), [...EXPECTED_TRIP_IDS].sort());
  const json = JSON.stringify(body);
  for (const id of NEVER_TRIP_IDS) assert.equal(json.includes(id), false, `${id} must not be served`);
  for (const leak of ["NEVER-TO-CLIENT", "Rua X", "38.7"]) assert.equal(json.includes(leak), false, `${leak} must not reach a card`);
}
function assertExpectedPlans(body: any) {
  assert.deepEqual(ids(body).sort(), [...EXPECTED_PLAN_IDS].sort());
  const json = JSON.stringify(body);
  for (const id of NEVER_PLAN_IDS) assert.equal(json.includes(id), false, `${id} must not be served`);
}

// ═════════════════════════════════════════════════════════════════════════════
describe("flag OFF (the seed) — searchTrips issues the legacy read, byte-identical, and never the projection", () => {
  const PINNED_CARD = {
    id: T_PUB, type: "trips", title: "Lisbon in October", subtitle: "Lisbon, PT", avatarUrl: null,
    imageUrl: "https://img/cover.jpg", fallbackInitials: "LI", locationPreview: "Lisbon, PT", matchedReason: null,
    actionState: null, privacyState: { isPublic: true }, accessState: { canAccess: true },
    destinationRoute: `/trip/${T_PUB}`, metadata: { ownerId: ALICE, status: "upcoming" },
    createdAt: "2026-01-01T00:00:00.000Z", startsAt: "2026-10-01",
  };

  for (const [label, flag] of [["absent flag row", "absent"], ["flag row explicitly false", false]] as const) {
    it(`${label}: exactly one trips read, the legacy shape; projection readers never called; the card is the legacy card`, async () => {
      setup(baseState(flag));
      const { status, body } = await search("trips");
      assert.equal(status, 200);
      assertExpectedTrips(body);
      assert.deepEqual(body.results.find((r: any) => r.id === T_PUB), PINNED_CARD);

      const reads = tripsReads();
      assert.equal(reads.length, 1, "one trips read and only one");
      // limit 20 → fetchLimit 21 → dispatchSearch pool min(0 + 63, 100) = 63 → range(0, 62)
      assertLegacyTripsSearchRead(reads[0]!, { range: [0, 62] });
      assert.equal(projectionReads().length, 0, "TRIP_DISCOVERY_SOURCE_COLUMNS never selected with the flag off");
      assert.equal(flagReads().length, 1, "the flag is read once, through isFlagEnabled");
    });
  }

  it("feature_flags UNREADABLE (resolved error): legacy read, projection never consulted", async () => {
    setup(baseState(true), (table) => (table === "feature_flags" ? { data: null, error: { message: "simulated" } } : undefined));
    const { body } = await search("trips");
    assertExpectedTrips(body);
    assertLegacyTripsSearchRead(tripsReads()[0]!, { range: [0, 62] });
    assert.equal(projectionReads().length, 0);
  });

  it("feature_flags read THROWS: legacy read, projection never consulted", async () => {
    setup(baseState(true), (table) => (table === "feature_flags" ? "throw" : undefined));
    const { body } = await search("trips");
    assertExpectedTrips(body);
    assertLegacyTripsSearchRead(tripsReads()[0]!, { range: [0, 62] });
    assert.equal(projectionReads().length, 0);
  });

  it("production today (trips.version absent → 42703 on any read naming it): flag off, results unchanged", async () => {
    setup(baseState("absent"), PRODUCTION_NO_VERSION);
    const { status, body } = await search("trips");
    assert.equal(status, 200);
    assertExpectedTrips(body);
    assert.equal(projectionReads().length, 0);
  });

  it("time intent: the legacy read carries gte/lt on start_date, verbatim", async () => {
    setup(baseState("absent"));
    const sc = makeFakeClient(baseState("absent"));
    const out = await dispatchSearch(sc as any, "lisbon", ME, new Set([BOB]), new Set([CARL]), "trips", 0, 21,
      { startsAfter: "2026-09-01T00:00:00.000Z", startsBefore: "2026-11-01T00:00:00.000Z" });
    assert.deepEqual(out.map((r) => r.id), [T_PUB], "T_PUB2 (2026-12-01) falls outside the bound");
    assertLegacyTripsSearchRead(tripsReads()[0]!, { gte: "2026-09-01", lt: "2026-11-01", range: [0, 62] });
    assert.equal(projectionReads().length, 0);
  });
});

describe("flag OFF (the seed) — searchPlans issues the legacy parent-trip read, byte-identical", () => {
  for (const [label, flag] of [["absent flag row", "absent"], ["flag row explicitly false", false]] as const) {
    it(`${label}: the second trips read is the legacy by-id read with the status denylist; admission decided in Discovery as before`, async () => {
      setup(baseState(flag));
      const { status, body } = await search("plans", "belem");
      assert.equal(status, 200);
      assertExpectedPlans(body);
      const reads = tripsReads();
      assert.equal(reads.length, 1);
      assertLegacyPlanTripsRead(reads[0]!, [T_PUB, T_PUB2, T_PRIV, T_DRAFT, T_BLOCKED, T_OPTOUT, T_SUSP, T_AGE]);
      assert.equal(projectionReads().length, 0);
    });
  }

  it("feature_flags unreadable / thrown: legacy parent-trip read", async () => {
    for (const o of [{ data: null, error: { message: "simulated" } }, "throw"] as const) {
      setup(baseState(true), (table) => (table === "feature_flags" ? o : undefined));
      const { body } = await search("plans", "belem");
      assertExpectedPlans(body);
      assert.equal(tripsReads()[0]!.select, LEGACY_PLAN_TRIPS_COLUMNS);
      assert.equal(projectionReads().length, 0);
    }
  });

  it("production today (42703 on version): flag off, plans unchanged", async () => {
    setup(baseState("absent"), PRODUCTION_NO_VERSION);
    const { body } = await search("plans", "belem");
    assertExpectedPlans(body);
  });

  it("time intent: the parent's true start_date bounds the plan, in memory, as before", async () => {
    const sc = makeFakeClient(baseState("absent"));
    const out = await dispatchSearch(sc as any, "belem", ME, new Set([BOB]), new Set([CARL]), "plans", 0, 21,
      { startsAfter: "2026-09-01", startsBefore: "2026-11-01" });
    assert.deepEqual(out.map((r) => r.id).sort(), [P_PUB, P_PRIV].sort(), "P_PUB2's parent (2026-12-01) is outside the bound");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("capability READY (flag ON + trips.version present) — the projection path returns the same results as legacy", () => {
  it("trips: body deepEqual to the flag-OFF body; the one trips read selects TRIP_DISCOVERY_SOURCE_COLUMNS; blocked / age-restricted / suspended owners still excluded here", async () => {
    setup(baseState("absent"));
    const off = await search("trips");
    assertExpectedTrips(off.body);

    setup(baseState(true));
    const on = await search("trips");
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, off.body, "flag ON serves exactly what flag OFF serves for these fixtures");

    assert.equal(probeReads().length, 1, "the schema was probed before the projection was trusted");
    assert.deepEqual(readDiscoveryTripSourceDecisions(), [
      { surface: "trips", source: "projection", reason: "ready", missing: [] },
    ]);
    const reads = tripsReads();
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.select, TRIP_DISCOVERY_SOURCE_COLUMNS);
    assert.ok(/\bversion\b/.test(reads[0]!.select!), "the projection read names trips.version (2420)");
    // The projection reader's predicate is the rule, in SQL; the range is the same page.
    assert.deepEqual(reads[0]!.calls.filter(([m]) => m === "eq").map(([, a]) => a), [["visibility", "public"], ["show_in_discovery", true]]);
    assert.deepEqual(reads[0]!.calls.find(([m]) => m === "range")![1], [0, 62]);
    // Discovery's own filters ran on ownerId: the profiles active-owner read was issued for the surviving owners only.
    const ownerRead = QUERIES.find((q) => q.table === "profiles" && q.calls.some(([m, a]) => m === "in" && a[0] === "account_status"));
    assert.ok(ownerRead, "fetchActiveOwnerSet ran");
    assert.deepEqual(ownerRead!.calls.find(([m, a]) => m === "in" && a[0] === "id")![1][1].sort(), [ALICE, DAN].sort(),
      "BOB (blocked) and CARL (age-restricted) were removed BEFORE the owner-status read; DAN is removed BY it");
  });

  it("plans: body deepEqual to the flag-OFF body; the parent read is the by-id reader with NO visibility predicate — tripDiscoveryAdmits decides per viewer", async () => {
    setup(baseState("absent"));
    const off = await search("plans", "belem");
    assertExpectedPlans(off.body);

    setup(baseState(true));
    const on = await search("plans", "belem");
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, off.body);

    const reads = tripsReads();
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.select, TRIP_DISCOVERY_SOURCE_COLUMNS);
    assert.deepEqual(reads[0]!.calls.map(([m]) => m), ["select", "in"], "by id only; admission is not restated in SQL");
    assert.deepEqual(reads[0]!.calls[1]![1], ["id", [T_PUB, T_PUB2, T_PRIV, T_DRAFT, T_BLOCKED, T_OPTOUT, T_SUSP, T_AGE]]);
  });

  it("the verdict is cached: two searches, one feature_flags read AND one schema probe", async () => {
    setup(baseState(true));
    await search("trips");
    await search("plans", "belem");
    assert.equal(flagReads().length, 1);
    assert.equal(probeReads().length, 1, "the schema probe is not repeated per surface");
    assert.equal(projectionReads().length, 2, "both searches took the projection path");
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => [d.surface, d.source]), [
      ["trips", "projection"], ["plans", "projection"],
    ]);
  });

  it("time intent ON: the projection search carries the same gte/lt on start_date", async () => {
    const sc = makeFakeClient(baseState(true));
    QUERIES.length = 0; invalidateDiscoveryTripProjectionFlagCache(); resetSchemaCapabilityMemo();
    const out = await dispatchSearch(sc as any, "lisbon", ME, new Set([BOB]), new Set([CARL]), "trips", 0, 21,
      { startsAfter: "2026-09-01T00:00:00.000Z", startsBefore: "2026-11-01T00:00:00.000Z" });
    assert.deepEqual(out.map((r) => r.id), [T_PUB]);
    const rec = tripsReads()[0]!;
    assert.equal(rec.select, TRIP_DISCOVERY_SOURCE_COLUMNS);
    assert.deepEqual(rec.calls.find(([m]) => m === "gte")![1], ["start_date", "2026-09-01"]);
    assert.deepEqual(rec.calls.find(([m]) => m === "lt")![1],  ["start_date", "2026-11-01"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE CAPABILITY, not the flag: FLAG_ENABLED && SCHEMA_CAPABILITY_READY.
//
// This is the case a bare flag could not survive. Somebody sets
// `discovery_trip_projection_enabled = true` on production, where 2420 has not
// been applied and `trips` has no `version` column. Under the bare flag the
// projection readers 42703 and EVERY trips and plans search answers `[]`,
// silently. Under the capability the probe finds the column absent, the gate
// refuses, and Discovery serves the legacy read it always served.
// ════════════════════════════════════════════════════════════════════════════
describe("capability NOT ready: the flag is ON over production's schema — legacy, byte-identical, never []", () => {
  it("trips: the probe 42703s on `version`, the gate refuses, and the read issued is the LEGACY read call for call", async () => {
    setup(baseState(true), PRODUCTION_NO_VERSION);
    const { status, body } = await search("trips");
    assert.equal(status, 200);

    // The results are the ones Discovery has always served — NOT [].
    assertExpectedTrips(body);

    assert.equal(probeReads().length, 1, "the schema was probed once");
    assert.deepEqual(
      probeReads()[0]!.calls.filter(([m]) => m === "eq").map(([, a]) => a),
      [["id", SCHEMA_PROBE_SENTINEL_ID]],
      "the probe is pinned to a sentinel id, so it can never return a user row",
    );
    const reads = tripsReads();
    assert.equal(reads.length, 1, "one search read of trips, and only one");
    assertLegacyTripsSearchRead(reads[0]!, { range: [0, 62] });
    assert.equal(projectionReads().length, 0, "the projection readers were never called");

    assert.deepEqual(readDiscoveryTripSourceDecisions(), [
      // PostgREST relays PostgreSQL's dotted wording ("column trips.version does
      // not exist"), which missingObjectsNamedBy can only resolve to the table.
      // That is the documented FLOOR, not the whole requirement; the refusal log
      // names providedBy, which is what an operator acts on.
      { surface: "trips", source: "legacy", reason: "schema_missing", missing: ["trips"] },
    ]);
  });

  it("plans: the same — legacy parent-trip read, every plan still served", async () => {
    setup(baseState(true), PRODUCTION_NO_VERSION);
    const { status, body } = await search("plans", "belem");
    assert.equal(status, 200);
    assertExpectedPlans(body);
    assertLegacyPlanTripsRead(tripsReads()[0]!, [T_PUB, T_PUB2, T_PRIV, T_DRAFT, T_BLOCKED, T_OPTOUT, T_SUSP, T_AGE]);
    assert.equal(projectionReads().length, 0);
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => [d.surface, d.source, d.reason]), [
      ["plans", "legacy", "schema_missing"],
    ]);
  });

  it("`unknown` refuses exactly like `missing`: a probe that THROWS keeps Discovery on legacy", async () => {
    setup(baseState(true), (table, select, rec) =>
      table === "trips" && select === TRIP_DISCOVERY_SOURCE_COLUMNS && isProbeRead(rec) ? "throw" : undefined);
    const { body } = await search("trips");
    assertExpectedTrips(body);
    assertLegacyTripsSearchRead(tripsReads()[0]!, { range: [0, 62] });
    assert.equal(projectionReads().length, 0);
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => d.reason), ["schema_unknown"]);
  });

  it("a NON-schema error on the probe (permission denied) is `unknown`, and still refuses — a guard that opens because it could not check is not a guard", async () => {
    setup(baseState(true), (table, select, rec) =>
      table === "trips" && select === TRIP_DISCOVERY_SOURCE_COLUMNS && isProbeRead(rec)
        ? { data: null, error: { code: "42501", message: "permission denied for table trips" } }
        : undefined);
    const { body } = await search("trips");
    assertExpectedTrips(body);
    assert.equal(projectionReads().length, 0);
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => d.reason), ["schema_unknown"]);
  });

  it("the dark flag makes NO schema contact: flag off ⇒ the probe never runs", async () => {
    setup(baseState(false));
    await search("trips");
    assert.equal(probeReads().length, 0, "a flag that is not on is not worth a round trip");
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => d.reason), ["flag_off"]);
  });
});

describe("capability READY — a projection read that fails AFTER the probe passed is [] : no crash, no leak", () => {
  const READ_ERROR: Answer = { data: null, error: { code: "42501", message: "permission denied for table trips" } };

  it("trips: probe ready, search read errors → 200 with results [] and no trip id in the body", async () => {
    setup(baseState(true), PROBE_OK_BUT_READ_FAILS(READ_ERROR));
    const { status, body } = await search("trips");
    assert.equal(status, 200);
    assert.deepEqual(body.results, []);
    assert.equal(body.hasMore, false);
    const json = JSON.stringify(body);
    for (const id of [...EXPECTED_TRIP_IDS, ...NEVER_TRIP_IDS]) assert.equal(json.includes(id), false, id);
    assert.equal(probeReads().length, 1);
    assert.equal(projectionReads().length, 1, "the projection WAS consulted (capability ready) and refused");
    assert.equal(tripsReads().length, 1, "no legacy fallback read — the capability decides the branch, not the outcome");
    assert.deepEqual(readDiscoveryTripSourceDecisions().map((d) => [d.source, d.reason]), [["projection", "ready"]]);
  });

  it("plans: the same — every plan withheld, none leaked from an unreadable parent", async () => {
    setup(baseState(true), PROBE_OK_BUT_READ_FAILS(READ_ERROR));
    const { status, body } = await search("plans", "belem");
    assert.equal(status, 200);
    assert.deepEqual(body.results, []);
    const json = JSON.stringify(body);
    for (const id of [...EXPECTED_PLAN_IDS, ...NEVER_PLAN_IDS]) assert.equal(json.includes(id), false, id);
  });

  it("a THROWN client on the projection read (probe already passed) is the same []", async () => {
    setup(baseState(true), PROBE_OK_BUT_READ_FAILS("throw"));
    const t = await search("trips");
    assert.deepEqual(t.body.results, []);
    setup(baseState(true), PROBE_OK_BUT_READ_FAILS("throw"));
    const p = await search("plans", "belem");
    assert.deepEqual(p.body.results, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("the policy consequence, pinned: the owner's non-member toggles reach a searcher ONLY with the flag on", () => {
  const withToggles = (flag: "absent" | true) => {
    const s = baseState(flag);
    s.trips.push(trip({ id: T_TOGGLES, title: "Lisbon toggles", start_date: "2026-10-20", end_date: "2026-10-22",
      show_exact_dates: false, show_destination_city: false, show_header_publicly: false }));
    s.trip_plan_items.push({ id: P_TOGGLES, trip_id: T_TOGGLES, title: "Belem toggles", creator_id: ALICE, removed_at: null, created_at: "2026-01-01T00:00:00Z" });
    return s;
  };

  it("OFF: true date, city and cover are served regardless of the toggles (today's behaviour)", async () => {
    setup(withToggles("absent"));
    const { body } = await search("trips");
    const card = body.results.find((r: any) => r.id === T_TOGGLES);
    assert.ok(card);
    assert.equal(card.startsAt, "2026-10-20");
    assert.equal(card.subtitle, "Lisbon, PT");
    assert.equal(card.locationPreview, "Lisbon, PT");
    assert.equal(card.imageUrl, "https://img/cover.jpg");
  });

  it("ON: startsAt null, country only, placeholder cover — toPrivateTripPreview's rule, via the projection; the trip is still discoverable", async () => {
    setup(withToggles(true));
    const { body } = await search("trips");
    const card = body.results.find((r: any) => r.id === T_TOGGLES);
    assert.ok(card, "hiding fields does not hide the trip");
    assert.equal(card.startsAt, null);
    assert.equal(card.subtitle, "PT");
    assert.equal(card.locationPreview, "PT");
    assert.equal(card.imageUrl, PRIVATE_TRIP_COVER_PLACEHOLDER);
    assert.equal(card.title, "Lisbon toggles");
    assert.equal(JSON.stringify(body).includes("2026-10-20"), false, "the hidden date appears nowhere in the body");
  });

  it("ON, a hidden-date parent passes the plans time-intent bound (the by-id reader carries no bounding date); OFF, the true date excludes it — reported, not hidden", async () => {
    const bound = { startsAfter: "2026-09-01", startsBefore: "2026-10-10" }; // T_TOGGLES starts 2026-10-20: outside
    const off = await dispatchSearch(makeFakeClient(withToggles("absent")) as any, "belem", ME, new Set([BOB]), new Set([CARL]), "plans", 0, 21, bound);
    assert.equal(off.some((r) => r.id === P_TOGGLES), false, "OFF: excluded by the true start_date");
    invalidateDiscoveryTripProjectionFlagCache(); resetSchemaCapabilityMemo();
    const on = await dispatchSearch(makeFakeClient(withToggles(true)) as any, "belem", ME, new Set([BOB]), new Set([CARL]), "plans", 0, 21, bound);
    assert.equal(on.some((r) => r.id === P_TOGGLES), true, "ON: startDate is null under show_exact_dates=false, so the bound cannot apply");
    // Everything else about the bound still holds on the projection path.
    assert.deepEqual(on.filter((r) => r.id !== P_TOGGLES).map((r) => r.id).sort(), [P_PUB, P_PRIV].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("lib/discoveryTripProjectionConsumer — the units", () => {
  it("the flag name is the literal 2550 seeds, `*_enabled` (CAPABILITY, isFlagEnabled)", () => {
    assert.equal(DISCOVERY_TRIP_PROJECTION_FLAG, "discovery_trip_projection_enabled");
  });

  it("discoveryTripProjectionEnabled is fail-closed toward legacy: absent, false, error, throw, AND missing schema → false; only an enabled row over ready schema → true", async () => {
    const mk = (flags: any[], override?: Override) => makeFakeClient({ feature_flags: flags, trips: [] }, override);
    const reset = () => { invalidateDiscoveryTripProjectionFlagCache(); resetSchemaCapabilityMemo(); };
    const ON = [{ flag: DISCOVERY_TRIP_PROJECTION_FLAG, enabled: true }];

    reset(); assert.equal(await discoveryTripProjectionEnabled(mk([])), false, "absent flag row");
    reset(); assert.equal(await discoveryTripProjectionEnabled(mk([{ flag: DISCOVERY_TRIP_PROJECTION_FLAG, enabled: false }])), false, "flag false");
    reset(); assert.equal(await discoveryTripProjectionEnabled(mk([], (t) => (t === "feature_flags" ? { data: null, error: { message: "x" } } : undefined))), false, "flag row unreadable");
    reset(); assert.equal(await discoveryTripProjectionEnabled(mk([], (t) => (t === "feature_flags" ? "throw" : undefined))), false, "flag read throws");
    reset(); assert.equal(await discoveryTripProjectionEnabled(mk(ON, PRODUCTION_NO_VERSION)), false, "flag ON over production's schema");
    reset(); assert.equal(await discoveryTripProjectionEnabled(mk(ON)), true, "flag ON over ready schema");
    reset();
  });

  it("the gate names WHY it refused, and only `ready` opens it", async () => {
    const mk = (flags: any[], override?: Override) => makeFakeClient({ feature_flags: flags, trips: [] }, override);
    const reset = () => { invalidateDiscoveryTripProjectionFlagCache(); resetSchemaCapabilityMemo(); };
    const ON = [{ flag: DISCOVERY_TRIP_PROJECTION_FLAG, enabled: true }];

    reset();
    const off = await discoveryTripProjectionGate(mk([]));
    assert.deepEqual([off.source, off.reason, off.schema], ["legacy", "flag_off", null]);

    reset();
    const missing = await discoveryTripProjectionGate(mk(ON, PRODUCTION_NO_VERSION));
    assert.equal(missing.source, "legacy");
    assert.equal(missing.reason, "schema_missing");
    assert.equal(missing.schema!.state, "missing");
    assert.deepEqual(missing.schema!.missing, ["trips"], "the dotted driver wording resolves only to the table — the documented floor");
    assert.equal(missing.schema!.errorCode, "42703");

    reset();
    const quoted = await discoveryTripProjectionGate(mk(ON, PRODUCTION_NO_VERSION_QUOTED));
    assert.equal(quoted.reason, "schema_missing");
    assert.deepEqual(quoted.schema!.missing, ["trips.version"], "when the driver quotes the column, the probe names the column 2420 provides");

    reset();
    const unknown = await discoveryTripProjectionGate(mk(ON, (_t, _sel, rec) => (isProbeRead(rec) ? "throw" : undefined)));
    assert.equal(unknown.source, "legacy");
    assert.equal(unknown.reason, "schema_unknown");

    reset();
    const ready = await discoveryTripProjectionGate(mk(ON));
    assert.deepEqual([ready.source, ready.reason, ready.schema!.state], ["projection", "ready", "ready"]);
    reset();
  });

  it("the verdict cache is keyed on the CLIENT OBJECT: one client's answer is never served to another", async () => {
    const reset = () => { invalidateDiscoveryTripProjectionFlagCache(); resetSchemaCapabilityMemo(); };
    const ON = [{ flag: DISCOVERY_TRIP_PROJECTION_FLAG, enabled: true }];
    reset();
    const ready = makeFakeClient({ feature_flags: ON, trips: [] });
    const notReady = makeFakeClient({ feature_flags: ON, trips: [] }, PRODUCTION_NO_VERSION);
    assert.equal(await discoveryTripProjectionEnabled(ready), true);
    // No invalidate between the two — a module-global cache would answer `true` here.
    assert.equal(await discoveryTripProjectionEnabled(notReady), false);
    assert.equal(await discoveryTripProjectionEnabled(ready), true);
    reset();
  });

  it("the capability declares exactly the columns the Trips-owned reader selects — derived, so it cannot drift", () => {
    assert.deepEqual(
      DISCOVERY_TRIP_PROJECTION_COLUMNS,
      TRIP_DISCOVERY_SOURCE_COLUMNS.split(",").map((c) => c.trim()),
    );
    assert.ok(DISCOVERY_TRIP_PROJECTION_COLUMNS.includes("version"), "the 2420 column is declared");
    assert.equal(DISCOVERY_TRIP_PROJECTION.flag, DISCOVERY_TRIP_PROJECTION_FLAG);
    assert.deepEqual(DISCOVERY_TRIP_PROJECTION.requires.tables.trips!.columns, DISCOVERY_TRIP_PROJECTION_COLUMNS);
    assert.ok(DISCOVERY_TRIP_PROJECTION.providedBy.some((m) => m.includes("2420")), "the refusal names the migration to apply");
    // The WRAPPER, not the route. checkFlagSchemaPrerequisites' consumer rule
    // tests whether a declared consumer REACHES lib/capability, not whether it
    // mentions the flag; routes/discoverySearch.ts does the latter only, through
    // this file. Declaring the route made the ratchet fail
    // "REGISTRY WITHOUT A CONSUMER: does not reach lib/capability", correctly.
    // MEDIA_CANONICAL uses the same shape: consumers: ["lib/mediaAssets.ts"].
    assert.deepEqual(DISCOVERY_TRIP_PROJECTION.consumers, ["lib/discoveryTripProjectionConsumer.ts"]);
  });

  it("§19.1: acceptTripDiscoveryProjections keeps schema version 1 and drops (and counts) anything else", () => {
    assert.equal(DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION, 1);
    const ok = projectTripForDiscovery(baseTrips()[0]!, "2026-09-07T00:00:00.000Z");
    const future = { ...ok, projectionSchemaVersion: 2 as any };
    const { accepted, rejected } = acceptTripDiscoveryProjections([ok, future, ok]);
    assert.deepEqual(accepted, [ok, ok]);
    assert.equal(rejected, 1);
  });

  it("tripCardSourceFromProjection copies exactly the card fields, and only from the projection", () => {
    const p = projectTripForDiscovery(baseTrips()[0]!, "2026-09-07T00:00:00.000Z");
    assert.deepEqual(tripCardSourceFromProjection(p), {
      id: T_PUB, ownerId: ALICE, title: "Lisbon in October", destinationCity: "Lisbon", destinationCountry: "PT",
      coverUrl: "https://img/cover.jpg", startDate: "2026-10-01", status: "upcoming", createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
