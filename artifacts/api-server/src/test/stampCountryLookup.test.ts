/**
 * Country lookup + canonical location key — real codes, never guessed.
 *
 * Guards the fix for XX-keyed catalog duplicates: canonical keys must use a
 * real ISO country code (from an explicit code, the country-name map, or the
 * well-known-city lookup) and must NEVER abbreviate a country's spelling.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countryCodeFromName,
  countryFromCity,
  resolveCountry,
} from "../lib/stamps/countryLookup.js";
import { canonicalLocationKey } from "../lib/stamps/locationKey.js";

test("countryCodeFromName resolves full names and aliases", () => {
  assert.equal(countryCodeFromName("United Kingdom"), "GB");
  assert.equal(countryCodeFromName("portugal"), "PT");
  assert.equal(countryCodeFromName("  USA  "), "US");
  assert.equal(countryCodeFromName("Viet Nam"), "VN");
  assert.equal(countryCodeFromName("gb"), "GB"); // already a code
});

test("countryCodeFromName never guesses from spelling", () => {
  assert.equal(countryCodeFromName("Atlantis"), null);
  assert.equal(countryCodeFromName("Untied Kingdm"), null); // typo → unknown, not "UN"
  assert.equal(countryCodeFromName(null), null);
});

test("countryFromCity resolves well-known cities (accent/case-insensitive)", () => {
  assert.deepEqual(countryFromCity("London"), { country: "United Kingdom", countryCode: "GB" });
  assert.deepEqual(countryFromCity("lisbon"), { country: "Portugal", countryCode: "PT" });
  assert.deepEqual(countryFromCity("SÃO PAULO"), { country: "Brazil", countryCode: "BR" });
  assert.equal(countryFromCity("Nowhereville"), null);
});

test("resolveCountry priority: explicit code > country name > city > XX", () => {
  assert.equal(resolveCountry({ countryCode: "jp", city: "London" }).countryCode, "JP");
  assert.equal(resolveCountry({ country: "France", city: "London" }).countryCode, "FR");
  assert.equal(resolveCountry({ city: "London" }).countryCode, "GB");
  assert.equal(resolveCountry({ city: "London" }).country, "United Kingdom");
  assert.equal(resolveCountry({ city: "Nowhereville" }).countryCode, "XX");
  // An unresolvable country name must not shadow a resolvable city
  assert.equal(resolveCountry({ country: "Untied Kingdm", city: "London" }).countryCode, "GB");
});

test("canonical keys use real codes derived from city when country is missing", () => {
  assert.equal(
    canonicalLocationKey({ stampType: "trip", city: "London" }),
    "trip:gb:london",
  );
  assert.equal(
    canonicalLocationKey({ stampType: "social", city: "Lisbon" }),
    "social:pt:lisbon",
  );
});

test("canonical keys stay stable once country is backfilled", () => {
  const before = canonicalLocationKey({ stampType: "trip", city: "London" });
  const after  = canonicalLocationKey({ stampType: "trip", city: "London", country: "United Kingdom" });
  assert.equal(before, after);
});

test("canonical keys never contain a code abbreviated from spelling", () => {
  // Unknown country name + unknown city → xx, NOT "at" from "Atlantis"
  assert.equal(
    canonicalLocationKey({ stampType: "city", country: "Atlantis", city: "Mysteryville" }),
    "city:xx:mysteryville",
  );
});

// The six launch cities' countries must resolve to their REAL ISO codes — the
// old PassportStampService slice(0,2) fabricated "VI"/"JA" for Vietnam/Japan,
// corrupting Da Nang and Tokyo stamp catalog keys + artwork (audit STAMP·H3).
test("countryCodeFromName resolves every launch-city country correctly", () => {
  assert.equal(countryCodeFromName("Vietnam"), "VN");      // Da Nang — was "VI"
  assert.equal(countryCodeFromName("Japan"), "JP");        // Tokyo   — was "JA"
  assert.equal(countryCodeFromName("Thailand"), "TH");     // Bangkok
  assert.equal(countryCodeFromName("Philippines"), "PH");  // Manila
  assert.equal(countryCodeFromName("United States"), "US");// Miami / Fort Lauderdale
  // And prove the old bug: slicing the name would have produced the wrong code.
  assert.notEqual("Vietnam".slice(0, 2).toUpperCase(), countryCodeFromName("Vietnam"));
  assert.notEqual("Japan".slice(0, 2).toUpperCase(), countryCodeFromName("Japan"));
});
