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
} from "../compass/CompassGraphEngine.js";
import { SEED_CITIES } from "../lib/popularCities.js";
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
          return (resolve: Function) =>
            resolve({ data: result(), error: null, count: result().length });
        }
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
    { id: "evt-1", city: "Cebu", category: "nightlife", start_at: friEvening },
    { id: "evt-2", city: "Cebu", category: "nightlife", start_at: "2026-07-17T12:00:00Z" }, // Fri 20:00 Cebu — also Fri evening local
    { id: "evt-3", city: "Cebu", category: "wellness",  start_at: monMorning },
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
      (e) => e.edge_type === "returned_to" && e.src_key === USER_ID && e.dst_key === "Cebu",
    );
    assert.ok(returned, "returned_to edge should exist for the two-trip user");

    // USER_B has only one Baguio trip → no returned_to edge for them
    const notReturned = edges.find(
      (e) => e.edge_type === "returned_to" && e.src_key === USER_B,
    );
    assert.equal(notReturned, undefined);

    // Repeat observations accumulate on the visited edge (2 Cebu stamps)
    const visited = edges.find(
      (e) => e.edge_type === "visited" && e.src_key === USER_ID && e.dst_key === "Cebu",
    );
    assert.ok(visited);
    assert.equal(visited!.observed_count, 2);
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
      city: "Cebu",
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
      city: "Cebu",
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
    assert.equal(report.strongestCity, "Cebu");

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
    assert.equal(ok.json.strongestCity, "Cebu");
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
