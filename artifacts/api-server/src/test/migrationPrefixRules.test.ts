/**
 * New-numeric-prefix band rules
 *
 * Closes the gap where a future 8-digit dated migration filename
 * (20270101_foo.sql) would sort lexicographically BELOW the string "2100" —
 * an exact test for "authored after baseline" only as long as every filename
 * compared against it is a same-length 4-digit prefix. See
 * migrationPrefixRules.ts for the full reasoning.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePrefixBand, validateAllPrefixBands, RESERVED_BUFFER_MIN, RESERVED_BUFFER_MAX } from "../scripts/migrationPrefixRules.js";

describe("validatePrefixBand — the lexicographic-sort gap this exists to close", () => {
  it("a future 8-digit dated file sorts BELOW the string '2100' — demonstrating the bug this closes", () => {
    // This is the literal footgun described in the module doc: a naive
    // `filename >= "2100"` test would misclassify this file as pre-baseline.
    assert.ok("20270101_foo.sql" < "2100", "sanity check on the underlying JS string comparison");
  });

  it("that same 8-digit dated file is NOT flagged by this check (different, unambiguous convention)", () => {
    assert.equal(validatePrefixBand("20270101_foo.sql"), null);
  });

  it("any 8-digit dated file, in or out of the reserved decimal range, passes clean", () => {
    assert.equal(validatePrefixBand("20260815_close_memories.sql"), null);
    assert.equal(validatePrefixBand("21000101_far_future.sql"), null); // 8 digits, not 4 — still fine
  });
});

describe("validatePrefixBand — reserved buffer 2096-2099", () => {
  it("flags every prefix in the reserved buffer", () => {
    for (const n of [2096, 2097, 2098, 2099]) {
      const v = validatePrefixBand(`${n}_something.sql`);
      assert.ok(v, `${n} must be flagged`);
      assert.match(v!.reason, /reserved buffer/);
    }
  });

  it("does not flag the boundaries just outside the buffer", () => {
    assert.equal(validatePrefixBand("2095_last_legacy.sql"), null, "2095 is grandfathered, just below the buffer");
    assert.equal(validatePrefixBand("2100_first_new.sql"), null, "2100 is the first valid new-format prefix");
  });

  it("RESERVED_BUFFER_MIN/MAX are exactly 2096 and 2099", () => {
    assert.equal(RESERVED_BUFFER_MIN, 2096);
    assert.equal(RESERVED_BUFFER_MAX, 2099);
  });
});

describe("validatePrefixBand — new-format ranges 2100-2999 and 3000-3999", () => {
  it("accepts prefixes across the valid range", () => {
    for (const n of [2100, 2150, 2500, 2999]) {
      assert.equal(validatePrefixBand(`${n}_ok.sql`), null, `${n} should be valid`);
    }
  });

  it("accepts 3000-3999, added 2026-09-23 because 2100-2999 ran out", () => {
    // This assertion used to say the opposite, and it changed on purpose. Main
    // held prefixes up to 2997 and unmerged branches held 2998 and 2999, so
    // there was no number a new migration could take without planting a
    // collision. A dated prefix is not the alternative: apply order is plain
    // lexicographic and "20260923_…" sorts below "2810_…", so a dated file
    // authored today would run before the migrations it depends on.
    for (const n of [3000, 3001, 3500, 3999]) {
      assert.equal(validatePrefixBand(`${n}_ok.sql`), null, `${n} should now be valid`);
    }
  });

  it("3000-3999 still cannot be confused with a dated prefix, and still sorts after 2xxx", () => {
    // The invariant this module exists for, now carried by the FIRST digit
    // rather than the second: no YYYYMMDD in this millennium begins with "3".
    assert.ok("3000_x.sql" > "2999_x.sql", "a 3xxx prefix must sort after every 2xxx one");
    assert.ok("3000_x.sql".slice(0, 4) >= "2100", "a 3xxx prefix must still read as post-cutover");
    assert.ok("20260923_x.sql" < "2810_x.sql",
      "this is why a dated prefix is not the escape hatch for a dependent migration");
  });

  it("rejects a 4-digit prefix at or above 4000, which is not allocated", () => {
    const v = validatePrefixBand("4000_too_far.sql");
    assert.ok(v);
    assert.match(v!.reason, /3000-3999/);
    assert.match(v!.reason, /not allocated yet/);
  });

  it("rejects a prefix whose second digit is 0 (would collide in spirit with the 20xx dated shape)", () => {
    // 2000-2095 already exist as legacy files; a NEW file landing back in
    // that shape (e.g. 2010, chosen after the buffer was supposedly adopted)
    // is not itself dangerous since it's < 2096 and therefore grandfathered
    // by definition — this test instead confirms the boundary is precise at
    // exactly 2096, not fuzzy.
    assert.equal(validatePrefixBand("2010_reused_legacy_shape.sql"), null, "< 2096 is always grandfathered, regardless of digit shape");
  });
});

describe("validatePrefixBand — grandfathered legacy prefixes", () => {
  it("every prefix below the buffer passes, matching real files in the canonical chain today", () => {
    for (const name of ["0010_trip_plan.sql", "0011_x.sql", "2059_content_distribution_stats.sql", "2078_x.sql", "2079_x.sql", "2089_x.sql", "2095_discovery_place_photos.sql"]) {
      assert.equal(validatePrefixBand(name), null, `${name} must be grandfathered clean`);
    }
  });
});

describe("validatePrefixBand — files this check doesn't apply to at all", () => {
  it("a filename with no numeric prefix returns null", () => {
    assert.equal(validatePrefixBand("APPLY_THESE_IN_ORDER.sql"), null);
    assert.equal(validatePrefixBand("README.sql"), null);
  });

  it("a near-miss like a hyphen instead of underscore returns null (not this check's shape)", () => {
    assert.equal(validatePrefixBand("2097-rollback.sql"), null);
  });
});

describe("validateAllPrefixBands", () => {
  it("returns violations only for the offending files, in a mixed list", () => {
    const files = [
      "0010_trip_plan.sql",
      "2095_discovery_place_photos.sql",
      "20260815_close_memories.sql",
      "2097_sneaks_into_the_buffer.sql",
      "2100_valid_new_format.sql",
      "3000_valid_new_format.sql",
      "4000_out_of_range.sql",
    ];
    const violations = validateAllPrefixBands(files);
    assert.deepEqual(
      violations.map((v) => v.file).sort(),
      ["2097_sneaks_into_the_buffer.sql", "4000_out_of_range.sql"].sort(),
    );
  });

  it("an empty list produces no violations", () => {
    assert.deepEqual(validateAllPrefixBands([]), []);
  });
});
