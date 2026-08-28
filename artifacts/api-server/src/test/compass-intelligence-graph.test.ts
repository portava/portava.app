/**
 * Phase 15 — Travel Intelligence Graph tests.
 *
 * Covers:
 *   - graph substrate: batch builders persist typed nodes/edges from existing
 *     app data; cross-trip relationships (returned_to) persist; person nodes
 *     carry no profile attributes (privacy)
 *   - Destination World Model: per-city day-of-week × daypart profiles derived
 *     from graph data; time-varying behavior changes recommendations (the same
 *     item ranks differently when the current time slice favors its category)
 *   - city-confidence index: depth scoring, tiers, strongest-city selection,
 *     honest thin-city messaging (Phase 8 bridge)
 *   - prompt context lines: aggregates only — no user ids, no coordinates
 *   - routes: rebuild/status admin-only; city-confidence auth + honest default
 *
 * Runtime: node:test + node:assert (no vitest, no real DB, no network)
 * Run: node --import tsx/esm --test src/test/compass-intelligence-graph.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import compassGraphRouter from "../routes/compassGraph.js";
import {
  daypartOf,
  timeSliceKey,
  localMonthKey,
  registerCityCoordinates,
  timezoneFromCoords,
  cityTimezone,
  buildGraphFromSources,
  cleanupNonCanonicalCityRows,
  buildCityWorldModels,
  computeCityConfidenceIndex,
  rebuildIntelligenceGraph,
  getCityWorldModel,
  getCityConfidence,
  worldModelBoostForItem,
  scoreCityDepth,
  tierForScore,
  cityConfidenceNote,
  buildDestinationContextLines,
  WORLD_MODEL_BOOST_MAX,
  MIN_SLICE_SAMPLE,
  type CityWorldModel,
  initCityTimezonePersistence,
  sweepCityTimezoneTable,
  _resetCityTimezoneStateForTest,
} from "../compass/CompassGraphEngine.js";
import { SEED_CITIES, getPopularCities } from "../lib/popularCities.js";
import { canonicalCityKey } from "../lib/canonicalLocations.js";
import { runPipeline } from "../compass/CompassPipeline.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

const USER_ID  = "00000000-0000-0000-0000-000000000001";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const USER_B   = "00000000-0000-0000-0000-000000000003";

/* ── Fake Supabase client (outcome-learning pattern + in/neq/like) ────────── */
type Row = Record<string, unknown>;

let idCounter = 0;

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  return new RegExp(`^${esc}$`);
}

function makeFakeClient(store: Record<string, Row[]> = {}) {
  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;
    let _lastWritten: Row[] | null = null;
    let _order: { key: string; asc: boolean } | null = null;
    let _delete = false;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_order) {
        const { key, asc } = _order;
        out = [...out].sort((a, b) => {
          const av = Number(a[key] ?? 0), bv = Number(b[key] ?? 0);
          return asc ? av - bv : bv - av;
        });
      }
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }

    function result(): Row[] {
      return _lastWritten ?? rows();
    }

    const passthrough = new Set(["select", "or", "ilike", "not", "filter", "match"]);

    const b: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => {
            if (_delete) {
              const matched = tbl(tableName).filter((r) => filters.every((f) => f(r)));
              store[tableName] = tbl(tableName).filter((r) => !matched.includes(r));
              return resolve({ data: matched, error: null, count: matched.length });
            }
            return resolve({ data: result(), error: null, count: result().length });
          };
        }
        if (prop === "delete") return () => { _delete = true; return b; };
        if (prop === "maybeSingle" || prop === "single") {
          return () => Promise.resolve({ data: result()[0] ?? null, error: null });
        }
        if (prop === "order") {
          return (key: string, opts?: { ascending?: boolean }) => {
            _order = { key, asc: opts?.ascending !== false };
            return b;
          };
        }
        if (prop === "limit") return (n: number) => { _limit = n; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "in")  return (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k] as never)); return b; };
        if (prop === "like") {
          return (k: string, pattern: string) => {
            const re = likeToRegex(pattern);
            filters.push((r) => re.test(String(r[k] ?? "")));
            return b;
          };
        }
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "insert") {
          return (payload: Row | Row[]) => {
            const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
              id: `20000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`,
              created_at: new Date().toISOString(),
              ...r,
            }));
            tbl(tableName).push(...arr);
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "upsert") {
          return (payload: Row | Row[], opts?: { onConflict?: string }) => {
            const keys = (opts?.onConflict ?? "id").split(",");
            const arr = Array.isArray(payload) ? payload : [payload];
            for (const r of arr) {
              const existing = tbl(tableName).find((e) => keys.every((k) => e[k] === r[k]));
              if (existing) Object.assign(existing, r);
              else tbl(tableName).push({ ...r });
            }
            _lastWritten = arr;
            return b;
          };
        }
        if (passthrough.has(prop)) return (..._a: unknown[]) => b;
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
            : token === "admin-token"
            ? Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store,
  };
}

