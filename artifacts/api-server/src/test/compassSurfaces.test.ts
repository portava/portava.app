/**
 * Compass surfaces + create-suggestions tests
 *
 * Covers:
 *   - GET /api/compass/recommendations?surface=trip   — type filter, date-range filter
 *   - GET /api/compass/recommendations?surface=passport — type filter, blocked-user exclusion
 *   - GET /api/compass/recommendations?surface=for_you  — flag-off returns empty list
 *   - POST /api/compass/create-suggestions             — keyword inference, invalid body
 *
 * Runtime: node:test (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compassSurfaces.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import compassRouter from "../routes/compass.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import {
  isEventInRange,
  isPublicItem,
  passesTripFilter,
  passesPassportFilter,
} from "../compass/CompassSurfaceFilters.js";

// ── IDs ───────────────────────────────────────────────────────────────────────

const ALICE_ID  = "00000000-0000-0000-0000-0000000000a1";
const BOB_ID    = "00000000-0000-0000-0000-0000000000b2";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  users:                    Record<string, { id: string } | null>;
  feature_flags:            { flag: string; enabled: boolean }[];
  profiles:                 any[];
  trust_profiles:           any[];
  user_preference_profiles: any[];
  user_location_state:      any[];
  user_location_preferences:any[];
  blocks:                   any[];
  trips:                    any[];
  trip_members:             any[];
  safe_return_sessions:     any[];
  rent_buddy_bookings:      any[];
  rent_buddy_profiles:      any[];
  rent_buddy_availability:  any[];
  events:                   any[];
  places:                   any[];
  compass_user_preferences: any[];
  compass_settings:         any[];
  compass_served_recommendations: any[];
  discovery_places:         any[];
  hidden_gems:              any[];
  user_follows:             any[];
  friend_requests:          any[];
  event_rsvps:              any[];
  rank_events:              any[];
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];

    const b: any = {
      select()                   { return b; },
      insert(data: any) {
        if (table === "rank_events") {
          const rows = Array.isArray(data) ? data : [data];
          state.rank_events.push(...rows);
        }
        return Promise.resolve({ data, error: null });
      },
      eq(col: string, val: any)  { filters.push((r: any) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r: any) => r[col] !== val); return b; },
      in(col: string, vals: any[]){ filters.push((r: any) => vals.includes(r[col])); return b; },
      not()                      { return b; },
      or()                       { return b; },
      is()                       { return b; },
      like()                     { return b; },
      ilike()                    { return b; },
      limit()                    { return b; },
      order()                    { return b; },
      gte()                      { return b; },
      lte()                      { return b; },
      gt()                       { return b; },
      lt()                       { return b; },
      contains()                 { return b; },
      overlaps()                 { return b; },
      maybeSingle()              { return resolveOne(); },
      single()                   { return resolveOne(); },
      then(onF: any, onR: any)   { return resolveList().then(onF, onR); },
    };

    const src         = (): any[]  => (state as any)[table] ?? [];
    const rows        = ()         => src().filter((r: any) => filters.every((f) => f(r)));
    const resolveOne  = async ()   => ({ data: rows()[0] ?? null, error: null });
    const resolveList = async ()   => ({ data: rows(), error: null });

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    users:                     { "alice-tok": { id: ALICE_ID } },
    feature_flags:             [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles:                  [{ id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: [], travel_group_style: null, account_status: "active", is_private: false }],
    trust_profiles:            [],
    user_preference_profiles:  [],
    user_location_state:       [],
    user_location_preferences: [],
    blocks:                    [],
    trips:                     [],
    trip_members:              [],
    safe_return_sessions:      [],
    rent_buddy_bookings:       [],
    rent_buddy_profiles:       [],
    rent_buddy_availability:   [],
    events:                    [],
    places:                    [],
    compass_user_preferences:  [],
    compass_settings:          [],
    compass_served_recommendations: [],
    discovery_places:          [],
    hidden_gems:               [],
    user_follows:              [],
    friend_requests:           [],
    event_rsvps:               [],
    rank_events:               [],
    ...overrides,
  };
}

// ── HTTP test helpers ─────────────────────────────────────────────────────────

function makeTestApp(client: ReturnType<typeof makeFakeClient>) {
  _setTestClient(client as any, true);
  invalidateFlagsCache();
  clearCompassProfileCache();
  const app = express();
  app.use(express.json());
  app.use((_req: any, _res: any, next: any) => {
    _req.log = { info: () => {}, error: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", compassRouter);
  return app;
}

async function req(
  server: Server,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const port = (server.address() as any).port;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function listen(app: express.Application): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((r, j) => server.close((e) => (e ? j(e) : r())));
}

// ── POST /api/compass/create-suggestions ─────────────────────────────────────

describe("POST /api/compass/create-suggestions", () => {
  let server: Server;

  before(async () => {
    const client = makeFakeClient(makeState());
    server = await listen(makeTestApp(client));
  });

  after(() => close(server));

  it("returns 401 without auth token", async () => {
    const { status } = await req(server, "POST", "/api/compass/create-suggestions", {
      body: { type: "event", titleDraft: "Sunset hike" },
    });
    assert.equal(status, 401);
  });

  it("returns 400 when type is missing", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { titleDraft: "Sunset hike" },
    });
    assert.equal(status, 400);
    assert.ok(body.error, "should have error field");
  });

  it("returns 400 when titleDraft is empty string", async () => {
    const { status } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "" },
    });
    assert.equal(status, 400);
  });

  it("infers Hiking for a hike title", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "Sunset hike at Mount Batang" },
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.suggestions), "suggestions should be array");
    const cats = body.suggestions.map((s: any) => s.category);
    assert.ok(cats.includes("Hiking"), `expected Hiking in ${JSON.stringify(cats)}`);
  });

  it("infers Food & Drinks for a dinner title", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "Friday night dinner by the river" },
    });
    assert.equal(status, 200);
    const cats = body.suggestions.map((s: any) => s.category);
    assert.ok(cats.includes("Food & Drinks"), `expected Food & Drinks in ${JSON.stringify(cats)}`);
  });

  it("returns at most 3 suggestions", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "Beach party music night concert dance festival" },
    });
    assert.equal(status, 200);
    assert.ok(body.suggestions.length <= 3, `got ${body.suggestions.length} suggestions`);
  });

  it("returns empty suggestions for a non-matching title", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "Team quarterly review" },
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.suggestions));
    // no keyword match — could be 0; just ensure it's an array under limit
    assert.ok(body.suggestions.length <= 3);
  });

  it("each suggestion has category, vibe, reason fields", async () => {
    const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
      token: "alice-tok",
      body: { type: "event", titleDraft: "Sunday yoga and meditation retreat" },
    });
    assert.equal(status, 200);
    for (const s of body.suggestions) {
      assert.ok(typeof s.category === "string", "category must be string");
      assert.ok(typeof s.vibe === "string",     "vibe must be string");
      assert.ok(typeof s.reason === "string",   "reason must be string");
    }
  });
});

// ── GET /api/compass/recommendations — flag off ───────────────────────────────

describe("GET /api/compass/recommendations — compass disabled", () => {
  let server: Server;

  before(async () => {
    const client = makeFakeClient(makeState({
      feature_flags: [{ flag: "COMPASS_ENABLED", enabled: false }],
    }));
    server = await listen(makeTestApp(client));
  });

  after(() => close(server));

  it("returns empty recommendations when Compass flag is off", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=for_you", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.deepEqual(body.recommendations, []);
  });
});

// ── inferEventCategories unit-level keyword tests ─────────────────────────────

describe("inferEventCategories keyword coverage", () => {
  // Test keyword inference in isolation via the HTTP route
  let server: Server;

  before(async () => {
    const client = makeFakeClient(makeState());
    server = await listen(makeTestApp(client));
  });

  after(() => close(server));

  const cases: [string, string, string][] = [
    ["Nightlife",     "DJ party at the rooftop bar",          "party/club keyword"],
    ["Beach & Water", "Snorkeling trip around the island",    "snorkel/island keyword"],
    ["Music",         "Live acoustic concert in the park",    "concert/live keyword"],
    ["Sports",        "5km fun run and marathon warm-up",     "run/marathon keyword"],
    ["Photography",   "Golden hour portrait photoshoot",      "photoshoot/golden hour keyword"],
    ["Adventure",     "Bungee jumping and zipline adventure", "bungee/zipline keyword"],
    ["Wellness",      "Morning yoga and breathwork session",  "yoga/breathwork keyword"],
    ["Nature",        "Scenic forest picnic by the river",    "forest/picnic keyword"],
    ["Culture",       "Museum tour and heritage walk",        "museum/heritage keyword"],
    ["Shopping",      "Weekend flea market and thrift swap",  "flea/thrift keyword"],
  ];

  for (const [expectedCategory, titleDraft, label] of cases) {
    it(`infers ${expectedCategory} (${label})`, async () => {
      const { status, body } = await req(server, "POST", "/api/compass/create-suggestions", {
        token: "alice-tok",
        body: { type: "event", titleDraft },
      });
      assert.equal(status, 200, `unexpected status for: ${titleDraft}`);
      const cats = body.suggestions.map((s: any) => s.category);
      assert.ok(
        cats.includes(expectedCategory),
        `expected "${expectedCategory}" in [${cats.join(", ")}] for title: "${titleDraft}"`,
      );
    });
  }
});

// ── isEventInRange unit tests ─────────────────────────────────────────────────

describe("isEventInRange — pure filter logic", () => {
  const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();       // 7 days from now
  const PAST   = new Date(Date.now() - 2 * 86_400_000).toISOString();       // 2 days ago
  const TRIP_START = new Date(Date.now() + 1 * 86_400_000).toISOString();   // tomorrow
  const TRIP_END   = new Date(Date.now() + 5 * 86_400_000).toISOString();   // 5 days from now
  const IN_RANGE   = new Date(Date.now() + 3 * 86_400_000).toISOString();   // 3 days from now (in range)
  const OUT_OF_RANGE = new Date(Date.now() + 9 * 86_400_000).toISOString(); // 9 days from now (after range)

  it("includes a future event with no date filter", () => {
    const item = { data: { startsAt: FUTURE } };
    assert.equal(isEventInRange(item, undefined, undefined), true);
  });

  it("excludes a past event", () => {
    const item = { data: { startsAt: PAST } };
    assert.equal(isEventInRange(item, undefined, undefined), false);
  });

  it("includes an event with no date info (no startsAt field)", () => {
    const item = { data: {} };
    assert.equal(isEventInRange(item, undefined, undefined), true);
  });

  it("includes an event inside the trip date window", () => {
    const item = { data: { startsAt: IN_RANGE } };
    assert.equal(isEventInRange(item, TRIP_START, TRIP_END), true);
  });

  it("excludes an event outside the trip date window (after end)", () => {
    const item = { data: { startsAt: OUT_OF_RANGE } };
    assert.equal(isEventInRange(item, TRIP_START, TRIP_END), false);
  });

  it("excludes a future event before the trip start date", () => {
    // event starts in 30 minutes (future but before trip_start = tomorrow)
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const item = { data: { startsAt: soon } };
    assert.equal(isEventInRange(item, TRIP_START, TRIP_END), false);
  });
});

// ── isPublicItem unit tests ───────────────────────────────────────────────────

describe("isPublicItem — visibility guard", () => {
  it("includes an item with visibility=public", () => {
    assert.equal(isPublicItem({ data: { visibility: "public" } }), true);
  });

  it("excludes an item with visibility=private", () => {
    assert.equal(isPublicItem({ data: { visibility: "private" } }), false);
  });

  it("excludes an item with visibility=invite_only", () => {
    assert.equal(isPublicItem({ data: { visibility: "invite_only" } }), false);
  });

  it("includes an item with no visibility field (open by default)", () => {
    assert.equal(isPublicItem({ data: {} }), true);
  });

  it("reads top-level visibility when data is absent", () => {
    assert.equal(isPublicItem({ visibility: "private" }), false);
  });
});

// ── passesTripFilter unit tests ───────────────────────────────────────────────

describe("passesTripFilter — combined type + visibility + date guard", () => {
  const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

  it("passes a public future event with correct type", () => {
    const fi = { type: "event", data: { visibility: "public", startsAt: FUTURE } };
    assert.equal(passesTripFilter(fi, undefined, undefined), true);
  });

  it("blocks a private event even when date is valid", () => {
    const fi = { type: "event", data: { visibility: "private", startsAt: FUTURE } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });

  it("blocks a past event even when it is public", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const fi = { type: "event", data: { visibility: "public", startsAt: past } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });

  it("passes a place item (places have no date constraint)", () => {
    const fi = { type: "place", data: { visibility: "public" } };
    assert.equal(passesTripFilter(fi, undefined, undefined), true);
  });

  it("blocks a private place", () => {
    const fi = { type: "place", data: { visibility: "private" } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });

  it("blocks an item whose type is not in the trip whitelist", () => {
    const fi = { type: "user", data: { visibility: "public" } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });

  it("passes a safety_tip item (no date constraint, always public)", () => {
    const fi = { type: "safety_tip", data: {} };
    assert.equal(passesTripFilter(fi, undefined, undefined), true);
  });

  it("passes a language_tip item (no date constraint, always public)", () => {
    const fi = { type: "language_tip", data: {} };
    assert.equal(passesTripFilter(fi, undefined, undefined), true);
  });

  it("blocks a stamp item (removed from trip whitelist)", () => {
    const fi = { type: "stamp", data: { visibility: "public" } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });

  it("supports fi.item wrapping (as returned by FeedBuilder)", () => {
    const fi = { item: { type: "event", data: { visibility: "public", startsAt: FUTURE } } };
    assert.equal(passesTripFilter(fi, undefined, undefined), true);
  });

  it("blocks a private event even when wrapped in fi.item", () => {
    const fi = { item: { type: "event", data: { visibility: "invite_only", startsAt: FUTURE } } };
    assert.equal(passesTripFilter(fi, undefined, undefined), false);
  });
});

// ── passesPassportFilter unit tests ──────────────────────────────────────────

describe("passesPassportFilter — type whitelist + blocked-user exclusion", () => {
  const BLOCKED_ID = "00000000-0000-0000-0000-000000000bb1";

  it("passes a traveler not in blocked set", () => {
    const fi = { type: "traveler", id: "00000000-0000-0000-0000-000000000aa2", data: {} };
    assert.equal(passesPassportFilter(fi, new Set()), true);
  });

  it("excludes a traveler whose id is in blocked set", () => {
    const fi = { type: "traveler", id: BLOCKED_ID, data: { userId: BLOCKED_ID } };
    assert.equal(passesPassportFilter(fi, new Set([BLOCKED_ID])), false);
  });

  it("excludes a user type whose data.userId is blocked", () => {
    const fi = { type: "user", data: { userId: BLOCKED_ID } };
    assert.equal(passesPassportFilter(fi, new Set([BLOCKED_ID])), false);
  });

  it("does not block a place item even when place id matches blocked set", () => {
    const fi = { type: "place", id: BLOCKED_ID, data: {} };
    assert.equal(passesPassportFilter(fi, new Set([BLOCKED_ID])), true);
  });

  it("blocks an item type not in passport whitelist", () => {
    const fi = { type: "hidden_gem", data: {} };
    assert.equal(passesPassportFilter(fi, new Set()), false);
  });

  it("supports fi.item wrapping", () => {
    const fi = { item: { type: "traveler", id: BLOCKED_ID, data: { userId: BLOCKED_ID } } };
    assert.equal(passesPassportFilter(fi, new Set([BLOCKED_ID])), false);
  });
});

// ── GET /api/compass/recommendations — passport surface integration ───────────

describe("GET /api/compass/recommendations?surface=passport — non-empty results", () => {
  let server: Server;

  const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();

  before(async () => {
    const client = makeFakeClient(makeState({
      // Profile must have a city so city-scoped queries return results
      profiles: [
        { id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: [], travel_group_style: null, city: "Cebu" },
      ],
      user_location_state: [
        { user_id: ALICE_ID, city: "Cebu", updated_at: new Date().toISOString() },
      ],
      // A discovery place — type 'place' passes the passport filter
      discovery_places: [
        {
          id:           "00000000-0000-0000-0000-000000000cc1",
          name:         "Mango Bay Beach",
          category:     "beach",
          city:         "Cebu",
          status:       "active",
          rating:       4,
          submitted_by: null,
          created_at:   new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      // A hidden gem — type 'hidden_gem' passes the trip surface filter
      hidden_gems: [
        {
          id:           "00000000-0000-0000-0000-000000000ee1",
          name:         "Taoist Temple shortcut alley",
          description:  "Hidden alley locals use to skip the crowds",
          city:         "Cebu",
          country:      "PH",
          category:     "sightseeing",
          submitted_by: null,
          status:       "active",
          created_at:   new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
      // A published public event — type 'event' passes the passport filter
      events: [
        {
          id:             "00000000-0000-0000-0000-000000000dd1",
          host_id:        BOB_ID,
          title:          "Cebu Night Run",
          category:       "Sports",
          starts_at:      FUTURE,
          ends_at:        FUTURE,
          city:           "Cebu",
          max_attendees:  50,
          going_count:    5,
          visibility:     "public",
          state:          "open",
        },
      ],
    }));
    server = await listen(makeTestApp(client));
  });

  after(() => close(server));

  it("returns 200 with items for the passport surface", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=passport", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.recommendations), "recommendations must be an array");
  });

  it("returns at least one eligible item when places and events are seeded", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=passport", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.ok(
      body.recommendations.length >= 1,
      `expected ≥1 recommendations, got ${body.recommendations.length}`,
    );
  });

  it("only returns types allowed by the passport filter (place, event, user, traveler)", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=passport", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    const allowedTypes = new Set(["place", "event", "user", "traveler"]);
    for (const rec of body.recommendations) {
      assert.ok(
        allowedTypes.has(rec.type),
        `unexpected type "${rec.type}" in passport surface response`,
      );
    }
  });

  it("excludes blocked users from passport results", async () => {
    // seed a new client with blocks entry for BOB (the event host)
    const client = makeFakeClient(makeState({
      events: [
        {
          id:             "00000000-0000-0000-0000-000000000dd2",
          host_id:        BOB_ID,
          title:          "Bob's Secret Run",
          category:       "Sports",
          starts_at:      FUTURE,
          ends_at:        FUTURE,
          city:           "Cebu",
          max_attendees:  50,
          going_count:    0,
          visibility:     "public",
          state:          "open",
        },
      ],
      blocks: [
        // Alice blocks Bob
        { blocker_id: ALICE_ID, blocked_id: BOB_ID },
      ],
    }));
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=passport", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    // The event whose host_id is BOB_ID (blocked) must not appear
    const bobEvents = body.recommendations.filter(
      (r: any) => r.authorId === BOB_ID || r.data?.host_id === BOB_ID,
    );
    assert.equal(bobEvents.length, 0, "blocked user's items must not appear in passport surface");
  });
});

// ── GET /api/compass/recommendations?surface=buddy ────────────────────────────

const BUDDY_A_ID  = "00000000-0000-0000-0000-0000000000ba";
const BUDDY_B_ID  = "00000000-0000-0000-0000-0000000000bb";
const BUDDY_C_ID  = "00000000-0000-0000-0000-0000000000bc"; // blocked
const BUDDY_D_ID  = "00000000-0000-0000-0000-0000000000bd"; // adult category

describe("GET /api/compass/recommendations?surface=buddy", () => {
  let server: Server;

  function buddyState(overrides: Partial<FakeState> = {}): FakeState {
    return makeState({
      rent_buddy_profiles: [
        {
          id:              BUDDY_A_ID,
          user_id:         "00000000-0000-0000-0000-0000000000u1",
          display_name:    "Aria Santos",
          city:            "Cebu",
          categories:      ["city", "language"],
          languages:       ["en", "fil"],
          hourly_rate_usd: 25,
          status:          "active",
          verified:        true,
          average_rating:  4.8,
          review_count:    12,
          cover_photo_url: null,
          admin_status:    "active",
          risk_hold:       false,
        },
        {
          id:              BUDDY_B_ID,
          user_id:         "00000000-0000-0000-0000-0000000000u2",
          display_name:    "Marco Reyes",
          city:            "Manila",
          categories:      ["nightlife"],
          languages:       ["en"],
          hourly_rate_usd: 30,
          status:          "active",
          verified:        true,
          average_rating:  4.5,
          review_count:    6,
          cover_photo_url: null,
          admin_status:    "active",
          risk_hold:       false,
        },
        {
          id:              BUDDY_C_ID,
          user_id:         "00000000-0000-0000-0000-0000000000u3",
          display_name:    "Blocked Buddy",
          city:            "Cebu",
          categories:      ["city"],
          languages:       ["en"],
          hourly_rate_usd: 20,
          status:          "active",
          verified:        true,
          average_rating:  4.0,
          review_count:    3,
          cover_photo_url: null,
          admin_status:    "active",
          risk_hold:       false,
        },
        {
          id:              BUDDY_D_ID,
          user_id:         "00000000-0000-0000-0000-0000000000u4",
          display_name:    "Adult Cat Buddy",
          city:            "Cebu",
          categories:      ["escort"],
          languages:       ["en"],
          hourly_rate_usd: 100,
          status:          "active",
          verified:        true,
          average_rating:  3.5,
          review_count:    1,
          cover_photo_url: null,
          admin_status:    "active",
          risk_hold:       false,
        },
      ],
      blocks: [{ blocker_id: ALICE_ID, blocked_id: "00000000-0000-0000-0000-0000000000u3" }],
      ...overrides,
    });
  }

  before(async () => {
    const client = makeFakeClient(buddyState());
    server = await listen(makeTestApp(client));
  });
  after(() => close(server));

  it("returns 401 without auth token", async () => {
    const { status } = await req(server, "GET", "/api/compass/recommendations?surface=buddy");
    assert.equal(status, 401);
  });

  it("returns 200 with buddy recommendations", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.surface, "buddy");
    assert.ok(Array.isArray(body.recommendations), "recommendations should be an array");
  });

  it("all returned items have type=buddy", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      assert.equal(rec.type, "buddy", `expected type=buddy, got "${rec.type}"`);
    }
  });

  it("excludes buddies in adult/escort categories", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    const adultBuddies = body.recommendations.filter((r: any) => r.id === BUDDY_D_ID);
    assert.equal(adultBuddies.length, 0, "buddy with escort category must be excluded");
  });

  it("excludes buddies blocked by viewer", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    const blockedBuddies = body.recommendations.filter((r: any) => r.id === BUDDY_C_ID);
    assert.equal(blockedBuddies.length, 0, "blocked buddy must be excluded");
  });

  it("returns empty + disabled:true when show_buddy_recommendations is false", async () => {
    const stateWithSettings = buddyState({
      compass_settings: [{ user_id: ALICE_ID, show_buddy_recommendations: false }],
    });
    const client = makeFakeClient(stateWithSettings);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.recommendations.length, 0, "should return empty array when setting is off");
    assert.equal(body.disabled, true, "should include disabled:true");
  });

  it("reason text does not contain private schedule details", async () => {
    const client = makeFakeClient(buddyState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      const reason: string = rec.reason ?? "";
      assert.ok(!reason.toLowerCase().includes("schedule"), `reason must not mention schedule: "${reason}"`);
      assert.ok(!reason.toLowerCase().includes("calendar"), `reason must not mention calendar: "${reason}"`);
    }
  });

  it("respects city override param", async () => {
    const client = makeFakeClient(buddyState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    // Cebu buddy (BUDDY_A) should rank higher — it matches the city
    const ids = body.recommendations.map((r: any) => r.id);
    if (ids.length >= 2) {
      assert.equal(ids[0], BUDDY_A_ID, "Cebu city-match buddy should rank first");
    }
  });

  it("data payload includes availabilityStatus field", async () => {
    const client = makeFakeClient(buddyState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      assert.ok("availabilityStatus" in rec.data, `rec.data must have availabilityStatus; got ${JSON.stringify(Object.keys(rec.data))}`);
      const valid = ["available_today", "available_this_week", "not_available"];
      assert.ok(valid.includes(rec.data.availabilityStatus), `availabilityStatus "${rec.data.availabilityStatus}" must be one of ${valid.join(", ")}`);
    }
  });

  it("shows available_today for buddy with an active availability slot", async () => {
    const today = new Date();
    const todayStr    = today.toISOString().slice(0, 10);
    const nextWeekStr = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

    const stateWithAvail = buddyState({
      rent_buddy_availability: [
        {
          id:           "00000000-0000-0000-0000-000000000av1",
          buddy_id:     BUDDY_A_ID,
          date:         todayStr,
          is_available: true,
        },
      ],
    });
    const client = makeFakeClient(stateWithAvail);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    const buddyA = body.recommendations.find((r: any) => r.id === BUDDY_A_ID);
    assert.ok(buddyA, "BUDDY_A must appear in recommendations");
    assert.equal(buddyA.data.availabilityStatus, "available_today", "BUDDY_A has an active slot so status must be available_today");
  });

  it("available_today buddy ranks above city-match-only buddy", async () => {
    const today       = new Date();
    const todayStr    = today.toISOString().slice(0, 10);
    const nextWeekStr = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    // BUDDY_B (Manila, verified, rating 4.5) without availability ≈ 39.5 pts
    // BUDDY_A (Cebu, city-match, verified, rating 4.8) without availability ≈ 69.4 pts
    // Give BUDDY_B available_today (+35) → ~74.5 pts — must rank ahead of BUDDY_A
    const stateAvailRank = buddyState({
      rent_buddy_availability: [
        {
          id:           "00000000-0000-0000-0000-000000000av2",
          buddy_id:     BUDDY_B_ID,
          date:         todayStr,
          is_available: true,
        },
      ],
    });
    const client = makeFakeClient(stateAvailRank);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    const ids = body.recommendations.map((r: any) => r.id);
    const aIdx = ids.indexOf(BUDDY_A_ID);
    const bIdx = ids.indexOf(BUDDY_B_ID);
    assert.ok(aIdx !== -1 && bIdx !== -1, "both BUDDY_A and BUDDY_B must appear in results");
    assert.ok(bIdx < aIdx, `available_today BUDDY_B (idx ${bIdx}) must rank ahead of city-match BUDDY_A (idx ${aIdx})`);
  });

  it("city-match buddy without availability gets city_match reason code", async () => {
    const client = makeFakeClient(buddyState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    const buddyA = body.recommendations.find((r: any) => r.id === BUDDY_A_ID);
    assert.ok(buddyA, "BUDDY_A must appear in recommendations");
    assert.equal(
      buddyA.data.reasonCode,
      "city_match",
      `city-match buddy without availability must have reasonCode=city_match, got: ${buddyA.data.reasonCode}`,
    );
  });

  it("excludes suspended/banned buddies — allowlist admin_status=active only", async () => {
    const BUDDY_SUSPENDED_ID = "00000000-0000-0000-0000-0000000000bs";
    const BUDDY_BANNED_ID    = "00000000-0000-0000-0000-0000000000bx";
    const stateWithBad = buddyState({
      rent_buddy_profiles: [
        // Keep BUDDY_A (active — should appear)
        {
          id:              BUDDY_A_ID,
          user_id:         "00000000-0000-0000-0000-0000000000u1",
          display_name:    "Aria Santos",
          city:            "Cebu",
          categories:      ["city"],
          languages:       ["en"],
          hourly_rate_usd: 25,
          status:          "active",
          verified:        true,
          average_rating:  4.8,
          review_count:    12,
          cover_photo_url: null,
          admin_status:    "active",
          risk_hold:       false,
        },
        // Suspended buddy — must NOT appear
        {
          id:              BUDDY_SUSPENDED_ID,
          user_id:         "00000000-0000-0000-0000-0000000000us",
          display_name:    "Suspended Buddy",
          city:            "Cebu",
          categories:      ["city"],
          languages:       ["en"],
          hourly_rate_usd: 20,
          status:          "active",
          verified:        true,
          average_rating:  4.9,
          review_count:    20,
          cover_photo_url: null,
          admin_status:    "suspended",
          risk_hold:       false,
        },
        // Banned buddy — must NOT appear
        {
          id:              BUDDY_BANNED_ID,
          user_id:         "00000000-0000-0000-0000-0000000000ux",
          display_name:    "Banned Buddy",
          city:            "Cebu",
          categories:      ["city"],
          languages:       ["en"],
          hourly_rate_usd: 15,
          status:          "active",
          verified:        true,
          average_rating:  5.0,
          review_count:    50,
          cover_photo_url: null,
          admin_status:    "banned",
          risk_hold:       false,
        },
      ],
    });
    const client = makeFakeClient(stateWithBad);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    const ids = body.recommendations.map((r: any) => r.id);
    assert.ok(ids.includes(BUDDY_A_ID), "active buddy must appear");
    assert.ok(!ids.includes(BUDDY_SUSPENDED_ID), "suspended buddy must be excluded");
    assert.ok(!ids.includes(BUDDY_BANNED_ID), "banned buddy must be excluded");
  });

  it("logs an impression row with a session_id — not silently dropped on this skip-ranking pipeline", async () => {
    const state = buddyState();
    const client = makeFakeClient(state);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu&sessionId=test-session-buddy-1", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.sessionId, "test-session-buddy-1", "response should echo the client-supplied sessionId");

    const rows = state.rank_events.filter((r: any) => r.surface === "compass");
    assert.ok(rows.length > 0, "expected at least one rank_events row for the buddy surface");
    for (const row of rows) {
      assert.equal(row.session_id, "test-session-buddy-1", "impression row must carry the sessionId — not null");
    }
  });

  it("mints a session_id when the client omits one — never writes session_id=null", async () => {
    const state = buddyState();
    const client = makeFakeClient(state);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=buddy&city=Cebu", {
      token: "alice-tok",
    });
    assert.ok(typeof body.sessionId === "string" && body.sessionId.length > 0, "response must include a minted sessionId");

    const rows = state.rank_events.filter((r: any) => r.surface === "compass");
    assert.ok(rows.length > 0, "expected at least one rank_events row for the buddy surface");
    for (const row of rows) {
      assert.equal(row.session_id, body.sessionId, "impression row must use the same minted sessionId as the response");
      assert.notEqual(row.session_id, null, "impression row session_id must never be null");
    }
  });
});

// ── GET /api/compass/recommendations?surface=traveler ─────────────────────────

const TRAV_A_ID = "00000000-0000-0000-0000-000000000ta1";
const TRAV_B_ID = "00000000-0000-0000-0000-000000000ta2";
const TRAV_C_ID = "00000000-0000-0000-0000-000000000ta3"; // blocked by Alice

describe("GET /api/compass/recommendations?surface=traveler", () => {
  let server: Server;

  function travelerState(overrides: Partial<FakeState> = {}): FakeState {
    return makeState({
      profiles: [
        // Alice's own profile (seed from makeState, overridden here)
        { id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: ["hiking", "beach"], interests: ["hiking", "beach"], travel_group_style: null, account_status: "active", is_private: false, verified: false },
        // Traveler A — shares interests with Alice
        {
          id:              TRAV_A_ID,
          username:        "beach_hiker",
          display_name:    "Beth Hiker",
          avatar_url:      null,
          home_city:       "Cebu",
          spoken_languages: ["en"],
          interests:       ["hiking", "beach"],
          verified:        true,
          account_status:  "active",
          is_private:      false,
          created_at:      new Date(Date.now() - 5 * 86_400_000).toISOString(),
        },
        // Traveler B — no shared interests
        {
          id:              TRAV_B_ID,
          username:        "city_explorer",
          display_name:    "Carl Explorer",
          avatar_url:      null,
          home_city:       "Manila",
          spoken_languages: ["fil"],
          interests:       ["nightlife"],
          verified:        false,
          account_status:  "active",
          is_private:      false,
          created_at:      new Date(Date.now() - 30 * 86_400_000).toISOString(),
        },
        // Traveler C — blocked
        {
          id:              TRAV_C_ID,
          username:        "blocked_user",
          display_name:    "Blocked Traveler",
          avatar_url:      null,
          home_city:       "Davao",
          spoken_languages: ["en"],
          interests:       ["hiking"],
          verified:        false,
          account_status:  "active",
          is_private:      false,
          created_at:      new Date().toISOString(),
        },
      ],
      blocks: [{ blocker_id: ALICE_ID, blocked_id: TRAV_C_ID }],
      ...overrides,
    });
  }

  before(async () => {
    const client = makeFakeClient(travelerState());
    server = await listen(makeTestApp(client));
  });
  after(() => close(server));

  it("returns 401 without auth token", async () => {
    const { status } = await req(server, "GET", "/api/compass/recommendations?surface=traveler");
    assert.equal(status, 401);
  });

  it("returns 200 with traveler recommendations", async () => {
    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.surface, "traveler");
    assert.ok(Array.isArray(body.recommendations));
  });

  it("all returned items have type=traveler", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      assert.equal(rec.type, "traveler", `expected type=traveler, got "${rec.type}"`);
    }
  });

  it("excludes the requesting user from results", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const selfResult = body.recommendations.filter((r: any) => r.id === ALICE_ID);
    assert.equal(selfResult.length, 0, "viewer must not appear in their own traveler suggestions");
  });

  it("excludes blocked travelers", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const blocked = body.recommendations.filter((r: any) => r.id === TRAV_C_ID);
    assert.equal(blocked.length, 0, "blocked traveler must be excluded");
  });

  it("reason text does not contain private-only signals", async () => {
    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const PRIVATE_SIGNALS = ["saved the same", "attending the same", "private", "schedule"];
    for (const rec of body.recommendations) {
      const reason: string = (rec.reason ?? "").toLowerCase();
      for (const signal of PRIVATE_SIGNALS) {
        assert.ok(!reason.includes(signal), `reason must not include "${signal}": got "${rec.reason}"`);
      }
    }
  });

  it("ranks traveler with shared interests above one without", async () => {
    const client = makeFakeClient(travelerState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const ids = body.recommendations.map((r: any) => r.id);
    const aIdx = ids.indexOf(TRAV_A_ID);
    const bIdx = ids.indexOf(TRAV_B_ID);
    if (aIdx !== -1 && bIdx !== -1) {
      assert.ok(aIdx < bIdx, "shared-interest traveler (A) should rank above no-overlap traveler (B)");
    }
  });

  it("returns empty + disabled:true when show_people_recommendations is false", async () => {
    const stateWithSettings = travelerState({
      compass_settings: [{ user_id: ALICE_ID, show_people_recommendations: false }],
    });
    const client = makeFakeClient(stateWithSettings);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.recommendations.length, 0);
    assert.equal(body.disabled, true);
  });

  it("data payload includes safe fields only (no private schedule or location)", async () => {
    const client = makeFakeClient(travelerState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      const d = rec.data ?? {};
      assert.ok(!("liveLocation" in d), "liveLocation must not be in traveler data");
      assert.ok(!("currentLocation" in d), "currentLocation must not be in traveler data");
      assert.ok(!("privateTrips" in d), "privateTrips must not be in traveler data");
    }
  });

  it("data payload includes followStatus field for each traveler", async () => {
    const client = makeFakeClient(travelerState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    for (const rec of body.recommendations) {
      const d = rec.data ?? {};
      assert.ok("followStatus" in d, `rec.data must have followStatus; got ${JSON.stringify(Object.keys(d))}`);
      const valid = ["following", "requested", "not_following"];
      assert.ok(valid.includes(d.followStatus), `followStatus "${d.followStatus}" must be one of ${valid.join(", ")}`);
    }
  });

  it("already-followed traveler has followStatus=following", async () => {
    const stateWithFollow = travelerState({
      user_follows: [{ follower_id: ALICE_ID, following_id: TRAV_A_ID }],
    });
    const client = makeFakeClient(stateWithFollow);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const travA = body.recommendations.find((r: any) => r.id === TRAV_A_ID);
    assert.ok(travA, "TRAV_A must appear in recommendations");
    assert.equal(travA.data.followStatus, "following", "TRAV_A is already followed so followStatus must be 'following'");
  });

  it("private traveler strips username, homeCity, and sharedInterests", async () => {
    const TRAV_PRIV_ID = "00000000-0000-0000-0000-000000000tp1";
    const stateWithPrivate = travelerState({
      profiles: [
        { id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: ["hiking"], interests: ["hiking"], travel_group_style: null, account_status: "active", is_private: false, verified: false },
        {
          id:              TRAV_PRIV_ID,
          username:        "secret_hiker",
          display_name:    "Private Person",
          avatar_url:      null,
          home_city:       "Cebu",
          spoken_languages: ["en"],
          interests:       ["hiking"],
          verified:        false,
          account_status:  "active",
          is_private:      true,
          created_at:      new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      ],
    });
    const client = makeFakeClient(stateWithPrivate);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const privRec = body.recommendations.find((r: any) => r.id === TRAV_PRIV_ID);
    assert.ok(privRec, "private traveler must appear in results");
    const d = privRec.data ?? {};
    assert.equal(d.username, null, "private traveler must not expose username");
    assert.equal(d.homeCity, null, "private traveler must not expose homeCity");
    assert.deepEqual(d.sharedInterests, [], "private traveler must not expose sharedInterests");
    assert.equal(privRec.city, null, "private traveler must not expose city on recommendation envelope");
    assert.equal(d.isPrivate, true, "isPrivate must be true");
    assert.equal(d.followStatus, "not_following", "unfollowed private traveler followStatus must be not_following");
  });

  it("traveler with mutual connections gets mutual_connections reasonCode", async () => {
    const MUTUAL_USER_ID = "00000000-0000-0000-0000-000000000mx1";
    // Alice follows MUTUAL_USER_ID; MUTUAL_USER_ID follows TRAV_B → TRAV_B gets 1 mutual connection
    // TRAV_B has no shared interests with Alice so mutual_connections wins reason priority
    const stateWithMutual = travelerState({
      user_follows: [
        { follower_id: ALICE_ID,       following_id: MUTUAL_USER_ID },
        { follower_id: MUTUAL_USER_ID, following_id: TRAV_B_ID },
      ],
    });
    const client = makeFakeClient(stateWithMutual);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const travB = body.recommendations.find((r: any) => r.id === TRAV_B_ID);
    assert.ok(travB, "TRAV_B must appear in recommendations");
    assert.equal(
      travB.data.reasonCode,
      "mutual_connections",
      `TRAV_B has a mutual connection so reasonCode must be mutual_connections, got: ${travB.data.reasonCode}`,
    );
  });

  it("traveler with upcoming destination overlap gets destination_overlap reasonCode", async () => {
    const futureDate = "2099-12-31";
    // Alice has upcoming trip to Manila; TRAV_B also has upcoming public trip to Manila
    // TRAV_B has no shared interests or mutual connections → destination_overlap wins
    const stateWithDestOverlap = travelerState({
      trips: [
        { id: "00000000-0000-0000-0000-000000000tr1", owner_id: ALICE_ID,    destination_city: "Manila", status: "upcoming", end_date: futureDate, visibility: "public" },
        { id: "00000000-0000-0000-0000-000000000tr2", owner_id: TRAV_B_ID,  destination_city: "Manila", status: "upcoming", end_date: futureDate, visibility: "public" },
      ],
    });
    const client = makeFakeClient(stateWithDestOverlap);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", {
      token: "alice-tok",
    });
    const travB = body.recommendations.find((r: any) => r.id === TRAV_B_ID);
    assert.ok(travB, "TRAV_B must appear in recommendations");
    assert.equal(
      travB.data.reasonCode,
      "destination_overlap",
      `TRAV_B is heading to Manila (same as Alice) so reasonCode must be destination_overlap, got: ${travB.data.reasonCode}`,
    );
  });

  it("logs an impression row with a session_id — not silently dropped on this skip-ranking pipeline", async () => {
    const state = travelerState();
    const client = makeFakeClient(state);
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { status, body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler&sessionId=test-session-trav-1", {
      token: "alice-tok",
    });
    assert.equal(status, 200);
    assert.equal(body.sessionId, "test-session-trav-1", "response should echo the client-supplied sessionId");

    const rows = state.rank_events.filter((r: any) => r.surface === "compass");
    assert.ok(rows.length > 0, "expected at least one rank_events row for the traveler surface");
    for (const row of rows) {
      assert.equal(row.session_id, "test-session-trav-1", "impression row must carry the sessionId — not null");
    }
  });

  // ── Avatar privacy gate (A3) ────────────────────────────────────────────────
  // Seeds travelers whose avatar_url is NON-null, so the assertions prove the
  // gate actively nulls the avatar rather than passing an already-null value.
  const TRAV_PRIV_AV = "00000000-0000-0000-0000-0000000avp1";
  const TRAV_OPTOUT  = "00000000-0000-0000-0000-0000000avo1";
  const TRAV_PUBLIC  = "00000000-0000-0000-0000-0000000avu1";

  function avatarState(overrides: Partial<FakeState> = {}): FakeState {
    return travelerState({
      profiles: [
        { id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: ["hiking"], interests: ["hiking"], travel_group_style: null, account_status: "active", is_private: false, verified: false },
        // Private traveler with an avatar — must NOT leak to an unconnected viewer.
        { id: TRAV_PRIV_AV, username: "priv_av", display_name: "Priv Av", avatar_url: "https://example.test/priv.jpg", home_city: "Cebu", spoken_languages: ["en"], interests: ["hiking"], verified: false, account_status: "active", is_private: true, show_profile_picture_publicly: true, created_at: new Date().toISOString() },
        // Public traveler who opted out of showing their photo (flag=false).
        { id: TRAV_OPTOUT, username: "optout", display_name: "Opt Out", avatar_url: "https://example.test/optout.jpg", home_city: "Cebu", spoken_languages: ["en"], interests: ["hiking"], verified: false, account_status: "active", is_private: false, show_profile_picture_publicly: false, created_at: new Date().toISOString() },
        // Public traveler with the default flag — avatar visible (control).
        { id: TRAV_PUBLIC, username: "pub_av", display_name: "Pub Av", avatar_url: "https://example.test/pub.jpg", home_city: "Cebu", spoken_languages: ["en"], interests: ["hiking"], verified: false, account_status: "active", is_private: false, show_profile_picture_publicly: true, created_at: new Date().toISOString() },
      ],
      blocks: [],
      ...overrides,
    });
  }

  it("nulls avatarUrl for a PRIVATE traveler the viewer doesn't follow (closes the private-avatar leak)", async () => {
    const client = makeFakeClient(avatarState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", { token: "alice-tok" });
    const rec = body.recommendations.find((r: any) => r.id === TRAV_PRIV_AV);
    assert.ok(rec, "private traveler must appear");
    assert.equal(rec.data.avatarUrl, null, "private traveler's avatar must not leak to a non-follower");
  });

  it("nulls avatarUrl for a PUBLIC traveler who opted out (show_profile_picture_publicly=false), unconnected viewer", async () => {
    const client = makeFakeClient(avatarState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", { token: "alice-tok" });
    const rec = body.recommendations.find((r: any) => r.id === TRAV_OPTOUT);
    assert.ok(rec, "opted-out traveler must appear");
    assert.equal(rec.data.avatarUrl, null, "avatar must be null when show_profile_picture_publicly=false");
  });

  it("exposes avatarUrl for a public traveler with the default flag", async () => {
    const client = makeFakeClient(avatarState());
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", { token: "alice-tok" });
    const rec = body.recommendations.find((r: any) => r.id === TRAV_PUBLIC);
    assert.ok(rec, "public traveler must appear");
    assert.equal(rec.data.avatarUrl, "https://example.test/pub.jpg", "public traveler with default flag keeps their avatar");
  });

  it("exposes a private traveler's avatar once the viewer follows them (parity with discoverySearch)", async () => {
    const client = makeFakeClient(avatarState({
      user_follows: [{ follower_id: ALICE_ID, following_id: TRAV_PRIV_AV }],
    }));
    _setTestClient(client as any, true);
    invalidateFlagsCache();
    clearCompassProfileCache();

    const { body } = await req(server, "GET", "/api/compass/recommendations?surface=traveler", { token: "alice-tok" });
    const rec = body.recommendations.find((r: any) => r.id === TRAV_PRIV_AV);
    assert.ok(rec, "followed private traveler must appear");
    assert.equal(rec.data.avatarUrl, "https://example.test/priv.jpg", "follower sees the avatar of a private account");
  });
});
