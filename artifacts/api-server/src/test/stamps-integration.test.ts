/**
 * stamps-integration.test.ts
 *
 * Integration test verifying the full award path:
 *   HTTP request → awardStamp() → user_stamps row
 *
 * Covers:
 *   A. POST /api/trips → first_trip_created + trip_planner stamps awarded
 *   B. PATCH /api/trips/:tripId (past dates → completed) → first_trip_completed awarded
 *   C. Idempotency: second POST (new trip, same user) does not double-award
 *      first_trip_created (is_repeatable=false → already_earned)
 *   D. Feature flag disabled → POST succeeds but no stamps inserted
 *
 * Pattern: node:test + tsx/esm, fake-client, no vitest / no supertest.
 * Run: node --import tsx/esm --test src/test/stamps-integration.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const OWNER_ID   = "a2000000-0000-4000-8000-000000000001";
// Trip used in suite B (PATCH → completed) — must be pre-seeded in the DB.
const TRIP_ID_B  = "b2000000-0000-4000-8000-000000000002";

// stamp_definition UUIDs
const DEF_CREATED   = "c2000000-0000-4000-8000-000000000003";
const DEF_COMPLETED = "d2000000-0000-4000-8000-000000000004";
const DEF_PLANNER   = "e2000000-0000-4000-8000-000000000005";
const DEF_SOLO      = "f2000000-0000-4000-8000-000000000006";
const DEF_INTL      = "a3000000-0000-4000-8000-000000000007";
const DEF_WKND      = "b3000000-0000-4000-8000-000000000008";
const DEF_LONG      = "c3000000-0000-4000-8000-000000000009";

// Past dates so computeTripStatus() returns "completed".
// 2020-06-01 (Mon) → 2020-06-03 (Wed): 2 days, not a weekend trip.
const PAST_START = "2020-06-01";
const PAST_END   = "2020-06-03";

// Future dates so computeTripStatus() returns "planning" (not draft, not completed).
const FUTURE_START = "2099-01-01";
const FUTURE_END   = "2099-01-07";

// ── Fake DB state ──────────────────────────────────────────────────────────────

interface FakeDB {
  trips:                any[];
  trip_members:         any[];
  feature_flags:        any[];
  stamp_definitions:    any[];
  user_stamps:          any[];
  stamp_award_events:   any[];
  stamp_progress:       any[];
  notifications:        any[];
  notification_devices: any[];
  profiles:             any[];
  blocks:               any[];
  plan_editors:         any[];
  chat_threads:         any[];
  chat_members:         any[];
  [key: string]:        any[];
}

/** Full stamp_definitions roster used across all suites. */
const ALL_DEFS = [
  { id: DEF_CREATED,   slug: "first_trip_created",   is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_COMPLETED, slug: "first_trip_completed",  is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_PLANNER,   slug: "trip_planner",          is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_SOLO,      slug: "solo_traveler",         is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_INTL,      slug: "international_voyager", is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_WKND,      slug: "weekend_wanderer",      is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
  { id: DEF_LONG,      slug: "long_haul",             is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
];

function makeDB(overrides: Partial<FakeDB> = {}): FakeDB {
  return {
    trips:                [],
    trip_members:         [],
    feature_flags:        [
      { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true },
    ],
    stamp_definitions:    ALL_DEFS.map((d) => ({ ...d })),
    user_stamps:          [],
    stamp_award_events:   [],
    stamp_progress:       [],
    notifications:        [],
    notification_devices: [],
    profiles:             [{ id: OWNER_ID, role: "user" }],
    blocks:               [],
    plan_editors:         [],
    chat_threads:         [],
    chat_members:         [],
    ...overrides,
  };
}

// ── Fake in-memory Supabase client ────────────────────────────────────────────
//
// Adapted from the established pattern in tripCompletion.test.ts.

function makeFakeClient(db: FakeDB) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert:     any   = null;
    let _update:     any   = null;
    let _upsertData: any   = null;
    let _isDelete          = false;
    let _limit: number | null = null;
    let _count             = false;
    let _single            = false;
    let _maybeSingle       = false;
    let _head              = false;

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    function tableArr(): any[] {
      if (!db[table]) db[table] = [];
      return db[table];
    }

    const chain: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === "exact") _count = true;
        if (opts?.head)              _head  = true;
        return chain;
      },
      insert(data: any)  { _insert     = Array.isArray(data) ? data : [data]; return chain; },
      update(data: any)  { _update     = data; return chain; },
      upsert(data: any)  { _upsertData = Array.isArray(data) ? data : [data]; return chain; },
      delete()           { _isDelete   = true; return chain; },
      eq(col: string, val: any)  { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { _filters.push((r) => r[col] !== val); return chain; },
      is(col: string, val: any)  {
        _filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return chain;
      },
      in(col: string, vals: any[]) {
        _filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      or()     { return chain; },
      gte()    { return chain; },
      lte()    { return chain; },
      gt()     { return chain; },
      ilike()  { return chain; },
      order()  { return chain; },
      range()  { return chain; },
      limit(n: number) { _limit = n; return chain; },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head()        { _head        = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            const arr = tableArr();

            // Delete
            if (_isDelete) {
              const before = arr.length;
              db[table] = arr.filter((r) => !_filters.every((f) => f(r)));
              return resolve({ data: null, error: null, count: before - db[table].length });
            }

            // Upsert
            if (_upsertData) {
              for (const row of _upsertData) {
                const idx = arr.findIndex((r) => _filters.every((f) => f(r)));
                if (idx >= 0) Object.assign(arr[idx], row);
                else arr.push({ id: `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              return resolve({ data: _upsertData, error: null });
            }

            // Insert
            if (_insert) {
              // Enforce unique idempotency_key on stamp_award_events (mirrors 23505)
              if (table === "stamp_award_events") {
                for (const row of _insert) {
                  if (row.idempotency_key) {
                    const dupe = arr.some((r: any) => r.idempotency_key === row.idempotency_key);
                    if (dupe) {
                      return resolve({
                        data:  null,
                        error: { message: "duplicate key value violates unique constraint", code: "23505" },
                      });
                    }
                  }
                }
              }
              for (const row of _insert) {
                arr.push({ id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              const inserted = _insert.length === 1 ? { ...arr[arr.length - 1] } : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }

            // Update
            if (_update) {
              const matches = applyFilters(arr);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            // Select — return shallow copies so later DB mutations don't
            // retroactively change values the handler already received.
            let results = applyFilters(arr).map((r) => ({ ...r }));
            if (_limit !== null) results = results.slice(0, _limit);
            const cnt = results.length;
            if (_head)        return resolve({ data: null, error: null, count: cnt });
            if (_single)      return resolve({ data: results[0] ?? null, error: null, count: _count ? cnt : undefined });
            if (_maybeSingle) return resolve({ data: results[0] ?? null, error: null, count: _count ? cnt : undefined });
            return resolve({ data: results, error: null, count: _count ? cnt : undefined });
          } catch (e) {
            return resolve({ data: null, error: { message: String(e) } });
          }
        }).catch(reject);
      },
    };
    return chain;
  }

  return {
    auth: {
      getUser: async (_token: string) => ({
        data:  { user: { id: OWNER_ID, email: "owner@example.com" } },
        error: null,
      }),
    },
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── App factory ────────────────────────────────────────────────────────────────

async function makeApp() {
  const { default: tripsRouter } = await import("../routes/trips.js");
  const app = express();
  app.use(express.json());
  app.use("/api", tripsRouter);
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stampSlug(db: FakeDB, stamp: any): string | undefined {
  return db.stamp_definitions.find((d) => d.id === stamp.stamp_definition_id)?.slug;
}

function userStampsWithSlug(db: FakeDB, userId: string, slug: string): any[] {
  return db.user_stamps.filter(
    (s) => s.user_id === userId && stampSlug(db, s) === slug,
  );
}

// ── Test suites ────────────────────────────────────────────────────────────────

describe("Stamp award integration: POST /api/trips + PATCH + idempotency", async () => {
  let server: ReturnType<typeof createServer>;
  let port:   number;

  before(async () => {
    const app = await makeApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  after(() => { server.close(); });

  function base()         { return `http://127.0.0.1:${port}/api`; }
  function authHeaders()  {
    return { "Content-Type": "application/json", Authorization: `Bearer token-${OWNER_ID}` };
  }

  // Fire-and-forget stamp awards settle asynchronously — allow enough time.
  const SETTLE_MS = 250;

  // ── A. POST /api/trips → first_trip_created + trip_planner ─────────────────

  describe("A. POST /api/trips awards first_trip_created and trip_planner stamps", () => {
    let db:     FakeDB;
    let status: number;

    before(async () => {
      db = makeDB();
      _setTestClient(makeFakeClient(db) as any, true);

      const res = await fetch(`${base()}/trips`, {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({
          title:              "Island Hopping",
          destinationCity:    "Cebu",
          destinationCountry: "Philippines",
          startDate:          FUTURE_START,
          endDate:            FUTURE_END,
          visibility:         "public",
        }),
      });
      status = res.status;

      // Stamp awards fire in the background — wait for them to settle
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("POST returns 201 Created", () => {
      assert.equal(status, 201, `Expected 201, got ${status}`);
    });

    it("first_trip_created stamp is inserted for the owner", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "first_trip_created");
      assert.equal(stamps.length, 1, `Expected 1 first_trip_created stamp, got ${stamps.length}`);
    });

    it("trip_planner stamp is inserted for the owner", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "trip_planner");
      assert.equal(stamps.length, 1, `Expected 1 trip_planner stamp, got ${stamps.length}`);
    });

    it("stamp rows reference the correct user", () => {
      for (const s of db.user_stamps) {
        assert.equal(s.user_id,    OWNER_ID,  "user_id must be the trip creator");
        assert.equal(s.source_type, "trips",  "source_type must be 'trips'");
        assert.equal(s.is_revoked,  false,    "is_revoked must be false");
      }
    });

    it("stamp_award_events audit rows are created for every awarded stamp", () => {
      assert.ok(
        db.stamp_award_events.length >= 1,
        `Expected ≥1 audit event, got ${db.stamp_award_events.length}`,
      );
      for (const ev of db.stamp_award_events) {
        assert.equal(ev.source_type, "trips", "Audit event source_type must be 'trips'");
        assert.equal(ev.status,      "awarded");
      }
    });

    it("stamp_award_events carry the same source_id as the created trip", () => {
      const trip = db.trips[0];
      assert.ok(trip, "A trip row must exist in the fake DB after POST");
      for (const ev of db.stamp_award_events) {
        assert.equal(ev.source_id, trip.id, "Audit event source_id must match the new trip id");
      }
    });
  });

  // ── B. PATCH → past dates → completed → first_trip_completed ───────────────

  describe("B. PATCH trip with past dates awards first_trip_completed stamp", () => {
    let db: FakeDB;

    before(async () => {
      db = makeDB({
        trips: [
          {
            id:                  TRIP_ID_B,
            owner_id:            OWNER_ID,
            status:              "planning",
            title:               "Backpacking Europe",
            destination_city:    "Paris",
            destination_country: null,     // no international stamp this time
            start_date:          PAST_START,
            end_date:            PAST_END,
            visibility:          "public",
            updated_at:          new Date().toISOString(),
          },
        ],
        trip_members: [
          {
            id:      "m2000000-0000-4000-8000-000000000001",
            trip_id: TRIP_ID_B,
            user_id: OWNER_ID,
            role:    "owner",
          },
        ],
      });
      _setTestClient(makeFakeClient(db) as any, true);

      const res = await fetch(`${base()}/trips/${TRIP_ID_B}`, {
        method:  "PATCH",
        headers: authHeaders(),
        body:    JSON.stringify({}),
      });
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(await res.json())}`);

      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("PATCH computes status = completed from past dates", () => {
      const trip = db.trips.find((t) => t.id === TRIP_ID_B);
      assert.equal(trip?.status, "completed", "Trip status must be 'completed' after PATCH with past dates");
    });

    it("first_trip_completed stamp is inserted for the owner", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "first_trip_completed");
      assert.equal(stamps.length, 1, `Expected 1 first_trip_completed stamp, got ${stamps.length}`);
    });

    it("stamp_award_events carry source_type='trips' and correct source_id", () => {
      assert.ok(db.stamp_award_events.length >= 1, "Expected ≥1 audit event");
      for (const ev of db.stamp_award_events) {
        assert.equal(ev.source_type, "trips");
        assert.equal(ev.source_id,   TRIP_ID_B);
      }
    });
  });

  // ── C. Idempotency: second trip creation does not double-award ──────────────

  describe("C. first_trip_created is non-repeatable — second POST does not double-award", () => {
    let db:             FakeDB;
    let stampsAfterFirstPost: number;

    before(async () => {
      db = makeDB();
      _setTestClient(makeFakeClient(db) as any, true);

      // First POST
      await fetch(`${base()}/trips`, {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({
          title:              "First Adventure",
          destinationCity:    "Tokyo",
          destinationCountry: "Japan",
          startDate:          FUTURE_START,
          endDate:            FUTURE_END,
          visibility:         "public",
        }),
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      stampsAfterFirstPost = userStampsWithSlug(db, OWNER_ID, "first_trip_created").length;

      // Second POST — new trip, same user
      await fetch(`${base()}/trips`, {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({
          title:              "Second Adventure",
          destinationCity:    "Seoul",
          destinationCountry: "South Korea",
          startDate:          FUTURE_START,
          endDate:            FUTURE_END,
          visibility:         "public",
        }),
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("first POST awards exactly one first_trip_created stamp", () => {
      assert.equal(stampsAfterFirstPost, 1, `Expected 1 first_trip_created after first POST, got ${stampsAfterFirstPost}`);
    });

    it("second POST does not insert a second first_trip_created stamp (already_earned)", () => {
      const afterBoth = userStampsWithSlug(db, OWNER_ID, "first_trip_created").length;
      assert.equal(
        afterBoth,
        1,
        `first_trip_created must remain at 1 after second POST — got ${afterBoth} (double-award detected)`,
      );
    });

    it("idempotency_keys are unique across all audit events", () => {
      const keys   = db.stamp_award_events.map((e: any) => e.idempotency_key);
      const unique = new Set(keys);
      assert.equal(
        unique.size,
        keys.length,
        "idempotency_key uniqueness violated — duplicate audit events found",
      );
    });
  });

  // ── D. Feature flag disabled → POST succeeds, no stamps ────────────────────

  describe("D. stamp_system_v2_enabled=false → POST succeeds but no stamps inserted", () => {
    let db:     FakeDB;
    let status: number;

    before(async () => {
      db = makeDB({
        feature_flags: [
          { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: false },
        ],
      });
      _setTestClient(makeFakeClient(db) as any, true);

      const res = await fetch(`${base()}/trips`, {
        method:  "POST",
        headers: authHeaders(),
        body:    JSON.stringify({
          title:              "Flag-Off Trip",
          destinationCity:    "Berlin",
          destinationCountry: "Germany",
          startDate:          FUTURE_START,
          endDate:            FUTURE_END,
          visibility:         "public",
        }),
      });
      status = res.status;

      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("POST still returns 201 even when stamp flag is disabled", () => {
      assert.equal(status, 201, `Expected 201, got ${status}`);
    });

    it("no user_stamps rows are inserted when stamp_system_v2_enabled=false", () => {
      assert.equal(
        db.user_stamps.length,
        0,
        `Expected 0 user_stamps, got ${db.user_stamps.length}`,
      );
    });

    it("no stamp_award_events rows are inserted when stamp_system_v2_enabled=false", () => {
      assert.equal(
        db.stamp_award_events.length,
        0,
        `Expected 0 audit events, got ${db.stamp_award_events.length}`,
      );
    });
  });
});