/* ── Mini express app ─────────────────────────────────────────────────────── */

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassGraphRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestServiceClient(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function api(method: string, path: string, body?: unknown, token = "valid-token") {
  const resp = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

/* ── Seed helpers ─────────────────────────────────────────────────────────── */

let fake: ReturnType<typeof makeFakeClient>;

function seed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  fake = makeFakeClient({
    profiles: [
      { id: USER_ID,  role: "user" },
      { id: ADMIN_ID, role: "admin" },
    ],
    ...extra,
  });
  _setTestClient(fake.fakeClient, true);
  _setTestServiceClient(fake.fakeClient);
  return fake.store;
}

/** Seed a realistic Cebu-heavy dataset with a thin second city. */
function seedTravelData(store: Record<string, Row[]>) {
  // Cebu is UTC+8: Friday 7pm LOCAL = 11am UTC; Monday 8am LOCAL = midnight UTC.
  // Slices must be computed on the city's local clock, not UTC.
  const friEvening = "2026-07-24T11:00:00Z"; // Fri 19:00 in Cebu
  const monMorning = "2026-07-20T00:00:00Z"; // Mon 08:00 in Cebu

  store.user_stamps = [
    { user_id: USER_ID, city: "Cebu", country: "Philippines", earned_at: friEvening, is_revoked: false },
    { user_id: USER_ID, city: "Cebu", country: "Philippines", earned_at: monMorning, is_revoked: false },
    { user_id: USER_B,  city: "Cebu", country: "Philippines", earned_at: friEvening, is_revoked: false },
    { user_id: USER_B,  city: "Baguio", country: "Philippines", earned_at: monMorning, is_revoked: false },
  ];
  store.trips = [
    { id: "trip-1", owner_id: USER_ID, destination_city: "Cebu", start_date: "2026-05-01" },
    { id: "trip-2", owner_id: USER_ID, destination_city: "Cebu", start_date: "2026-07-20" },
    { id: "trip-3", owner_id: USER_B,  destination_city: "Baguio", start_date: "2026-06-10" },
  ];
  store.events = [
    { id: "evt-1", city: "Cebu", category: "nightlife", starts_at: friEvening },
    { id: "evt-2", city: "Cebu", category: "nightlife", starts_at: "2026-07-17T12:00:00Z" }, // Fri 20:00 Cebu — also Fri evening local
    { id: "evt-3", city: "Cebu", category: "wellness",  starts_at: monMorning },
  ];
  store.compass_outcome_events = [
    { user_id: USER_ID, item_id: "evt-1", item_type: "event", stage: "went", occurred_at: friEvening },
  ];
  store.rank_events = [
    { user_id: USER_B, item_id: "evt-1", item_kind: "event", outcome: "save", served_at: friEvening },
  ];
}

/* ── Time slicing ─────────────────────────────────────────────────────────── */

describe("time slicing", () => {
  it("maps hours to dayparts", () => {
    assert.equal(daypartOf(8), "morning");
    assert.equal(daypartOf(13), "afternoon");
    assert.equal(daypartOf(19), "evening");
    assert.equal(daypartOf(23), "night");
    assert.equal(daypartOf(2), "night");
  });

  it("builds dow:daypart keys — Friday night differs from Monday morning", () => {
    assert.equal(timeSliceKey(new Date("2026-07-24T19:00:00Z")), "fri:evening");
    assert.equal(timeSliceKey(new Date("2026-07-20T08:00:00Z")), "mon:morning");
    assert.notEqual(
      timeSliceKey(new Date("2026-07-24T23:30:00Z")),
      timeSliceKey(new Date("2026-07-20T08:00:00Z")),
    );
  });

  it("uses the city's LOCAL clock — 7pm Cebu is fri:evening even though it is 11am UTC", () => {
    const sevenPmCebu = new Date("2026-07-24T11:00:00Z"); // Fri 19:00 Asia/Manila
    assert.equal(timeSliceKey(sevenPmCebu, "Cebu"), "fri:evening");
    // Without the city, the same instant buckets by UTC (Fri afternoon)
    assert.equal(timeSliceKey(sevenPmCebu), "fri:afternoon");
    // Crossing the date line: Fri 23:00 UTC is already Sat morning in Cebu
    assert.equal(timeSliceKey(new Date("2026-07-24T23:00:00Z"), "Cebu"), "sat:morning");
    // Case-insensitive city lookup
    assert.equal(timeSliceKey(sevenPmCebu, "cebu"), "fri:evening");
  });

  it("falls back to UTC for cities with no known timezone", () => {
    const at = new Date("2026-07-24T11:00:00Z");
    assert.equal(timeSliceKey(at, "Nowhereville"), timeSliceKey(at));
    assert.equal(timeSliceKey(at, null), timeSliceKey(at));
  });

  it("resolves brand-new cities from coordinates when the static map misses", () => {
    const sevenPmCebu = new Date("2026-07-24T11:00:00Z"); // Fri 19:00 Asia/Manila
    // Not in CITY_TIMEZONES, but coords near Cebu → Asia/Manila
    assert.equal(cityTimezone("Lapu-Lapu City", { lat: 10.31, lng: 123.95 }), "Asia/Manila");
    assert.equal(timeSliceKey(sevenPmCebu, "Lapu-Lapu City", { lat: 10.31, lng: 123.95 }), "fri:evening");
    // Once seen with coords, the city resolves even WITHOUT coords (learned cache)
    assert.equal(cityTimezone("lapu-lapu city"), "Asia/Manila");
    assert.equal(timeSliceKey(sevenPmCebu, "Lapu-Lapu City"), "fri:evening");
    assert.equal(localMonthKey(sevenPmCebu, "Lapu-Lapu City"), "07");
  });

  it("registerCityCoordinates teaches the resolver ahead of time", () => {
    registerCityCoordinates("Reykjanesbær", 63.99, -22.56);
    assert.equal(cityTimezone("reykjanesbær"), "Atlantic/Reykjavik");
  });

  it("still falls back honestly to UTC with missing or invalid coords", () => {
    const at = new Date("2026-07-24T11:00:00Z");
    assert.equal(cityTimezone("Totally Unknown Place"), null);
    assert.equal(cityTimezone("Totally Unknown Place", { lat: null, lng: null }), null);
    assert.equal(cityTimezone("Totally Unknown Place", { lat: 999, lng: 999 }), null);
    assert.equal(timeSliceKey(at, "Totally Unknown Place", { lat: 999, lng: 999 }), timeSliceKey(at));
    assert.equal(timezoneFromCoords(null, null), null);
    assert.equal(timezoneFromCoords(NaN, 10), null);
  });

  it("covers every seed popular city — none silently fall back to UTC", () => {
    // Guard: SEED_CITIES is what the popular-cities picker surfaces to every
    // fresh install. A seed city missing from CITY_TIMEZONES would skew its
    // day-of-week × daypart world model. When a seed is added, add its tz.
    for (const s of SEED_CITIES) {
      assert.ok(
        cityTimezone(s.name),
        `SEED_CITIES entry "${s.name}" has no timezone in CITY_TIMEZONES — add it to CompassGraphEngine.ts`,
      );
    }
  });

  it("covers the cities seen in real activity data", () => {
    // Snapshot of live user_stamps/events/trips/posts/profiles cities
    // (July 2026 audit) — each must resolve to a real IANA timezone.
    const liveCities = [
      "Miami", "Fort Lauderdale", "New York City", "Denver", "Vancouver",
      "Mexico City", "Rio de Janeiro", "Lisbon", "Barcelona", "Rome",
      "Dublin", "Zurich", "Interlaken", "Copenhagen", "Istanbul", "Oia",
      "Mumbai", "General Luna", "Ubud", "Cebu City", "Davao City",
      "El Nido", "Siargao", "Palawan", "Ho Chi Minh City", "Hanoi",
      "Hong Kong", "Taipei", "Bangkok", "Tokyo", "Seoul", "Singapore",
      "Bali", "London", "Paris", "Dubai", "Sydney", "Melbourne",
      "Los Angeles", "Berlin",
    ];
    const at = new Date("2026-07-24T11:00:00Z");
    for (const city of liveCities) {
      const tz = cityTimezone(city);
      assert.ok(tz, `live city "${city}" has no timezone in CITY_TIMEZONES`);
      // The tz must be valid — timeSliceKey should not throw or fall back oddly
      assert.match(timeSliceKey(at, city), /^(sun|mon|tue|wed|thu|fri|sat):(morning|afternoon|evening|night)$/);
    }
  });
  it("resolves variant/misspelled city names to their real city's timezone", () => {
    // Misspellings and variants collapse through canonicalCityKey — the map
    // itself no longer needs entries like "siargoa".
    assert.equal(cityTimezone("Siargoa"), "Asia/Manila");   // misspelled Siargao
    assert.equal(cityTimezone("Cebu City"), "Asia/Manila");
    assert.equal(cityTimezone("New York City"), "America/New_York");
    assert.equal(cityTimezone("NYC"), "America/New_York");
  });

  it("coords override a stale learned entry for ambiguous same-name cities", () => {
    // Two different real-world "Springfield"s: IL (America/Chicago) and
    // MA (America/New_York). Learning one must never shadow the other's
    // coordinates on later calls.
    const il = { lat: 39.7817, lng: -89.6501 }; // Springfield, IL
    const ma = { lat: 42.1015, lng: -72.5898 }; // Springfield, MA
    assert.equal(cityTimezone("Springfield", il), "America/Chicago");
    // Learned cache now holds Chicago — but MA coords must still win.
    assert.equal(cityTimezone("Springfield", ma), "America/New_York");
    // And back again — each call's coords are authoritative.
    assert.equal(cityTimezone("Springfield", il), "America/Chicago");
  });

  it("resolves timezones for CANONICAL keys — what graph builders actually store", () => {
    // Graph city nodes are keyed by canonicalCityKey, which strips generic
    // suffixes ("Mexico City" → "mexico"). Those canonical keys must resolve
    // to the same timezone as the raw names — no silent UTC fallback.
    const canonicalPairs: Array<[string, string]> = [
      ["mexico", "America/Mexico_City"],       // from "Mexico City"
      ["ho chi minh", "Asia/Ho_Chi_Minh"],     // from "Ho Chi Minh City"
      ["quezon", "Asia/Manila"],               // from "Quezon City"
      ["cebu", "Asia/Manila"],
      ["davao", "Asia/Manila"],
      ["new york", "America/New_York"],
      ["siargao", "Asia/Manila"],
    ];
    for (const [key, tz] of canonicalPairs) {
      assert.equal(cityTimezone(key), tz, `canonical key "${key}" must resolve`);
    }
    // Exhaustive guard: every raw map name's canonical form must still resolve
    // to the same timezone as the raw form.
    const rawNames = [
      "Mexico City", "Ho Chi Minh City", "Quezon City", "Cebu City",
      "Davao City", "New York City",
    ];
    for (const raw of rawNames) {
      const canon = canonicalCityKey(raw);
      assert.ok(canon, `canonicalCityKey("${raw}") should not be null`);
      assert.equal(cityTimezone(canon!), cityTimezone(raw), `"${raw}" vs canonical "${canon}"`);
    }
  });
});

/* ── Graph substrate ──────────────────────────────────────────────────────── */

describe("graph substrate — batch builders persist typed nodes/edges", () => {
  beforeEach(() => seed());

  it("persists people, cities, trips, events, vibes, behaviors, and outcomes", async () => {
    seedTravelData(fake.store);
    const report = await buildGraphFromSources(fake.fakeClient);
    assert.ok(report.nodesUpserted > 0);
    assert.ok(report.edgesUpserted > 0);

    const nodes = fake.store.compass_graph_nodes ?? [];
    const types = new Set(nodes.map((n) => n.node_type));
    for (const t of ["person", "city", "trip", "event", "time_slice", "vibe", "behavior", "outcome"]) {
      assert.ok(types.has(t), `expected node type ${t}`);
    }

    const edges = fake.store.compass_graph_edges ?? [];
    const edgeTypes = new Set(edges.map((e) => e.edge_type));
    for (const t of ["visited", "took_trip", "destination", "in_city", "has_vibe", "active_during:nightlife", "outcome:went", "behavior:save"]) {
      assert.ok(edgeTypes.has(t), `expected edge type ${t}`);
    }
  });

  it("persists cross-trip relationships — returning to a city creates returned_to", async () => {
    seedTravelData(fake.store);
    await buildGraphFromSources(fake.fakeClient);
    const edges = fake.store.compass_graph_edges ?? [];

    // USER_ID took two trips to Cebu → cross-trip edge persists
    const returned = edges.find(
      (e) => e.edge_type === "returned_to" && e.src_key === USER_ID && e.dst_key === "cebu",
    );
    assert.ok(returned, "returned_to edge should exist for the two-trip user");

    // USER_B has only one Baguio trip → no returned_to edge for them
    const notReturned = edges.find(
      (e) => e.edge_type === "returned_to" && e.src_key === USER_B,
    );
    assert.equal(notReturned, undefined);

    // Repeat observations accumulate on the visited edge (2 Cebu stamps)
    const visited = edges.find(
      (e) => e.edge_type === "visited" && e.src_key === USER_ID && e.dst_key === "cebu",
    );
    assert.ok(visited);
    assert.equal(visited!.observed_count, 2);
  });

  it("merges misspelled/variant city names into one canonical city node", async () => {
    const friEvening = "2026-07-24T11:00:00Z";
    fake.store.user_stamps = [
      { user_id: USER_ID, city: "Siargao",  country: "Philippines", earned_at: friEvening, is_revoked: false },
      { user_id: USER_B,  city: "Siargoa",  country: "Philippines", earned_at: friEvening, is_revoked: false }, // misspelling
      { user_id: USER_ID, city: "Cebu City", country: "Philippines", earned_at: friEvening, is_revoked: false },
      { user_id: USER_B,  city: "Cebu",      country: "Philippines", earned_at: friEvening, is_revoked: false },
      { user_id: USER_ID, city: "san",       country: "Philippines", earned_at: friEvening, is_revoked: false }, // junk fragment
    ];
    await buildGraphFromSources(fake.fakeClient);

    const cityNodes = (fake.store.compass_graph_nodes ?? [])
      .filter((n) => n.node_type === "city")
      .map((n) => n.node_key)
      .sort();
    assert.deepEqual(cityNodes, ["cebu", "siargao"], "variants collapse; junk rejected");

    // Both users' activity lands on the SAME siargao node — not split
    const siargaoVisits = (fake.store.compass_graph_edges ?? []).filter(
      (e) => e.edge_type === "visited" && e.dst_key === "siargao",
    );
    assert.equal(siargaoVisits.length, 2);
  });

  it("person nodes never carry profile attributes (privacy)", async () => {
    seedTravelData(fake.store);
    await buildGraphFromSources(fake.fakeClient);
    const people = (fake.store.compass_graph_nodes ?? []).filter((n) => n.node_type === "person");
    assert.ok(people.length > 0);
    for (const p of people) {
      assert.deepEqual(p.attrs, {}, "person node attrs must stay empty");
    }
  });

  it("rebuild is idempotent — running twice does not duplicate edges", async () => {
    seedTravelData(fake.store);
    await buildGraphFromSources(fake.fakeClient);
    const countAfterFirst = (fake.store.compass_graph_edges ?? []).length;
    await buildGraphFromSources(fake.fakeClient);
    assert.equal((fake.store.compass_graph_edges ?? []).length, countAfterFirst);
  });
});

/* ── Destination World Model ──────────────────────────────────────────────── */

describe("Destination World Model — time-sliced per-city profiles", () => {
  beforeEach(() => seed());

  it("derives day-of-week × daypart profiles from graph data", async () => {
    seedTravelData(fake.store);
    await buildGraphFromSources(fake.fakeClient);
    const modeled = await buildCityWorldModels(fake.fakeClient);
    assert.ok(modeled >= 2); // Cebu + Baguio

    const cebu = await getCityWorldModel(fake.fakeClient, "Cebu");
    assert.ok(cebu);
    const friEvening = cebu!.timeSlices["fri:evening"];
    const monMorning = cebu!.timeSlices["mon:morning"];
    assert.ok(friEvening, "Friday evening slice exists");
    assert.ok(monMorning, "Monday morning slice exists");
    // Friday evening in Cebu skews nightlife; Monday morning does not
    assert.ok((friEvening!.categories["nightlife"] ?? 0) > 0);
    assert.equal(friEvening!.categories["wellness"] ?? 0, 0);
    assert.ok((monMorning!.categories["wellness"] ?? 0) > 0);
    assert.equal(monMorning!.categories["nightlife"] ?? 0, 0);
  });

  it("records per-slice DISTINCT-actor counts from active_in edges (IG-07 k-anon)", async () => {
    // One activity signal (30 observations) but three DISTINCT people. The gate
    // must see 3 contributors, not 30 observations — otherwise a slice that is
    // really one person repeated would publish as 'community history'.
    // City stored verbatim from src_key by the rollup; use the normalized form
    // getCityWorldModel resolves to, so the lookup matches.
    fake.store.compass_graph_edges = [
      { id: "ad-1", src_type: "city",   src_key: "cebu", dst_type: "time_slice", dst_key: "cebu|fri:evening", edge_type: "active_during:nightlife", observed_count: 30 },
      { id: "ai-1", src_type: "person", src_key: "u1",   dst_type: "time_slice", dst_key: "cebu|fri:evening", edge_type: "active_in" },
      { id: "ai-2", src_type: "person", src_key: "u2",   dst_type: "time_slice", dst_key: "cebu|fri:evening", edge_type: "active_in" },
      { id: "ai-3", src_type: "person", src_key: "u3",   dst_type: "time_slice", dst_key: "cebu|fri:evening", edge_type: "active_in" },
    ];
    await buildCityWorldModels(fake.fakeClient);
    const cebu = await getCityWorldModel(fake.fakeClient, "cebu");
    const slice = cebu!.timeSlices["fri:evening"];
    assert.ok(slice, "slice exists");
    assert.equal(slice!.count, 30, "activity count comes from active_during observed_count");
    assert.equal(slice!.distinctActors, 3, "distinct-actor count comes from the deduped active_in edges");
  });

  it("world-model boost is time-varying: same item, different time, different boost", () => {
    const model: CityWorldModel = {
      city: "Cebu",
      timeSlices: {
        "fri:evening": { count: 10, categories: { nightlife: 8, food: 2 } },
        "mon:morning": { count: 6,  categories: { wellness: 6 } },
      },
      monthly: {},
      topCategories: ["nightlife"],
      sampleSize: 16,
      builtAt: new Date().toISOString(),
    };
    const bar: CompassItem = { id: "bar-1", type: "event", interestTags: ["nightlife"], city: "Cebu" } as CompassItem;

    // Instants chosen by CEBU local clock (UTC+8): Fri 20:00 local = 12:00Z
    const friday = worldModelBoostForItem(bar, model, new Date("2026-07-24T12:00:00Z"));
    const monday = worldModelBoostForItem(bar, model, new Date("2026-07-20T00:00:00Z"));

    assert.ok(friday.boost > 0, "nightlife boosted on Friday evening");
    assert.ok(friday.boost <= WORLD_MODEL_BOOST_MAX);
    assert.ok(friday.factor);
    assert.equal(friday.factor!.key, "city_rhythm");
    assert.equal(monday.boost, 0, "no nightlife boost on Monday morning");
    assert.equal(monday.factor, null);
  });

  it("under-sampled slices contribute no boost (honesty over noise)", () => {
    const model: CityWorldModel = {
      city: "Baguio",
      timeSlices: { "fri:evening": { count: MIN_SLICE_SAMPLE - 1, categories: { nightlife: 2 } } },
      monthly: {},
      topCategories: [],
      sampleSize: 2,
      builtAt: new Date().toISOString(),
    };
    const item: CompassItem = { id: "x", type: "event", interestTags: ["nightlife"] } as CompassItem;
    assert.equal(worldModelBoostForItem(item, model, new Date("2026-07-24T12:00:00Z")).boost, 0);
    assert.equal(worldModelBoostForItem(item, null, new Date()).boost, 0);
  });

  it("pipeline ranking consumes the world model — time slice reorders equal-scored items", async () => {
    const store = seed();
    const now = new Date();
    const currentSlice = timeSliceKey(now, "Cebu"); // boost lookup uses Cebu's local clock
    store.compass_city_models = [{
      city: "cebu", // world-model rows are keyed by canonical city key
      time_slices: { [currentSlice]: { count: 10, categories: { nightlife: 9 } } },
      monthly: {},
      top_categories: ["nightlife"],
      sample_size: 10,
      built_at: now.toISOString(),
    }];

    const profile = {
      userId: USER_ID, currentCity: "Cebu", preferredCities: [], preferredLanguages: [],
      travelStyles: [], socialStyle: null, safetyPreference: "standard", budgetStyle: null,
      visibilityPreference: "public", categoryWeights: null, ignoredItemIds: [],
      blockedUserIds: [], blockerUserIds: [], mutedUserIds: [],
    } as unknown as CompassProfile;
    const context = { contextState: "normal", signals: { hourUtc: 12 }, computedAt: now.toISOString() } as unknown as CompassContext;
    const items: CompassItem[] = [
      { id: "museum", type: "event", interestTags: ["museum"], city: "Cebu" } as CompassItem,
      { id: "club",   type: "event", interestTags: ["nightlife"], city: "Cebu" } as CompassItem,
    ];

    const summary = await runPipeline(items, profile, context, fake.fakeClient, {
      safetyFilter:     () => ({ allowed: true }),
      eligibilityCheck: () => ({ eligible: true }),
      scoreItem:        () => ({ finalScore: 50, components: {} as any }),
    });

    assert.equal(summary.passedCount, 2);
    assert.equal(summary.results[0]!.item.id, "club", "world-model city rhythm should rank the club first");
    assert.ok(summary.results[0]!.finalScore > summary.results[1]!.finalScore);
    assert.ok(summary.results[0]!.rankingFactors.some((f) => f.key === "city_rhythm"));

    // Same items, but the model's activity lives in a DIFFERENT slice → tie stands
    store.compass_city_models = [{
      city: "cebu",
      time_slices: { "__other:slice__": { count: 10, categories: { nightlife: 9 } } },
      monthly: {}, top_categories: ["nightlife"], sample_size: 10, built_at: now.toISOString(),
    }];
    const summary2 = await runPipeline(items, profile, context, fake.fakeClient, {
      safetyFilter:     () => ({ allowed: true }),
      eligibilityCheck: () => ({ eligible: true }),
      scoreItem:        () => ({ finalScore: 50, components: {} as any }),
    });
    assert.equal(summary2.results[0]!.finalScore, summary2.results[1]!.finalScore);
  });
});

/* ── City-confidence index ────────────────────────────────────────────────── */

describe("city-confidence index", () => {
  beforeEach(() => seed());

  it("scores depth from aggregate signals and maps tiers", () => {
    const deep = scoreCityDepth({ visitors: 120, returners: 40, events: 150, outcomes: 90, sliceCoverage: 0.8, sampleSize: 400 });
    const thin = scoreCityDepth({ visitors: 1, returners: 0, events: 1, outcomes: 0, sliceCoverage: 0.03, sampleSize: 2 });
    assert.ok(deep > 60, `deep score should exceed 60, got ${deep}`);
    assert.ok(thin < 30, `thin score should stay under 30, got ${thin}`);
    assert.equal(tierForScore(deep), "deep");
    assert.equal(tierForScore(thin), "thin");
    assert.equal(tierForScore(45), "moderate");
  });

  it("identifies the strongest launch city from real data", async () => {
    seedTravelData(fake.store);
    const report = await rebuildIntelligenceGraph(fake.fakeClient);
    assert.ok(report.citiesScored >= 2);
    assert.equal(report.strongestCity, "cebu"); // canonical city key

    const cebu = await getCityConfidence(fake.fakeClient, "Cebu");
    const baguio = await getCityConfidence(fake.fakeClient, "Baguio");
    assert.ok(cebu && baguio);
    assert.ok(cebu!.depthScore > baguio!.depthScore, "Cebu should be deeper than Baguio");
    // Signals are aggregate counts only — never user identifiers
    for (const v of Object.values(cebu!.signals)) assert.equal(typeof v, "number");
  });

  it("thin cities say so honestly; deep cities answer confidently (Phase 8 bridge)", () => {
    const thinNote = cityConfidenceNote({ city: "Baguio", depthScore: 5, tier: "thin", signals: {}, computedAt: "" }, "Baguio");
    const deepNote = cityConfidenceNote({ city: "Cebu", depthScore: 82, tier: "deep", signals: {}, computedAt: "" }, "Cebu");
    const unknownNote = cityConfidenceNote(null, "Nowhere");
    assert.match(thinNote, /Limited local data/);
    assert.match(unknownNote, /Limited local data/);
    assert.match(deepNote, /Deep local data/);
  });
});

/* ── Prompt context lines (privacy at read time) ──────────────────────────── */

describe("destination context lines", () => {
  beforeEach(() => seed());

  it("emits rhythm + confidence lines with aggregates only — no ids, no coordinates", async () => {
    seedTravelData(fake.store);
    await rebuildIntelligenceGraph(fake.fakeClient);
    const lines = await buildDestinationContextLines(fake.fakeClient, "Cebu", new Date("2026-07-24T11:30:00Z")); // Fri 19:30 Cebu local
    assert.ok(lines.length >= 2);
    const blob = lines.join("\n");
    assert.match(blob, /Destination rhythm — Cebu/);
    assert.match(blob, /City data confidence/);
    assert.ok(!blob.includes(USER_ID), "no user ids in prompt lines");
    assert.ok(!blob.includes(USER_B), "no user ids in prompt lines");
    assert.ok(!/lat|lng|latitude|longitude/i.test(blob), "no coordinates in prompt lines");
  });

  it("fails soft: no db / no city → no lines", async () => {
    assert.deepEqual(await buildDestinationContextLines(null, "Cebu"), []);
    assert.deepEqual(await buildDestinationContextLines(fake.fakeClient, null), []);
  });
});

/* ── Routes ───────────────────────────────────────────────────────────────── */

describe("graph routes", () => {
  beforeEach(() => seed());

  it("POST /api/compass/graph/rebuild is admin-only", async () => {
    const denied = await api("POST", "/compass/graph/rebuild");
    assert.equal(denied.status, 403);
    const unauth = await api("POST", "/compass/graph/rebuild", undefined, "bad-token");
    assert.equal(unauth.status, 401);

    seedTravelData(fake.store);
    const ok = await api("POST", "/compass/graph/rebuild", undefined, "admin-token");
    assert.equal(ok.status, 200);
    assert.ok(ok.json.nodesUpserted > 0);
    assert.ok(ok.json.edgesUpserted > 0);
    assert.equal(ok.json.strongestCity, "cebu"); // canonical city key
  });

  it("GET /api/compass/graph/status is admin-only and reports counts", async () => {
    const denied = await api("GET", "/compass/graph/status");
    assert.equal(denied.status, 403);

    seedTravelData(fake.store);
    await rebuildIntelligenceGraph(fake.fakeClient);
    const ok = await api("GET", "/compass/graph/status", undefined, "admin-token");
    assert.equal(ok.status, 200);
    assert.ok(ok.json.nodes > 0);
    assert.ok(ok.json.edges > 0);
    assert.ok(Array.isArray(ok.json.cities));
  });

  it("GET /api/compass/city-confidence requires auth + city, defaults honestly to thin", async () => {
    const unauth = await api("GET", "/compass/city-confidence?city=Cebu", undefined, "bad-token");
    assert.equal(unauth.status, 401);
    const missing = await api("GET", "/compass/city-confidence");
    assert.equal(missing.status, 400);

    const unknown = await api("GET", "/compass/city-confidence?city=Nowhere");
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.tier, "thin");
    assert.match(unknown.json.note, /Limited local data/);

    seedTravelData(fake.store);
    await rebuildIntelligenceGraph(fake.fakeClient);
    const cebu = await api("GET", "/compass/city-confidence?city=Cebu");
    assert.equal(cebu.status, 200);
    assert.equal(cebu.json.city, "Cebu");
    assert.ok(typeof cebu.json.depthScore === "number");
    // Aggregates only — response never includes user identifiers
    assert.ok(!JSON.stringify(cebu.json).includes(USER_ID));
  });
});

