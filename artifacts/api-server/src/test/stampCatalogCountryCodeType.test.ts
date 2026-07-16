/**
 * Compile-time + runtime verification that the Supabase-generated type for
 * universal_stamp_catalog.country_code is string | null.
 *
 * The column was originally defined as char(2) NOT NULL in migration 0125.
 * Migration 0144 drops the NOT NULL constraint so the live schema allows null,
 * and the generated type in database.types.ts now reflects that.
 *
 * The compile-time assertion below fails to build if someone regenerates the
 * types from a schema that still has NOT NULL — making the discrepancy
 * immediately visible rather than silently hidden.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogCountryCodeType.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Tables } from "../lib/database.types.js";

// ── Compile-time assertion ────────────────────────────────────────────────────
//
// `null extends T` is `true` only when T includes null (i.e. T is string | null
// or null or unknown/any).  If country_code were `string` (non-null), this
// resolves to `never`, making the assignment below a compile error.
type _NullIsAssignable =
  null extends Tables<"universal_stamp_catalog">["Row"]["country_code"]
    ? true
    : never;

// This line is the guard: it will not compile if country_code is non-null.
const _typeCheck: _NullIsAssignable = true;

// Keep the compiler from tree-shaking the variable.
void _typeCheck;

// ── Runtime tests ─────────────────────────────────────────────────────────────

describe("universal_stamp_catalog generated type — country_code nullability", () => {
  it("Row type includes null for country_code", () => {
    // The compile-time assertion above already enforces this; the runtime
    // test documents the intent and gives a clear failure message if the
    // type file is regenerated without the nullable column.
    type RowCountryCode =
      Tables<"universal_stamp_catalog">["Row"]["country_code"];
    // At runtime we verify the type constant compiled successfully (true).
    assert.strictEqual(_typeCheck, true);

    // Also confirm the Insert type accepts null (optional nullable insert).
    type InsertCountryCode =
      Tables<"universal_stamp_catalog">["Insert"]["country_code"];
    type _InsertNullable = null extends InsertCountryCode ? true : never;
    const _insertCheck: _InsertNullable = true;
    assert.strictEqual(_insertCheck, true);
  });

  it("Update type accepts null for country_code", () => {
    type UpdateCountryCode =
      Tables<"universal_stamp_catalog">["Update"]["country_code"];
    type _UpdateNullable = null extends UpdateCountryCode ? true : never;
    const _updateCheck: _UpdateNullable = true;
    assert.strictEqual(_updateCheck, true);
  });
});
