/**
 * globe_trotter_5 / globe_trotter_10 — criteria engine award tests
 *
 * Verifies that evaluateAndAwardCriteria correctly awards:
 *   - globe_trotter_5  when countries_visited >= 5
 *   - globe_trotter_10 when countries_visited >= 10
 *
 * Uses an in-memory fake client so no live DB or HTTP is required.
 * The criteria engine reads countries_visited via distinctStampField
 * (distinct non-null, non-empty country values in user_stamps where
 * is_revoked = false).
 *
 * Run: node --import tsx/esm --test src/test/globeTrotterCriteria.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { evaluateAndAwardCriteria, evaluateCriteria } from "../lib/stamps/criteria/index.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const USER_ID   = "aaaaaaaa-0000-4000-8000-000000000011";
const POST_ID   = "bbbbbbbb-0000-4000-8000-000000000022";

// ── Fake in-memory Supabase client ────────────────────────────────────────────

interface FakeDB {
  feature_flags:     any[];
  stamp_definitions: any[];
  user_stamps:       any[];
  stamp_award_events: any[];
  user_stamps_awarded: any[]; // tracks what awardFn receives
}

function makeFakeClient(db: FakeDB) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any   = null;
    let _update: any   = null;
    let _count         = false;
    let _head          = false;
    let _single        = false;
    let _maybeSingle   = false;
    let _limit: number | null = null;
    let _notFilter: { col: string; val: any } | null = null;

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    const chain: any = {
      select(_cols?: string, opts?: any) {
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
      not(col: string, op: string, val: any) {
        if (op === "is" && val === null) _filters.push((r) => r[col] != null);
        return chain;
      },
      in(col: string, vals: any[]) {
        _filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      or() { return chain; },
      gte() { return chain; },
      lte() { return chain; },
      order() { return chain; },
      range() { return chain; },
      limit(n: number) { _limit = n; return chain; },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head()        { _head        = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            if (_insert) {
              const tableData = (db as any)[table] as any[] | undefined;
              if (tableData) {
                for (const row of _insert) {
                  tableData.push({ id: row.id ?? `gen-${Math.random()}`, ...row });
                }
              }
              const inserted = _insert[0];
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }

            if (_update) {
              const tableData = (db as any)[table] as any[] | undefined ?? [];
              const matches = applyFilters(tableData);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            const tableData = (db as any)[table] as any[] | undefined ?? [];
            let results = applyFilters(tableData);
            if (_limit !== null) results = results.slice(0, _limit);
            const cnt = results.length;
            if (_head)        return resolve({ data: null, error: null, count: cnt });
            if (_single)      return resolve({ data: results[0] ?? null, error: null });
            if (_maybeSingle) return resolve({ data: results[0] ?? null, error: null });
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
  };
}

// ── Stamp definition helpers ───────────────────────────────────────────────────

const CRITERIA_FLAG_ON = {
  flag: "stamp_criteria_engine_enabled",
  key:  "stamp_criteria_engine_enabled",
  enabled: true,
};

const DEF_GT5 = {
  id:            "def-gt5-0000-4000-8000-000000000001",
  slug:          "globe_trotter_5",
  name:          "Globe Trotter",
  is_active:     true,
  criteria_type: "automatic",
  criteria:      { version: 1, metric: "countries_visited", gte: 5 },
};

const DEF_GT10 = {
  id:            "def-gt10-000-4000-8000-000000000002",
  slug:          "globe_trotter_10",
  name:          "World Explorer",
  is_active:     true,
  criteria_type: "automatic",
  criteria:      { version: 1, metric: "countries_visited", gte: 10 },
};

/** Build user_stamps rows for N distinct countries (is_revoked=false). */
function countryStamps(n: number): any[] {
  const codes = ["US","GB","FR","DE","JP","AU","BR","CA","IT","ES","MX","IN","CN","ZA","NZ"];
  return codes.slice(0, n).map((code, i) => ({
    id:         `stamp-${i}-${code}`,
    user_id:    USER_ID,
    country:    code,
    city:       null,
    is_revoked: false,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("globe_trotter_5 criteria threshold", () => {
  let db: FakeDB;

  beforeEach(() => {
    db = {
      feature_flags:      [CRITERIA_FLAG_ON],
      stamp_definitions:  [DEF_GT5, DEF_GT10],
      user_stamps:        [],
      stamp_award_events: [],
      user_stamps_awarded: [],
    };
  });

  it("does NOT award at 4 countries", async () => {
    db.user_stamps = countryStamps(4);
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, false, "should not be met at 4 countries");
    assert.equal(awardLog.includes("globe_trotter_5"), false, "awardFn must not be called");
  });

  it("awards globe_trotter_5 at exactly 5 countries", async () => {
    db.user_stamps = countryStamps(5);
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, true,    "should be met at 5 countries");
    assert.equal(gt5!.awarded, true, "should be awarded");
    assert.ok(awardLog.includes("globe_trotter_5"), "awardFn called for globe_trotter_5");
  });

  it("awards globe_trotter_5 at 7 countries (above threshold)", async () => {
    db.user_stamps = countryStamps(7);
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, true, "should be met at 7 countries");
  });
});

describe("globe_trotter_10 criteria threshold", () => {
  let db: FakeDB;

  beforeEach(() => {
    db = {
      feature_flags:      [CRITERIA_FLAG_ON],
      stamp_definitions:  [DEF_GT5, DEF_GT10],
      user_stamps:        [],
      stamp_award_events: [],
      user_stamps_awarded: [],
    };
  });

  it("does NOT award globe_trotter_10 at 9 countries", async () => {
    db.user_stamps = countryStamps(9);
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt10 = outcomes.find((o) => o.slug === "globe_trotter_10");
    assert.ok(gt10, "outcome for globe_trotter_10 expected");
    assert.equal(gt10!.met, false, "should not be met at 9 countries");
    assert.equal(awardLog.includes("globe_trotter_10"), false, "awardFn must not be called for gt10");

    // globe_trotter_5 should still award at 9 countries
    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, true, "globe_trotter_5 should be met at 9 countries");
    assert.ok(awardLog.includes("globe_trotter_5"), "awardFn called for globe_trotter_5");
  });

  it("awards globe_trotter_10 at exactly 10 countries", async () => {
    db.user_stamps = countryStamps(10);
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      sourceType: "posts",
      sourceId:   POST_ID,
      onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt10 = outcomes.find((o) => o.slug === "globe_trotter_10");
    assert.ok(gt10, "outcome for globe_trotter_10 expected");
    assert.equal(gt10!.met, true,    "should be met at 10 countries");
    assert.equal(gt10!.awarded, true, "should be awarded");
    assert.ok(awardLog.includes("globe_trotter_10"), "awardFn called for globe_trotter_10");

    // globe_trotter_5 also fires at 10 countries
    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, true, "globe_trotter_5 should also be met at 10 countries");
  });
});