/* ── Learned-timezone persistence (survives restarts) ─────────────────────── */

describe("city timezone persistence", () => {
  beforeEach(() => {
    _resetCityTimezoneStateForTest();
  });

  after(() => {
    _resetCityTimezoneStateForTest();
  });

  it("persists learned entries and reloads them after a restart", async () => {
    const store: Record<string, Row[]> = { city_timezones: [] };
    const { fakeClient } = makeFakeClient(store);
    await initCityTimezonePersistence(fakeClient);

    // Learn Tbilisi from coordinates — not in the static map.
    registerCityCoordinates("Tbilisi", 41.7151, 44.8271);
    await new Promise((r) => setTimeout(r, 0)); // flush fire-and-forget upsert

    assert.equal(store.city_timezones!.length, 1);
    assert.equal(store.city_timezones![0]!.city_key, "tbilisi");
    assert.equal(store.city_timezones![0]!.timezone, "Asia/Tbilisi");

    // Simulate restart: in-memory cache wiped, no coords available anymore.
    _resetCityTimezoneStateForTest();
    assert.equal(cityTimezone("Tbilisi"), null);

    const loaded = await initCityTimezonePersistence(makeFakeClient(store).fakeClient);
    assert.equal(loaded, 1);
    assert.equal(cityTimezone("Tbilisi"), "Asia/Tbilisi");
  });

  it("coord-path learning in cityTimezone is also persisted", async () => {
    const store: Record<string, Row[]> = { city_timezones: [] };
    await initCityTimezonePersistence(makeFakeClient(store).fakeClient);

    assert.equal(cityTimezone("Reykjavik", { lat: 64.1466, lng: -21.9426 }), "Atlantic/Reykjavik");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(store.city_timezones!.length, 1);
    assert.equal(store.city_timezones![0]!.city_key, "reykjavik");
  });

  it("is fail-soft when the table is missing or the DB errors", async () => {
    const failing: any = {
      from: () => ({
        select: () => ({
          limit: () => Promise.reject(new Error("relation does not exist")),
        }),
      }),
    };
    const loaded = await initCityTimezonePersistence(failing);
    assert.equal(loaded, 0);
    // Learning still works in-memory even though persistence is broken.
    registerCityCoordinates("Tbilisi", 41.7151, 44.8271);
    assert.equal(cityTimezone("Tbilisi"), "Asia/Tbilisi");
  });

  it("static map stays authoritative over persisted rows", async () => {
    const store: Record<string, Row[]> = {
      city_timezones: [{ city_key: "cebu", timezone: "Europe/Paris" }],
    };
    await initCityTimezonePersistence(makeFakeClient(store).fakeClient);
    assert.equal(cityTimezone("Cebu"), "Asia/Manila");
  });

  it("popular seed places carry a real timezone instead of null", async () => {
    const places = await getPopularCities(null, { limit: 3 });
    assert.ok(places.length > 0);
    const cebu = places.find((p) => p.name === "Cebu City");
    assert.ok(cebu);
    assert.equal(cebu!.timezone, "Asia/Manila");
    for (const p of places) assert.equal(typeof p.timezone, "string");
  });
});

