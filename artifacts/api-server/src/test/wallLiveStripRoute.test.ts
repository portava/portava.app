/**
 * The Live For You strip, AS THE ROUTES ACTUALLY SERVE IT (spec §4 / TABLE 0).
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Every strip producer had unit coverage, and the route-level wiring had none.
 * Deleting the producers from the array `assembleLiveCandidates` returns —
 * `return [...tripSignals, ...events, ...social, ...gems, ...buddies, ...placeState]`
 * — left the WHOLE backend suite green: the only route-level `liveForYou`
 * assertions in the repo were in wallRouteDegradation.test.ts, and all of those
 * assert the strip is `[]`. So a refactor could silently unwire all five resolved
 * kinds and nothing would say so. These tests drive the REAL routers over HTTP
 * against a seeded corpus and assert the strip's KIND SET, which is exactly the
 * thing that mutation removed.
 *
 * AND THE FLAG MUST GATE THE READS, NOT JUST THE OUTPUT
 * ====================================================
 * `assembleLiveCandidates` used to be awaited unconditionally and its result
 * thrown away when `wall_live_for_you_enabled` was off, so a flagged-off first
 * page still paid for the block read, the places read, up to two spatial event
 * probes with their per-row privacy pass, and three trip reads — precisely the
 * TABLE 4 cost the strip is supposed to bound. The last two tests count reads by
 * table and pin that an OFF flag costs zero of them.
 *
 * Run: node --import tsx/esm --test src/test/wallLiveStripRoute.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const HOST = "host-1";

const NOW_MS = Date.now();
const at = (minutes: number) => new Date(NOW_MS + minutes * 60_000).toISOString();

// ── The corpus ───────────────────────────────────────────────────────────────
//
// Five places, each engineered to produce exactly ONE resolved kind, so the
// strip's kind set is a direct readout of which producers ran:
//
//   place-1  trip_signal      — a saved stop on the viewer's own trip, with a
//                               milestone happening now
//   place-2  event_state      — an event on now, at the venue
//   place-3  social_presence  — two distinct followed authors posted there
//   place-4  hidden_gem       — an active, public gem that is quiet right now
//   place-5  buddy            — the only place in a city with a buddy available
//
// Priority order in assembleLiveCandidates is trip → event → social → gem →
// buddy → place_state, and the strip caps at MAX_LIVE_FOR_YOU (4). So the first
// four kinds fill it, and buddy is proven separately with the higher-priority
// producers starved (see "buddy" below).

const PLACES = [
  { id: "place-1", name: "Trip Stop", city: "Da Nang", country_code: "VN",
    latitude: 16.05, longitude: 108.20, status: "active", merged_into_place_id: null },
  { id: "place-2", name: "Event Venue", city: "Da Nang", country_code: "VN",
    latitude: 16.10, longitude: 108.25, status: "active", merged_into_place_id: null },
  { id: "place-3", name: "Social Spot", city: "Da Nang", country_code: "VN",
    latitude: 16.15, longitude: 108.30, status: "active", merged_into_place_id: null },
  { id: "place-4", name: "Gem Cove", city: "Da Nang", country_code: "VN",
    latitude: 16.20, longitude: 108.35, status: "active", merged_into_place_id: null },
  { id: "place-5", name: "Buddy Town", city: "Bangkok", country_code: "TH",
    latitude: 13.75, longitude: 100.50, status: "active", merged_into_place_id: null },
];

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, display_name: "Viewer", username: "viewer", avatar_url: null,
    account_status: "active", current_city: "Da Nang", home_city: "Da Nang", interests: ["food"] },
};
for (const a of ["author-1", "author-2", "author-3"]) {
  PROFILES[a] = { id: a, display_name: a, username: a, avatar_url: null, account_status: "active" };
}

/** Newest first: post order fixes the place order the /wall/live strip probes,
 *  and MAX_EVENT_PROBE_PLACES is 2 — so the event place must be in the first two. */
