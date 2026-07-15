/**
 * canonicalLocations.test — pure-function tests for the universal location
 * service matching core. Verifies that provider variants of the same
 * real-world location ("Cebu" vs "Cebu City" vs a Nominatim row) resolve to
 * the same canonical row, and that different places never collide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLocationName,
  kindClass,
  providerKeyOf,
  matchCanonical,
  haversineKm,
  type CanonicalRow,
  type PlaceInput,
} from "../lib/canonicalLocations";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<CanonicalRow>): CanonicalRow {
  return {
    id: overrides.id ?? "row-1",
    kind: "city",
    name: "Cebu City",
    normalized_name: "cebu",
    display_name: "Cebu City, Philippines",
    city: "Cebu City",
    region: "Central Visayas",
    country: "Philippines",
    country_code: "PH",
    postal_code: null,
    lat: 10.316,
    lng: 123.891,
    provider_ids: {},
    aliases: [],
    ...overrides,
  };
}

function makePlace(overrides: Partial<PlaceInput>): PlaceInput {
  return {
    id: "manual-test",
    type: "city",
    name: "Cebu",
    ...overrides,
  };
}

// ── normalizeLocationName ─────────────────────────────────────────────────────

test("normalize: Cebu variants collapse to 'cebu'", () => {
  assert.equal(normalizeLocationName("Cebu"), "cebu");
  assert.equal(normalizeLocationName("Cebu City"), "cebu");
  assert.equal(normalizeLocationName("  cebú  "), "cebu");
  assert.equal(normalizeLocationName("City of Cebu"), "cebu");
  assert.equal(normalizeLocationName("CEBU CITY"), "cebu");
});

test("normalize: strips diacritics and punctuation", () => {
  assert.equal(normalizeLocationName("Medellín"), "medellin");
  assert.equal(normalizeLocationName("São Paulo"), "sao paulo");
  assert.equal(normalizeLocationName("Ho-Chi-Minh City"), "ho chi minh");
});

test("normalize: generic prefixes/suffixes removed but never emptied", () => {
  assert.equal(normalizeLocationName("City of Manila"), "manila");
  assert.equal(normalizeLocationName("Quezon City"), "quezon");
  assert.equal(normalizeLocationName("Metro Manila"), "metro manila"); // prefix 'metro' kept
  assert.equal(normalizeLocationName("City"), "city"); // never strip to empty
});

// ── kindClass / providerKeyOf ─────────────────────────────────────────────────

test("kindClass buckets", () => {
  assert.equal(kindClass("country"), "admin");
  assert.equal(kindClass("region"), "admin");
  assert.equal(kindClass("city"), "city");
  assert.equal(kindClass("town"), "city");
  assert.equal(kindClass("neighborhood"), "city");
  assert.equal(kindClass("landmark"), "venue");
  assert.equal(kindClass("airport"), "venue");
  assert.equal(kindClass("place"), "venue");
});

test("providerKeyOf parses known providers only", () => {
  assert.deepEqual(providerKeyOf("nominatim-12345"), { provider: "nominatim", providerId: "12345" });
  assert.deepEqual(providerKeyOf("foursquare-4bf58dd8"), { provider: "foursquare", providerId: "4bf58dd8" });
  assert.equal(providerKeyOf("manual-cebu"), null);
  assert.equal(providerKeyOf("gps-1"), null);
  assert.equal(providerKeyOf("reverse-10.3-123.9"), null);
});

// ── matchCanonical ────────────────────────────────────────────────────────────

test("match: 'Cebu' and 'Cebu City' variants hit the same canonical row", () => {
  const row = makeRow({ id: "cebu-row" });

  // GPS-style: name only + coords near the city
  const gpsVariant = makePlace({ id: "reverse-10.30-123.90", name: "Cebu", lat: 10.3, lng: 123.9, countryCode: "PH" });
  assert.equal(matchCanonical([row], gpsVariant)?.id, "cebu-row");

  // Nominatim-style: full name, different provider id, coords ~20 km away
  const nomVariant = makePlace({
    id: "nominatim-99999", name: "Cebu City", country: "Philippines", countryCode: "PH",
    lat: 10.45, lng: 123.95,
  });
  assert.equal(matchCanonical([row], nomVariant)?.id, "cebu-row");

  // Manual free-text, no coords, no country
  const manualVariant = makePlace({ id: "manual-cebu-city", name: "cebu city" });
  assert.equal(matchCanonical([row], manualVariant)?.id, "cebu-row");
});

test("match: alias hit works when normalized names differ", () => {
  const row = makeRow({ id: "cebu-row", normalized_name: "cebu", aliases: ["sugbo"] });
  const aliasVariant = makePlace({ id: "manual-sugbo", name: "Sugbo" });
  assert.equal(matchCanonical([row], aliasVariant)?.id, "cebu-row");
});

test("match: provider id short-circuits even if name differs", () => {
  const row = makeRow({ id: "cebu-row", provider_ids: { nominatim: "777" } });
  const renamed = makePlace({ id: "nominatim-777", name: "Sugbo Metropolis", type: "city" });
  assert.equal(matchCanonical([row], renamed)?.id, "cebu-row");
});

test("match: two same-named cities far apart never collide", () => {
  // Springfield IL vs a query near Springfield MA (~1900 km apart)
  const springfieldIL = makeRow({
    id: "springfield-il", name: "Springfield", normalized_name: "springfield",
    country: "USA", country_code: "US", lat: 39.78, lng: -89.65,
  });
  const nearMA = makePlace({
    id: "reverse-42.10-72.59", name: "Springfield", countryCode: "US", lat: 42.1, lng: -72.59,
  });
  assert.equal(matchCanonical([springfieldIL], nearMA), null);
});

test("match: country mismatch disqualifies", () => {
  const parisFR = makeRow({
    id: "paris-fr", name: "Paris", normalized_name: "paris",
    country: "France", country_code: "FR", lat: 48.85, lng: 2.35,
  });
  const parisTX = makePlace({ id: "manual-paris", name: "Paris", countryCode: "US" });
  assert.equal(matchCanonical([parisFR], parisTX), null);
});

test("match: country-name fallback works when codes missing", () => {
  const row = makeRow({ id: "cebu-row", country_code: null, country: "Philippines" });
  const same = makePlace({ id: "manual-cebu", name: "Cebu", country: "philippines" });
  assert.equal(matchCanonical([row], same)?.id, "cebu-row");
  const other = makePlace({ id: "manual-cebu2", name: "Cebu", country: "Indonesia" });
  assert.equal(matchCanonical([row], other), null);
});

test("match: kind classes never cross-match", () => {
  // A hotel named "Cebu" must not merge with the city
  const cityRow = makeRow({ id: "cebu-city-row" });
  const hotel = makePlace({ id: "foursquare-abc", name: "Cebu", type: "place", lat: 10.316, lng: 123.891 });
  assert.equal(matchCanonical([cityRow], hotel), null);

  // Mexico City (city) vs Mexico (country) — same normalized name, different class
  const mexicoCountry = makeRow({
    id: "mexico-country", kind: "country", name: "Mexico", normalized_name: "mexico",
    country: "Mexico", country_code: "MX", lat: 23.6, lng: -102.5,
  });
  const mexicoCity = makePlace({ id: "manual-mexico-city", name: "Mexico City", countryCode: "MX", lat: 19.43, lng: -99.13 });
  assert.equal(matchCanonical([mexicoCountry], mexicoCity), null);
});

test("match: venue proximity is tight (1.5 km)", () => {
  const venueRow = makeRow({
    id: "venue-row", kind: "landmark", name: "Magellan's Cross", normalized_name: "magellan s cross",
    lat: 10.2935, lng: 123.9021,
  });
  const near = makePlace({ id: "foursquare-x", name: "Magellan's Cross", type: "landmark", lat: 10.2941, lng: 123.9029, countryCode: "PH" });
  assert.equal(matchCanonical([venueRow], near)?.id, "venue-row");

  const far = makePlace({ id: "foursquare-y", name: "Magellan's Cross", type: "landmark", lat: 10.34, lng: 123.95, countryCode: "PH" });
  assert.equal(matchCanonical([venueRow], far), null);
});

test("match: missing coordinates fall back to name+country", () => {
  const row = makeRow({ id: "cebu-row", lat: null, lng: null });
  const withCoords = makePlace({ id: "nominatim-5", name: "Cebu City", countryCode: "PH", lat: 10.3, lng: 123.9 });
  assert.equal(matchCanonical([row], withCoords)?.id, "cebu-row");
});

test("haversine sanity", () => {
  const d = haversineKm(10.316, 123.891, 14.599, 120.984); // Cebu -> Manila
  assert.ok(d > 550 && d < 600, `expected ~570 km, got ${d}`);
});
