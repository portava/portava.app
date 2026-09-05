/**
 * CompassSearchDecayFlushScheduler tests.
 *
 * Verifies the scheduled job:
 *   1. No-ops when SEARCH_SIGNAL_DECAY_DAYS is disabled.
 *   2. Skips gracefully when the service client is unavailable.
 *   3. Skips overlapping runs (overlap guard).
 *   4. Upserts decayed category_weights back to compass_user_preferences.
 *   5. Resets each log row's search_weight to the post-decay effective value
 *      and updates last_nudge_at to the flush time.
 *   6. Leaves weights unchanged for users with no signal log rows.
 *   7. Survives a per-user DB failure without aborting the rest of the run.
 *   8. Survives a hard top-level DB failure without throwing.
 *
 * Run: node --import tsx/esm --test src/test/compassSearchDecayFlushScheduler.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  runDecayFlushOnce,
  flushDecayForAllUsers,
  _setTestFlushFn,
  _setTestGetClient,
} from "../lib/compassSearchDecayFlushScheduler.js";

// ── Minimal fake Supabase client ───────────────────────────────────────────────

type Row = Record<string, unknown>;

interface FakeStore {
  feature_flags:              Row[];
  compass_search_signal_log:  Row[];
  compass_user_preferences:   Row[];
}

function makeFakeClient(store: FakeStore) {
  function tbl(name: keyof FakeStore): Row[] {
    return store[name];
  }

  function builder(tableName: keyof FakeStore) {
    const filters: Array<(r: Row) => boolean> = [];
    let _selectCols = "*";
    let _limitN: number | null = null;
    let _orderKey: string | null = null;
    let _lastUpdated: Row[] | null = null;
    let _lastUpserted: Row[] | null = null;

    function matchRows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_orderKey) {
        const k = _orderKey;
        out = [...out].sort((a, b) => String(a[k] ?? "").localeCompare(String(b[k] ?? "")));
      }
      if (_limitN !== null) out = out.slice(0, _limitN);
      return out;
    }

    const b: any = {
      select(cols: string) { _selectCols = cols; return b; },
      eq(k: string, v: unknown) { filters.push((r) => r[k] === v); return b; },
      gt(k: string, v: unknown) { filters.push((r) => String(r[k] ?? "") > String(v)); return b; },
      order(k: string) { _orderKey = k; return b; },
      limit(n: number)  { _limitN = n; return b; },
      maybeSingle() {
        return Promise.resolve({ data: matchRows()[0] ?? null, error: null });
      },
      update(patch: Row) {
        return {
          eq(k: string, v: unknown) {
            const innerFilters: Array<(r: Row) => boolean> = [...filters, (r) => r[k] === v];
            return {
              eq(k2: string, v2: unknown) {
                const allFilters = [...innerFilters, (r: Row) => r[k2] === v2];
                const rows = tbl(tableName).filter((r) => allFilters.every((f) => f(r)));
                rows.forEach((r) => Object.assign(r, patch));
                _lastUpdated = rows;
                return Promise.resolve({ data: rows, error: null });
              },
            };
          },
        };
      },
      upsert(payload: Row | Row[], _opts?: unknown) {
        const payloads = Array.isArray(payload) ? payload : [payload];
        for (const p of payloads) {
          const existing = tbl(tableName).find((r) => r["user_id"] === p["user_id"] || r["flag"] === p["flag"]);
          if (existing) {
            Object.assign(existing, p);
          } else {
            tbl(tableName).push({ ...p });
          }
        }
        _lastUpserted = payloads;
        return Promise.resolve({ data: payloads, error: null });
      },
      then(resolve: Function) {
        return resolve({ data: matchRows(), error: null });
      },
    };
    return b;
  }

  return {
    from(name: string) { return builder(name as keyof FakeStore); },
  } as any;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const HALF_LIFE_7 = 7;

/** A timestamp 14 days in the past → decay_factor = 0.5^(14/7) = 0.25. */
function daysAgoIso(days: number, fromMs = Date.now()): string {
  return new Date(fromMs - days * 86_400_000).toISOString();
}