const POSTS = [
  { id: "post-1", author_id: "author-1", place: "place-1", minutes: -5 },
  { id: "post-2", author_id: "author-1", place: "place-2", minutes: -10 },
  { id: "post-3", author_id: "author-2", place: "place-3", minutes: -15 },
  { id: "post-4", author_id: "author-3", place: "place-3", minutes: -20 },
  { id: "post-5", author_id: "author-1", place: "place-4", minutes: -25 },
  { id: "post-6", author_id: "author-1", place: "place-5", minutes: -30 },
].map((p) => ({
  id: p.id, author_id: p.author_id, trip_id: null,
  content: `Post at ${p.place}`, visibility: "public", status: "active", post_status: "published",
  created_at: at(p.minutes), published_at: at(p.minutes),
  canonical_place_id: p.place, has_video: false, media_count: 1, category: "food",
  location_city: PLACES.find((x) => x.id === p.place)!.city, location_country: "VN",
  like_count: 1, comment_count: 0, save_count: 0,
}));

/** One event ON NOW at EVERY place's exact coordinate. The producer probes only
 *  the first two feed places, and For You ranking decides which those are — so
 *  seeding all five keeps the /wall assertion order-independent while the
 *  per-place haversine bound still admits exactly the one at the probed place. */
const EVENTS = PLACES.map((p) => ({
  id: `event-at-${p.id}`, host_id: HOST, title: `Party at ${p.name}`, location_name: p.name,
  location_lat: p.latitude, location_lng: p.longitude, show_exact_location: true,
  starts_at: at(-30), ends_at: at(90), cover_url: null, visibility: "public", state: "open",
  age_min: null, age_max: null, trust_score_min: null, verified_only: false,
}));

const HIDDEN_GEMS = [{
  id: "gem-1", canonical_place_id: "place-4", sensitivity_level: "public",
  verification_level: "community", status: "active", crowd_level: "quiet",
  save_count: 0, visit_count: 0, updated_at: at(-60),
  latitude: 16.20, longitude: 108.35, approx_latitude: 16.2, approx_longitude: 108.35, image_url: null,
}];

const RENT_BUDDY_PROFILES = [{ id: "rb-1", city: "Bangkok", categories: [] }];

const TRIP_MEMBERS = [{ trip_id: "trip-1", user_id: VIEWER, status: "accepted", role: "member" }];
const TRIP_SAVED_PLACES = [{ trip_id: "trip-1", place_id: "place-1", lat: 16.05, lng: 108.20 }];
const TRIP_PLAN_ITEMS = [{
  id: "tpi-1", trip_id: "trip-1", title: "Sunset meetup", category: "meeting_point",
  status: "active", source_type: "manual", source_id: null,
  starts_at: at(-10), ends_at: at(60), lat: 16.05, lng: 108.20,
  location_is_private: false, removed_at: null, visibility: "members",
}];

const BASE_TABLES: Record<string, any[]> = {
  posts: POSTS,
  places: PLACES,
  profiles: Object.values(PROFILES),
  user_follows: [{ following_id: "author-1" }, { following_id: "author-2" }, { following_id: "author-3" }],
  trip_members: TRIP_MEMBERS,
  trip_saved_places: TRIP_SAVED_PLACES,
  trip_plan_items: TRIP_PLAN_ITEMS,
  events: EVENTS,
  hidden_gems: HIDDEN_GEMS,
  rent_buddy_profiles: RENT_BUDDY_PROFILES,
  blocks: [],
};

const BASE_FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: true,
  wall_rab_integration_enabled: true,
  // RAB needs BOTH: the Wall's own integration flag AND the product master
  // (`rent_buddy_enabled`, re-read inside buildBuddyLiveCandidates via
  // wallRabGate). The default world has both ON so the buddy kind is exercised;
  // the two tests below turn each one off independently.
  rent_buddy_enabled: true,
  wall_input_intelligence_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_context_threads_enabled: false,
  events_trust_gates_enabled: false,
};

// ── Fake client ──────────────────────────────────────────────────────────────

/** Reads issued since the last reset, by table — the flag-gating assertions. */
let reads: string[] = [];