/* ── City-timezone table sweep (bounded persistence) ──────────────────────── */

// Dedicated mini-fake: unlike the shared fake it honors string ordering
// (ISO timestamps), lt filters, and head/count selects — the exact query
// surface the sweep and the boot loader depend on.
function makeTzFake(rows: Row[]) {
  const table = rows;
  return {
    from: (name: string) => {
      assert.equal(name, "city_timezones");
      const filters: Array<(r: Row) => boolean> = [];
      let _order: { key: string; asc: boolean } | null = null;
      let _limit: number | null = null;
      let _head = false;
      let _delete = false;
      const b: any = {
        select: (_cols?: string, opts?: { head?: boolean }) => { _head = !!opts?.head; return b; },
        order: (key: string, opts?: { ascending?: boolean }) => { _order = { key, asc: opts?.ascending !== false }; return b; },
        limit: (n: number) => { _limit = n; return b; },
        lt: (k: string, v: unknown) => { filters.push((r) => String(r[k] ?? "") < String(v)); return b; },
        delete: () => { _delete = true; return b; },
        then: (resolve: Function) => {
          let out = table.filter((r) => filters.every((f) => f(r)));
          if (_delete) {
            const kept = table.filter((r) => !out.includes(r));
            table.length = 0;
            table.push(...kept);
            return resolve({ data: null, error: null, count: out.length });
          }
          if (_order) {
            const { key, asc } = _order;
            out = [...out].sort((a, b2) => {
              const av = String(a[key] ?? ""), bv = String(b2[key] ?? "");
              return asc ? av.localeCompare(bv) : bv.localeCompare(av);
            });
          }
          if (_limit !== null) out = out.slice(0, _limit);
          return resolve({ data: _head ? null : out, error: null, count: table.length });
        },
      };
      return b;
    },
  } as any;
}

