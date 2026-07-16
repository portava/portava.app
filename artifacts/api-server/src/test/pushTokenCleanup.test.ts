/**
 * pushTokenCleanup unit tests
 *
 * Verifies that clearDeadTokens() issues no DB calls when called with an
 * empty token list.  An empty .in() filter on some Supabase driver versions
 * matches ALL rows — a silent catastrophic wipe — so the function must
 * short-circuit before touching the database.
 *
 * Also verifies that a non-empty token list reaches all three storage tables
 * (profiles, notification_devices, rent_buddy_profiles) with the correct
 * token passed to each .in() filter.
 *
 * Run: node --import tsx/esm --test src/test/pushTokenCleanup.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clearDeadTokens } from "../lib/pushTokenCleanup.js";

// ── Minimal fake Supabase client ───────────────────────────────────────────────
//
// Records every .from() call so the test can assert that zero DB operations
// were issued.  Any call to .from() is recorded as a "touched table"; the
// mutation methods (update, delete) are also individually tracked.
//
// The .in() filter values are captured in the DbCall entry so the happy-path
// test can assert that the correct token list reached each table.

interface DbCall {
  table:       string;
  kind:        "update" | "delete";
  filterCol:   string | null;
  filterVals:  unknown[] | null;
}

function makeFakeClient() {
  const dbCalls: DbCall[] = [];

  function builder(tableName: string) {
    // Pending call entry — .in() fills in the filter details before the
    // promise resolves.
    let pending: DbCall | null = null;

    const b: Record<string, unknown> = {
      update(_patch: unknown) {
        pending = { table: tableName, kind: "update", filterCol: null, filterVals: null };
        dbCalls.push(pending);
        return b;
      },
      delete() {
        pending = { table: tableName, kind: "delete", filterCol: null, filterVals: null };
        dbCalls.push(pending);
        return b;
      },
      in(col: string, vals: unknown[]) {
        if (pending) {
          pending.filterCol  = col;
          pending.filterVals = vals;
        }
        return b;
      },
      eq(_col: string, _val: unknown) { return b; },
      then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    from: builder as unknown as (t: string) => ReturnType<typeof builder>,
    /** Every DB mutation call recorded, in order. */
    get dbCalls() { return dbCalls; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// clearDeadTokens([]) — empty list guard
// ─────────────────────────────────────────────────────────────────────────────

describe("clearDeadTokens() — empty token list", () => {
  it("issues no DB calls (no profiles update, no notification_devices delete, no rent_buddy_profiles update)", async () => {
    const client = makeFakeClient();

    await clearDeadTokens(client as never, []);

    assert.equal(
      client.dbCalls.length,
      0,
      `expected 0 DB calls but got ${client.dbCalls.length}: ${JSON.stringify(client.dbCalls)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearDeadTokens([token]) — happy path: all three tables reached
// ─────────────────────────────────────────────────────────────────────────────

describe("clearDeadTokens() — valid token list", () => {
  it("fires exactly three DB operations (profiles update, notification_devices delete, rent_buddy_profiles update) each with the correct token in the .in() filter", async () => {
    const client = makeFakeClient();
    const tokens = ["ExponentPushToken[abc123]", "ExponentPushToken[def456]"];

    await clearDeadTokens(client as never, tokens);

    assert.equal(
      client.dbCalls.length,
      3,
      `expected 3 DB calls but got ${client.dbCalls.length}: ${JSON.stringify(client.dbCalls)}`,
    );

    // ── profiles: update with .in("expo_push_token", tokens) ──
    const profilesCall = client.dbCalls[0];
    assert.equal(profilesCall.table, "profiles", "first call must target profiles");
    assert.equal(profilesCall.kind,  "update",   "profiles call must be an update");
    assert.equal(profilesCall.filterCol, "expo_push_token",
      "profiles .in() must filter on expo_push_token");
    assert.deepEqual(profilesCall.filterVals, tokens,
      "profiles .in() must receive the full token list");

    // ── notification_devices: delete with .in("push_token", tokens) ──
    const devicesCall = client.dbCalls[1];
    assert.equal(devicesCall.table, "notification_devices",
      "second call must target notification_devices");
    assert.equal(devicesCall.kind,  "delete",
      "notification_devices call must be a delete");
    assert.equal(devicesCall.filterCol, "push_token",
      "notification_devices .in() must filter on push_token");
    assert.deepEqual(devicesCall.filterVals, tokens,
      "notification_devices .in() must receive the full token list");

    // ── rent_buddy_profiles: update with .in("expo_push_token", tokens) ──
    const rentCall = client.dbCalls[2];
    assert.equal(rentCall.table, "rent_buddy_profiles",
      "third call must target rent_buddy_profiles");
    assert.equal(rentCall.kind,  "update",
      "rent_buddy_profiles call must be an update");
    assert.equal(rentCall.filterCol, "expo_push_token",
      "rent_buddy_profiles .in() must filter on expo_push_token");
    assert.deepEqual(rentCall.filterVals, tokens,
      "rent_buddy_profiles .in() must receive the full token list");
  });
});
