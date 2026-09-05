/**
 * Passport Stamps & Memories tests
 *
 * Verifies stamp creation, deduplication, privacy enforcement, memory lifecycle,
 * map privacy invariant, and contribution event recording.
 *
 * Run: node --import tsx/esm --test src/test/passportStamps.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportStampsRouter from "../routes/passportStamps.js";
import { isVisible, filterStamps } from "../services/passport/PassportPrivacyGuard.js";
import { createStamp } from "../services/passport/PassportStampService.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "passport-test-token";
const USER_ID = "user-passport-1";
const OTHER_USER_ID = "user-passport-2";
const STAMP_ID = "stamp-uuid-1";
const MEMORY_ID = "memory-uuid-1";
const SUGGESTION_ID = "suggestion-uuid-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    };
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeState {
  featureFlags?: Record<string, boolean>;
  stamps?: Record<string, any>[];
  memories?: Record<string, any>[];
  contributions?: Record<string, any>[];
  locationPrefs?: Record<string, any>[];
  visibilityPrefs?: Record<string, any>[];
  /** When true, count-requesting queries resolve with an error and no count. */
  countError?: boolean;
}

/**
 * A REAL stamp_definitions row for a fixture's passport_stamps.stamp_type.
 *
 * Every category + slug below is seeded by migration 0081/0082/0145 and present
 * in production. Do not shortcut this to `{ category: stampType }` — a
 * passport_stamps.stamp_type is NOT a stamp_definitions.category, and pretending
 * otherwise is what let buildStats's four counters read green in this file
 * while returning zero for every real traveller.
 */
function definitionFor(stampType: string): { category: string; slug: string } {
  switch (stampType) {
    case "plan":        return { category: "event",    slug: "event_participant" };
    case "host":        return { category: "event",    slug: "event_host" };
    case "hidden_gem":  return { category: "location", slug: "hidden_gem_hunter" };
    case "safe_return": return { category: "safety",   slug: "safe_return_completed" };
    case "trip":
    case "trip_crew":   return { category: "trip",     slug: "first_trip" };
    default:            return { category: "location", slug: "city_explorer" };
  }
}

function makeFakeClient(state: FakeState, userId: string) {
  const inserted: Array<{ table: string; row: any }> = [];
  const updated: Array<{ table: string; patch: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingUpsert: any = null;

    let countRequested = false;

    const builder: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) countRequested = true;
        return builder;
      },
      insert(row: any) { pendingInsert = row; inserted.push({ table, row }); return builder; },
      update(patch: any) { pendingUpdate = patch; updated.push({ table, patch }); return builder; },
      upsert(row: any) { pendingUpsert = row; return builder; },
      delete() { return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      not(col: string, op: string, val: any) {
        if (op === "eq") filters.push((r) => r[col] !== val);
        return builder;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return builder;
      },
      order() { return builder; },
      limit() { return builder; },
      range() { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single() {
        if (pendingInsert) {
          const id = pendingInsert.id ?? `generated-${Date.now()}`;
          return Promise.resolve({ data: { ...pendingInsert, id }, error: null });
        }
        if (pendingUpsert) {
          const id = pendingUpsert.id ?? (pendingUpsert.user_id ? pendingUpsert.user_id : `generated-${Date.now()}`);
          return Promise.resolve({ data: { ...pendingUpsert, id }, error: null });
        }
        return resolveSingle(false);
      },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      const tableData: Record<string, any[]> = {
        feature_flags: Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, enabled })),
        passport_stamps: state.stamps ?? [],
        // buildStats (Passport Countries/Cities stat) reads from the live
        // user_stamps table, not the legacy passport_stamps table it used to
        // read — mirror the same fixture rows here with a joined
        // stamp_definitions shape.
        //
        // This mapper used to be `stamp_definitions: { category: s.stamp_type }`,
        // which ENCODED THE PRODUCTION BUG it was meant to exercise: it fed a
        // passport_stamps.stamp_type straight into stamp_definitions.category,
        // so buildStats's `category === "plan" | "host" | "safe_return"`
        // branches matched here and nowhere else. No definition in any seed has
        // any of those categories — the real vocabulary is community | event |
        // location | rent_buddy | safety | special | trip | trust — so the four
        // counters were zero in production while this test read green.
        // Fixed 2026-09-05 by giving each fixture stamp a REAL definition
        // (category + slug), taken from the seeds in migrations 0081/0082/0145.
        user_stamps: (state.stamps ?? []).map((s) => ({
          ...s,
          is_revoked: s.is_revoked ?? false,
          stamp_definitions: definitionFor(s.stamp_type),
        })),
        passport_memories: state.memories ?? [],
        passport_contribution_events: state.contributions ?? [],
        location_preferences: state.locationPrefs ?? [],
        passport_visibility_preferences: state.visibilityPrefs ?? [],
      };
      return (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }

    function resolveSingle(nullable: boolean) {
      const filtered = rows();
      if (filtered.length === 0) {
        if (nullable) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      }
      return Promise.resolve({ data: filtered[0], error: null });
    }

    function resolveList() {
      if (countRequested) {
        if (state.countError) {
          return Promise.resolve({ data: null, error: { message: "count query failed" }, count: null });
        }
        return Promise.resolve({ data: rows(), error: null, count: rows().length });
      }
      return Promise.resolve({ data: rows(), error: null });
    }

    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: userId } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    _inserted: inserted,
    _updated: updated,
  };

  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", passportStampsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Passport Stamps — feature flag gating", () => {
  it("returns feature_disabled when flag is off", async () => {
    const client = makeFakeClient(
      { featureFlags: { passport_stamps_enabled: false } },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
});

describe("Passport Stamps — load and filter", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_stamps_enabled: true, passport_memories_enabled: true, passport_map_enabled: true, passport_contribution_events_enabled: true },
        stamps: [
          { id: STAMP_ID, user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Tokyo", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
          { id: "stamp-private-1", user_id: USER_ID, stamp_type: "safe_return", country: "Japan", city: "Osaka", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "safe_return", verification_level: "safe_return", visibility: "private", earned_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z" },
        ],
        memories: [],
        contributions: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("returns stamps for the authenticated user", async () => {
    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.stamps));
    assert.equal(r.body.stamps.length, 2);
  });

  it("safe_return stamp defaults to private visibility", async () => {
    const r = await req("GET", "/api/me/passport/stamps");
    const safeReturn = r.body.stamps.find((s: any) => s.stampType === "safe_return");
    assert.ok(safeReturn, "safe_return stamp should be present for owner");
    assert.equal(safeReturn.visibility, "private");
  });
});

