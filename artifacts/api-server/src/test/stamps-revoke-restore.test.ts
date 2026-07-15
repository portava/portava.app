/**
 * stamps-revoke-restore.test.ts
 *
 * Integration tests for the three remaining public functions on StampAwardEngine
 * that the stamps-integration suite does not cover:
 *
 *   E. revokeStamp  — sets is_revoked, writes required audit event; fails + rolls
 *                     back if audit write fails.
 *   F. restoreStamp — clears is_revoked, writes required audit event; fails + rolls
 *                     back if audit write fails.
 *   G. recalculateForUser heal path — event row exists but user_stamp is missing →
 *                     inserts the missing stamp row and returns awarded:1.
 *
 * Pattern: node:test + tsx/esm, fake in-memory Supabase client, no vitest / no supertest.
 * Run: node --import tsx/esm --test src/test/stamps-revoke-restore.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { revokeStamp, restoreStamp, recalculateForUser } from "../services/passport/StampAwardEngine.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const USER_ID        = "a4000000-0000-4000-8000-000000000001";
const ADMIN_ID       = "a4000000-0000-4000-8000-000000000002";
const STAMP_ID       = "a4000000-0000-4000-8000-000000000010";
const DEF_ID         = "a4000000-0000-4000-8000-000000000020";
const AWARD_EVENT_ID = "a4000000-0000-4000-8000-000000000030";

// ── Fake DB ────────────────────────────────────────────────────────────────────

interface FakeDB {
  user_stamps:        any[];
  stamp_award_events: any[];
  stamp_definitions:  any[];
  /** When true, the next insert on stamp_award_events returns a DB error. */
  forceAuditError:    boolean;
  [key: string]:      any;
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
    forceAuditError: false,
    ...overrides,
  };
}

/** Builds a pre-revoked user_stamp row (used by restoreStamp tests). */
function revokedStampRow() {
  return {
    id:                 STAMP_ID,
    user_id:            USER_ID,
    stamp_definition_id: DEF_ID,
    source_type:        "system",
    source_id:          null,
    is_revoked:         true,
    revoked_at:         new Date().toISOString(),
    revoked_reason:     "test revoke",
  };
}

/** Builds an active (non-revoked) user_stamp row. */
function activeStampRow() {
  return {
    id:                 STAMP_ID,
    user_id:            USER_ID,
    stamp_definition_id: DEF_ID,
    source_type:        "system",
    source_id:          null,
    is_revoked:         false,
    revoked_at:         null,
    revoked_reason:     null,
  };
}

// ── Fake in-memory Supabase client ────────────────────────────────────────────

