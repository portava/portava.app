/**
 * Passport stats — Countries/Cities count from trip-completion stamps
 *
 * buildStats reads from user_stamps (the live award table).
 * awardTripCompletionStamps writes via awardStamp() → user_stamps with
 * source_type="trips".
 *
 * This test confirms that a user who completes a trip earns a non-zero
 * Countries and Cities count on their passport even if they never make a
 * GPS-verified post from that location.  Without a GPS-verified post, the
 * old passport_stamps table (which the GPS post path wrote to) would remain
 * empty and Countries would stay at 0.
 *
 * Run: node --import tsx/esm --test src/test/passportStatsFromTripCompletion.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportStampsRouter from "../routes/passportStamps.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "trip-completion-stats-token";
const USER_ID    = "user-trip-completion-stats-1";
const TRIP_ID    = "trip-00000000-0000-4000-8000-000000000001";
const DEF_ID     = "def-00000000-0000-4000-8000-000000000001";
const STAMP_ID   = "stamp-00000000-0000-4000-8000-000000000001";
const STAMP_ID2  = "stamp-00000000-0000-4000-8000-000000000002";

// ── Fake client ───────────────────────────────────────────────────────────────
//
// Simulates user_stamps written by awardTripCompletionStamps (source_type="trips")
// with no corresponding rows in passport_stamps (the GPS-verified-post table).
//
// The key constraint being tested: buildStats must read user_stamps, not
// passport_stamps, so trip-completion country data reaches the Countries counter.

interface FakeDB {
  feature_flags:  { flag: string; enabled: boolean }[];
  /** Rows exactly as awardStamp() inserts them */
  user_stamps:    any[];
  /** passport_stamps intentionally empty — no GPS-verified posts */
  passport_stamps: any[];
  user_follows:    any[];
  trip_members:    any[];
  trips:           any[];
  stamp_milestones: any[];
  content_stamps:   any[];
  [key: string]:    any[];
}

function makeDB(): FakeDB {
  return {
    feature_flags: [
      { flag: "passport_stamps_enabled",    enabled: true },
      { flag: "stamp_system_v2_enabled",    enabled: true },
    ],
    // Two trip-completion stamps for different cities in different countries.
    // source_type="trips" — written by awardTripCompletionStamps, not a GPS post.
    user_stamps: [
      {
        id:                  STAMP_ID,
        user_id:             USER_ID,
        stamp_definition_id: DEF_ID,
        source_type:         "trips",   // ← trip-completion, NOT a GPS post
        source_id:           TRIP_ID,
        country:             "France",
        city:                "Paris",
        is_revoked:          false,
        visibility:          "public",
        // Joined shape buildStats reads: stamp_definitions(category)
        stamp_definitions:   { category: "trip" },
      },
      {
        id:                  STAMP_ID2,
        user_id:             USER_ID,
        stamp_definition_id: DEF_ID,
        source_type:         "trips",
        source_id:           TRIP_ID,
        country:             "France",
        city:                "Lyon",    // second city, same country
        is_revoked:          false,
        visibility:          "public",
        stamp_definitions:   { category: "trip" },
      },
    ],
    // Intentionally empty — no GPS-verified posts were ever made.
    passport_stamps: [],
    user_follows:    [],
    trip_members:    [],
    trips:           [],
    stamp_milestones: [],
    content_stamps:  [],
  };
}

function makeFakeClient(db: FakeDB) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _count  = false;
    let _head   = false;

    function tableArr(): any[] {
      return db[table] ?? [];
    }
    function applyFilters(arr: any[]): any[] {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    const chain: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count) _count = true;
        if (opts?.head)  _head  = true;
        return chain;
      },
      insert()      { return Promise.resolve({ data: null, error: null }); },
      update()      { return chain; },
      upsert()      { return Promise.resolve({ data: null, error: null }); },
      delete()      { return chain; },
      eq(col: string, val: any)   { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any)  { _filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]){ _filters.push((r) => vals.includes(r[col])); return chain; },
      not(col: string, op: string, val: any) {
        if (op === "eq" || op === "is") _filters.push((r) => r[col] !== val);
        return chain;
      },
      is(col: string, val: any)   {
        _filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return chain;
      },
      or()          { return chain; },
      order()       { return chain; },
      limit()       { return chain; },
      range()       { return chain; },
      gte()         { return chain; },
      lte()         { return chain; },
      maybeSingle() {
        const rows = applyFilters(tableArr());
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        const rows = applyFilters(tableArr());
        if (rows.length === 0) return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(onF: any, onR: any) {
        const rows  = applyFilters(tableArr());
        const count = rows.length;
        const result = _head
          ? { data: null, error: null, count }
          : { data: _count ? rows : rows, error: null, count: _count ? count : undefined };
        return Promise.resolve(result).then(onF, onR);
      },
    };
    return chain;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN) return { data: { user: { id: USER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const db     = makeDB();
  const client = makeFakeClient(db);

  // Both auth client and service client point to the same fake.
  // isFlagEnabled("passport_stamps_enabled") reads via service client.
  // buildStats(client, userId) reads via auth client.
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);

  const app = express();
  app.use(express.json());
  app.use("/api", passportStampsRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

function getStats(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/me/passport/stats", base);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method:   "GET",
        headers:  { authorization: `Bearer ${FAKE_TOKEN}` },
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
    r.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Passport stats — Countries count from trip-completion stamps (no GPS post)", () => {
  it("countries is non-zero even though passport_stamps table is empty", async () => {
    const r = await getStats();
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body.countries, 1,
      `Expected countries=1 (France), got ${r.body.countries}. ` +
      "buildStats must read user_stamps (written by trip-completion), not the empty passport_stamps table.",
    );
  });

  it("cities count reflects trip-completion stamps — both Paris and Lyon are counted", async () => {
    const r = await getStats();
    assert.equal(r.status, 200);
    assert.equal(
      r.body.cities, 2,
      `Expected cities=2 (Paris, Lyon), got ${r.body.cities}. ` +
      "City-level geography from trip-completion stamps must reach the stats counter.",
    );
  });

  it("totalStamps reflects the trip-completion user_stamps rows", async () => {
    const r = await getStats();
    assert.equal(r.status, 200);
    assert.equal(
      r.body.totalStamps, 2,
      `Expected totalStamps=2, got ${r.body.totalStamps}.`,
    );
  });

  it("countries stays 0 when user_stamps is empty (no GPS posts, no trip stamps)", async () => {
    // Temporarily clear user_stamps to verify the 0-baseline.
    // This also confirms the test is not reading from a stale in-memory fixture.
    const emptyDb  = makeDB();
    emptyDb.user_stamps = [];
    const emptyClient = makeFakeClient(emptyDb);
    _setTestClient(emptyClient as any, true);
    _setTestServiceClient(emptyClient as any);

    try {
      const r = await getStats();
      assert.equal(r.status, 200);
      assert.equal(r.body.countries, 0, "empty user_stamps → countries must be 0");
      assert.equal(r.body.cities,    0, "empty user_stamps → cities must be 0");
    } finally {
      // Restore the original client for any subsequent test cases.
      const db     = makeDB();
      const client = makeFakeClient(db);
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);
    }
  });
});
