/**
 * STAMP·H3 regression guard — country codes are never derived by truncation.
 *
 * A measured audit found the legacy stamp path converting a country NAME to a
 * "code" with `name.slice(0, 2).toUpperCase()`. That fabricates codes that
 * look real but are not:
 *
 *   Vietnam       → "VI"   (real VN; "VI" is the U.S. Virgin Islands)
 *   Japan         → "JA"   (real JP; "JA" is not an ISO code at all)
 *   United States → "UN"   (real US)
 *   Germany       → "GE"   (real DE; "GE" is Georgia)
 *
 * Four of the six launch cities (Fort Lauderdale, Miami, Manila, Tokyo,
 * Da Nang, Bangkok) were hit: Fort Lauderdale and Miami → "UN", Tokyo → "JA",
 * Da Nang → "VI". Manila → "PH" and Bangkok → "TH" were only right by
 * coincidence — truncation happened to land on the correct letters.
 *
 * Every case below fails if the truncation is restored at either site.
 *
 * Run: node --import tsx/esm --test src/test/stampCountryCodeTruncation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCityStampLabels } from "../lib/stampHelper.js";
import { normalizeCatalogCountryCode } from "../lib/stamps/StampCatalogService.js";

const YEAR = new Date().getFullYear();

/** The six launch cities, their country as the client sends it, and the truth. */
const LAUNCH_CITIES: ReadonlyArray<{
  city: string;
  country: string;
  iso: string;
  /** what the old `slice(0, 2)` produced */
  truncated: string;
}> = [
  { city: "Fort Lauderdale", country: "United States", iso: "US", truncated: "UN" },
  { city: "Miami", country: "United States", iso: "US", truncated: "UN" },
  { city: "Manila", country: "Philippines", iso: "PH", truncated: "PH" },
  { city: "Tokyo", country: "Japan", iso: "JP", truncated: "JA" },
  { city: "Da Nang", country: "Vietnam", iso: "VN", truncated: "VI" },
  { city: "Bangkok", country: "Thailand", iso: "TH", truncated: "TH" },
];

// ── Site 1: lib/stampHelper.ts — buildCityStampLabels (the live legacy path) ──

describe("STAMP·H3 · buildCityStampLabels — real ISO codes, never truncation", () => {
  for (const { city, country, iso } of LAUNCH_CITIES) {
    it(`${city} / ${country} → "${iso} · ${YEAR}"`, () => {
      const { sublabel } = buildCityStampLabels(city, country);
      assert.equal(
        sublabel,
        `${iso} · ${YEAR}`,
        `${country} must render its real ISO-3166-1 alpha-2 code ${iso}`,
      );
    });
  }

  // The four cities where truncation and truth actually diverge. Stated as its
  // own assertion so a regression names the fabrication rather than just a
  // string mismatch.
  for (const { city, country, iso, truncated } of LAUNCH_CITIES.filter(
    (c) => c.iso !== c.truncated,
  )) {
    it(`${city} must not render the fabricated code "${truncated}"`, () => {
      const { sublabel } = buildCityStampLabels(city, country);
      assert.ok(
        !sublabel.startsWith(`${truncated} `),
        `${country} rendered "${sublabel}" — "${truncated}" is the first two ` +
          `letters of the name, not a country code (real code: ${iso})`,
      );
    });
  }

  // Structural guard: no launch city may ever render its own name's prefix.
  it("no launch city renders name-prefix truncation", () => {
    for (const { city, country, iso } of LAUNCH_CITIES) {
      const { sublabel } = buildCityStampLabels(city, country);
      const prefix = country.slice(0, 2).toUpperCase();
      if (prefix !== iso) {
        assert.notEqual(sublabel, `${prefix} · ${YEAR}`, `${country} was truncated`);
      }
    }
  });

  it("resolves each launch city from the city name alone (country omitted)", () => {
    for (const { city, iso } of LAUNCH_CITIES) {
      const { sublabel } = buildCityStampLabels(city, null);
      assert.equal(sublabel, `${iso} · ${YEAR}`, `${city} (country omitted)`);
    }
  });

  it("uppercases the city into the label unchanged", () => {
    assert.equal(buildCityStampLabels("Da Nang", "Vietnam").label, "DA NANG");
  });

  // Alpha-3 inputs are the trap that makes "smarter truncation" impossible:
  // DNK→"DN" (real DK) and PRT→"PR" (real PT, and "PR" is Puerto Rico).
  // We emit nothing rather than guess.
  for (const alpha3 of ["DNK", "PRT", "JPN", "VNM"]) {
    it(`emits no code for the alpha-3 input "${alpha3}"`, () => {
      const { sublabel } = buildCityStampLabels("nowheresville", alpha3);
      assert.equal(
        sublabel,
        String(YEAR),
        `"${alpha3}" is not alpha-2 and must not be truncated to ` +
          `"${alpha3.slice(0, 2)}"`,
      );
    });
  }

  it("emits no code for an unknown country and unknown city", () => {
    const { sublabel } = buildCityStampLabels("nowheresville", "Freedonia");
    assert.equal(sublabel, String(YEAR));
    assert.ok(!sublabel.includes("FR"), "must not fabricate FR from Freedonia");
  });

  it("emits no code — not 'XX' — when the country is unresolvable", () => {
    // "XX" is the catalog's internal sentinel; it must never reach a user-facing
    // sublabel, where it would read as a country code.
    const { sublabel } = buildCityStampLabels("nowheresville", "Freedonia");
    assert.ok(!sublabel.includes("XX"), `sublabel leaked a sentinel: ${sublabel}`);
  });
});

// ── Site 2: lib/stamps/StampCatalogService.ts — catalog country_code ─────────

describe("STAMP·H3 · normalizeCatalogCountryCode — never truncates", () => {
  for (const { country, iso, truncated } of LAUNCH_CITIES) {
    it(`"${country}" → "${iso}" (not "${truncated}")`, () => {
      assert.equal(normalizeCatalogCountryCode(country), iso);
    });
  }

  it("passes a real ISO code through, uppercased", () => {
    assert.equal(normalizeCatalogCountryCode("vn"), "VN");
    assert.equal(normalizeCatalogCountryCode("JP"), "JP");
    assert.equal(normalizeCatalogCountryCode("gb"), "GB");
  });

  it('preserves the "XX" unknown sentinel', () => {
    assert.equal(normalizeCatalogCountryCode("XX"), "XX");
    assert.equal(normalizeCatalogCountryCode("xx"), "XX");
  });

  it('falls back to "XX" for unrecognised input rather than a fabricated code', () => {
    for (const junk of ["Freedonia", "DNK", "PRT", "", "   ", null, undefined]) {
      assert.equal(
        normalizeCatalogCountryCode(junk),
        "XX",
        `${JSON.stringify(junk)} must resolve to the XX sentinel`,
      );
    }
  });

  it("never returns the first two letters of an unrecognised name", () => {
    assert.notEqual(normalizeCatalogCountryCode("Freedonia"), "FR");
    assert.notEqual(normalizeCatalogCountryCode("Narnia"), "NA");
  });
});
