/**
 * The seed path and the live path must produce the SAME place shape.
 *
 * WHY THIS TEST EXISTS. `routes/discovery.ts` and `scripts/seed-discovery-places.ts`
 * both turn an OSM element into a place, and they had drifted: the live path
 * read `addr:neighbourhood` and not `suburb`, the seeder read `suburb` and not
 * `addr:neighbourhood`. **The same real place therefore got a neighbourhood
 * from one path and none from the other.**
 *
 * That is worse than either behaviour on its own, because it corrupts the
 * comparison QA depends on: a genuine defect and a mere path difference become
 * indistinguishable, producing **false regressions** (a change looks broken
 * because the check compared across paths) and **false confidence** (a change
 * looks fine because the check happened to exercise the path it did not
 * affect).
 *
 * WHAT IS PINNED, and why it is pinned this way. The guard below asserts that
 * the SEEDER'S SOURCE calls the shared helper and does not carry its own key
 * chain. That is a structural assertion rather than a behavioural one, on
 * purpose: the seeder is a standalone script that talks to Supabase and
 * Overpass at import time, so calling its mapper in a unit test would mean
 * standing up both. **A test that cannot run is not a guard**, and the failure
 * being prevented here is textual drift — someone reintroducing a local chain —
 * which source inspection detects exactly.
 *
 * Run: node --import tsx/esm --test src/test/seedLivePlaceShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { osmNeighborhood } from "../lib/osmPlaceShape.js";
import { mapOsmElementToPlace } from "../routes/discovery.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_SCRIPT = join(HERE, "..", "..", "scripts", "seed-discovery-places.ts");
const DISCOVERY_ROUTE = join(HERE, "..", "routes", "discovery.ts");

const seedSource = readFileSync(SEED_SCRIPT, "utf8");
const routeSource = readFileSync(DISCOVERY_ROUTE, "utf8");

const ORIGIN = { lat: 48.8566, lng: 2.3522 };

function live(tags: Record<string, string>) {
  return mapOsmElementToPlace(
    { type: "node", id: 1, lat: ORIGIN.lat, lon: ORIGIN.lng, tags: { name: "X", ...tags } },
    "food",
    ORIGIN.lat,
    ORIGIN.lng,
  ).neighborhood;
}

describe("Both paths resolve neighbourhood through ONE shared definition", () => {
  it("the seeder calls the shared helper", () => {
    assert.ok(
      seedSource.includes("osmNeighborhood(tags)"),
      "seed-discovery-places.ts must call osmNeighborhood",
    );
  });

  it("the seeder's import of the shared helper actually resolves", () => {
    // `tsconfig.json` includes only `src`, so **scripts/ is not typechecked** —
    // `pnpm run typecheck` would stay green with a broken import here, and the
    // seeder only fails when someone runs it against a real database. This
    // check closes that gap cheaply: find the specifier, resolve it, require
    // the file to exist.
    const match = /from\s+"([^"]*osmPlaceShape[^"]*)"/.exec(seedSource);
    assert.ok(match, "seeder must import osmPlaceShape");

    const specifier = match![1]!.replace(/\.js$/, ".ts");
    const resolved = join(dirname(SEED_SCRIPT), specifier);
    assert.ok(existsSync(resolved), `seeder imports ${specifier}, which does not exist at ${resolved}`);
  });

  it("the live route calls the shared helper", () => {
    assert.ok(
      routeSource.includes("osmNeighborhood(tags)"),
      "discovery.ts must call osmNeighborhood",
    );
  });

  it("NEITHER path carries its own key chain any more", () => {
    // The exact shapes that had drifted. Their reappearance is the regression.
    for (const [label, source] of [["seeder", seedSource], ["live route", routeSource]] as const) {
      assert.ok(
        !/tags\.neighbourhood\s*\?\?/.test(source),
        `${label} reintroduced a local neighbourhood chain`,
      );
      assert.ok(
        !/tags\["addr:neighbourhood"\]\s*\?\?/.test(source),
        `${label} reintroduced a local addr:neighbourhood chain`,
      );
    }
  });
});

describe("The shared chain covers what BOTH paths used to cover", () => {
  // Neither old chain was a superset of the other, so the union is the only
  // answer that does not silently drop places one path used to handle.
  const cases: Array<[string, Record<string, string>, string | null]> = [
    ["addr:neighbourhood — live had it, the seeder did not", { "addr:neighbourhood": "Le Marais" }, "Le Marais"],
    ["neighbourhood — both had it",                          { neighbourhood: "Pigalle" },          "Pigalle"],
    ["addr:suburb — the seeder had it, live did not",         { "addr:suburb": "Passy" },            "Passy"],
    ["suburb — the seeder had it, live did not",              { suburb: "Kreuzberg" },               "Kreuzberg"],
    ["nothing tagged",                                        {},                                    null],
  ];

  for (const [label, tags, expected] of cases) {
    it(`${label} → ${expected ?? "null"}`, () => {
      assert.equal(osmNeighborhood(tags), expected);
      // And the live route agrees, because it is the same function.
      assert.equal(live(tags), expected);
    });
  }

  it("keeps the live route's existing precedence rather than a tidier one", () => {
    // Grouping the two addr:* keys first would arguably be more principled, but
    // it flips the answer for places carrying both — a change to what the feed
    // returns. The ruling asks for ONE shape, not a better one.
    assert.equal(osmNeighborhood({ neighbourhood: "Pigalle", "addr:suburb": "Passy" }), "Pigalle");
  });

  it("treats whitespace as absent rather than rendering a blank line", () => {
    assert.equal(osmNeighborhood({ "addr:neighbourhood": "   " }), null);
    assert.equal(live({ "addr:neighbourhood": "   " }), null);
  });
});

describe("The divergences that were found but NOT unified stay visible", () => {
  it("the seeder still derives name, blurb and rating its own way — filed, not fixed", () => {
    // Unifying these would change what the LIVE feed returns, which is a
    // product change rather than a consistency fix, so they are recorded in
    // docs/discovery/seed-live-place-shape-divergences.md for a ruling instead
    // of being changed quietly. This test fails if someone unifies them without
    // updating that record — the point being that the decision stays explicit.
    assert.ok(seedSource.includes('tags["name:en"]'), "seeder still prefers name:en");
    assert.ok(seedSource.includes("tags.inscription"), "seeder still falls back to inscription");
    assert.ok(seedSource.includes("tags.stars"), "seeder still derives rating from stars");
  });
});