const TZ_CAP = 5000; // mirrors LEARNED_CITY_TZ_MAX

function tzRow(i: number, updatedAt: string): Row {
  return { city_key: `junkcity${i}`, timezone: "Asia/Manila", updated_at: updatedAt };
}

describe("city_timezones table sweep", () => {
  beforeEach(() => _resetCityTimezoneStateForTest());
  after(() => _resetCityTimezoneStateForTest());

  it("no-ops when the table is within the cap", async () => {
    const rows = [tzRow(1, "2020-01-01T00:00:00.000Z"), tzRow(2, "2020-01-02T00:00:00.000Z")];
    const deleted = await sweepCityTimezoneTable(makeTzFake(rows));
    assert.equal(deleted, 0);
    assert.equal(rows.length, 2);
  });

  it("deletes old rows beyond the newest cap, keeping recently-updated ones", async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // 1 day ago
    const ancient = "2020-01-01T00:00:00.000Z"; // far beyond the age window
    const rows: Row[] = [];
    for (let i = 0; i < TZ_CAP; i++) rows.push(tzRow(i, recent));
    rows.push(tzRow(TZ_CAP, ancient), tzRow(TZ_CAP + 1, ancient));

    const deleted = await sweepCityTimezoneTable(makeTzFake(rows));
    assert.equal(deleted, 2);
    assert.equal(rows.length, TZ_CAP);
    assert.ok(rows.every((r) => r.updated_at === recent), "only the ancient overflow rows are removed");
  });

  it("never purges recently-updated rows even when the table overshoots the cap", async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const rows: Row[] = [];
    for (let i = 0; i < TZ_CAP + 3; i++) rows.push(tzRow(i, recent)); // all fresh
    const deleted = await sweepCityTimezoneTable(makeTzFake(rows));
    assert.equal(deleted, 0);
    assert.equal(rows.length, TZ_CAP + 3);
  });

  it("is fail-soft: null client and throwing client both return 0", async () => {
    assert.equal(await sweepCityTimezoneTable(null), 0);
    const throwing: any = { from: () => { throw new Error("db down"); } };
    assert.equal(await sweepCityTimezoneTable(throwing), 0);
  });

  it("boot load prefers most-recently-updated rows when the table exceeds the cap", async () => {
    const rows: Row[] = [];
    // junkcity0 is the OLDEST — with cap+1 rows it must be the one left out.
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i <= TZ_CAP; i++) {
      rows.push(tzRow(i, new Date(base + i * 1000).toISOString()));
    }
    const loaded = await initCityTimezonePersistence(makeTzFake(rows));
    assert.equal(loaded, TZ_CAP);
    assert.equal(cityTimezone("junkcity0"), null, "oldest row is dropped");
    assert.equal(cityTimezone(`junkcity${TZ_CAP}`), "Asia/Manila", "newest row is loaded");
    assert.equal(cityTimezone("junkcity1"), "Asia/Manila");
  });
});