/**
 * A table-routed fake. Row filters are accepted and ignored (each producer
 * re-applies its own membership checks in JS, which is what makes a whole-table
 * fake safe here); `maybeSingle` is honoured for the two tables whose single-row
 * reads actually steer behaviour.
 */
function client(tables: Record<string, any[]>, flags: Record<string, boolean>) {
  function builder(table: string) {
    reads.push(table);
    const f: Record<string, any> = {};
    const b: any = {
      select: () => b, neq: () => b, in: () => b, not: () => b, is: () => b, or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, order: () => b, limit: () => b,
      range: () => b,
      eq(col: string, val: any) { f[col] = val; return b; },
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!flags[String(f["flag"])] }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: PROFILES[String(f["id"])] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: any, onR: any) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

function useWorld(
  opts: { tables?: Record<string, any[]>; flags?: Record<string, boolean> } = {},
) {
  _clearPromotedScopeCache();
  _setTestClient(
    client({ ...BASE_TABLES, ...(opts.tables ?? {}) }, { ...BASE_FLAGS, ...(opts.flags ?? {}) }),
    true,
  );
  reads = [];
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl = "";

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const kindsOf = (strip: any[]) => new Set(strip.map((i) => i.liveObjectType));

describe("Live For You strip — the routes serve the full multi-kind set (§4/TABLE 0)", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  beforeEach(() => useWorld());

  it("GET /wall/live serves trip_signal, event_state, social_presence and hidden_gem", async () => {
    const res = await get("/api/wall/live?limit=4");
    assert.equal(res.status, 200);
    const strip = res.json.liveForYou as any[];
    // The guard against a vacuous assertion: the strip must not be empty.
    assert.ok(strip.length > 0, "the seeded corpus must produce a strip");
    assert.deepEqual(
      [...kindsOf(strip)].sort(),
      ["event_state", "hidden_gem", "social_presence", "trip_signal"],
      `strip kinds were ${JSON.stringify(strip.map((i) => [i.liveObjectType, i.subjectId]))}`,
    );
    const bySubject = new Map(strip.map((i) => [i.subjectId, i]));
    assert.equal(bySubject.get("place-1")!.liveObjectType, "trip_signal");
    assert.equal(bySubject.get("place-2")!.liveObjectType, "event_state");
    assert.equal(bySubject.get("place-3")!.liveObjectType, "social_presence");
    assert.equal(bySubject.get("place-4")!.liveObjectType, "hidden_gem");
  });

  it("GET /wall serves the same multi-kind strip alongside the feed", async () => {
    const res = await get("/api/wall?mode=for_you");
    assert.equal(res.status, 200);
    assert.ok(res.json.items.length >= 5, "the feed itself is intact");
    const kinds = kindsOf(res.json.liveForYou as any[]);
    // For You ranking picks which places the (bounded) event probe sees, so this
    // asserts the KIND is wired, not which place won.
    assert.ok(kinds.has("trip_signal"), `no trip_signal in ${[...kinds]}`);
    assert.ok(kinds.has("event_state"), `no event_state in ${[...kinds]}`);
    assert.ok(kinds.has("social_presence"), `no social_presence in ${[...kinds]}`);
    assert.ok(kinds.has("hidden_gem"), `no hidden_gem in ${[...kinds]}`);
  });

  it("the buddy kind is wired too — it fills a slot once the higher priorities are absent", async () => {
    // With no trip milestone and no event, the strip's four slots are social,
    // gem and buddy (the only resolved kinds left).
    useWorld({ tables: { trip_plan_items: [], events: [] } });
    const res = await get("/api/wall/live?limit=4");
    assert.equal(res.status, 200);
    const kinds = kindsOf(res.json.liveForYou as any[]);
    assert.ok(kinds.has("buddy"), `no buddy in ${[...kinds]}`);
    assert.ok(kinds.has("social_presence") && kinds.has("hidden_gem"));
    assert.ok(!kinds.has("event_state") && !kinds.has("trip_signal"));
  });

  it("the buddy kind stays behind the Wall's RAB integration flag", async () => {
    useWorld({ tables: { trip_plan_items: [], events: [] }, flags: { wall_rab_integration_enabled: false } });
    const res = await get("/api/wall/live?limit=4");
    assert.ok(!kindsOf(res.json.liveForYou as any[]).has("buddy"));
  });

  it("the buddy kind stays behind the RAB MASTER too, even with the Wall flag on", async () => {
    // The Wall flag is necessary, never sufficient: a globally disabled product
    // must not be advertised by the strip (wallRabGate).
    useWorld({
      tables: { trip_plan_items: [], events: [] },
      flags: { wall_rab_integration_enabled: true, rent_buddy_enabled: false },
    });
    const res = await get("/api/wall/live?limit=4");
    assert.ok(!kindsOf(res.json.liveForYou as any[]).has("buddy"));
  });

  it("no strip item carries a coordinate for anyone (§23)", async () => {
    const res = await get("/api/wall/live?limit=4");
    const raw = JSON.stringify(res.json.liveForYou);
    for (const n of ["16.05", "16.10", "16.15", "16.20", "13.75", "108.2", "108.25", "100.5"]) {
      assert.ok(!raw.includes(n), `strip leaked the coordinate fragment ${n}: ${raw}`);
    }
    for (const item of res.json.liveForYou as any[]) {
      // The coarse ref and nothing else — no latitude/longitude field may exist.
      assert.deepEqual(Object.keys(item.subject ?? {}).sort(), ["city", "country", "name", "placeId"]);
    }
  });

  it("a predicted/scheduled item is never labelled an observation (§37)", async () => {
    const res = await get("/api/wall/live?limit=4");
    for (const item of res.json.liveForYou as any[]) {
      if (item.liveObjectType !== "event_state" && item.liveObjectType !== "trip_signal") continue;
      assert.equal(item.state, "emerging", "a schedule is never a live observation");
      assert.notEqual(item.freshness, "live");
      assert.equal(item.confidence, null, "a schedule carries no fabricated confidence");
    }
  });
});

describe("wall_live_for_you_enabled gates the strip's READS, not just its output", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  /** Tables ONLY the strip's producers read on the /wall path. */
  const PRODUCER_ONLY = ["events", "trip_saved_places", "trip_plan_items", "meetups"];

  it("GET /wall pays for the producers when the flag is ON, and for none of them when it is OFF", async () => {
    useWorld();
    let on = await get("/api/wall?mode=for_you");
    assert.equal(on.status, 200);
    // The positive control: with the flag ON these reads DO happen, so the
    // negative assertion below is measuring something real.
    const onReads = reads.slice();
    assert.ok(onReads.includes("events"), "flag ON must probe events");
    assert.ok(onReads.includes("trip_saved_places"), "flag ON must read trip saved stops");
    assert.ok((on.json.liveForYou as any[]).length > 0, "flag ON must produce a strip");

    useWorld({ flags: { wall_live_for_you_enabled: false } });
    const off = await get("/api/wall?mode=for_you");
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.liveForYou, [], "flag OFF serves no strip");
    assert.ok(off.json.items.length >= 5, "flag OFF still serves the whole social feed");
    const offReads = reads.slice();
    for (const t of PRODUCER_ONLY) {
      assert.ok(
        !offReads.includes(t),
        `wall_live_for_you_enabled is OFF but the first page still read "${t}" ` +
          `(${offReads.filter((x) => x === t).length}x) — the flag must disable the WORK, not just the output`,
      );
    }
    assert.ok(offReads.length < onReads.length, "a flagged-off page must be strictly cheaper");
  });

  it("GET /wall/live costs nothing but its flag reads when the flag is OFF", async () => {
    useWorld({ flags: { wall_live_for_you_enabled: false } });
    const res = await get("/api/wall/live?limit=4");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.liveForYou, []);
    // The strip IS this route's response: with it off, nothing beyond the flag
    // reads and requireUser's own ban check may happen — not the viewer context,
    // not the followed-content window, not one producer.
    assert.deepEqual(
      [...new Set(reads)].sort(),
      ["feature_flags", "profiles"],
      `a flagged-off /wall/live read ${JSON.stringify([...new Set(reads)])}`,
    );
  });
});
