/**
 * Age eligibility tests.
 *
 * Covers:
 *   - calculateUserAge
 *   - getAgeEligibilityReason (no_limit, dob_missing, below_min, above_max, within_range)
 *   - formatAgeLimitLabel
 *   - validateAgeRange
 *
 * Uses Node.js built-in test runner (no external test framework needed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateUserAge,
  getAgeEligibilityReason,
  formatAgeLimitLabel,
  validateAgeRange,
  isUserAgeEligible,
} from "../lib/ageEligibility.js";

// ── calculateUserAge ──────────────────────────────────────────────────────────

describe("calculateUserAge", () => {
  it("returns null for null dob", () => {
    assert.equal(calculateUserAge(null), null);
  });

  it("returns null for undefined dob", () => {
    assert.equal(calculateUserAge(undefined), null);
  });

  it("returns null for unparseable string", () => {
    assert.equal(calculateUserAge("not-a-date"), null);
  });

  it("returns correct full years for a past birthday this year", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 25, now.getMonth() - 1, 1);
    const dobStr = dob.toISOString().slice(0, 10);
    assert.equal(calculateUserAge(dobStr), 25);
  });

  it("returns age - 1 when birthday hasn't occurred yet this year", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 25, now.getMonth() + 2, 1);
    const dobStr = dob.toISOString().slice(0, 10);
    assert.equal(calculateUserAge(dobStr), 24);
  });
});

// ── getAgeEligibilityReason — no age limit ────────────────────────────────────

describe("getAgeEligibilityReason — no age limit", () => {
  it("returns no_limit eligible when age_limit_enabled=false", () => {
    const result = getAgeEligibilityReason("1990-01-01", false, null, null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "no_limit");
    assert.equal(result.hostStatus, "no_limit");
  });

  it("allows missing DOB when age limit is disabled", () => {
    const result = getAgeEligibilityReason(null, false, 18, null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "no_limit");
  });
});

// ── getAgeEligibilityReason — dob_missing ────────────────────────────────────

describe("getAgeEligibilityReason — DOB missing", () => {
  it("returns dob_missing when limit is on and dob is null", () => {
    const result = getAgeEligibilityReason(null, true, 18, null);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "dob_missing");
    assert.equal(result.hostStatus, "dob_missing");
  });

  it("returns dob_missing when limit is on and dob is empty string", () => {
    const result = getAgeEligibilityReason("", true, 18, null);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "dob_missing");
  });
});

// ── getAgeEligibilityReason — below_min_age ───────────────────────────────────

describe("getAgeEligibilityReason — below min age", () => {
  it("blocks a 17-year-old from an 18+ event", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 17, now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, 18, null);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "below_min_age");
    assert.equal(result.hostStatus, "not_eligible");
  });

  it("blocks a 20-year-old from a 21+ event", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 20, now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, 21, null);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "below_min_age");
  });
});

// ── getAgeEligibilityReason — above_max_age ───────────────────────────────────

describe("getAgeEligibilityReason — above max age", () => {
  it("blocks a 31-year-old from an Under 30 event", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 31, now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, null, 30);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "above_max_age");
    assert.equal(result.hostStatus, "not_eligible");
  });
});

// ── getAgeEligibilityReason — within_range ────────────────────────────────────

describe("getAgeEligibilityReason — within range", () => {
  it("allows a 25-year-old to join an 18+ event", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 25, now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, 18, null);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "within_range");
    assert.equal(result.hostStatus, "eligible");
  });

  it("allows a 25-year-old to join an 18–30 event", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 25, now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, 18, 30);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "within_range");
  });

  it("allows exact min-age boundary (just turned 18)", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 18, now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, 18, null);
    assert.equal(result.eligible, true);
  });

  it("allows exact max-age boundary (just turned 30 on a 30-max event)", () => {
    const now = new Date();
    const dob = new Date(now.getFullYear() - 30, now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    const result = getAgeEligibilityReason(dob, true, null, 30);
    assert.equal(result.eligible, true);
  });
});

// ── isUserAgeEligible shorthand ───────────────────────────────────────────────

describe("isUserAgeEligible", () => {
  it("returns true when no limit", () => {
    assert.equal(isUserAgeEligible(null, false, null, null), true);
  });

  it("returns false when dob missing and limit enabled", () => {
    assert.equal(isUserAgeEligible(null, true, 18, null), false);
  });
});

// ── formatAgeLimitLabel ───────────────────────────────────────────────────────

describe("formatAgeLimitLabel", () => {
  it("returns null when limit disabled", () => {
    assert.equal(formatAgeLimitLabel(false, 18, null), null);
  });

  it("formats min-only as Ages N+", () => {
    assert.equal(formatAgeLimitLabel(true, 21, null), "Ages 21+");
  });

  it("formats max-only as Under N+1", () => {
    assert.equal(formatAgeLimitLabel(true, null, 29), "Under 30");
  });

  it("formats min+max as Ages N–M", () => {
    assert.equal(formatAgeLimitLabel(true, 18, 30), "Ages 18–30");
  });

  it("returns null when limit enabled but both null", () => {
    assert.equal(formatAgeLimitLabel(true, null, null), null);
  });
});

// ── validateAgeRange ─────────────────────────────────────────────────────────

describe("validateAgeRange", () => {
  it("returns null for valid min + max", () => {
    assert.equal(validateAgeRange(18, 30), null);
  });

  it("returns null for min only", () => {
    assert.equal(validateAgeRange(21, null), null);
  });

  it("returns null for max only", () => {
    assert.equal(validateAgeRange(null, 35), null);
  });

  it("rejects max < min", () => {
    const err = validateAgeRange(30, 20);
    assert.ok(err?.includes("greater than or equal to minimum"));
  });

  it("rejects min below platform minimum", () => {
    const err = validateAgeRange(10, null);
    assert.ok(err?.includes("at least 18"));
  });

  it("rejects max above platform maximum", () => {
    const err = validateAgeRange(null, 150);
    assert.ok(err?.includes("at most 100"));
  });
});