/* ── One-time cleanup: non-canonical city rows ────────────────────────────── */

/** Seed leftover pre-canonicalization rows across all four graph tables. */
function seedStaleGraphRows(store: Record<string, Row[]>) {
  store.compass_graph_nodes = [
    // Canonical rows — must survive.
    { id: "n-1", node_type: "city", node_key: "cebu", city: "cebu" },
    { id: "n-2", node_type: "time_slice", node_key: "cebu|fri:evening", city: "cebu" },
    { id: "n-3", node_type: "person", node_key: USER_ID, city: null },
    // Stale variants + junk — must be removed.
    { id: "n-4", node_type: "city", node_key: "siargoa", city: "siargoa" },
    { id: "n-5", node_type: "city", node_key: "cebu city", city: "cebu city" },
    { id: "n-6", node_type: "city", node_key: "san", city: "san" },
    { id: "n-7", node_type: "time_slice", node_key: "siargoa|fri:evening", city: "siargoa" },
  ];
  store.compass_graph_edges = [
    { id: "e-1", src_type: "person", src_key: USER_ID, dst_type: "city", dst_key: "cebu", edge_type: "visited" },
    { id: "e-2", src_type: "person", src_key: USER_ID, dst_type: "city", dst_key: "siargoa", edge_type: "visited" },
    { id: "e-3", src_type: "city", src_key: "siargoa", dst_type: "time_slice", dst_key: "siargoa|fri:evening", edge_type: "active_during:exploring" },
    { id: "e-4", src_type: "city", src_key: "cebu", dst_type: "time_slice", dst_key: "cebu|fri:evening", edge_type: "active_during:exploring" },
    { id: "e-5", src_type: "person", src_key: USER_ID, dst_type: "city", dst_key: "san", edge_type: "visited" },
  ];
  store.compass_city_models = [
    { id: "m-1", city: "cebu", time_slices: {}, monthly: {}, top_categories: [], sample_size: 3 },
    { id: "m-2", city: "siargoa", time_slices: {}, monthly: {}, top_categories: [], sample_size: 1 },
    { id: "m-3", city: "new york city", time_slices: {}, monthly: {}, top_categories: [], sample_size: 1 },
  ];
  store.compass_city_confidence = [
    { id: "c-1", city: "cebu", depth_score: 40, tier: "moderate" },
    { id: "c-2", city: "siargoa", depth_score: 5, tier: "thin" },
    { id: "c-3", city: "san", depth_score: 1, tier: "thin" },
  ];
}

