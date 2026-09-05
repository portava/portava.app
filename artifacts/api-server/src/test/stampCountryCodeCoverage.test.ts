/**
 * Stamp country-code coverage + the no-key-fork contract.
 *
 * THE PROBLEM
 * -----------
 * Three independent country-name → ISO maps live in this repo:
 *   lib/stamps/countryLookup.ts  ~120 countries + stamp aliases ("uk" → "GB")
 *   lib/countryCodes.ts          the full ISO-3166-1 list
 *   lib/tripBudgetIntel.ts       an inline map for budget intel
 *
 * `countryCodeFromName` reads the first. Anything only in the full list —
 * Senegal, for one — resolved to null and the caller fell back to "XX", which
 * `locationKey.canonicalLocationKeyFromStrings` bakes into
 * `canonical_location_key`. So a whole country's stamps sat under a fabricated
 * key that no later award could ever join.
 *
 * WHY THE FALLBACK IS SAFE — the two facts this file pins
 * ------------------------------------------------------
 *  1. NO DISAGREEMENT. Over every name the stamp table knows, the full ISO list
 *     either agrees exactly or says nothing. A disagreement would be a genuine
 *     key fork (A → B), so it fails here rather than in production.
 *  2. NO OVERRIDE. The stamp-local table is consulted FIRST, so every name that
 *     resolved before the fallback resolves to the same code after it. The only
 *     possible transition is XX → a real code — which
 *     lib/stamps/xxCatalogRepair.ts re-keys or merges idempotently, and which
 *     index.ts runs by default via startXXCatalogSweeper.
 *
 * Expectations are DERIVED (the local table is parsed from its own source, and
 * the fallback's expected answers come from `toCountryCode`), never hand-typed.
 *
 * Run: node --import tsx/esm --test src/test/stampCountryCodeCoverage.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { countryCodeFromName, countryNameFromCode, resolveCountry } from "../lib/stamps/countryLookup.js";
import { toCountryCode, countryName } from "../lib/countryCodes.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOOKUP_SRC = resolve(__dir, "../lib/stamps/countryLookup.ts");

/**
 * The stamp-local NAME_TO_CODE table, read out of its own source so the
 * expectations cannot drift from the data they are meant to pin.
 */
function localNameTable(): Array<[string, string]> {
  const src = readFileSync(LOOKUP_SRC, "utf8");
  const start = src.indexOf("const NAME_TO_CODE");
  const end = src.indexOf("};", start);
  assert.ok(start > -1 && end > start, "NAME_TO_CODE table not found in countryLookup.ts");
  return [...src.slice(start, end).matchAll(/"([^"]+)":\s*"([A-Z]{2})"/g)].map((m) => [m[1], m[2]] as [string, string]);
}

const LOCAL = localNameTable();

describe("the stamp country table and the full ISO list do not fork keys", () => {
  it("parsed a plausible local table (guard against a vacuous run)", () => {
    assert.ok(LOCAL.length > 100, `only ${LOCAL.length} local country names parsed — the parse broke`);
  });

  it("no name resolves to a DIFFERENT code in the two maps", () => {
    const disagreements = LOCAL
      .map(([name, code]) => ({ name, code, iso: toCountryCode(name) }))
      .filter((r) => r.iso !== null && r.iso !== r.code)
      .map((r) => `${r.name}: stamps=${r.code} iso=${r.iso}`);
    assert.deepEqual(
      disagreements, [],
      "a name resolves to two different ISO codes. canonical_location_key is " +
      "built from this code, so the disagreement forks the stamp catalog — " +
      "reconcile the tables before shipping:\n  " + disagreements.join("\n  "),
    );
  });

  it("every local entry still resolves to its own code (the fallback never overrides)", () => {
    const changed = LOCAL
      .filter(([name, code]) => countryCodeFromName(name) !== code)
      .map(([name, code]) => `${name}: table=${code} resolved=${countryCodeFromName(name)}`);
    assert.deepEqual(
      changed, [],
      "the ISO fallback overrode a stamp-local mapping — every existing catalog " +
      "key built from these names would fork:\n  " + changed.join("\n  "),
    );
  });

  it("stamp-specific aliases survive", () => {
    // "uk" is in the stamp table and NOT in the ISO name index; it must not be
    // lost to the fallback.
    assert.equal(countryCodeFromName("uk"), "GB");
    assert.equal(countryCodeFromName("UK"), "GB");
  });
});

describe("names only the full ISO list knows now resolve", () => {
  const ISO_SRC = resolve(__dir, "../lib/countryCodes.ts");

  /**
   * The gap set, DERIVED: every canonical ISO country name the stamp-local
   * table has no entry for. Hard-coding a list would go stale the moment the
   * local table grows — and four of a hand-picked seven were already in it.
   */
  const GAP_NAMES = (() => {
    const src = readFileSync(ISO_SRC, "utf8");
    const start = src.indexOf("const CODES");
    const end = src.indexOf("};", start);
    assert.ok(start > -1 && end > start, "CODES table not found in countryCodes.ts");
    const isoNames = [...src.slice(start, end).matchAll(/[A-Z]{2}:\s*"([^"]+)"/g)].map((m) => m[1]);
    const local = new Set(LOCAL.map(([n]) => n.toLowerCase()));
    return isoNames.filter((n) => !local.has(n.toLowerCase()));
  })();

  it("the derived gap set is real and non-trivial", () => {
    assert.ok(GAP_NAMES.length > 20,
      `only ${GAP_NAMES.length} ISO names missing from the stamp table — the derivation broke`);
    assert.ok(GAP_NAMES.some((n) => n.toLowerCase() === "senegal"),
      "Senegal — the case the follow-up named — is not in the derived gap set");
  });

  it("every gap name resolves to its real ISO code, not XX", () => {
    const unresolved = GAP_NAMES
      .map((name) => ({ name, expected: toCountryCode(name), got: countryCodeFromName(name) }))
      .filter((r) => r.got !== r.expected)
      .map((r) => `${r.name}: expected ${r.expected}, got ${r.got}`);
    assert.deepEqual(
      unresolved, [],
      `${unresolved.length} of ${GAP_NAMES.length} ISO countries still fall through to XX, ` +
      "so their catalog keys are fabricated:\n  " + unresolved.join("\n  "),
    );
  });

  it("the full resolution path stops handing the catalog an XX key for them", () => {
    const stillXx = GAP_NAMES.filter((name) => resolveCountry({ country: name }).countryCode === "XX");
    assert.deepEqual(stillXx, [], `resolveCountry still returns XX for: ${stillXx.join(", ")}`);
  });

  it("a code resolved through the fallback still gets a country name", () => {
    const code = toCountryCode("Senegal")!;
    assert.equal(countryNameFromCode(code), countryName(code));
    assert.ok(countryNameFromCode(code));
  });
});

describe("still never guesses", () => {
  it("an unknown country name resolves to null, and the catalog key to XX", () => {
    assert.equal(countryCodeFromName("Wakanda"), null);
    assert.equal(resolveCountry({ country: "Wakanda" }).countryCode, "XX");
  });

  it("a two-letter string that is not an ISO code resolves to null", () => {
    // The old `slice(0,2)` defect's shape: "Germany" must never become "GE",
    // and a bare non-code pair must never be accepted as one.
    assert.equal(countryCodeFromName("ZZ"), null);
    assert.equal(countryCodeFromName("Germany"), "DE");
    assert.equal(countryCodeFromName("Vietnam"), "VN");
    assert.equal(countryCodeFromName("Japan"), "JP");
    assert.equal(countryCodeFromName("United States"), "US");
  });
});
