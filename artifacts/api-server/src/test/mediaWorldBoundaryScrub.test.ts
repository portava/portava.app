/**
 * mediaWorldBoundaryScrub — proves the Media v2 World-shell's SECOND defence
 * against precise-location leakage actually exists at runtime.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The certification lists two independent defences on §33 (no precise media
 * location leaves the World shell):
 *
 *   1. The projectors in lib/media/mediaProjection.ts whitelist their fields.
 *      mediaWorldProjection.test.ts proves that one is non-vacuous: feed a row
 *      that HAS location_lat/location_lng and the projection has none.
 *
 *   2. `routes/mediaWorld.ts::sendProjection` applies scrubPreciseLocation to
 *      the fully-assembled response of all seven endpoints, as a fail-closed
 *      boundary backstop.
 *
 * Defence 2 was NOT proven. The pure function scrubPreciseLocation had a unit
 * test; its WIRING did not. Replacing sendProjection's body with a bare
 * `res.json(payload)` — deleting the second defence outright — left every media
 * suite green, because defence 1 means no fixture can ever reach the boundary
 * carrying a coordinate. A backstop that no test can distinguish from its own
 * absence is not a backstop.
 *
 * This file closes that in the only two places the wiring can break:
 *
 *   A. sendProjection STOPS SCRUBBING (its body becomes a pass-through, or the
 *      scrub call is dropped). Driven directly with a payload that carries
 *      coordinates — exactly the regression case defence 2 is for.
 *   B. A ROUTE BYPASSES sendProjection (a handler calls res.json itself). A
 *      structural assertion over the router source: `res.json` appears in this
 *      router exactly once, inside sendProjection, and every endpoint's terminal
 *      send is a sendProjection call.
 *
 * Neither is vacuous: A goes red if the scrub is removed from sendProjection,
 * B goes red if any one of the seven endpoints starts answering on its own.
 *
 * Run: node --import tsx/esm --test src/test/mediaWorldBoundaryScrub.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sendProjection } from "../routes/mediaWorld.js";
import { findPreciseLocation } from "../lib/media/mediaLocationSafety.js";

// ── A minimal express-shaped response that captures what was sent ────────────

function captureRes(): { res: any; sent: () => unknown; calls: () => number } {
  let payload: unknown;
  let calls = 0;
  const res = {
    json(v: unknown) {
      payload = v;
      calls += 1;
      return res;
    },
  };
  return { res, sent: () => payload, calls: () => calls };
}

/**
 * A World-shell response shaped like the real thing, but with coordinates
 * smuggled in at four different depths — top level, inside an array element,
 * inside a nested object, and under a snake_case alias. This is the payload a
 * REGRESSED projector would hand the boundary.
 */
function leakyProjection() {
  return {
    city: "Da Nang",
    generatedAt: "2026-09-05T00:00:00.000Z",
    lat: 16.0544,
    lng: 108.2022,
    forYouNow: [
      {
        id: "post-1",
        placeId: "place-1",
        placeLabel: "An Thuong Bar",
        freshness: "fresh",
        location_lat: 16.0301,
        location_lng: 108.2503,
      },
    ],
    changingNow: {
      summary: "quieter than usual",
      anchor: { placeId: "place-2", geohash: "w6s0", coordinates: [1, 2] },
    },
  };
}