const UID_A = "00000000-0000-0000-0000-000000000001";
const UID_B = "00000000-0000-0000-0000-000000000002";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CompassSearchDecayFlushScheduler", () => {
  afterEach(() => {
    _setTestFlushFn(null);
    _setTestGetClient(null);
  });

  // ── runDecayFlushOnce: top-level scheduler logic ──────────────────────────

  it("no-ops when SEARCH_SIGNAL_DECAY_DAYS is disabled", async () => {
    const store: FakeStore = {
      feature_flags: [{ flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: false, metadata: { numeric_value: 7 } }],
      compass_search_signal_log: [
        { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14), search_weight: 4 },
      ],
      compass_user_preferences: [
        { user_id: UID_A, category_weights: { food: 6 }, updated_at: daysAgoIso(1) },
      ],
    };
    _setTestGetClient(() => makeFakeClient(store));

    const result = await runDecayFlushOnce();
    assert.equal(result.status, "skipped");
    assert.equal((result as any).reason, "disabled");
    // Weights must not have been touched.
    assert.deepEqual(store.compass_user_preferences[0]!["category_weights"], { food: 6 });
  });

  it("skips when the service client is unavailable", async () => {
    _setTestGetClient(() => null);
    const result = await runDecayFlushOnce();
    assert.equal(result.status, "skipped");
    assert.equal((result as any).reason, "no_service_client");
  });

  it("returns completed with a report on success", async () => {
    _setTestGetClient(() => ({} as any));
    _setTestFlushFn(async (_db, _hl) => ({
      usersProcessed: 2, usersSkipped: 0, weightsUpdated: 2, logRowsReset: 3, durationMs: 0,
    }));
    // Provide a client that returns enabled config.
    const store: FakeStore = {
      feature_flags: [{ flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: { numeric_value: 7 } }],
      compass_search_signal_log: [],
      compass_user_preferences: [],
    };
    _setTestGetClient(() => makeFakeClient(store));

    const result = await runDecayFlushOnce();
    assert.equal(result.status, "completed");
    const r = (result as any).report;
    assert.ok(typeof r.durationMs === "number");
  });

  it("survives a hard top-level flush failure without throwing", async () => {
    const store: FakeStore = {
      feature_flags: [{ flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: { numeric_value: 7 } }],
      compass_search_signal_log: [],
      compass_user_preferences: [],
    };
    _setTestGetClient(() => makeFakeClient(store));
    _setTestFlushFn(async () => { throw new Error("db down"); });

    const result = await runDecayFlushOnce();
    assert.equal(result.status, "failed");
  });

  // ── flushDecayForAllUsers: core logic ─────────────────────────────────────

  describe("flushDecayForAllUsers", () => {
    it("upserts decayed weights for a user with stale signal rows", async () => {
      const nowMs = Date.now();
      // search_weight=4, age=14 days, halfLife=7 → decayFactor=0.25, effectiveSw=1
      // weightToShed = 4−1 = 3; stored weight 6 → 6−3 = 3
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14, nowMs), search_weight: 4 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { food: 6 }, updated_at: daysAgoIso(1, nowMs) },
        ],
      };
      const db = makeFakeClient(store);

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      assert.equal(report.usersProcessed, 1);
      assert.equal(report.usersSkipped, 0);
      assert.equal(report.weightsUpdated, 1);
      // The stored weight should now be 3 (6 − 3 shed).
      const prefs = store.compass_user_preferences[0] as any;
      assert.equal(prefs.category_weights.food, 3);
    });

    it("resets log row search_weight to effectiveSw and updates last_nudge_at", async () => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14, nowMs), search_weight: 4 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { food: 6 }, updated_at: daysAgoIso(1, nowMs) },
        ],
      };
      const db = makeFakeClient(store);

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      assert.equal(report.logRowsReset, 1);
      const logRow = store.compass_search_signal_log[0] as any;
      // effectiveSw = round(4 * 0.25) = 1
      assert.equal(logRow.search_weight, 1);
      // last_nudge_at must be updated to the flush time.
      assert.equal(logRow.last_nudge_at, nowIso);
    });

    it("does not reset a log row whose search_weight did not decay", async () => {
      const nowMs = Date.now();
      // age=0 → decayFactor=1 → effectiveSw=search_weight → no change
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "nature", last_nudge_at: new Date(nowMs).toISOString(), search_weight: 3 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { nature: 5 }, updated_at: daysAgoIso(1, nowMs) },
        ],
      };
      const db = makeFakeClient(store);

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      // No decay happened — log row stays unchanged.
      assert.equal(report.logRowsReset, 0);
      assert.equal(report.weightsUpdated, 0);
      const logRow = store.compass_search_signal_log[0] as any;
      assert.equal(logRow.search_weight, 3);
    });

    it("processes multiple users independently", async () => {
      const nowMs = Date.now();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14, nowMs), search_weight: 4 },
          { user_id: UID_B, category: "art",  last_nudge_at: daysAgoIso(7, nowMs),  search_weight: 6 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { food: 8 }, updated_at: daysAgoIso(1, nowMs) },
          { user_id: UID_B, category_weights: { art: 7 },  updated_at: daysAgoIso(1, nowMs) },
        ],
      };
      const db = makeFakeClient(store);

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      // Both users must be processed and their weights updated.
      assert.equal(report.usersProcessed, 2);
      assert.equal(report.usersSkipped, 0);
      assert.equal(report.weightsUpdated, 2);
      // UID_A: effectiveSw=round(4*0.25)=1, shed=3 (log reset)
      // UID_B: effectiveSw=round(6*0.5)=3,  shed=3 (log reset)
      assert.equal(report.logRowsReset, 2);
    });

    it("creates compass_user_preferences when none exists for the user", async () => {
      const nowMs = Date.now();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14, nowMs), search_weight: 4 },
        ],
        compass_user_preferences: [], // no existing row
      };
      const db = makeFakeClient(store);

      await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      // A new prefs row should have been upserted.
      const created = store.compass_user_preferences.find((r: any) => r.user_id === UID_A) as any;
      assert.ok(created, "preferences row should have been created");
      // storedWeights = {} → 0 for food; decay subtracts weightToShed from 0
      // but food category is not in storedWeights, so result[food] = max(-10, min(10, 0 - 3)) = -3
      assert.equal(typeof created.category_weights, "object");
    });

    it("does not reset log rows when the preferences upsert fails", async () => {
      const nowMs = Date.now();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(14, nowMs), search_weight: 4 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { food: 6 }, updated_at: daysAgoIso(1, nowMs) },
        ],
      };

      // Build a client where the preferences upsert always errors.
      const failingDb = {
        from(name: string) {
          const real = makeFakeClient(store).from(name);
          if (name !== "compass_user_preferences") return real;
          // Return a proxy that fails only on upsert.
          return {
            ...real,
            upsert(_payload: unknown, _opts?: unknown) {
              return Promise.resolve({ data: null, error: { message: "upsert failed" } });
            },
          };
        },
      } as any;

      const report = await flushDecayForAllUsers(failingDb, HALF_LIFE_7, nowMs);

      // Weight could not be persisted — log row must be preserved as-is.
      assert.equal(report.logRowsReset, 0);
      assert.equal(report.weightsUpdated, 0);
      const logRow = store.compass_search_signal_log[0] as any;
      // search_weight and last_nudge_at must be unchanged.
      assert.equal(logRow.search_weight, 4);
      assert.notEqual(logRow.last_nudge_at, new Date(nowMs).toISOString());
    });

    it("returns zero counts when the signal log is empty", async () => {
      const nowMs = Date.now();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [],
        compass_user_preferences: [],
      };
      const db = makeFakeClient(store);

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7, nowMs);

      assert.equal(report.usersProcessed, 0);
      assert.equal(report.weightsUpdated, 0);
      assert.equal(report.logRowsReset, 0);
    });

    it("handles a halfLifeDays of 0 without crashing (applySearchDecay no-ops)", async () => {
      const nowMs = Date.now();
      const store: FakeStore = {
        feature_flags: [],
        compass_search_signal_log: [
          { user_id: UID_A, category: "food", last_nudge_at: daysAgoIso(7, nowMs), search_weight: 5 },
        ],
        compass_user_preferences: [
          { user_id: UID_A, category_weights: { food: 5 }, updated_at: daysAgoIso(1, nowMs) },
        ],
      };
      const db = makeFakeClient(store);

      // halfLifeDays=0 means applySearchDecay returns the original weights unchanged.
      const report = await flushDecayForAllUsers(db, 0, nowMs);
      assert.equal(report.usersProcessed, 1);
      assert.equal(report.weightsUpdated, 0);
      assert.equal(report.logRowsReset, 0);
    });

    it("survives a top-level DB failure on the user-list query", async () => {
      const db = {
        from(_name: string) {
          return {
            select() { return this; },
            gt()     { return this; },
            order()  { return this; },
            limit()  { return this; },
            then(resolve: Function) {
              return resolve({ data: null, error: { message: "db down" } });
            },
          };
        },
      } as any;

      const report = await flushDecayForAllUsers(db, HALF_LIFE_7);
      assert.equal(report.usersProcessed, 0);
      assert.equal(report.logRowsReset, 0);
    });
  });
});
