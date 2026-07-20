/**
 * stampCatalogConflictCollapse.test.ts
 *
 * Regression test: the insert-on-conflict (23505) recovery branch in
 * resolveOrEnqueue / resolveOrEnqueueForDefinition correctly collapses to the
 * authoritative existing entry when a concurrent writer wins the race.
 *
 * The race condition under test:
 *   1. fetchEntryByKey → null   (row doesn't exist at lookup time)
 *   2. INSERT            → 23505 (concurrent writer just created it)
 *   3. fetchEntryByKey → row    (fallback fetch finds the winner's entry)
 *
 * The fake client is wired to simulate this exact sequence: the catalog table
 * starts empty so the first select misses, then the insert handler fires 23505
 * and simultaneously drops the winner row into the table so the retry fetch
 * succeeds.
 *
 * Covers:
 *  A. resolveOrEnqueue — location-scoped city stamp (city:jp:tokyo)
 *  B. resolveOrEnqueueForDefinition — definition-scoped key (definition:helpful-buddy)
 *  C. Sequential double-call still produces one row (cache hit on second call)
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogConflictCollapse.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOrEnqueue,
  resolveOrEnqueueForDefinition,
  _clearCatalogCache,
} from "../lib/stamps/StampCatalogService.js";

// ── ID generator ──────────────────────────────────────────────────────────────

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `cc000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

type DB = Record<string, any[]>;

// ── Race-condition fake client ─────────────────────────────────────────────────
//
// The client tracks how many times insert has been attempted for
// `universal_stamp_catalog`.  On the FIRST insert attempt:
//   - it fires a 23505 error (simulating a concurrent writer winning)
//   - it drops the "winner" row (pre-built as `raceWinner`) into the table so
//     the service's retry fetch sees it.
// Subsequent inserts (other tables, other rows) behave normally.

function makeFakeClientWithRace(db: DB, raceWinner: Record<string, unknown>): SupabaseClient {
  let catalogInsertAttempts = 0;

  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any   = null;
    let _single        = false;
    let _maybeSingle   = false;

    const rows = () => (db[table] ?? (db[table] = []));
    const apply = () => rows().filter((r) => _filters.every((f) => f(r)));

    const chain: any = {
      select()                      { return chain; },
      insert(data: any)             { _insert = Array.isArray(data) ? data : [data]; return chain; },
      eq(col: string, val: any)     { _filters.push((r) => r[col] === val); return chain; },
      is(col: string, val: any)     {
        _filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return chain;
      },
      in(col: string, vals: any[])  { _filters.push((r) => vals.includes(r[col])); return chain; },
      not(col: string, op: string)  {
        if (op === "is") _filters.push((r) => r[col] != null);
        return chain;
      },
      or()         { return chain; },
      order()      { return chain; },
      limit()      { return chain; },
      single()     { _single = true; return chain; },
      maybeSingle(){ _maybeSingle = true; return chain; },

      then(resolve: (v: any) => void) {
        return Promise.resolve().then(() => {
          if (!db[table]) db[table] = [];

          if (_insert) {
            if (table === "universal_stamp_catalog") {
              catalogInsertAttempts++;
              if (catalogInsertAttempts === 1) {
                // ── Simulate concurrent winner: inject winner row + return 23505 ──
                db[table].push(raceWinner);
                return resolve({
                  data: null,
                  error: {
                    code:    "23505",
                    message: "duplicate key value violates unique constraint \"universal_stamp_catalog_canonical_location_key_stamp_type_key\"",
                  },
                });
              }
            }

            // Normal path: unique constraint check on queue
            if (table === "stamp_generation_queue") {
              for (const row of _insert) {
                const conflict = rows().some(
                  (r) =>
                    r.catalog_id === row.catalog_id &&
                    ["queued", "processing"].includes(r.status),
                );
                if (conflict) {
                  return resolve({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  });
                }
              }
            }

            const inserted = _insert.map((r: any) => ({
              id:         nextId(),
              created_at: "2026-07-20T00:00:00Z",
              updated_at: "2026-07-20T00:00:00Z",
              earn_count: 0,
              ...r,
            }));
            db[table].push(...inserted);
            const data = _single ? inserted[0] : inserted;
            return resolve({ data, error: null });
          }

          const matched = apply();
          if (_single || _maybeSingle) {
            return resolve({ data: matched[0] ?? null, error: null });
          }
          return resolve({ data: matched, error: null, count: matched.length });
        });
      },
    };
    return chain;
  }

  return { from: (table: string) => buildChain(table) } as unknown as SupabaseClient;
}

// Normal client (no race injection) for sequential-call tests
function makeFakeClient(db: DB): SupabaseClient {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any   = null;
    let _single        = false;
    let _maybeSingle   = false;

    const rows = () => (db[table] ?? (db[table] = []));
    const apply = () => rows().filter((r) => _filters.every((f) => f(r)));

    const chain: any = {
      select()                      { return chain; },
      insert(data: any)             { _insert = Array.isArray(data) ? data : [data]; return chain; },
      eq(col: string, val: any)     { _filters.push((r) => r[col] === val); return chain; },
      is(col: string, val: any)     {
        _filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return chain;
      },
      in(col: string, vals: any[])  { _filters.push((r) => vals.includes(r[col])); return chain; },
      not(col: string, op: string)  {
        if (op === "is") _filters.push((r) => r[col] != null);
        return chain;
      },
      or()         { return chain; },
      order()      { return chain; },
      limit()      { return chain; },
      single()     { _single = true; return chain; },
      maybeSingle(){ _maybeSingle = true; return chain; },

      then(resolve: (v: any) => void) {
        return Promise.resolve().then(() => {
          if (!db[table]) db[table] = [];

          if (_insert) {
            // Unique constraint: canonical_location_key + stamp_type
            if (table === "universal_stamp_catalog") {
              for (const row of _insert) {
                const conflict = rows().some(
                  (r) =>
                    r.canonical_location_key === row.canonical_location_key &&
                    r.stamp_type === row.stamp_type,
                );
                if (conflict) {
                  return resolve({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  });
                }
              }
            }

            // Unique constraint on queue
            if (table === "stamp_generation_queue") {
              for (const row of _insert) {
                const conflict = rows().some(
                  (r) =>
                    r.catalog_id === row.catalog_id &&
                    ["queued", "processing"].includes(r.status),
                );
                if (conflict) {
                  return resolve({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  });
                }
              }
            }

            const inserted = _insert.map((r: any) => ({
              id:         nextId(),
              created_at: "2026-07-20T00:00:00Z",
              updated_at: "2026-07-20T00:00:00Z",
              earn_count: 0,
              ...r,
            }));
            db[table].push(...inserted);
            const data = _single ? inserted[0] : inserted;
            return resolve({ data, error: null });
          }

          const matched = apply();
          if (_single || _maybeSingle) {
            return resolve({ data: matched[0] ?? null, error: null });
          }
          return resolve({ data: matched, error: null, count: matched.length });
        });
      },
    };
    return chain;
  }

  return { from: (table: string) => buildChain(table) } as unknown as SupabaseClient;
}

function freshDb(): DB {
  return {
    universal_stamp_catalog: [],  // starts empty — first lookup misses
    stamp_generation_queue:  [],
  };
}

beforeEach(() => {
  idSeq = 0;
  _clearCatalogCache();
});

// ═══════════════════════════════════════════════════════════════════════════════
// A. resolveOrEnqueue — city stamp race-condition collapse
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. resolveOrEnqueue — insert fires 23505, retry fetch collapses to winner row", () => {
  it("resolves to the concurrent winner when catalog insert returns 23505", async () => {
    const db = freshDb();

    // The row that a concurrent writer would have created — injected by the fake
    // client when it fires the 23505, so the retry fetch finds it.
    const WINNER_ID = "aa000000-0000-4000-8000-000000000001";
    const raceWinner = {
      id:                     WINNER_ID,
      canonical_location_key: "city:jp:tokyo",
      stamp_type:             "city",
      display_name:           "Tokyo",
      country:                "Japan",
      country_code:           "JP",
      city:                   "Tokyo",
      region:                 null,
      neighborhood:           null,
      lat:                    null,
      lng:                    null,
      status:                 "pending_artwork",
      active_version_id:      null,
      prompt_template_version:"v1.0",
      earn_count:             0,
      created_at:             "2026-07-20T00:00:00Z",
      updated_at:             "2026-07-20T00:00:00Z",
      stamp_artwork_versions: null,
    };

    const sc = makeFakeClientWithRace(db, raceWinner);

    const { catalogEntry, wasEnqueued } = await resolveOrEnqueue(
      sc,
      {
        stampType:    "city",
        countryCode:  "JP",
        country_code: "JP",
        country:      "Japan",
        city:         "Tokyo",
        displayName:  "Tokyo",
      },
      "city",
      "test_race_collapse",
    );

    // Must resolve to the concurrent winner's entry, not create a new one
    assert.equal(
      catalogEntry.id,
      WINNER_ID,
      `Expected winner id ${WINNER_ID}, got ${catalogEntry.id}`,
    );
    assert.equal(catalogEntry.canonical_location_key, "city:jp:tokyo");
    assert.equal(catalogEntry.stamp_type, "city");

    // Exactly one catalog row (the winner's) must exist — the insert was rejected
    assert.equal(
      db.universal_stamp_catalog.length,
      1,
      `Expected exactly 1 catalog row, got ${db.universal_stamp_catalog.length}`,
    );
    assert.equal(
      db.universal_stamp_catalog[0].id,
      WINNER_ID,
      "The sole catalog row must be the concurrent winner",
    );

    // A generation job is enqueued for the winner's entry because it's still
    // pending_artwork — wasEnqueued reflects this
    if (wasEnqueued) {
      assert.equal(db.stamp_generation_queue.length, 1);
      assert.equal(db.stamp_generation_queue[0].catalog_id, WINNER_ID);
    }
  });

  it("does not leave a second catalog row behind after 23505 recovery", async () => {
    const db = freshDb();

    const WINNER_ID = "aa000000-0000-4000-8000-000000000002";
    const raceWinner = {
      id:                     WINNER_ID,
      canonical_location_key: "city:fr:paris",
      stamp_type:             "city",
      display_name:           "Paris",
      country:                "France",
      country_code:           "FR",
      city:                   "Paris",
      region:                 null,
      neighborhood:           null,
      lat:                    null,
      lng:                    null,
      status:                 "pending_artwork",
      active_version_id:      null,
      prompt_template_version:"v1.0",
      earn_count:             0,
      created_at:             "2026-07-20T00:00:00Z",
      updated_at:             "2026-07-20T00:00:00Z",
      stamp_artwork_versions: null,
    };

    const sc = makeFakeClientWithRace(db, raceWinner);

    await resolveOrEnqueue(
      sc,
      {
        stampType:    "city",
        countryCode:  "FR",
        country_code: "FR",
        country:      "France",
        city:         "Paris",
        displayName:  "Paris",
      },
      "city",
      "test_no_duplicate_after_race",
    );

    assert.equal(
      db.universal_stamp_catalog.length,
      1,
      `Collision recovery must not leave a duplicate row — got ${db.universal_stamp_catalog.length}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. resolveOrEnqueueForDefinition — definition-scoped race collapse
// ═══════════════════════════════════════════════════════════════════════════════

describe("B. resolveOrEnqueueForDefinition — insert fires 23505, retry fetch collapses to winner row", () => {
  it("resolves to the concurrent winner for a definition-scoped key", async () => {
    const db = freshDb();

    const WINNER_ID = "bb000000-0000-4000-8000-000000000001";
    const raceWinner = {
      id:                     WINNER_ID,
      canonical_location_key: "definition:helpful-buddy",
      stamp_type:             "social",
      display_name:           "Helpful Buddy",
      country:                "Global",
      country_code:           "XX",
      city:                   null,
      region:                 null,
      neighborhood:           null,
      lat:                    null,
      lng:                    null,
      status:                 "pending_artwork",
      active_version_id:      null,
      prompt_template_version:"v1.0",
      earn_count:             0,
      created_at:             "2026-07-20T00:00:00Z",
      updated_at:             "2026-07-20T00:00:00Z",
      stamp_artwork_versions: null,
    };

    const sc = makeFakeClientWithRace(db, raceWinner);

    const { catalogEntry } = await resolveOrEnqueueForDefinition(
      sc,
      { slug: "helpful_buddy", name: "Helpful Buddy", stamp_type: "social" },
      "test_def_race_collapse",
    );

    assert.equal(
      catalogEntry.id,
      WINNER_ID,
      `Expected winner id ${WINNER_ID}, got ${catalogEntry.id}`,
    );
    assert.equal(catalogEntry.canonical_location_key, "definition:helpful-buddy");

    assert.equal(
      db.universal_stamp_catalog.length,
      1,
      `Expected exactly 1 catalog row after race collapse, got ${db.universal_stamp_catalog.length}`,
    );
    assert.equal(
      db.universal_stamp_catalog[0].id,
      WINNER_ID,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Sequential calls — normal path, no race, one row survives via cache
// ═══════════════════════════════════════════════════════════════════════════════

describe("C. Sequential calls — exactly one catalog entry survives", () => {
  it("two resolveOrEnqueue calls for the same city produce exactly one catalog row", async () => {
    const db = freshDb();
    const sc = makeFakeClient(db);

    const first  = await resolveOrEnqueue(
      sc,
      { stampType: "city", countryCode: "DE", country_code: "DE", country: "Germany", city: "Berlin", displayName: "Berlin" },
      "city",
      "first_call",
    );
    const second = await resolveOrEnqueue(
      sc,
      { stampType: "city", countryCode: "DE", country_code: "DE", country: "Germany", city: "Berlin", displayName: "Berlin" },
      "city",
      "second_call",
    );

    assert.equal(
      db.universal_stamp_catalog.length,
      1,
      `Expected 1 catalog row after two identical calls, got ${db.universal_stamp_catalog.length}`,
    );
    assert.equal(
      second.catalogEntry.id,
      first.catalogEntry.id,
      "Both calls must resolve to the same catalog entry id",
    );
    assert.equal(second.catalogEntry.canonical_location_key, "city:de:berlin");
  });

  it("two resolveOrEnqueueForDefinition calls for the same slug produce exactly one catalog row", async () => {
    const db = freshDb();
    const sc = makeFakeClient(db);

    const first  = await resolveOrEnqueueForDefinition(sc, { slug: "solo_traveler", stamp_type: "social" });
    const second = await resolveOrEnqueueForDefinition(sc, { slug: "solo_traveler", stamp_type: "social" });

    assert.equal(
      db.universal_stamp_catalog.length,
      1,
      `Expected 1 catalog row, got ${db.universal_stamp_catalog.length}`,
    );
    assert.equal(second.catalogEntry.id, first.catalogEntry.id);
    assert.equal(db.stamp_generation_queue.length, 1, "No double-enqueue on second call");
  });
});
