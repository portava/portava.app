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

  // Additional sentinels that would otherwise produce fake codes like "N/" or "NO".
  it('falls back to year-only when country is "N/A"', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "N/A");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "n/a" (lowercase)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "n/a");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "  N/A  " (whitespace-padded)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "  N/A  ");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "None"', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "None");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "none" (lowercase)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "none");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "NONE" (uppercase)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "NONE");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "" (empty string)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "   " (whitespace-only)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "   ");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "null"', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "null");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "undefined"', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "undefined");
    assert.equal(sublabel, String(YEAR));
  });

  // Punctuation-only strings would produce garbled codes like "--" or "??" if
  // sliced — they must fall back to year-only.
  it('falls back to year-only when country is "---" (punctuation-only)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "---");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "???" (punctuation-only)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "???");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "--" (two-char punctuation)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "--");
    assert.equal(sublabel, String(YEAR));
  });

  // Digit-only strings would produce codes like "00" or "12" — also garbled.
  it('falls back to year-only when country is "00" (digit-only)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "00");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "123" (digit-only)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "123");
    assert.equal(sublabel, String(YEAR));
  });

  it('falls back to year-only when country is "42" (two-digit)', () => {
    const { sublabel } = buildCityStampLabels("somewhere", "42");
    assert.equal(sublabel, String(YEAR));
  });

  // A string starting with letters but containing digits/punctuation after the
  // first two characters is still valid (the guard only checks the prefix).
  it("uses country code when string starts with two or more letters", () => {
    const { sublabel } = buildCityStampLabels("somewhere", "Philippines");
    assert.equal(sublabel, `PH · ${YEAR}`);
  });

  // A country string that starts with letters but contains digits after the
  // prefix must still produce the two-letter code — the guard is prefix-only.
  it('extracts "US" from "US1" (letters-then-digit)', () => {
    const { sublabel } = buildCityStampLabels("new york", "US1");
    assert.equal(sublabel, `US · ${YEAR}`);
  });

  it('extracts "TH" from "TH-ext" (letters then hyphen+letters)', () => {
    const { sublabel } = buildCityStampLabels("bangkok", "TH-ext");
    assert.equal(sublabel, `TH · ${YEAR}`);
  });
});
