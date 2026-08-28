/**
 * stampRevoke.test.ts
 *
 * Covers revokeStamp, restoreStamp, and recalculateForUser from StampAwardEngine.
 * Tests are at the engine level (direct function calls, no HTTP).
 *
 * Scenarios:
 *   E. revokeStamp: happy path, not-found/already-revoked, audit-write-fails rollback
 *   F. restoreStamp: happy path, not-found/not-revoked, audit-write-fails rollback
 *   G. recalculateForUser: no events, heal-path (event without stamp), idempotent skip
 *
 * Pattern: node:test + tsx/esm, fake Supabase client, no vitest / no supertest.
 * Run: node --import tsx/esm --test src/test/stampRevoke.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  revokeStamp,
  restoreStamp,
  recalculateForUser,
} from "../services/passport/StampAwardEngine.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const USER_ID     = "a4000000-0000-4000-8000-000000000001";
const ADMIN_ID    = "b4000000-0000-4000-8000-000000000002";
const STAMP_ID    = "c4000000-0000-4000-8000-000000000003";
const DEF_ID      = "d4000000-0000-4000-8000-000000000004";
const TRIP_ID     = "e4000000-0000-4000-8000-000000000005";
const EVENT_ID    = "f4000000-0000-4000-8000-000000000006";

// ── Fake DB state ──────────────────────────────────────────────────────────────

interface FakeDB {
  user_stamps:        any[];
  stamp_award_events: any[];
  stamp_definitions:  any[];
  [key: string]:      any[];
}

function revokeRow(): any {
  return {
    id:                  STAMP_ID,
    user_id:             USER_ID,
    stamp_definition_id: DEF_ID,
    source_type:         "trips",
    source_id:           TRIP_ID,
    is_revoked:          false,
    revoked_at:          null,
    revoked_reason:      null,
  };
}

function makeDB(overrides: Partial<FakeDB> = {}): FakeDB {
  return {
    user_stamps:        [],
    stamp_award_events: [],
    stamp_definitions:  [
      {
        id:                 DEF_ID,
        slug:               "first_trip_created",
        is_active:          true,
        is_repeatable:      false,
        visibility_default: "public",
      },
    ],
    ...overrides,
  };
}

// ── Fake Supabase client ───────────────────────────────────────────────────────
//
// `failInsertTables` — set of table names whose insert calls return a DB error.
// Used to simulate the audit-write-fails rollback path.

function makeFakeClient(db: FakeDB, failInsertTables: Set<string> = new Set()) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert:     any   = null;
    let _update:     any   = null;
    let _upsertData: any   = null;
    let _isDelete          = false;
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
      select(_cols?: string, opts?: any) {
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
      limit()  { return chain; },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head()        { _head        = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            const arr = tableArr();

            if (_isDelete) {
              const before = arr.length;
              db[table] = arr.filter((r) => !_filters.every((f) => f(r)));
              return resolve({ data: null, error: null, count: before - db[table].length });
            }

            if (_upsertData) {
              for (const row of _upsertData) {
                const idx = arr.findIndex((r) => _filters.every((f) => f(r)));
                if (idx >= 0) Object.assign(arr[idx], row);
                else arr.push({ id: `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              return resolve({ data: _upsertData, error: null });
            }

            if (_insert) {
              // Simulate a DB error for tables nominated by the test
              if (failInsertTables.has(table)) {
                return resolve({
                  data:  null,
                  error: { message: "simulated insert failure", code: "XX000" },
                });
              }
              for (const row of _insert) {
                arr.push({ id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              const inserted = _insert.length === 1 ? { ...arr[arr.length - 1] } : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }

            if (_update) {
              const matches = applyFilters(arr);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            // Select — shallow copies so handler-captured values can't drift
            let results = applyFilters(arr).map((r) => ({ ...r }));
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
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: (table: string) => buildChain(table),
    rpc:  async () => ({ data: null, error: null }),
  };
}

// ── E. revokeStamp ─────────────────────────────────────────────────────────────

describe("E. revokeStamp", () => {
  // E1. Happy path

  describe("E1. happy path — revokes the stamp and writes the audit event", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    before(async () => {
      db = makeDB({ user_stamps: [revokeRow()] });
      const sc = makeFakeClient(db) as any;
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "policy_violation");
    });

    it("returns { revoked: true, reason: 'revoked' }", () => {
      assert.deepEqual(result, { revoked: true, reason: "revoked" });
    });

    it("sets is_revoked=true on the user_stamp row", () => {
      const row = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.ok(row, "Stamp row must still exist");
      assert.equal(row.is_revoked, true, "is_revoked must be true after revoke");
    });

    it("stamps revoked_reason on the row", () => {
      const row = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(row?.revoked_reason, "policy_violation");
    });

    it("inserts one audit event with status='revoked'", () => {
      assert.equal(db.stamp_award_events.length, 1, "Expected 1 audit event");
      assert.equal(db.stamp_award_events[0].status,   "revoked");
      assert.equal(db.stamp_award_events[0].admin_id, ADMIN_ID);
    });
  });

  // E2. Not found / already revoked

  describe("E2. target stamp does not exist or is already revoked", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    before(async () => {
      // Row is already revoked — update filter matches nothing
      db = makeDB({ user_stamps: [{ ...revokeRow(), is_revoked: true }] });
      const sc = makeFakeClient(db) as any;
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "test");
    });

    it("returns { revoked: false, reason: 'not_found_or_already_revoked' }", () => {
      assert.deepEqual(result, { revoked: false, reason: "not_found_or_already_revoked" });
    });

    it("does not insert an audit event", () => {
      assert.equal(db.stamp_award_events.length, 0, "No audit event expected for a failed revoke");
    });

    it("leaves the row unchanged", () => {
      assert.equal(db.user_stamps[0].is_revoked, true, "Row must remain is_revoked=true");
    });
  });

  // E3. Audit write fails → rollback

  describe("E3. audit-write failure rolls back the revoke", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    before(async () => {
      db = makeDB({ user_stamps: [revokeRow()] });
      // Fail inserts on stamp_award_events to simulate audit-write failure
      const sc = makeFakeClient(db, new Set(["stamp_award_events"])) as any;
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "test");
    });

    it("returns { revoked: false } with audit_write_failed reason", () => {
      assert.equal(result.revoked, false);
      assert.ok(
        result.reason.startsWith("audit_write_failed"),
        `Expected reason to start with 'audit_write_failed', got: ${result.reason}`,
      );
    });

    it("rolls back is_revoked to false on the stamp row", () => {
      const row = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(row?.is_revoked, false, "Stamp must be rolled back to is_revoked=false");
    });

    it("leaves stamp_award_events empty (no partial audit record)", () => {
      assert.equal(db.stamp_award_events.length, 0);
    });
  });
});

// ── F. restoreStamp ────────────────────────────────────────────────────────────

describe("F. restoreStamp", () => {
  function revokedRow(): any {
    return { ...revokeRow(), is_revoked: true, revoked_reason: "old_reason" };
  }

  // F1. Happy path

  describe("F1. happy path — restores the stamp and writes the audit event", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      db = makeDB({ user_stamps: [revokedRow()] });
      const sc = makeFakeClient(db) as any;
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "false_positive");
    });

    it("returns { restored: true, reason: 'restored' }", () => {
      assert.deepEqual(result, { restored: true, reason: "restored" });
    });

    it("clears is_revoked on the user_stamp row", () => {
      const row = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(row?.is_revoked, false, "is_revoked must be false after restore");
    });

    it("inserts one audit event with status='restored'", () => {
      assert.equal(db.stamp_award_events.length, 1, "Expected 1 audit event");
      assert.equal(db.stamp_award_events[0].status,   "restored");
      assert.equal(db.stamp_award_events[0].admin_id, ADMIN_ID);
    });
  });

  // F2. Not found / not revoked

  describe("F2. target stamp does not exist or is not revoked", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      // Row is NOT revoked — update filter (.eq("is_revoked", true)) matches nothing
      db = makeDB({ user_stamps: [revokeRow()] });
      const sc = makeFakeClient(db) as any;
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "test");
    });

    it("returns { restored: false, reason: 'not_found_or_not_revoked' }", () => {
      assert.deepEqual(result, { restored: false, reason: "not_found_or_not_revoked" });
    });

    it("does not insert an audit event", () => {
      assert.equal(db.stamp_award_events.length, 0);
    });
  });

  // F3. Audit write fails → rollback

  describe("F3. audit-write failure rolls back the restore", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      db = makeDB({ user_stamps: [revokedRow()] });
      const sc = makeFakeClient(db, new Set(["stamp_award_events"])) as any;
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "test");
    });

    it("returns { restored: false } with audit_write_failed reason", () => {
      assert.equal(result.restored, false);
      assert.ok(
        result.reason.startsWith("audit_write_failed"),
        `Expected reason to start with 'audit_write_failed', got: ${result.reason}`,
      );
    });

    it("rolls back is_revoked to true on the stamp row", () => {
      const row = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(row?.is_revoked, true, "Stamp must be rolled back to is_revoked=true after failed restore");
    });

    it("leaves stamp_award_events empty", () => {
      assert.equal(db.stamp_award_events.length, 0);
    });
  });
});

// ── G. recalculateForUser ──────────────────────────────────────────────────────

describe("G. recalculateForUser", () => {
  function awardedEvent(): any {
    return {
      id:                  EVENT_ID,
      user_id:             USER_ID,
      stamp_definition_id: DEF_ID,
      source_type:         "trips",
      source_id:           TRIP_ID,
      award_reason:        null,
      admin_id:            null,
      idempotency_key:     `${USER_ID}:${DEF_ID}:trips:${TRIP_ID}`,
      status:              "awarded",
    };
  }

  // G1. No events → immediate empty return

  describe("G1. user has no awarded events — returns zero counts", () => {
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      const db = makeDB();
      const sc = makeFakeClient(db) as any;
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns { checked: 0, awarded: 0, skipped: 0 }", () => {
      assert.deepEqual(result, { checked: 0, awarded: 0, skipped: 0 });
    });
  });

  // G2. Heal path: event exists but stamp row is missing

  describe("G2. heal path — missing user_stamp is re-created from award event", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      db = makeDB({
        stamp_award_events: [awardedEvent()],
        // user_stamps intentionally empty — simulates partial failure during original award
        user_stamps: [],
      });
      const sc = makeFakeClient(db) as any;
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns { checked: 1, awarded: 1, skipped: 0 }", () => {
      assert.deepEqual(result, { checked: 1, awarded: 1, skipped: 0 });
    });

    it("inserts the missing user_stamp row", () => {
      assert.equal(db.user_stamps.length, 1, "Expected 1 user_stamp row to be healed");
    });

    it("healed stamp references the correct user and definition", () => {
      const row = db.user_stamps[0];
      assert.equal(row.user_id,             USER_ID);
      assert.equal(row.stamp_definition_id, DEF_ID);
      assert.equal(row.source_type,         "trips");
      assert.equal(row.source_id,           TRIP_ID);
      assert.equal(row.is_revoked,          false);
    });
  });

  // G3. Idempotent: stamp already exists → skip

  describe("G3. idempotent — existing stamp is not duplicated on re-run", () => {
    let db:     FakeDB;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      db = makeDB({
        stamp_award_events: [awardedEvent()],
        user_stamps: [
          {
            id:                  STAMP_ID,
            user_id:             USER_ID,
            stamp_definition_id: DEF_ID,
            source_type:         "trips",
            source_id:           TRIP_ID,
            is_revoked:          false,
          },
        ],
      });
      const sc = makeFakeClient(db) as any;
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns { checked: 1, awarded: 0, skipped: 1 }", () => {
      assert.deepEqual(result, { checked: 1, awarded: 0, skipped: 1 });
    });

    it("does not insert a second user_stamp row", () => {
      assert.equal(db.user_stamps.length, 1, "Should still have exactly 1 stamp after idempotent re-run");
    });
  });

  // G4. Security: a REVOKED stamp must not be resurrected by recalc.
  describe("G4. revoked stamp is NOT resurrected (admin revocation sticks)", () => {
    let db: FakeDB;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      db = makeDB({
        stamp_award_events: [awardedEvent()], // the 'awarded' event survives revocation
        user_stamps: [
          {
            id:                  STAMP_ID,
            user_id:             USER_ID,
            stamp_definition_id: DEF_ID,
            source_type:         "trips",
            source_id:           TRIP_ID,
            is_revoked:          true, // admin-revoked
          },
        ],
      });
      const sc = makeFakeClient(db) as any;
      result = await recalculateForUser(sc, USER_ID);
    });

    it("skips the revoked stamp rather than re-awarding it", () => {
      assert.deepEqual(result, { checked: 1, awarded: 0, skipped: 1 });
    });
    it("inserts no new row and leaves the stamp revoked", () => {
      assert.equal(db.user_stamps.length, 1, "no resurrected row");
      assert.equal(db.user_stamps[0].is_revoked, true, "revocation stays in effect");
    });
  });
});