describe("A. sendProjection removes precise location from the assembled response", () => {
  it("strips every coordinate key at every depth", () => {
    const { res, sent } = captureRes();
    sendProjection(res, "world", leakyProjection());

    const leaks = findPreciseLocation(sent());
    assert.deepEqual(
      leaks.map((l) => l.path),
      [],
      `boundary scrub let precise location through: ${JSON.stringify(leaks)}`,
    );
  });

  it("the SAME payload is provably leaky before the boundary — the fixture is not a no-op", () => {
    // A positive control. If leakyProjection() ever stops carrying coordinates
    // (a fixture drifting into agreement with the bug), the assertion above
    // would pass for the wrong reason. This makes that impossible.
    const leaks = findPreciseLocation(leakyProjection());
    assert.ok(
      leaks.length >= 6,
      `the fixture must carry coordinates for the scrub to have anything to do; found ${leaks.length}`,
    );
  });

  it("keeps the coarse payload intact — the scrub removes keys, not content", () => {
    const { res, sent } = captureRes();
    sendProjection(res, "world", leakyProjection());
    const out = sent() as any;

    assert.equal(out.city, "Da Nang");
    assert.equal(out.generatedAt, "2026-09-05T00:00:00.000Z");
    assert.equal(out.forYouNow.length, 1);
    assert.equal(out.forYouNow[0].id, "post-1");
    assert.equal(out.forYouNow[0].placeId, "place-1");
    assert.equal(out.forYouNow[0].placeLabel, "An Thuong Bar");
    assert.equal(out.forYouNow[0].freshness, "fresh");
    assert.equal(out.changingNow.summary, "quieter than usual");
    assert.equal(out.changingNow.anchor.placeId, "place-2");
  });

  it("a healthy coarse projection passes through unchanged and is sent exactly once", () => {
    const clean = {
      city: "Da Nang",
      places: [{ placeId: "p1", placeLabel: "An Thuong Bar", neighborhood: "An Thuong" }],
      country: "VN",
    };
    const { res, sent, calls } = captureRes();
    sendProjection(res, "places", clean);
    assert.deepEqual(sent(), clean);
    assert.equal(calls(), 1);
  });
});

// ── B. Every endpoint in the router leaves through the boundary ──────────────

const ROUTER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "mediaWorld.ts"),
  "utf8",
);

/** Source with comments stripped, so prose about `res.json` is not counted. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("B. no mediaWorld endpoint answers without the boundary scrub", () => {
  const code = withoutComments(ROUTER_SRC);

  it("res.json appears exactly once in the router, and it is inside sendProjection", () => {
    const jsonSends = code.match(/\bres\s*\.\s*json\s*\(/g) ?? [];
    assert.equal(
      jsonSends.length,
      1,
      `every mediaWorld response must leave through sendProjection, which is the ` +
        `router's ONE res.json call; found ${jsonSends.length}. A handler that calls ` +
        `res.json itself skips scrubPreciseLocation entirely.`,
    );

    const fnStart = code.indexOf("export function sendProjection");
    assert.ok(fnStart >= 0, "sendProjection must still be a named function in this router");
    const sendIdx = code.search(/\bres\s*\.\s*json\s*\(/);
    assert.ok(
      sendIdx > fnStart,
      "the router's only res.json call must sit inside sendProjection",
    );
  });

  it("sendProjection actually calls the scrub", () => {
    const fnStart = code.indexOf("export function sendProjection");
    const body = code.slice(fnStart, code.indexOf("\n}", fnStart));
    assert.match(
      body,
      /scrubPreciseLocation\s*\(/,
      "sendProjection must apply scrubPreciseLocation — without it the boundary is a pass-through",
    );
  });

  it("every registered endpoint sends through sendProjection — checked per route, not in aggregate", () => {
    // §43 lists seven endpoints: world, places/:placeId, experiences/:id,
    // people, me, timeline, map. Counting sendProjection call sites in
    // aggregate is NOT enough: the experience route sends from two branches, so
    // a total of 7 survives one endpoint dropping the boundary. Split the file
    // at each router.get and require a send inside each segment.
    const segments = code.split(/router\s*\.\s*get\s*\(/).slice(1);
    assert.equal(segments.length, 7, `expected the seven §43 endpoints, found ${segments.length}`);

    const pathOf = (seg: string) => (seg.match(/"([^"]+)"/) ?? [, "?"])[1];
    const missing = segments.filter((s) => !/\bsendProjection\s*\(\s*res\s*,/.test(s)).map(pathOf);
    assert.deepEqual(
      missing,
      [],
      `these endpoints answer without the precise-location boundary scrub: ${missing.join(", ")}`,
    );
  });
});
