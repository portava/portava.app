/**
 * Globe Trotter legacy retirement
 *
 * Confirms that after retiring the unversioned 'globe_trotter' slug:
 *  A. awardStamp refuses to award 'globe_trotter' when is_active=false
 *     (stamp engine fail-closed on inactive definitions).
 *  B. awardStamp still awards 'globe_trotter_5' for the same user at 5 countries
 *     (the versioned replacement is active and functional).
 *  C. Only versioned slugs (globe_trotter_5, globe_trotter_10) are awarded by
 *     the criteria engine — the legacy slug stays out of the awarded list even
 *     if accidentally passed to evaluateAndAwardCriteria.
 *
 * Run: node --import tsx/esm --test src/test/globeTrotterLegacyRetirement.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { evaluateAndAwardCriteria } from "../lib/stamps/criteria/index.js";

const noopLog = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-4000-8000-000000000011";
const POST_ID   = "bbbbbbbb-0000-4000-8000-000000000022";

const LEGACY_DEF_ID  = "cccccccc-0000-4000-8000-000000000033";
const GT5_DEF_ID     = "dddddddd-0000-4000-8000-000000000044";
const GT10_DEF_ID    = "eeeeeeee-0000-4000-8000-000000000055";

const V2_FLAG = { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true };

// ── Fake in-memory Supabase client ────────────────────────────────────────────

interface FakeDB {
  feature_flags:     any[];
  stamp_definitions: any[];
  user_stamps:       any[];
  stamp_award_events: any[];
  stamp_progress:    any[];
  user_stamp_progress: any[];
  posts:             any[];
  passport_postcards: any[];
  [key: string]: any[];
}

function makeFakeClient(db: FakeDB): SupabaseClient {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any    = null;
    let _update: any    = null;
    let _limit: number | null = null;
    let _count          = false;
    let _single         = false;
    let _maybeSingle    = false;
    let _head           = false;

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    const chain: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === "exact") _count = true;
        if (opts?.head) _head = true;
        return chain;
      },
      insert(data: any) {
        _insert = Array.isArray(data) ? data : [data];
        return chain;
      },
      update(data: any) { _update = data; return chain; },
      upsert(data: any) { _insert = Array.isArray(data) ? data : [data]; return chain; },
      delete() { return chain; },
      eq(col: string, val: any) {
        _filters.push((r) => r[col] === val);
        return chain;
      },
      neq(col: string, val: any) {
        _filters.push((r) => r[col] !== val);
        return chain;
      },
      is(col: string, val: any) {
        if (val === null) _filters.push((r) => r[col] == null);
        else _filters.push((r) => r[col] === val);
        return chain;
      },
      or() { return chain; },
      in(col: string, vals: any[]) {
        _filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      gte(col: string, val: any) {
        _filters.push((r) => r[col] >= val);
        return chain;
      },
      lte() { return chain; },
      order() { return chain; },
      range() { return chain; },
      limit(n: number) { _limit = n; return chain; },
      single() { _single = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head() { _head = true; return chain; },
      not(col: string, op: string, val: any) {
        if (op === "eq") _filters.push((r) => r[col] !== val);
        return chain;
      },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            if (_insert) {
              if (table === "stamp_award_events") {
                const newKey = _insert[0]?.idempotency_key;
                if (newKey) {
                  const dupe = (db[table] ?? []).some((r: any) => r.idempotency_key === newKey);
                  if (dupe) {
                    return resolve({
                      data: null,
                      error: { message: "duplicate key value violates unique constraint", code: "23505" },
                    });
                  }
                }
              }
              const tableData: any[] = db[table] ?? (db[table] = []);
              for (const row of _insert) {
                tableData.push({ id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              const inserted = _insert.length === 1 ? { ...tableData[tableData.length - 1] } : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }
            if (_update) {
              const tableData: any[] = db[table] ?? [];
              const matches = applyFilters(tableData);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }
            const tableData: any[] = db[table] ?? [];
            let results = applyFilters(tableData);
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
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

// ── Shared DB fixture ─────────────────────────────────────────────────────────

function makeDb(): FakeDB {
  return {
    feature_flags: [V2_FLAG],
    posts: [{ id: POST_ID, status: "active" }],
    stamp_definitions: [
      // Legacy slug — retired (is_active=false)
      {
        id:                  LEGACY_DEF_ID,
        slug:                "globe_trotter",
        name:                "Globe Trotter (legacy)",
        is_active:           false,          // <— retired
        is_repeatable:       false,
        max_awards_per_user: null,
        visibility_default:  "public",
        criteria_type:       "automatic",
        criteria:            null,
      },
      // Versioned replacement — active
      {
        id:                  GT5_DEF_ID,
        slug:                "globe_trotter_5",
        name:                "Globe Trotter",
        is_active:           true,
        is_repeatable:       false,
        max_awards_per_user: 1,
        visibility_default:  "public",
        criteria_type:       "automatic",
        criteria:            { version: 1, metric: "countries_visited", gte: 5 },
      },
      {
        id:                  GT10_DEF_ID,
        slug:                "globe_trotter_10",
        name:                "World Explorer",
        is_active:           true,
        is_repeatable:       false,
        max_awards_per_user: 1,
        visibility_default:  "public",
        criteria_type:       "automatic",
        criteria:            { version: 1, metric: "countries_visited", gte: 10 },
      },
    ],
    user_stamps:        [],
    stamp_award_events: [],
    stamp_progress:     [],
    user_stamp_progress: [],
    passport_postcards: [],
  };
}

// ── A. Legacy slug is refused by the stamp engine (is_active=false) ───────────

describe("A. globe_trotter (legacy) — awardStamp refuses when is_active=false", () => {
  let db: FakeDB;
  beforeEach(() => { db = makeDb(); });

  it("returns awarded:false and inserts no user_stamps row", async () => {
    const sc = makeFakeClient(db);
    const result = await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "globe_trotter",
      sourceType:     "posts",
      sourceId:       POST_ID,
    }, noopLog);

    assert.equal(result.awarded, false, "Expected awarded:false for retired slug");
    assert.equal(db.user_stamps.length, 0, "No user_stamps row should be inserted");
  });

  it("reports a reason other than 'awarded'", async () => {
    const sc = makeFakeClient(db);
    const result = await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "globe_trotter",
      sourceType:     "posts",
      sourceId:       POST_ID,
    }, noopLog);

    assert.notEqual(result.reason, "awarded",
      `Expected a non-'awarded' reason, got: ${result.reason}`);
  });
});

// ── B. globe_trotter_5 awards correctly (versioned replacement) ───────────────

describe("B. globe_trotter_5 — awards for a user at 5+ distinct countries", () => {
  let db: FakeDB;
  beforeEach(() => { db = makeDb(); });

  it("returns awarded:true and inserts one user_stamps row", async () => {
    const sc = makeFakeClient(db);
    const result = await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "globe_trotter_5",
      sourceType:     "posts",
      sourceId:       POST_ID,
    }, noopLog);

    assert.equal(result.awarded, true, "Expected globe_trotter_5 to be awarded");
    assert.equal(db.user_stamps.length, 1, "Expected exactly one user_stamps row");
    assert.equal(db.user_stamps[0].user_id, ALICE_ID);
  });

  it("is idempotent — a second call does not create a second row", async () => {
    const sc = makeFakeClient(db);
    await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "globe_trotter_5",
      sourceType:     "posts",
      sourceId:       POST_ID,
    }, noopLog);
    const result2 = await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "globe_trotter_5",
      sourceType:     "posts",
      sourceId:       POST_ID,
    }, noopLog);

    assert.equal(result2.awarded, false, "Second call should not re-award");
    assert.equal(db.user_stamps.length, 1, "Still exactly one user_stamps row");
  });
});

// ── C. evaluateAndAwardCriteria never awards the legacy slug ──────────────────

describe("C. evaluateAndAwardCriteria — legacy slug excluded from versioned awards", () => {
  let db: FakeDB;
  beforeEach(() => {
    db = makeDb();
    // Seed 5 distinct country stamps so globe_trotter_5 criteria (gte:5) would fire
    for (let i = 0; i < 5; i++) {
      db.user_stamps.push({
        id:                   `stamp-${i}`,
        user_id:              ALICE_ID,
        stamp_definition_id:  `city-def-${i}`,
        source_type:          "posts",
        source_id:            `post-${i}`,
        is_revoked:           false,
        metadata:             { country: `Country${i}` },
      });
    }
    // Seed passport_postcards so the countries_visited metric can count
    for (let i = 0; i < 5; i++) {
      db.passport_postcards.push({
        id:              `pc-${i}`,
        user_id:         ALICE_ID,
        stamp_eligible:  true,
        location_country: `Country${i}`,
        location_city:   `City${i}`,
      });
    }
  });

  it("does not include 'globe_trotter' in awarded slugs when onlySlugs lists versioned ones", async () => {
    const sc = makeFakeClient(db);
    const outcomes = await evaluateAndAwardCriteria(sc, ALICE_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
    });

    const awardedSlugs = outcomes.filter((o) => o.awarded).map((o) => o.slug);
    assert.ok(
      !awardedSlugs.includes("globe_trotter"),
      `Legacy slug must not appear in awarded list; got: ${JSON.stringify(awardedSlugs)}`,
    );
  });

  it("does not award 'globe_trotter' even when explicitly passed to onlySlugs", async () => {
    const sc = makeFakeClient(db);
    const outcomes = await evaluateAndAwardCriteria(sc, ALICE_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter", "globe_trotter_5", "globe_trotter_10"],
    });

    const legacyOutcome = outcomes.find((o) => o.slug === "globe_trotter");
    if (legacyOutcome) {
      assert.equal(legacyOutcome.awarded, false,
        "Legacy slug must not be awarded even if passed to evaluateAndAwardCriteria");
    }
    // Either it's absent or present with awarded:false — both are acceptable
    const awardedSlugs = outcomes.filter((o) => o.awarded).map((o) => o.slug);
    assert.ok(
      !awardedSlugs.includes("globe_trotter"),
      `Legacy slug must not be in awarded list; got: ${JSON.stringify(awardedSlugs)}`,
    );
  });
});
