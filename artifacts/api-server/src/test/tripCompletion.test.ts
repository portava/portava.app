/**
 * Trip completion → stamp award integration test
 *
 * Verifies that PATCH /api/trips/:tripId triggers awardTripCompletionStamps()
 * and inserts user_stamps rows when a trip's computed status becomes "completed".
 *
 * Covers:
 *  V. PATCH with past dates → status computed as "completed" → first_trip_completed stamp awarded
 *  W. solo_traveler awarded when the trip has exactly one member
 *  X. international_voyager awarded when destination_country is set
 *  Y. Idempotency: second PATCH on an already-completed trip does not double-insert stamps
 *  Z. stamp_system_v2_enabled=false → PATCH succeeds but no stamps are inserted
 *
 * Pattern: node:test + tsx/esm, fake-client, no vitest / no supertest.
 * Run: node --import tsx/esm --test src/test/tripCompletion.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const OWNER_ID  = "a1000000-0000-4000-8000-000000000001";
const TRIP_ID   = "b1000000-0000-4000-8000-000000000002";
const DEF_FIRST = "c1000000-0000-4000-8000-000000000003";
const DEF_SOLO  = "d1000000-0000-4000-8000-000000000004";
const DEF_INTL  = "e1000000-0000-4000-8000-000000000005";
const DEF_WKND  = "f1000000-0000-4000-8000-000000000006";
const DEF_LONG  = "a2000000-0000-4000-8000-000000000007";

// Past dates so computeTripStatus returns "completed".
// 2020-01-03 (Fri) → 2020-01-05 (Sun): 2 days (≤3), crosses Sat Jan 4 and Sun Jan 5.
const PAST_START = "2020-01-03";
const PAST_END   = "2020-01-05";

// ── Fake DB state ─────────────────────────────────────────────────────────────

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
  [key: string]:        any[];
}

function makeDB(overrides: Partial<FakeDB> = {}): FakeDB {
  return {
    trips: [
      {
        id:                  TRIP_ID,
        owner_id:            OWNER_ID,
        status:              "planning",
        title:               "Paris Adventure",
        destination_city:    "Paris",
        destination_country: "France",
        start_date:          PAST_START,
        end_date:            PAST_END,
        visibility:          "public",
        updated_at:          new Date().toISOString(),
      },
    ],
    trip_members: [
      { id: "m1000000-0000-4000-8000-000000000001", trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner" },
    ],
    feature_flags: [
      { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true },
    ],
    stamp_definitions: [
      { id: DEF_FIRST, slug: "first_trip_completed",  is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
      { id: DEF_SOLO,  slug: "solo_traveler",         is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
      { id: DEF_INTL,  slug: "international_voyager", is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
      { id: DEF_WKND,  slug: "weekend_wanderer",      is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
      { id: DEF_LONG,  slug: "long_haul",             is_active: true, is_repeatable: false, max_awards_per_user: null, visibility_default: "public", criteria_type: "automatic" },
    ],
    user_stamps:          [],
    stamp_award_events:   [],
    stamp_progress:       [],
    notifications:        [],
    notification_devices: [],
    profiles:             [{ id: OWNER_ID, role: "user" }],
    blocks:               [],
    plan_editors:         [],
    ...overrides,
  };
}

// ── Fake in-memory Supabase client ────────────────────────────────────────────

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
      eq(col: string, val: any) { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any){ _filters.push((r) => r[col] !== val); return chain; },
      is(col: string, val: any) {
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
              if (table === "stamp_award_events") {
                for (const row of _insert) {
                  if (row.idempotency_key) {
                    const dupe = arr.some((r: any) => r.idempotency_key === row.idempotency_key);
                    if (dupe) {
                      return resolve({
                        data: null,
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

            // Select — return deep copies so mutations to db rows after the
            // query don't retroactively change the value the caller received.
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
        data: { user: { id: OWNER_ID, email: "owner@example.com" } },
        error: null,
      }),
    },
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp() {
  const { default: tripsRouter } = await import("../routes/trips.js");
  const app = express();
  app.use(express.json());
  app.use("/api", tripsRouter);
  return app;
}

function stampSlug(db: FakeDB, stamp: any): string | undefined {
  return db.stamp_definitions.find((d) => d.id === stamp.stamp_definition_id)?.slug;
}

function userStampsWithSlug(db: FakeDB, userId: string, slug: string): any[] {
  return db.user_stamps.filter(
    (s) => s.user_id === userId && stampSlug(db, s) === slug,
  );
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("PATCH /api/trips/:tripId → stamp award integration", async () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const app = await makeApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  after(() => { server.close(); });

  function base() { return `http://127.0.0.1:${port}/api`; }
  function authHeaders() {
    return { "Content-Type": "application/json", Authorization: `Bearer token-${OWNER_ID}` };
  }

  // Allow enough time for the fire-and-forget awardTripCompletionStamps to settle
  const SETTLE_MS = 250;

  // ── V. PATCH → completed → stamps awarded ──────────────────────────────────

  describe("V. PATCH with past dates awards trip-completion stamps", () => {
    let db: FakeDB;

    before(async () => {
      db = makeDB();
      _setTestClient(makeFakeClient(db) as any, true);

      const res = await fetch(`${base()}/trips/${TRIP_ID}`, {
        method:  "PATCH",
        headers: authHeaders(),
        body:    JSON.stringify({}),
      });
      // Verify the HTTP call succeeded before proceeding
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(await res.json())}`);

      // awardTripCompletionStamps fires in the background — wait for it
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("PATCH computes status = completed from past dates", async () => {
      const completedTrip = db.trips.find((t) => t.id === TRIP_ID);
      assert.equal(completedTrip?.status, "completed", "Trip status must be computed as completed");
    });

    it("first_trip_completed stamp is inserted for the owner", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "first_trip_completed");
      assert.equal(stamps.length, 1, `Expected 1 first_trip_completed stamp, got ${stamps.length}`);
    });

    it("solo_traveler stamp is awarded (only 1 trip member)", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "solo_traveler");
      assert.equal(stamps.length, 1, `Expected 1 solo_traveler stamp, got ${stamps.length}`);
    });

    it("international_voyager stamp is awarded (destination_country is set)", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "international_voyager");
      assert.equal(stamps.length, 1, `Expected 1 international_voyager stamp, got ${stamps.length}`);
    });

    it("weekend_wanderer stamp is awarded (2-day trip crosses Sat Jan 4 / Sun Jan 5)", () => {
      const stamps = userStampsWithSlug(db, OWNER_ID, "weekend_wanderer");
      assert.equal(stamps.length, 1, `Expected 1 weekend_wanderer stamp, got ${stamps.length}`);
    });

    it("stamp_award_events audit rows are created for every awarded stamp", () => {
      assert.ok(
        db.stamp_award_events.length >= 1,
        `Expected at least 1 audit event, got ${db.stamp_award_events.length}`,
      );
      // Every event row must carry the correct source
      for (const ev of db.stamp_award_events) {
        assert.equal(ev.source_type, "trips", "Audit event source_type must be 'trips'");
        assert.equal(ev.source_id, TRIP_ID, "Audit event source_id must be the tripId");
      }
    });

    it("stamp rows reference the correct user and trip", () => {
      for (const s of db.user_stamps) {
        assert.equal(s.user_id, OWNER_ID, "user_id must be the trip owner");
        assert.equal(s.source_type, "trips");
        assert.equal(s.source_id, TRIP_ID);
        assert.equal(s.is_revoked, false);
      }
    });
  });

  // ── W. Idempotency: second PATCH does not duplicate stamps ────────────────

  describe("W. Stamp award is idempotent across multiple PATCHes", () => {
    let db: FakeDB;
    let stampsAfterFirst: number;

    before(async () => {
      db = makeDB();
      _setTestClient(makeFakeClient(db) as any, true);

      // First PATCH
      await fetch(`${base()}/trips/${TRIP_ID}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      stampsAfterFirst = db.user_stamps.length;

      // Second PATCH
      await fetch(`${base()}/trips/${TRIP_ID}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("first PATCH awards at least one stamp", () => {
      assert.ok(stampsAfterFirst >= 1, `Expected ≥1 stamp after first PATCH, got ${stampsAfterFirst}`);
    });

    it("second PATCH does not insert duplicate user_stamps rows", () => {
      assert.equal(
        db.user_stamps.length,
        stampsAfterFirst,
        `Expected ${stampsAfterFirst} stamps after idempotent second PATCH, got ${db.user_stamps.length}`,
      );
    });

    it("second PATCH does not insert duplicate stamp_award_events rows", () => {
      const keys = db.stamp_award_events.map((e: any) => e.idempotency_key);
      const unique = new Set(keys);
      assert.equal(
        unique.size,
        keys.length,
        "idempotency_key uniqueness violated — duplicate audit events found",
      );
    });
  });

  // ── X. Feature flag disabled → no stamps ─────────────────────────────────

  describe("X. stamp_system_v2_enabled=false → PATCH succeeds but no stamps inserted", () => {
    let db: FakeDB;

    before(async () => {
      db = makeDB({
        feature_flags: [
          { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: false },
        ],
      });
      _setTestClient(makeFakeClient(db) as any, true);

      await fetch(`${base()}/trips/${TRIP_ID}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
    });

    it("PATCH still returns 200", async () => {
      const res = await fetch(`${base()}/trips/${TRIP_ID}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
    });

    it("no user_stamps rows are inserted when feature flag is disabled", () => {
      assert.equal(db.user_stamps.length, 0, "No stamps should be inserted when stamp_system_v2_enabled=false");
    });

    it("no stamp_award_events rows are inserted when feature flag is disabled", () => {
      assert.equal(db.stamp_award_events.length, 0, "No audit events when feature flag is disabled");
    });
  });

  // ── Y. Non-owner gets 403 (ownership check) ───────────────────────────────

  describe("Y. Non-owner PATCH is rejected before stamp logic runs", () => {
    let db: FakeDB;

    before(() => {
      db = makeDB();
      // Fake client authenticates as a different user (NOT the owner)
      const otherClient = {
        auth: {
          getUser: async (_token: string) => ({
            data: { user: { id: "ffffffff-0000-4000-8000-000000000099", email: "other@example.com" } },
            error: null,
          }),
        },
        from: (table: string) => makeFakeClient(db).from(table),
        rpc: async () => ({ data: null, error: null }),
      };
      _setTestClient(otherClient as any, true);
    });

    it("returns 403 when caller is not the trip owner", async () => {
      const res = await fetch(`${base()}/trips/${TRIP_ID}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify({}),
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("no stamps are inserted for a rejected PATCH", async () => {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      assert.equal(db.user_stamps.length, 0, "No stamps after a forbidden PATCH");
    });
  });
});
