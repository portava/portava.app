/**
 * pushTokenCleanup unit tests
 *
 * Verifies that clearDeadTokens() issues no DB calls when called with an
 * empty token list.  An empty .in() filter on some Supabase driver versions
 * matches ALL rows — a silent catastrophic wipe — so the function must
 * short-circuit before touching the database.
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

interface DbCall {
  table:    string;
  kind:     "update" | "delete";
}

function makeFakeClient() {
  const dbCalls: DbCall[] = [];

  function builder(tableName: string) {
    const b: Record<string, unknown> = {
      update(_patch: unknown) {
        dbCalls.push({ table: tableName, kind: "update" });
        return b;
      },
      delete() {
        dbCalls.push({ table: tableName, kind: "delete" });
        return b;
      },
      in(_col: string, _vals: unknown[]) { return b; },
      eq(_col: string, _val: unknown)    { return b; },
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
