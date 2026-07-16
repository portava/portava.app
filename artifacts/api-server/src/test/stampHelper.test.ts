/**
 * Unit tests for stampHelper.ts — pure logic only (no DB or HTTP).
 * Run: node --import tsx/esm --test src/test/stampHelper.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCityStampLabels } from "../lib/stampHelper";

const YEAR = new Date().getFullYear();

describe("buildCityStampLabels", () => {
  it("uppercases city label", () => {
    const { label } = buildCityStampLabels("cebu", "Philippines");
    assert.equal(label, "CEBU");
  });

  it("trims whitespace from city", () => {
    const { label } = buildCityStampLabels("  tokyo  ", "Japan");
    assert.equal(label, "TOKYO");
  });

  it("uses 2-char country code + year in sublabel", () => {
    const { sublabel } = buildCityStampLabels("cebu", "Philippines");
    assert.equal(sublabel, `PH · ${YEAR}`);
  });

  it("uses 2-char code from short country string", () => {
    const { sublabel } = buildCityStampLabels("bangkok", "TH");
    assert.equal(sublabel, `TH · ${YEAR}`);
  });

  it("falls back to year-only when country is null", () => {
    const { sublabel } = buildCityStampLabels("somewhere", null);
    assert.equal(sublabel, String(YEAR));
  });

  it("handles mixed-case country", () => {
    const { sublabel } = buildCityStampLabels("berlin", "germany");
    assert.equal(sublabel, `GE · ${YEAR}`);
  });

  it("preserves city with special chars", () => {
    const { label } = buildCityStampLabels("ho chi minh", "VN");
    assert.equal(label, "HO CHI MINH");
  });

  // "Unknown" is a sentinel value for unresolved ownership rows; slicing it
  // would produce "UN · 2026" which looks like a country code but is meaningless.
  it('falls back to year-only when country is "Unknown"', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "Unknown");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "unknown" (lowercase)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "unknown");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "UNKNOWN" (uppercase)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "UNKNOWN");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "  Unknown  " (whitespace-padded)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "  Unknown  ");
    assert.equal(sublabel, String(YEAR));
  });
});