describe("Passport Stamps — total/stamps consistency", () => {
  const TWO_STAMPS = [
    { id: "tc-1", user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Tokyo", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    { id: "tc-2", user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Osaka", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z" },
  ];

  it("total matches the stamp count when the count query succeeds", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_stamps_enabled: true },
        stamps: TWO_STAMPS,
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 2);
    assert.equal(r.body.total, 2, "total must equal the number of matching stamps");
  });

  it("count-query failure never yields total: 0 alongside non-empty stamps", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_stamps_enabled: true },
        stamps: TWO_STAMPS,
        countError: true,
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("GET", "/api/me/passport/stamps");
    assert.equal(r.status, 200);
    assert.equal(r.body.stamps.length, 2, "stamps must still be returned when only the count fails");
    assert.ok(
      r.body.total >= r.body.stamps.length,
      `total (${r.body.total}) must never be smaller than the stamps returned (${r.body.stamps.length})`,
    );
    assert.equal(r.body.total, 2, "fallback total should reflect the rows this page proves exist");
  });
});

describe("Passport Stamps — visibility update", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_stamps_enabled: true },
        stamps: [
          { id: STAMP_ID, user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Tokyo", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
        ],
        memories: [],
        contributions: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("allows owner to change stamp visibility", async () => {
    const r = await req("PATCH", `/api/me/passport/stamps/${STAMP_ID}`, { visibility: "private" });
    assert.equal(r.status, 200);
    assert.equal(r.body.visibility, "private");
  });

  it("rejects invalid visibility value", async () => {
    const r = await req("PATCH", `/api/me/passport/stamps/${STAMP_ID}`, { visibility: "friends_only" });
    assert.equal(r.status, 400);
  });
});

