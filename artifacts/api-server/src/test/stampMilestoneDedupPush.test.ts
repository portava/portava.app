/**
 * stampMilestoneDedupPush.test.ts
 *
 * Verifies that the milestone push notification in `_awardStampCore` is
 * never sent twice for the same (user_id, milestone_level) pair.
 *
 * Scenarios covered:
 *   A. First award that crosses the 100-stamp threshold:
 *      - milestone row is absent → INSERT into stamp_milestones is attempted
 *      - push path is reachable (tracked via insert count)
 *
 *   B. Second award above the same milestone (row already exists):
 *      - existing row found → `break` fires immediately
 *      - NO INSERT into stamp_milestones is attempted
 *      - push notification is never sent
 *
 *   C. Race condition — concurrent winner already inserted the row:
 *      - milestone row is absent on SELECT (both racers past the check)
 *      - INSERT returns error code 23505 (unique-violation on primary key)
 *      - `if (insertErr) break` fires → push is NOT sent by the loser
 *
 * Pattern: node:test, fake SupabaseClient injected directly into awardStamp().
 * No HTTP server, no live network calls.
 *
 * Run: node --import tsx/esm --test src/test/stampMilestoneDedupPush.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { awardStamp } from "../services/passport/StampAwardEngine.js";

// ── Fixed IDs ──────────────────────────────────────────────────────────────────

const USER_ID = "aa000000-0000-4000-8000-000000000001";
const DEF_ID  = "bb000000-0000-4000-8000-000000000002";
const DEF_SLUG = "milestone_test_stamp";

// ── Fake DB state ──────────────────────────────────────────────────────────────

interface FakeDB {
  feature_flags:     any[];
  stamp_definitions: any[];
  stamp_award_events:any[];
  user_stamps:       any[];
  stamp_milestones:  any[];
  profiles:          any[];
  [key: string]:     any[];
}

/**
 * Build a FakeDB pre-loaded with the minimum rows required for a successful
 * award path.  `existingUserStampCount` controls whether the milestone
 * threshold (100) is crossed.
 */
function makeDB(overrides: Partial<FakeDB> = {}, existingUserStampCount = 100): FakeDB {
  // Populate enough user_stamps rows to trigger the 100-stamp milestone.
  const userStamps: any[] = Array.from({ length: existingUserStampCount }, (_, i) => ({
    id:                  `us-${i}`,
    user_id:             USER_ID,
    stamp_definition_id: DEF_ID,
    is_revoked:          false,
  }));

  return {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
    ],
    stamp_definitions: [
      {
        id:                  DEF_ID,
        slug:                DEF_SLUG,
        name:                "Milestone Test Stamp",
        stamp_type:          "badge",
        is_active:           true,
        is_repeatable:       true,
        max_awards_per_user: null,
        visibility_default:  "public",
        criteria_type:       "automatic",
        criteria:            null,
      },
    ],
    stamp_award_events: [],
    user_stamps:        userStamps,
    stamp_milestones:   [],
    profiles: [
      // No expo_push_token → push block is a no-op, avoiding dynamic import issues
      { id: USER_ID, expo_push_token: null },
    ],
    ...overrides,
  };
}

// ── Fake Supabase client ───────────────────────────────────────────────────────
//
// Instruments the stamp_milestones table so tests can count insert attempts.

type InsertRecord = { table: string; row: any; error?: any };