function makeFakeClient(db: FakeDB) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert:     any   = null;
    let _update:     any   = null;
    let _maybeSingle       = false;
    let _single            = false;

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    function tableArr(): any[] {
      if (!db[table]) db[table] = [];
      return db[table];
    }

    const chain: any = {
      select()       { return chain; },
      insert(data: any)  { _insert = Array.isArray(data) ? data : [data]; return chain; },
      update(data: any)  { _update = data; return chain; },
      eq(col: string, val: any)  { _filters.push((r) => r[col] === val); return chain; },
      is(col: string, val: any)  {
        _filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return chain;
      },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            const arr = tableArr();

            // Insert
            if (_insert) {
              // Simulate audit write failure on stamp_award_events
              if (table === "stamp_award_events" && db.forceAuditError) {
                return resolve({ data: null, error: { message: "simulated audit DB error", code: "XX000" } });
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

            // Select
            let results = applyFilters(arr).map((r) => ({ ...r }));
            if (_single)      return resolve({ data: results[0] ?? null, error: null });
            if (_maybeSingle) return resolve({ data: results[0] ?? null, error: null });
            return resolve({ data: results, error: null });
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
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  };
}

// ── E. revokeStamp ─────────────────────────────────────────────────────────────

describe("E. revokeStamp — marks revoked and writes required audit event", () => {
  describe("E1. successful revoke", () => {
    const db   = makeDB({ user_stamps: [activeStampRow()] });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    // Run once, inspect multiple assertions
    before(async () => {
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "policy_violation");
    });

    it("returns revoked=true", () => {
      assert.equal(result.revoked, true, `Expected revoked=true, got: ${JSON.stringify(result)}`);
    });

    it("returns reason='revoked'", () => {
      assert.equal(result.reason, "revoked");
    });

    it("user_stamp row is_revoked is now true", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.ok(stamp, "user_stamp row must still exist");
      assert.equal(stamp.is_revoked, true, "is_revoked must be true after revoke");
    });

    it("revoked_reason is persisted on the stamp row", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(stamp?.revoked_reason, "policy_violation");
    });

    it("one audit event with status='revoked' is written", () => {
      const auditEvents = db.stamp_award_events.filter((e) => e.status === "revoked");
      assert.equal(auditEvents.length, 1, `Expected 1 revoke audit event, got ${auditEvents.length}`);
    });

    it("audit event carries the correct adminId and reason", () => {
      const ev = db.stamp_award_events.find((e) => e.status === "revoked");
      assert.ok(ev, "revoke audit event must exist");
      assert.equal(ev.admin_id,    ADMIN_ID,           "audit event admin_id must match");
      assert.equal(ev.award_reason, "policy_violation", "audit event award_reason must match");
    });

    it("audit event source_type is 'admin'", () => {
      const ev = db.stamp_award_events.find((e) => e.status === "revoked");
      assert.equal(ev?.source_type, "admin");
    });
  });

  describe("E2. revoke on already-revoked stamp returns not_found_or_already_revoked", () => {
    const db   = makeDB({ user_stamps: [revokedStampRow()] });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    before(async () => {
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "duplicate_attempt");
    });

    it("returns revoked=false", () => {
      assert.equal(result.revoked, false);
    });

    it("returns reason='not_found_or_already_revoked'", () => {
      assert.equal(result.reason, "not_found_or_already_revoked");
    });

    it("no audit event is written", () => {
      assert.equal(db.stamp_award_events.length, 0, "No audit event should be written when stamp was already revoked");
    });
  });

  describe("E3. revoke fails and rolls back when audit write fails", () => {
    const db   = makeDB({ user_stamps: [activeStampRow()], forceAuditError: true });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof revokeStamp>>;

    before(async () => {
      result = await revokeStamp(sc, STAMP_ID, ADMIN_ID, "should_fail");
    });

    it("returns revoked=false when audit write fails", () => {
      assert.equal(result.revoked, false, `Expected revoked=false, got: ${JSON.stringify(result)}`);
    });

    it("reason contains 'audit_write_failed'", () => {
      assert.ok(
        result.reason.startsWith("audit_write_failed"),
        `Expected reason to start with 'audit_write_failed', got: ${result.reason}`,
      );
    });

    it("is_revoked is rolled back to false after audit failure", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.ok(stamp, "user_stamp row must still exist");
      assert.equal(stamp.is_revoked, false, "is_revoked must be rolled back to false when audit write failed");
    });

    it("no successful audit event remains in DB", () => {
      assert.equal(
        db.stamp_award_events.length,
        0,
        "No audit event should persist after a failed audit write (error was returned before push)",
      );
    });
  });
});

// ── F. restoreStamp ────────────────────────────────────────────────────────────

describe("F. restoreStamp — clears revoked flag and writes required audit event", () => {
  describe("F1. successful restore", () => {
    const db   = makeDB({ user_stamps: [revokedStampRow()] });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "appeal_granted");
    });

    it("returns restored=true", () => {
      assert.equal(result.restored, true, `Expected restored=true, got: ${JSON.stringify(result)}`);
    });

    it("returns reason='restored'", () => {
      assert.equal(result.reason, "restored");
    });

    it("user_stamp is_revoked is now false", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.ok(stamp, "user_stamp row must still exist");
      assert.equal(stamp.is_revoked, false, "is_revoked must be false after restore");
    });

    it("revoked_at and revoked_reason are cleared", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.equal(stamp?.revoked_at,     null, "revoked_at must be null after restore");
      assert.equal(stamp?.revoked_reason,  null, "revoked_reason must be null after restore");
    });

    it("one audit event with status='restored' is written", () => {
      const auditEvents = db.stamp_award_events.filter((e) => e.status === "restored");
      assert.equal(auditEvents.length, 1, `Expected 1 restore audit event, got ${auditEvents.length}`);
    });

    it("audit event carries the correct adminId and reason", () => {
      const ev = db.stamp_award_events.find((e) => e.status === "restored");
      assert.ok(ev, "restore audit event must exist");
      assert.equal(ev.admin_id,    ADMIN_ID,        "audit event admin_id must match");
      assert.equal(ev.award_reason, "appeal_granted", "audit event award_reason must match");
    });
  });

  describe("F2. restore on a non-revoked stamp returns not_found_or_not_revoked", () => {
    const db   = makeDB({ user_stamps: [activeStampRow()] });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "should_fail");
    });

    it("returns restored=false", () => {
      assert.equal(result.restored, false);
    });

    it("returns reason='not_found_or_not_revoked'", () => {
      assert.equal(result.reason, "not_found_or_not_revoked");
    });

    it("no audit event is written", () => {
      assert.equal(db.stamp_award_events.length, 0);
    });
  });

  describe("F3. restore fails and rolls back when audit write fails", () => {
    const db   = makeDB({ user_stamps: [revokedStampRow()], forceAuditError: true });
    const sc   = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof restoreStamp>>;

    before(async () => {
      result = await restoreStamp(sc, STAMP_ID, ADMIN_ID, "should_rollback");
    });

    it("returns restored=false when audit write fails", () => {
      assert.equal(result.restored, false, `Expected restored=false, got: ${JSON.stringify(result)}`);
    });

    it("reason contains 'audit_write_failed'", () => {
      assert.ok(
        result.reason.startsWith("audit_write_failed"),
        `Expected reason to start with 'audit_write_failed', got: ${result.reason}`,
      );
    });

    it("is_revoked is rolled back to true after audit failure", () => {
      const stamp = db.user_stamps.find((s) => s.id === STAMP_ID);
      assert.ok(stamp, "user_stamp row must still exist");
      assert.equal(stamp.is_revoked, true, "is_revoked must be rolled back to true when audit write failed during restore");
    });
  });
});