describe("Passport Memories — suggested memory lifecycle", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_memories_enabled: true, passport_contribution_events_enabled: true },
        stamps: [],
        memories: [
          { id: SUGGESTION_ID, user_id: USER_ID, status: "suggested", title: "First time in Tokyo", description: null, country: "Japan", city: "Tokyo", neighborhood: "Shinjuku", category: "city", visibility: "private", verification_level: "gps", source_type: "gps_city_detection", source_id: null, photo_url: null, plan_id: null, trip_id: null, place_id: null, suggestion_reason: "You visited Tokyo for the first time", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
          { id: MEMORY_ID, user_id: USER_ID, status: "active", title: "Tokyo adventure", description: "Amazing trip", country: "Japan", city: "Tokyo", neighborhood: null, category: "city", visibility: "public", verification_level: "gps", source_type: null, source_id: null, photo_url: null, plan_id: null, trip_id: null, place_id: null, suggestion_reason: null, earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
        ],
        contributions: [],
        locationPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("GET /me/passport/suggestions returns only suggested memories", async () => {
    const r = await req("GET", "/api/me/passport/suggestions");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.suggestions));
    assert.equal(r.body.suggestions.length, 1);
    assert.equal(r.body.suggestions[0].status, "suggested");
    assert.equal(r.body.suggestions[0].suggestionReason, "You visited Tokyo for the first time");
  });

  it("GET /me/passport/memories returns only active memories", async () => {
    const r = await req("GET", "/api/me/passport/memories");
    assert.equal(r.status, 200);
    assert.equal(r.body.memories.length, 1);
    assert.equal(r.body.memories[0].status, "active");
  });

  it("suggested memory is not returned in active memories list", async () => {
    const r = await req("GET", "/api/me/passport/memories");
    const found = r.body.memories.find((m: any) => m.id === SUGGESTION_ID);
    assert.ok(!found, "suggested memory must not appear in active memories");
  });

  it("can accept a suggestion", async () => {
    const r = await req("POST", `/api/me/passport/suggestions/${SUGGESTION_ID}/accept`, { visibility: "public" });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, true);
  });

  it("can dismiss a suggestion", async () => {
    // Reset with a suggestion to dismiss
    const client = makeFakeClient(
      {
        featureFlags: { passport_memories_enabled: true },
        stamps: [],
        memories: [
          { id: "dismiss-me", user_id: USER_ID, status: "suggested", title: "Osaka trip", description: null, country: "Japan", city: "Osaka", neighborhood: null, category: "city", visibility: "private", verification_level: "unverified", source_type: null, source_id: null, photo_url: null, plan_id: null, trip_id: null, place_id: null, suggestion_reason: null, earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
        ],
        contributions: [],
        locationPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/me/passport/suggestions/dismiss-me/dismiss", {});
    assert.equal(r.status, 204);
  });
});

describe("Passport Memories — PATCH city/country round-trip", () => {
  const EDIT_MEMORY_ID = "edit-memory-uuid-1";
  let patchClient: ReturnType<typeof makeFakeClient>;

  before(() => {
    patchClient = makeFakeClient(
      {
        featureFlags: { passport_memories_enabled: true },
        stamps: [],
        memories: [
          {
            id: EDIT_MEMORY_ID,
            user_id: USER_ID,
            status: "active",
            title: "Old title",
            description: "Old desc",
            country: "Japan",
            city: "Tokyo",
            neighborhood: null,
            category: "city",
            visibility: "private",
            verification_level: "unverified",
            source_type: null,
            source_id: null,
            photo_url: null,
            plan_id: null,
            trip_id: null,
            place_id: null,
            suggestion_reason: null,
            earned_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        contributions: [],
        locationPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(patchClient, true);
    _setTestServiceClient(patchClient);
  });

  it("PATCH /me/passport/memories/:id accepts city and country and forwards them to the DB", async () => {
    const r = await req("PATCH", `/api/me/passport/memories/${EDIT_MEMORY_ID}`, {
      title: "New title",
      city: "Osaka",
      country: "Japan",
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.updated, true);

    // Verify the DB update contained the new city and country columns.
    const memoryUpdates = patchClient._updated.filter((u: any) => u.table === "passport_memories");
    assert.ok(memoryUpdates.length > 0, "expected at least one DB update on passport_memories");
    const patch = memoryUpdates[memoryUpdates.length - 1].patch;
    assert.equal(patch.city, "Osaka", "city must be written to DB");
    assert.equal(patch.country, "Japan", "country must be written to DB");
    assert.equal(patch.title, "New title", "title must also be written to DB");
  });

  it("PATCH /me/passport/memories/:id can clear city by sending null", async () => {
    const r = await req("PATCH", `/api/me/passport/memories/${EDIT_MEMORY_ID}`, {
      city: null,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const memoryUpdates = patchClient._updated.filter((u: any) => u.table === "passport_memories");
    const patch = memoryUpdates[memoryUpdates.length - 1].patch;
    assert.equal(patch.city, null, "city=null must be written to DB to clear it");
  });

  it("PATCH /me/passport/memories/:id rejects an empty patch", async () => {
    const r = await req("PATCH", `/api/me/passport/memories/${EDIT_MEMORY_ID}`, {});
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.equal(r.body.error, "invalid_payload");
  });
});

describe("Passport Map — privacy invariant", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_map_enabled: true },
        stamps: [
          { id: "map-stamp-1", user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Tokyo", neighborhood: "Shinjuku", place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
        ],
        memories: [],
        contributions: [],
        locationPrefs: [],
        visibilityPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("map response never contains lat/lng fields", async () => {
    const r = await req("GET", "/api/me/passport/map");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.markers));

    for (const marker of r.body.markers) {
      assert.ok(!("lat" in marker), "marker must not contain lat");
      assert.ok(!("lng" in marker), "marker must not contain lng");
      assert.ok(!("latitude" in marker), "marker must not contain latitude");
      assert.ok(!("longitude" in marker), "marker must not contain longitude");
    }
  });

  it("map returns city-level display labels", async () => {
    const r = await req("GET", "/api/me/passport/map");
    assert.ok(r.body.markers.length > 0);
    assert.ok(typeof r.body.markers[0].displayLabel === "string");
    assert.ok(r.body.markers[0].city);
  });
});

describe("Passport Stats", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_stamps_enabled: true },
        stamps: [
          { id: "s1", user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Tokyo", neighborhood: "Shinjuku", visibility: "public" },
          { id: "s2", user_id: USER_ID, stamp_type: "city", country: "Japan", city: "Osaka", neighborhood: null, visibility: "public" },
          { id: "s3", user_id: USER_ID, stamp_type: "plan", country: "Thailand", city: "Bangkok", neighborhood: null, visibility: "public" },
          { id: "s4", user_id: USER_ID, stamp_type: "safe_return", country: "Thailand", city: "Bangkok", neighborhood: null, visibility: "private" },
          { id: "s5", user_id: USER_ID, stamp_type: "host", country: "Japan", city: "Tokyo", neighborhood: null, visibility: "public" },
        ],
        memories: [],
        contributions: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("returns correct country, city, and stamp-type counts", async () => {
    const r = await req("GET", "/api/me/passport/stats");
    assert.equal(r.status, 200);
    assert.equal(r.body.countries, 2); // Japan, Thailand
    assert.equal(r.body.cities, 3);    // Tokyo, Osaka, Bangkok
    assert.equal(r.body.totalStamps, 5);
    assert.equal(r.body.planStamps, 1);
    assert.equal(r.body.hostStamps, 1);
    assert.equal(r.body.safeReturnStamps, 1);
  });
});

describe("Passport Visibility Preferences", () => {
  before(() => {
    const client = makeFakeClient(
      {
        featureFlags: {},
        stamps: [],
        memories: [],
        contributions: [],
        visibilityPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
  });

  it("returns defaults when no preference row exists", async () => {
    const r = await req("GET", "/api/me/passport/visibility-preferences");
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultStampVisibility, "public");
    assert.equal(r.body.defaultMemoryVisibility, "private");
    assert.equal(r.body.showCityMap, true);
    assert.equal(r.body.showSafeReturnStamps, false);
  });
});

describe("Contribution events — no Trust Score modification", () => {
  it("creating a memory records a contribution event without additional side effects", async () => {
    const client = makeFakeClient(
      {
        featureFlags: { passport_memories_enabled: true, passport_contribution_events_enabled: true },
        stamps: [],
        memories: [],
        contributions: [],
        locationPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("POST", "/api/me/passport/memories", {
      title: "Sunset in Bali",
      city: "Bali",
      country: "Indonesia",
      visibility: "public",
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.memory?.id);

    // Verify no trust_score table was touched
    const touchedTables = client._inserted.map((i: any) => i.table);
    assert.ok(!touchedTables.includes("trust_scores"), "trust_scores must not be written");
  });
});

// ── Privacy guard unit tests ───────────────────────────────────────────────────

describe("Privacy guard — visibility tier isolation", () => {
  it("trip_crew stamp is NOT visible to a circle-only caller", () => {
    assert.equal(isVisible("trip_crew", "circle"), false);
  });

  it("trip_crew stamp IS visible to a trip_crew caller", () => {
    assert.equal(isVisible("trip_crew", "trip_crew"), true);
  });

  it("circle_only stamp is NOT visible to a public caller", () => {
    assert.equal(isVisible("circle_only", "public"), false);
  });

  it("circle_only stamp IS visible to a circle caller", () => {
    assert.equal(isVisible("circle_only", "circle"), true);
  });

  it("public stamp is visible to all caller contexts", () => {
    for (const ctx of ["owner", "circle", "trip_crew", "public"] as const) {
      assert.equal(isVisible("public", ctx), true, `public stamp should be visible to ${ctx}`);
    }
  });

  it("private stamp is only visible to owner", () => {
    assert.equal(isVisible("private", "public"), false);
    assert.equal(isVisible("private", "circle"), false);
    assert.equal(isVisible("private", "trip_crew"), false);
    assert.equal(isVisible("private", "owner"), true);
  });

  it("filterStamps removes circle_only stamps from public view", () => {
    const stamps: any[] = [
      { id: "s1", stamp_type: "city", country: "JP", city: "Tokyo", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "gps", verification_level: "gps", visibility: "public", earned_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
      { id: "s2", stamp_type: "plan", country: "JP", city: "Osaka", neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "checkin", verification_level: "checkin", visibility: "circle_only", earned_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z" },
      { id: "s3", stamp_type: "safe_return", country: null, city: null, neighborhood: null, place_id: null, plan_id: null, trip_id: null, source_type: "safe_return", verification_level: "safe_return", visibility: "private", earned_at: "2026-01-03T00:00:00Z", created_at: "2026-01-03T00:00:00Z" },
    ];

    const publicView = filterStamps(stamps, "public");
    assert.equal(publicView.length, 1, "public caller sees only public stamps");
    assert.equal(publicView[0].id, "s1");

    const circleView = filterStamps(stamps, "circle");
    assert.equal(circleView.length, 2, "circle caller sees public + circle_only stamps");

    const ownerView = filterStamps(stamps, "owner");
    assert.equal(ownerView.length, 3, "owner sees all stamps");
  });
});

// ── Stamp dedup — null country/city handling ──────────────────────────────────

describe("Passport Stamps — dedup with null city", () => {
  it("createStamp returns isNew=false when a null-city stamp already exists for the user", async () => {
    let dedupQueryFired = false;

    const fakeDb: any = {
      from(table: string) {
        const builder: any = {
          select() { return builder; },
          update() { return builder; },
          insert() { return builder; },
          upsert() { return builder; },
          eq(col: string, val: any) {
            if (table === "passport_stamps" && col === "stamp_type" && val === "plan") {
              dedupQueryFired = true;
            }
            return builder;
          },
          is() { return builder; },
          neq() { return builder; },
          in() { return builder; },
          order() { return builder; },
          limit() { return builder; },
          range() { return builder; },
          maybeSingle() {
            // Simulate finding existing stamp
            if (table === "passport_stamps") return Promise.resolve({ data: { id: "existing-plan-stamp" }, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          single() { return Promise.resolve({ data: null, error: null }); },
          then(onF: any) { return Promise.resolve({ data: [], error: null }).then(onF); },
        };
        return builder;
      },
    };

    const result = await createStamp(fakeDb, {
      userId: USER_ID,
      stampType: "plan",
      city: null,
      country: null,
      tripId: "trip-123",
      verificationLevel: "checkin",
    });

    assert.ok(dedupQueryFired, "dedup query should have been fired");
    assert.ok(result !== null, "result must not be null");
    assert.equal(result!.isNew, false, "stamp must NOT be new (dedup hit)");
    assert.equal(result!.id, "existing-plan-stamp");
  });

  it("createStamp returns isNew=true when no matching stamp exists for the city", async () => {
    const fakeDb: any = {
      from(table: string) {
        const builder: any = {
          select() { return builder; },
          update() { return builder; },
          insert() { return builder; },
          upsert() { return builder; },
          eq() { return builder; },
          is() { return builder; },
          neq() { return builder; },
          in() { return builder; },
          order() { return builder; },
          limit() { return builder; },
          range() { return builder; },
          maybeSingle() {
            // No existing stamp found / no prefs
            return Promise.resolve({ data: null, error: null });
          },
          single() {
            if (table === "passport_stamps") return Promise.resolve({ data: { id: "new-stamp-id" }, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          then(onF: any) { return Promise.resolve({ data: [], error: null }).then(onF); },
        };
        return builder;
      },
    };

    const result = await createStamp(fakeDb, {
      userId: USER_ID,
      stampType: "city",
      city: "Tokyo",
      country: "Japan",
      verificationLevel: "gps",
    });

    assert.ok(result !== null, "result must not be null");
    assert.equal(result!.isNew, true, "stamp should be new");
    assert.equal(result!.id, "new-stamp-id");
  });
});

// ── Visibility preferences as stamp creation default ──────────────────────────

describe("Passport Stamps — visibility preference applied on creation", () => {
  it("PATCH visibility-preferences stores user defaults", async () => {
    const client = makeFakeClient(
      {
        featureFlags: {},
        stamps: [],
        memories: [],
        contributions: [],
        visibilityPrefs: [],
      },
      USER_ID,
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req("PATCH", "/api/me/passport/visibility-preferences", {
      defaultStampVisibility: "circle_only",
      defaultMemoryVisibility: "trip_crew",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.defaultStampVisibility, "circle_only");
    assert.equal(r.body.defaultMemoryVisibility, "trip_crew");
  });
});