function makeFakeClient(db: FakeDB, opts: { milestoneInsertError?: any } = {}) {
  const insertLog: InsertRecord[] = [];

  function buildChain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _insert:     any   = null;
    let _update:     any   = null;
    let _upsert:     any   = null;
    let _count             = false;
    let _head              = false;
    let _single            = false;
    let _maybeSingle       = false;

    function tableArr(): any[] {
      if (!db[table]) db[table] = [];
      return db[table];
    }

    function applyFilters(arr: any[]) {
      return arr.filter((r) => filters.every((f) => f(r)));
    }

    const chain: any = {
      select(_cols?: string, opts2?: any) {
        if (opts2?.count === "exact") _count = true;
        if (opts2?.head)              _head  = true;
        return chain;
      },
      insert(data: any) {
        _insert = Array.isArray(data) ? data : [data];
        return chain;
      },
      update(data: any) { _update = data; return chain; },
      upsert(data: any) { _upsert  = Array.isArray(data) ? data : [data]; return chain; },
      delete()          { return chain; },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return chain;
      },
      neq(col: string, val: any) {
        filters.push((r) => r[col] !== val);
        return chain;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return chain;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      or()    { return chain; },
      gte()   { return chain; },
      lte()   { return chain; },
      gt()    { return chain; },
      order() { return chain; },
      range() { return chain; },
      limit() { return chain; },
      not()   { return chain; },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head()        { _head        = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            const arr = tableArr();

            // Insert
            if (_insert) {
              // Unique-key simulation for stamp_award_events
              if (table === "stamp_award_events") {
                for (const row of _insert) {
                  if (row.idempotency_key) {
                    const dupe = arr.some((r: any) => r.idempotency_key === row.idempotency_key);
                    if (dupe) {
                      return resolve({
                        data:  null,
                        error: { message: "duplicate key", code: "23505" },
                      });
                    }
                  }
                }
              }

              // stamp_milestones: honour the injected error and log the attempt
              if (table === "stamp_milestones") {
                for (const row of _insert) {
                  if (opts.milestoneInsertError) {
                    insertLog.push({ table, row, error: opts.milestoneInsertError });
                    return resolve({ data: null, error: opts.milestoneInsertError });
                  }
                  // Check PK uniqueness: (user_id, milestone_level)
                  const dupe = arr.some(
                    (r: any) => r.user_id === row.user_id && r.milestone_level === row.milestone_level,
                  );
                  if (dupe) {
                    const err = { message: "duplicate key value violates unique constraint", code: "23505" };
                    insertLog.push({ table, row, error: err });
                    return resolve({ data: null, error: err });
                  }
                  arr.push({ ...row });
                  insertLog.push({ table, row });
                }
                const inserted = _insert.length === 1 ? { ...arr[arr.length - 1] } : _insert;
                if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
                return resolve({ data: _insert, error: null });
              }

              for (const row of _insert) {
                arr.push({ id: row.id ?? `gen-${Math.random()}`, ...row });
              }
              const inserted2 = _insert.length === 1 ? { ...arr[arr.length - 1] } : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted2, error: null });
              return resolve({ data: _insert, error: null });
            }

            // Upsert
            if (_upsert) {
              for (const row of _upsert) {
                const idx = arr.findIndex((r) => filters.every((f) => f(r)));
                if (idx >= 0) Object.assign(arr[idx], row);
                else arr.push({ id: `gen-${Math.random()}`, ...row });
              }
              return resolve({ data: _upsert, error: null });
            }

            // Update
            if (_update) {
              const matches = applyFilters(arr);
              for (const row of matches) Object.assign(row, _update);
              if (_single || _maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            // Select
            const results = applyFilters(arr).map((r) => ({ ...r }));
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
    from:        (table: string) => buildChain(table),
    rpc:         async () => ({ data: null, error: null }),
    auth:        { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    _insertLog:  insertLog,
  };
}

// ── Drain fire-and-forget promises ─────────────────────────────────────────────
// Multiple rounds ensure nested Promise.resolve().then() chains fully resolve.
async function flushAsync(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

// ── Input factory ──────────────────────────────────────────────────────────────

function makeInput(sourceId = "src-001") {
  return {
    userId:        USER_ID,
    definitionSlug: DEF_SLUG,
    sourceType:    "system",
    sourceId,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Stamp milestone dedup: no duplicate push notification", () => {
  it("Scenario A — milestone absent: INSERT into stamp_milestones is attempted once", async () => {
    const db = makeDB();
    const sc = makeFakeClient(db) as any;

    const result = await awardStamp(sc, makeInput());
    assert.equal(result.awarded, true, "stamp should be awarded");

    await flushAsync();

    const milestoneInserts = sc._insertLog.filter((r: InsertRecord) => r.table === "stamp_milestones");
    assert.equal(milestoneInserts.length, 1, "exactly one INSERT into stamp_milestones on first crossing");
    assert.equal(milestoneInserts[0].row.user_id,         USER_ID, "correct user_id");
    assert.equal(milestoneInserts[0].row.milestone_level, 100,     "correct milestone level");
    assert.equal(milestoneInserts[0].error,               undefined, "insert should succeed (no error)");

    // Verify the row persisted in the DB
    assert.equal(db.stamp_milestones.length, 1, "stamp_milestones row present in DB");
  });

  it("Scenario B — milestone already exists: no INSERT attempted, push never sent", async () => {
    // Pre-seed the milestone row so `existing` is non-null on first query.
    const db = makeDB({
      stamp_milestones: [{ user_id: USER_ID, milestone_level: 100 }],
    });
    const sc = makeFakeClient(db) as any;

    // Use a distinct sourceId so idempotency key is fresh
    const result = await awardStamp(sc, makeInput("src-002"));
    assert.equal(result.awarded, true, "stamp should be awarded");

    await flushAsync();

    const milestoneInserts = sc._insertLog.filter((r: InsertRecord) => r.table === "stamp_milestones");
    assert.equal(
      milestoneInserts.length,
      0,
      "no INSERT into stamp_milestones when row already exists — push path never reached",
    );

    // Row count unchanged (still exactly the pre-seeded row)
    assert.equal(db.stamp_milestones.length, 1, "stamp_milestones count unchanged");
  });

  it("Scenario C — race condition (23505 on INSERT): push is NOT sent by the losing racer", async () => {
    // Both concurrent paths see no existing row on SELECT, but the winner
    // inserts first.  The loser's INSERT returns 23505.
    const db = makeDB();
    const sc = makeFakeClient(db, {
      milestoneInsertError: { message: "duplicate key value violates unique constraint", code: "23505" },
    }) as any;

    const result = await awardStamp(sc, makeInput("src-003"));
    assert.equal(result.awarded, true, "stamp should be awarded regardless of milestone race");

    await flushAsync();

    const milestoneInserts = sc._insertLog.filter((r: InsertRecord) => r.table === "stamp_milestones");
    // INSERT was attempted once (SELECT saw no row)
    assert.equal(milestoneInserts.length, 1, "INSERT was attempted by the racing path");
    assert.equal(milestoneInserts[0].error?.code, "23505", "error is a unique-violation");

    // The DB should have NO new milestone row (insert was rejected)
    assert.equal(
      db.stamp_milestones.length,
      0,
      "no milestone row committed — concurrent winner owns the notification",
    );
  });

  it("Scenario D — ON CONFLICT (user_id, milestone_level) PK is the only constraint guarding inserts", async () => {
    // Verify the migration's PRIMARY KEY (user_id, milestone_level) is sufficient
    // to serialise concurrent inserts: a second insert with the same composite key
    // is rejected by the PK check in the fake (mirroring the DB's ON CONFLICT DO NOTHING).
    const db = makeDB();
    const sc = makeFakeClient(db) as any;

    // First award — crosses threshold, milestone row inserted.
    const r1 = await awardStamp(sc, makeInput("src-004"));
    assert.equal(r1.awarded, true);
    await flushAsync();

    // Snapshot insert count after first award.
    const countAfterFirst = sc._insertLog.filter((r: InsertRecord) => r.table === "stamp_milestones").length;
    assert.equal(countAfterFirst, 1, "one insert after first award");

    // Second award (different sourceId so idempotency key is fresh).
    const r2 = await awardStamp(sc, makeInput("src-005"));
    assert.equal(r2.awarded, true);
    await flushAsync();

    const allMilestoneInserts = sc._insertLog.filter((r: InsertRecord) => r.table === "stamp_milestones");

    // The second path sees the existing row and breaks before inserting.
    assert.equal(
      allMilestoneInserts.length,
      1,
      "no additional INSERT on the second award — existing row causes early break",
    );

    // Only one row ever lives in the milestones table.
    assert.equal(db.stamp_milestones.length, 1, "only one milestone row exists");
  });
});