describe("cleanup — leftover non-canonical city rows", () => {
  beforeEach(() => seed());

  it("removes variant/junk city rows from all four tables, keeps canonical rows", async () => {
    seedStaleGraphRows(fake.store);
    const report = await cleanupNonCanonicalCityRows(fake.fakeClient);

    const nodeKeys = (fake.store.compass_graph_nodes ?? []).map((n) => n.node_key);
    assert.deepEqual(nodeKeys.sort(), [USER_ID, "cebu", "cebu|fri:evening"].sort());

    const edgeIds = (fake.store.compass_graph_edges ?? []).map((e) => e.id);
    assert.deepEqual(edgeIds.sort(), ["e-1", "e-4"]);

    assert.deepEqual((fake.store.compass_city_models ?? []).map((m) => m.city), ["cebu"]);
    assert.deepEqual((fake.store.compass_city_confidence ?? []).map((c) => c.city), ["cebu"]);

    assert.equal(report.nodesDeleted, 4);
    assert.equal(report.edgesDeleted, 3);
    assert.equal(report.modelsDeleted, 2);
    assert.equal(report.confidenceDeleted, 2);
    assert.deepEqual(report.removedCityKeys, ["cebu city", "new york city", "san", "siargoa"]);
  });

  it("is idempotent — a second run finds nothing stale", async () => {
    seedStaleGraphRows(fake.store);
    await cleanupNonCanonicalCityRows(fake.fakeClient);
    const second = await cleanupNonCanonicalCityRows(fake.fakeClient);
    assert.equal(second.nodesDeleted, 0);
    assert.equal(second.edgesDeleted, 0);
    assert.equal(second.modelsDeleted, 0);
    assert.equal(second.confidenceDeleted, 0);
    assert.deepEqual(second.removedCityKeys, []);
  });

  it("rebuild after cleanup leaves only canonical city keys in all four tables", async () => {
    seedStaleGraphRows(fake.store);
    seedTravelData(fake.store);
    // A stamp under a misspelled city — the rebuild must fold it into "siargao".
    (fake.store.user_stamps ?? []).push(
      { user_id: USER_B, city: "Siargoa", country: "Philippines", earned_at: "2026-07-24T11:00:00Z", is_revoked: false },
    );

    await cleanupNonCanonicalCityRows(fake.fakeClient);
    await rebuildIntelligenceGraph(fake.fakeClient);

    const badKey = (k: unknown) => canonicalCityKey(String(k)) !== String(k);
    const cityNodes = (fake.store.compass_graph_nodes ?? []).filter((n) => n.node_type === "city");
    assert.ok(cityNodes.length > 0);
    assert.ok(cityNodes.every((n) => !badKey(n.node_key)));
    assert.ok(cityNodes.some((n) => n.node_key === "siargao"));

    const cityEdgeKeys = (fake.store.compass_graph_edges ?? [])
      .flatMap((e) => [
        e.src_type === "city" ? e.src_key : null,
        e.dst_type === "city" ? e.dst_key : null,
      ])
      .filter((k): k is string => !!k);
    assert.ok(cityEdgeKeys.every((k) => !badKey(k)));

    assert.ok((fake.store.compass_city_models ?? []).every((m) => !badKey(m.city)));
    assert.ok((fake.store.compass_city_confidence ?? []).every((c) => !badKey(c.city)));
  });

  it("POST /api/compass/graph/cleanup is admin-only and returns cleanup + rebuild reports", async () => {
    const denied = await api("POST", "/compass/graph/cleanup");
    assert.equal(denied.status, 403);
    const unauth = await api("POST", "/compass/graph/cleanup", undefined, "bad-token");
    assert.equal(unauth.status, 401);

    seedStaleGraphRows(fake.store);
    seedTravelData(fake.store);
    const ok = await api("POST", "/compass/graph/cleanup", undefined, "admin-token");
    assert.equal(ok.status, 200);
    assert.ok(ok.json.cleanup.nodesDeleted > 0);
    assert.ok(ok.json.cleanup.removedCityKeys.includes("siargoa"));
    assert.ok(ok.json.rebuild.nodesUpserted > 0);
  });
});
