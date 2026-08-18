/**
 * nominatimName.test.ts
 *
 * ## The defect
 *
 * searchNominatim sends `Accept-Language: en` and Nominatim honours it:
 * display_name, the address.* components and namedetails["name:en"] all come
 * back localised. namedetails.name does NOT — it is the raw local-script name.
 *
 * normalizeNominatim read namedetails.name FIRST. So a user in an English UI
 * searching for Bangkok was offered "กรุงเทพมหานคร" as the row label, on the
 * one query path that worked at all. The request asked for a language and the
 * code then preferred the single field that ignores it.
 *
 * ## What is pinned here
 *
 * The ORDER, not just the outcome. A test that only asserted `name === "Bangkok"`
 * would pass against a helper that read display_name first and namedetails
 * never — a different function that happens to agree on the common case. Each
 * test below removes the higher-priority fields so exactly one candidate is
 * reachable, which is what makes the ranking itself observable.
 *
 * Run:
 *   node --import tsx/esm --test src/lib/places/nominatimName.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickLocalisedName } from "./nominatimName.js";

/** The real shape Nominatim returns for Bangkok with Accept-Language: en. */
const BANGKOK = {
  namedetails: { name: "กรุงเทพมหานคร", "name:en": "Bangkok" },
  display_name: "Bangkok, Thailand",
  address: { city: "Bangkok", country: "Thailand" },
};

describe("pickLocalisedName — the localised name wins", () => {
  it("prefers name:<lang> over the local-script namedetails.name", () => {
    // The regression itself: namedetails.name is present and non-empty, and
    // must NOT be chosen while a localisation exists.
    const { name } = pickLocalisedName(BANGKOK, "en");
    assert.equal(name, "Bangkok");
    assert.notEqual(name, "กรุงเทพมหานคร");
  });

  it("returns the local-script name alongside, not instead", () => {
    // The local name is data a surface may want ("Bangkok (กรุงเทพมหานคร)"),
    // so the fix must not simply discard it.
    const { localName } = pickLocalisedName(BANGKOK, "en");
    assert.equal(localName, "กรุงเทพมหานคร");
  });

  it("honours the language it is asked for, not a hardcoded 'en'", () => {
    // Pins that `lang` is actually threaded into the key. A helper that
    // hardcoded name:en would return "Bangkok" here and pass a weaker test.
    const raw = {
      namedetails: { name: "กรุงเทพมหานคร", "name:en": "Bangkok", "name:fr": "Bangkok-ville" },
      display_name: "Bangkok, Thailand",
      address: { city: "Bangkok" },
    };
    assert.equal(pickLocalisedName(raw, "fr").name, "Bangkok-ville");
  });
});

describe("pickLocalisedName — fallback order below the exact localisation", () => {
  it("falls back to the display_name head when name:<lang> is absent", () => {
    // display_name IS localised by the Accept-Language header, so it outranks
    // the local-script name. Only namedetails.name remains as a competitor.
    const raw = {
      namedetails: { name: "กรุงเทพมหานคร" },
      display_name: "Bangkok, Thailand",
      address: {},
    };
    assert.equal(pickLocalisedName(raw, "en").name, "Bangkok");
  });

  it("falls back to localised address components when display_name is absent", () => {
    const raw = { namedetails: { name: "กรุงเทพมหานคร" }, address: { city: "Bangkok" } };
    assert.equal(pickLocalisedName(raw, "en").name, "Bangkok");
  });

  it("walks town → village → municipality when city is absent", () => {
    // Each rung asserted separately: a helper reading only `city` would pass a
    // single combined case that happened to supply one.
    assert.equal(
      pickLocalisedName({ address: { town: "Pai" } }, "en").name,
      "Pai",
    );
    assert.equal(
      pickLocalisedName({ address: { village: "Mae Kampong" } }, "en").name,
      "Mae Kampong",
    );
    assert.equal(
      pickLocalisedName({ address: { municipality: "Hua Hin" } }, "en").name,
      "Hua Hin",
    );
  });

  it("uses the local-script name when NO localisation exists at all", () => {
    // The one case the Accept-Language header cannot help with — a local name
    // is strictly better than "Unknown", so it must still be reachable.
    const raw = { namedetails: { name: "กรุงเทพมหานคร" }, address: {} };
    const { name, localName } = pickLocalisedName(raw, "en");
    assert.equal(name, "กรุงเทพมหานคร");
    // Not duplicated into localName — it is already what is shown.
    assert.equal(localName, null);
  });

  it("returns 'Unknown' rather than throwing on an empty response", () => {
    assert.equal(pickLocalisedName({}, "en").name, "Unknown");
    assert.equal(pickLocalisedName({}, "en").localName, null);
  });
});

describe("pickLocalisedName — localName never duplicates name", () => {
  it("is null when the local name equals the shown name", () => {
    // "Paris (Paris)" is the render this prevents. A caller is promised it can
    // show localName unconditionally.
    const raw = {
      namedetails: { name: "Paris", "name:en": "Paris" },
      display_name: "Paris, France",
      address: { city: "Paris" },
    };
    assert.equal(pickLocalisedName(raw, "en").localName, null);
  });
});

describe("pickLocalisedName — blank and malformed fields", () => {
  it("treats whitespace-only fields as absent, not as a valid name", () => {
    // `??` only rejects null/undefined, so a "" or "   " from Nominatim would
    // have been accepted as the name by a nullish-coalescing chain.
    const raw = {
      namedetails: { name: "กรุงเทพมหานคร", "name:en": "   " },
      display_name: "Bangkok, Thailand",
      address: {},
    };
    assert.equal(pickLocalisedName(raw, "en").name, "Bangkok");
  });

  it("trims surrounding whitespace from the chosen name", () => {
    const raw = { namedetails: { "name:en": "  Bangkok  " }, address: {} };
    assert.equal(pickLocalisedName(raw, "en").name, "Bangkok");
  });

  it("tolerates null namedetails/address without throwing", () => {
    // Nominatim omits namedetails entirely unless namedetails=1 is requested.
    const raw = { namedetails: null, address: null, display_name: "Bangkok, Thailand" };
    assert.equal(pickLocalisedName(raw, "en").name, "Bangkok");
  });

  it("defaults to 'en' when no language is passed", () => {
    // The default must match the Accept-Language searchNominatim actually sends.
    assert.equal(pickLocalisedName(BANGKOK).name, "Bangkok");
  });
});