// ── G. recalculateForUser heal path ────────────────────────────────────────────

describe("G. recalculateForUser — heal path re-creates missing user_stamp rows", () => {
  describe("G1. event row exists but user_stamp is missing — heals the gap", () => {
    const db = makeDB({
      stamp_award_events: [
        {
          id:                 AWARD_EVENT_ID,
          user_id:            USER_ID,
          stamp_definition_id: DEF_ID,
          source_type:        "system",
          source_id:          null,
          award_reason:       "auto",
          admin_id:           null,
          idempotency_key:    `${USER_ID}:${DEF_ID}:system:none`,
          status:             "awarded",
        },
      ],
      // user_stamps intentionally empty to simulate partial failure
    });
    const sc = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns checked=1 (one event was examined)", () => {
      assert.equal(result.checked, 1, `Expected checked=1, got ${result.checked}`);
    });

    it("returns awarded=1 (the missing stamp was re-inserted)", () => {
      assert.equal(result.awarded, 1, `Expected awarded=1, got ${result.awarded}`);
    });

    it("returns skipped=0", () => {
      assert.equal(result.skipped, 0, `Expected skipped=0, got ${result.skipped}`);
    });

    it("a new user_stamp row is present after recalculate", () => {
      assert.equal(
        db.user_stamps.length,
        1,
        `Expected 1 user_stamp row after recalculate, got ${db.user_stamps.length}`,
      );
    });

    it("the inserted stamp belongs to the correct user and definition", () => {
      const stamp = db.user_stamps[0];
      assert.equal(stamp.user_id,             USER_ID, "user_id must match");
      assert.equal(stamp.stamp_definition_id,  DEF_ID,  "stamp_definition_id must match");
    });

    it("the inserted stamp is not revoked", () => {
      const stamp = db.user_stamps[0];
      assert.equal(stamp.is_revoked, false, "is_revoked must be false on healed stamp");
    });

    it("the inserted stamp has display_on_passport=true", () => {
      const stamp = db.user_stamps[0];
      assert.equal(stamp.display_on_passport, true);
    });
  });

  describe("G2. stamp row already exists — skips without duplicate insert", () => {
    const db = makeDB({
      stamp_award_events: [
        {
          id:                 AWARD_EVENT_ID,
          user_id:            USER_ID,
          stamp_definition_id: DEF_ID,
          source_type:        "system",
          source_id:          null,
          award_reason:       "auto",
          admin_id:           null,
          idempotency_key:    `${USER_ID}:${DEF_ID}:system:none`,
          status:             "awarded",
        },
      ],
      user_stamps: [
        {
          id:                 STAMP_ID,
          user_id:            USER_ID,
          stamp_definition_id: DEF_ID,
          source_type:        "system",
          source_id:          null,
          is_revoked:         false,
        },
      ],
    });
    const sc = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns checked=1", () => {
      assert.equal(result.checked, 1);
    });

    it("returns awarded=0 (stamp already exists, no heal needed)", () => {
      assert.equal(result.awarded, 0, `Expected awarded=0, got ${result.awarded}`);
    });

    it("returns skipped=1", () => {
      assert.equal(result.skipped, 1, `Expected skipped=1, got ${result.skipped}`);
    });

    it("still exactly 1 user_stamp row (no duplicate inserted)", () => {
      assert.equal(db.user_stamps.length, 1, "Must not insert a duplicate stamp row");
    });
  });

  describe("G3. no award events for user — returns all-zero counts", () => {
    const db = makeDB();
    const sc = makeFakeClient(db) as any;
    let result: Awaited<ReturnType<typeof recalculateForUser>>;

    before(async () => {
      result = await recalculateForUser(sc, USER_ID);
    });

    it("returns checked=0", () => {
      assert.equal(result.checked, 0);
    });

    it("returns awarded=0", () => {
      assert.equal(result.awarded, 0);
    });

    it("returns skipped=0", () => {
      assert.equal(result.skipped, 0);
    });

    it("no user_stamp rows are created", () => {
      assert.equal(db.user_stamps.length, 0);
    });
  });
});