describe("criteria engine flag guard", () => {
  it("returns empty outcomes when flag is off", async () => {
    const db: FakeDB = {
      feature_flags:      [{ flag: "stamp_criteria_engine_enabled", key: "stamp_criteria_engine_enabled", enabled: false }],
      stamp_definitions:  [DEF_GT5, DEF_GT10],
      user_stamps:        countryStamps(10),
      stamp_award_events: [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      onlySlugs: ["globe_trotter_5", "globe_trotter_10"],
    });
    assert.equal(outcomes.length, 0, "no outcomes when flag is off");
  });

  it("revoked stamps do not count toward countries_visited", async () => {
    const db: FakeDB = {
      feature_flags:      [CRITERIA_FLAG_ON],
      stamp_definitions:  [DEF_GT5],
      user_stamps:        [
        // 4 valid + 2 revoked that would push count to 6
        ...countryStamps(4),
        { id: "revoked-1", user_id: USER_ID, country: "NG", city: null, is_revoked: true },
        { id: "revoked-2", user_id: USER_ID, country: "PL", city: null, is_revoked: true },
      ],
      stamp_award_events: [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);
    const awardLog: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(sc as any, USER_ID, {
      onlySlugs: ["globe_trotter_5"],
      awardFn: async ({ definitionSlug }) => {
        awardLog.push(definitionSlug);
        return { awarded: true, reason: "awarded_new" };
      },
    });

    const gt5 = outcomes.find((o) => o.slug === "globe_trotter_5");
    assert.ok(gt5, "outcome for globe_trotter_5 expected");
    assert.equal(gt5!.met, false, "revoked stamps must not count; 4 valid < 5 threshold");
    assert.equal(awardLog.length, 0, "awardFn must not be called");
  });
});

// ── Backfill direct-path tests ─────────────────────────────────────────────────
//
// The backfill endpoint calls evaluateCriteria + awardStamp directly, bypassing
// the stamp_criteria_engine_enabled feature flag. These tests verify that the
// direct evaluateCriteria path produces the correct outcome regardless of the
// flag's state — so the backfill works even when the live engine is still off.

describe("backfill — evaluateCriteria direct path (flag-independent)", () => {
  it("evaluateCriteria returns met=true for 5 countries regardless of flag state", async () => {
    // Flag is OFF — this simulates running the backfill before enabling the engine.
    const db: FakeDB = {
      feature_flags:       [{ flag: "stamp_criteria_engine_enabled", key: "stamp_criteria_engine_enabled", enabled: false }],
      stamp_definitions:   [DEF_GT5, DEF_GT10],
      user_stamps:         countryStamps(5),
      stamp_award_events:  [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);

    // evaluateCriteria has no flag gate — it must work regardless.
    const result5  = await evaluateCriteria(sc as any, USER_ID, DEF_GT5.criteria);
    const result10 = await evaluateCriteria(sc as any, USER_ID, DEF_GT10.criteria);

    assert.equal(result5.met,  true,  "gt5 must be met at 5 countries even with flag off");
    assert.equal(result10.met, false, "gt10 must NOT be met at 5 countries");
  });

  it("evaluateCriteria returns met=true for both tiers at 10 countries regardless of flag state", async () => {
    const db: FakeDB = {
      feature_flags:       [{ flag: "stamp_criteria_engine_enabled", key: "stamp_criteria_engine_enabled", enabled: false }],
      stamp_definitions:   [DEF_GT5, DEF_GT10],
      user_stamps:         countryStamps(10),
      stamp_award_events:  [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);

    const result5  = await evaluateCriteria(sc as any, USER_ID, DEF_GT5.criteria);
    const result10 = await evaluateCriteria(sc as any, USER_ID, DEF_GT10.criteria);

    assert.equal(result5.met,  true, "gt5 must be met at 10 countries");
    assert.equal(result10.met, true, "gt10 must be met at 10 countries");
  });

  it("evaluateCriteria returns met=false for 4 countries — user below threshold is skipped", async () => {
    const db: FakeDB = {
      feature_flags:       [{ flag: "stamp_criteria_engine_enabled", key: "stamp_criteria_engine_enabled", enabled: false }],
      stamp_definitions:   [DEF_GT5, DEF_GT10],
      user_stamps:         countryStamps(4),
      stamp_award_events:  [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);

    const result5 = await evaluateCriteria(sc as any, USER_ID, DEF_GT5.criteria);
    assert.equal(result5.met, false, "gt5 must NOT be met at 4 countries");
  });

  it("backfill awardFn is not called for a user below threshold (met=false guard)", async () => {
    // Verify that the backfill's met-check gate prevents spurious awardFn calls.
    const db: FakeDB = {
      feature_flags:       [{ flag: "stamp_criteria_engine_enabled", key: "stamp_criteria_engine_enabled", enabled: false }],
      stamp_definitions:   [DEF_GT5, DEF_GT10],
      user_stamps:         countryStamps(4),
      stamp_award_events:  [],
      user_stamps_awarded: [],
    };
    const sc = makeFakeClient(db);

    const awarded: string[] = [];
    for (const def of [DEF_GT5, DEF_GT10]) {
      const result = await evaluateCriteria(sc as any, USER_ID, def.criteria);
      if (result.met) awarded.push(def.slug);
    }

    assert.equal(awarded.length, 0, "no stamps should be awarded for a user with only 4 countries");
  });
});
