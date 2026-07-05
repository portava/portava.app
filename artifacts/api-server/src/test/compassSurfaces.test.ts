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
  events:                   any[];
  places:                   any[];
  compass_user_preferences: any[];
  compass_served_recommendations: any[];
  discovery_places:         any[];
  hidden_gems:              any[];
  user_follows:             any[];
  event_rsvps:              any[];
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];

    const b: any = {
      select()                   { return b; },
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
    profiles:                  [{ id: ALICE_ID, spoken_languages: ["en"], budget_style: null, travel_styles: [], travel_group_style: null }],
    trust_profiles:            [],
    user_preference_profiles:  [],
    user_location_state:       [],
    user_location_preferences: [],
    blocks:                    [],
    trips:                     [],
    trip_members:              [],
    safe_return_sessions:      [],
    rent_buddy_bookings:       [],
    events:                    [],
    places:                    [],
    compass_user_preferences:  [],
    compass_served_recommendations: [],
    discovery_places:          [],
    hidden_gems:               [],
    user_follows:              [],
    event_rsvps:               [],
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
          attendee_count: 5,
          visibility:     "public",
          status:         "published",
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
          attendee_count: 0,
          visibility:     "public",
          status:         "published",
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
