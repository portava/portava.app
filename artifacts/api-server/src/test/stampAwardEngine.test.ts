/**
 * StampAwardEngine — integration tests for the full award path
 *
 * Covers:
 *  R. Stamps are awarded when stamp_system_v2_enabled = true and definitions exist
 *     (trip completion → awardStamp → DB insert succeeds)
 *  S. awardStamp returns {awarded: false} (not throws) when
 *     stamp_system_v2_enabled = false (flag disabled or row absent)
 *  T. Idempotency: calling awardStamp twice with the same
 *     (userId, definitionSlug, sourceType, sourceId) creates only one row
 *     (idempotency_key uniqueness enforced by the engine)
 *
 * These tests call awardStamp() directly — no HTTP layer — to exercise the
 * full award path (trip completion → awardStamp → DB insert) independent of
 * the stamps.ts HTTP-router middleware.
 *
 * Fake-client pattern follows .agents/memory/phase8-test-pitfalls.md:
 *  - All tables live in an in-memory dict
 *  - feature_flags rows expose both `flag` and `key` columns (both column names
 *    are used by different subsystems)
 *  - awardStamp checks stamp_system_v2_enabled with fail-closed semantics;
 *    the fake client must seed this row to allow awards
 *
 * Run: node --import tsx/esm --test src/test/stampAwardEngine.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { awardStamp, type AwardInput } from "../services/passport/StampAwardEngine.js";

const noopLog = { warn: () => {} };

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ALICE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const DEF_ID   = "dddddddd-0000-4000-8000-000000000022";
const TRIP_ID  = "f1f1f1f1-0000-4000-8000-000000000033";

const DEF_SLUG = "first_trip_completed";

// ── Fake in-memory Supabase client ────────────────────────────────────────────

interface FakeDB {
  feature_flags:    any[];
  stamp_definitions: any[];
  user_stamps:       any[];
  stamp_award_events: any[];
  stamp_progress:    any[];
  trips:             any[];
}

function makeFakeClient(db: FakeDB): SupabaseClient {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any = null;
    let _update: any = null;
    let _limit: number | null = null;
    let _count  = false;
    let _single      = false;
    let _maybeSingle = false;
    let _head        = false;

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
      gte() { return chain; },
      lte() { return chain; },
      order() { return chain; },
      range() { return chain; },
      limit(n: number) { _limit = n; return chain; },
      single() { _single = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head() { _head = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            if (_insert) {
              // Enforce idempotency_key uniqueness on stamp_award_events
              if (table === "stamp_award_events") {
                const newKey = _insert[0]?.idempotency_key;
                if (newKey) {
                  const dupe = (db[table as keyof FakeDB] as any[])
                    .some((r: any) => r.idempotency_key === newKey);
                  if (dupe) {
                    return resolve({
                      data: null,
                      error: { message: "duplicate key value violates unique constraint", code: "23505" },
                    });
                  }
                }
              }

              const tableData = db[table as keyof FakeDB] as any[];
              for (const row of _insert) {
                tableData.push({ id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              const inserted = _insert.length === 1
                ? { ...tableData[tableData.length - 1] }
                : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }

            if (_update) {
              const tableData = db[table as keyof FakeDB] as any[];
              const matches = applyFilters(tableData);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            const tableData = db[table as keyof FakeDB] as any[] ?? [];
            let results = applyFilters(tableData);
            if (_limit !== null) results = results.slice(0, _limit);
            const cnt = results.length;
            if (_head) return resolve({ data: null, error: null, count: cnt });
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_DEFINITION = {
  id:                DEF_ID,
  slug:              DEF_SLUG,
  name:              "First Trip Completed",
  is_active:         true,
  is_repeatable:     false,
  max_awards_per_user: null,
  visibility_default: "public",
  criteria_type:     "automatic",
};

const V2_FLAG_ENABLED  = { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true  };
const V2_FLAG_DISABLED = { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: false };

function makeInput(overrides: Partial<AwardInput> = {}): AwardInput {
  return {
    userId:         ALICE_ID,
    definitionSlug: DEF_SLUG,
    sourceType:     "trips",
    sourceId:       TRIP_ID,
    awardReason:    "trip completed",
    ...overrides,
  };
}

// ── R. Full award path: flag enabled + definition exists ───────────────────────

describe("R. awardStamp — full award path (flag enabled + definition exists)", () => {
  it("inserts a user_stamps row and returns awarded:true", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    const result = await awardStamp(sc, makeInput(), noopLog);

    assert.equal(result.awarded, true, "Expected awarded:true");
    assert.equal(result.reason, "awarded");
    assert.ok(result.userStampId, "Expected userStampId to be set");
    assert.equal(db.user_stamps.length, 1, "Expected exactly one user_stamps row");
    assert.equal(db.stamp_award_events.length, 1, "Expected exactly one stamp_award_events row");
    assert.equal(db.user_stamps[0].user_id, ALICE_ID);
    assert.equal(db.user_stamps[0].stamp_definition_id, DEF_ID);
    assert.equal(db.user_stamps[0].is_revoked, false);
  });

  it("sets the correct source_type and source_id on the inserted rows", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    await awardStamp(sc, makeInput({ sourceType: "trips", sourceId: TRIP_ID }), noopLog);

    assert.equal(db.stamp_award_events[0].source_type, "trips");
    assert.equal(db.stamp_award_events[0].source_id, TRIP_ID);
    assert.equal(db.user_stamps[0].source_type, "trips");
    assert.equal(db.user_stamps[0].source_id, TRIP_ID);
  });

  it("awardTripCompletionStamps-style: awards first_trip_completed for a solo trip", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    const result = await awardStamp(sc, {
      userId:         ALICE_ID,
      definitionSlug: "first_trip_completed",
      sourceType:     "trips",
      sourceId:       TRIP_ID,
      awardReason:    "trip marked completed",
    }, noopLog);

    assert.equal(result.awarded, true, `Expected awarded:true, got ${result.reason}`);
    assert.equal(db.user_stamps.length, 1);
  });
});

// ── S. Flag disabled: awardStamp returns {awarded:false} — never throws ────────

describe("S. awardStamp — stamp_system_v2_enabled disabled (not throws)", () => {
  it("returns {awarded:false, reason:feature_disabled} when flag is explicitly false", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_DISABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    const result = await awardStamp(sc, makeInput(), noopLog);

    assert.equal(result.awarded, false, "Expected awarded:false when flag is disabled");
    assert.equal(result.reason, "feature_disabled");
    assert.equal(db.user_stamps.length, 0, "No user_stamps row should be created");
    assert.equal(db.stamp_award_events.length, 0, "No audit event should be created");
  });

  it("returns {awarded:false, reason:feature_disabled} when flag row is absent (migration not applied)", async () => {
    const db: FakeDB = {
      feature_flags:     [],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    const result = await awardStamp(sc, makeInput(), noopLog);

    assert.equal(result.awarded, false, "Expected awarded:false when flag row absent");
    assert.equal(result.reason, "feature_disabled");
    assert.equal(db.user_stamps.length, 0);
  });

  it("does not throw even if stamp_definitions table is also empty", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_DISABLED],
      stamp_definitions: [],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [],
    };
    const sc = makeFakeClient(db);

    let threw = false;
    let result: Awaited<ReturnType<typeof awardStamp>> | undefined;
    try {
      result = await awardStamp(sc, makeInput(), noopLog);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "awardStamp must not throw");
    assert.ok(result, "awardStamp must return a result");
    assert.equal(result!.awarded, false);
  });
});

// ── T. Idempotency: same (userId, slug, sourceType, sourceId) → one row ───────

describe("T. awardStamp — idempotency via idempotency_key", () => {
  it("second call for same source returns awarded:false (already_awarded), not a duplicate row", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);
    const input = makeInput();

    const first = await awardStamp(sc, input, noopLog);
    assert.equal(first.awarded, true, "First call must award the stamp");
    assert.equal(db.user_stamps.length, 1, "First call must create one user_stamps row");
    assert.equal(db.stamp_award_events.length, 1, "First call must create one audit event");

    const second = await awardStamp(sc, input, noopLog);
    assert.equal(second.awarded, false, "Second call must return awarded:false");
    assert.ok(
      second.reason === "already_awarded" || second.reason === "already_earned",
      `Expected already_awarded or already_earned, got: ${second.reason}`,
    );
    assert.equal(db.user_stamps.length, 1, "Second call must NOT create a second user_stamps row");
    assert.equal(db.stamp_award_events.length, 1, "Second call must NOT create a second audit event");
  });

  it("different sourceId for same user + slug creates a second row (repeatable path)", async () => {
    const TRIP_ID_2 = "f2f2f2f2-0000-4000-8000-000000000044";
    const repeatableDef = { ...BASE_DEFINITION, id: DEF_ID, slug: DEF_SLUG, is_repeatable: true };
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [repeatableDef],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [
        { id: TRIP_ID,   status: "completed" },
        { id: TRIP_ID_2, status: "completed" },
      ],
    };
    const sc = makeFakeClient(db);

    const r1 = await awardStamp(sc, makeInput({ sourceId: TRIP_ID }), noopLog);
    const r2 = await awardStamp(sc, makeInput({ sourceId: TRIP_ID_2 }), noopLog);

    assert.equal(r1.awarded, true, "First trip must be awarded");
    assert.equal(r2.awarded, true, "Second trip (different sourceId) must also be awarded");
    assert.equal(db.user_stamps.length, 2, "Two distinct source IDs must produce two rows");
    assert.equal(db.stamp_award_events.length, 2, "Two distinct source IDs must produce two audit events");
  });

  it("concurrent duplicate (DB 23505 uniqueness error) is handled as already_awarded — no throw", async () => {
    const db: FakeDB = {
      feature_flags:     [V2_FLAG_ENABLED],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };

    const sc = makeFakeClient(db);
    const input = makeInput();

    await awardStamp(sc, input, noopLog);
    const second = await awardStamp(sc, input, noopLog);

    assert.equal(second.awarded, false);
    assert.ok(
      second.reason === "already_awarded" || second.reason === "already_earned",
      `Expected already_awarded or already_earned, got: ${second.reason}`,
    );
  });
});

// ── U. log.warn emitted for skipped reasons ────────────────────────────────────

describe("U. awardStamp — log.warn emitted for specified skip reasons", () => {
  it("calls log.warn with userId, definitionSlug, and reason when stamp_system_v2_enabled is disabled", async () => {
    const db: FakeDB = {
      feature_flags:     [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: false }],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [],
    };
    const sc = makeFakeClient(db);

    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const spyLog = {
      warn(obj: Record<string, unknown>, msg: string) { warnings.push({ obj, msg }); },
    };

    await awardStamp(sc, makeInput(), spyLog);

    assert.equal(warnings.length, 1, "Expected exactly one warn call");
    assert.equal(warnings[0].obj.reason, "feature_disabled");
    assert.equal(warnings[0].obj.userId, ALICE_ID);
    assert.equal(warnings[0].obj.definitionSlug, DEF_SLUG);
    assert.equal(warnings[0].msg, "awardStamp: skipped");
  });

  it("calls log.warn when stamp definition is not found", async () => {
    const db: FakeDB = {
      feature_flags:     [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true }],
      stamp_definitions: [],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [],
    };
    const sc = makeFakeClient(db);

    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const spyLog = {
      warn(obj: Record<string, unknown>, msg: string) { warnings.push({ obj, msg }); },
    };

    await awardStamp(sc, makeInput(), spyLog);

    assert.equal(warnings.length, 1, "Expected exactly one warn call");
    assert.equal(warnings[0].obj.reason, "definition_not_found");
    assert.equal(warnings[0].obj.definitionSlug, DEF_SLUG);
    assert.equal(warnings[0].msg, "awardStamp: skipped");
  });

  it("does NOT call log.warn for already_awarded (not a misconfiguration)", async () => {
    const db: FakeDB = {
      feature_flags:     [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true }],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);
    const input = makeInput();

    const warnings: Array<unknown> = [];
    const spyLog = { warn(...args: unknown[]) { warnings.push(args); } };

    await awardStamp(sc, input, spyLog);
    await awardStamp(sc, input, spyLog);

    assert.equal(warnings.length, 0, "already_awarded must NOT trigger log.warn");
  });

  it("does NOT call log.warn when stamp is successfully awarded", async () => {
    const db: FakeDB = {
      feature_flags:     [{ flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true }],
      stamp_definitions: [BASE_DEFINITION],
      user_stamps:       [],
      stamp_award_events: [],
      stamp_progress:    [],
      trips:             [{ id: TRIP_ID, status: "completed" }],
    };
    const sc = makeFakeClient(db);

    const warnings: Array<unknown> = [];
    const spyLog = { warn(...args: unknown[]) { warnings.push(args); } };

    const result = await awardStamp(sc, makeInput(), spyLog);

    assert.equal(result.awarded, true);
    assert.equal(warnings.length, 0, "Successful award must NOT trigger log.warn");
  });
});
