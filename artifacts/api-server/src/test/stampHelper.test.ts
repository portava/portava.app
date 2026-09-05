/**
 * Unit tests for stampHelper.ts — pure logic only (no DB or HTTP).
 * Run: node --import tsx/esm --test src/test/stampHelper.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCityStampLabels, upsertCityStamp } from "../lib/stampHelper";

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

  // FIXTURE REPAIR (STAMP·H3): this used to assert `GE · YEAR`, which is not a
  // country code at all — it was the first two letters of "germany". Germany's
  // real ISO-3166-1 alpha-2 code is DE. The old assertion encoded the
  // truncation bug, so it is corrected to reality here rather than relaxed.
  it("handles mixed-case country", () => {
    const { sublabel } = buildCityStampLabels("berlin", "germany");
    assert.equal(sublabel, `DE · ${YEAR}`);
  });

  it("preserves city with special chars", () => {
    const { label } = buildCityStampLabels("ho chi minh", "VN");
    assert.equal(label, "HO CHI MINH");
  });

  // Blank city guards — empty or whitespace-only city must not produce a blank label.
  it('falls back to "UNKNOWN" when city is "" (empty string)', () => {
    const { label } = buildCityStampLabels("", null);
    assert.equal(label, "UNKNOWN");
  });

  it('falls back to "UNKNOWN" when city is "   " (whitespace-only)', () => {
    const { label } = buildCityStampLabels("   ", null);
    assert.equal(label, "UNKNOWN");
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

  // A full country name resolves through the ISO name table.
  it("uses the real ISO code for a full country name", () => {
    const { sublabel } = buildCityStampLabels("somewhere", "Philippines");
    assert.equal(sublabel, `PH · ${YEAR}`);
  });

  // FIXTURE REPAIR (STAMP·H3): these two cases were named "extracts US from
  // US1" / "extracts TH from TH-ext" and documented as prefix truncation. The
  // expected values happen to be right, but the stated mechanism was the bug.
  // The malformed country string now resolves to nothing at all; the code comes
  // from the well-known-city lookup instead. Names and comments corrected.
  it('falls back to the city lookup when the country is malformed ("US1")', () => {
    const { sublabel } = buildCityStampLabels("new york", "US1");
    assert.equal(sublabel, `US · ${YEAR}`);
  });

  it('falls back to the city lookup when the country is malformed ("TH-ext")', () => {
    const { sublabel } = buildCityStampLabels("bangkok", "TH-ext");
    assert.equal(sublabel, `TH · ${YEAR}`);
  });

  // …and when neither the country string nor the city is resolvable, no code
  // is emitted at all rather than a truncated one.
  it("emits no code when a malformed country has no resolvable city", () => {
    const { sublabel } = buildCityStampLabels("nowheresville", "US1");
    assert.equal(sublabel, String(YEAR));
  });
});

// ── upsertCityStamp: country resolution ───────────────────────────────────────
// Verifies that upsertCityStamp derives country from the city name when the
// caller passes locationCountry=null, so passport_stamps rows are never
// written with country=null when a well-known city is present.

function makeFakeRpc(
  captured: { name: string; args: Record<string, unknown> }[],
  returnError: boolean = false,
) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      captured.push({ name, args });
      return Promise.resolve({ error: returnError ? { message: "rpc error" } : null });
    },
  };
}

describe("upsertCityStamp — country resolution via resolveCountry", () => {
  it("passes resolved country when locationCountry is null and city is well-known (Bohol → Philippines)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fakeClient = makeFakeRpc(calls);
    const fakeLog = { error: () => {} };

    await upsertCityStamp(
      fakeClient as any,
      { userId: "u1", locationCity: "Bohol", locationCountry: null, postcardId: null },
      fakeLog,
    );

    assert.equal(calls.length, 1);
    const { args } = calls[0];
    // Bohol is in the Philippines — resolveCountry should derive it
    assert.ok(
      typeof args["p_location_country"] === "string" && (args["p_location_country"] as string).length > 0,
      `expected non-null country, got ${JSON.stringify(args["p_location_country"])}`,
    );
    assert.match(args["p_location_country"] as string, /Philippines/i);
  });

  it("passes resolved country when locationCountry is null and city is Ubud (→ Indonesia)", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fakeClient = makeFakeRpc(calls);
    const fakeLog = { error: () => {} };

    await upsertCityStamp(
      fakeClient as any,
      { userId: "u2", locationCity: "Ubud", locationCountry: null, postcardId: null },
      fakeLog,
    );

    assert.equal(calls.length, 1);
    const { args } = calls[0];
    assert.ok(
      typeof args["p_location_country"] === "string" && (args["p_location_country"] as string).length > 0,
      `expected non-null country, got ${JSON.stringify(args["p_location_country"])}`,
    );
    assert.match(args["p_location_country"] as string, /Indonesia/i);
  });

  it("prefers the explicit locationCountry over the resolved one when both are present", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fakeClient = makeFakeRpc(calls);
    const fakeLog = { error: () => {} };

    await upsertCityStamp(
      fakeClient as any,
      { userId: "u3", locationCity: "Bohol", locationCountry: "Philippines", postcardId: null },
      fakeLog,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args["p_location_country"], "Philippines");
  });

  it("passes null when neither locationCountry nor city-lookup yields a country", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fakeClient = makeFakeRpc(calls);
    const fakeLog = { error: () => {} };

    await upsertCityStamp(
      fakeClient as any,
      { userId: "u4", locationCity: "Smallville", locationCountry: null, postcardId: null },
      fakeLog,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args["p_location_country"], null);
  });

  it("logs error and does not throw when RPC fails", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const fakeClient = makeFakeRpc(calls, /* returnError= */ true);
    const errors: unknown[] = [];
    const fakeLog = { error: (...args: unknown[]) => { errors.push(args); } };

    await assert.doesNotReject(() =>
      upsertCityStamp(
        fakeClient as any,
        { userId: "u5", locationCity: "Bohol", locationCountry: null, postcardId: null },
        fakeLog,
      ),
    );
    assert.equal(errors.length, 1);
  });
});
