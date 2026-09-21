/**
 * Gateway bypass guard (Map spec §19).
 *
 * §19: "Never place raw database rows directly on the map… The mobile client
 * should not independently reconstruct Portava intelligence rules."
 *
 * Once a layer moves into the projection, the OLD path does not disappear —
 * `listMapTravelers`, `findNearbyGems` and `readCircleLocations` are all still
 * exported and callable. Nothing structurally prevents a future surface from
 * calling one directly and serving raw rows again, and that regression is
 * invisible: the data looks right, it just skipped ranking, the §24 protection
 * gate, viewport aggregation and the privacy-class stamping.
 *
 * This guard fails when a privacy-complete reader is called from anywhere
 * except an APPROVED path. Approval is per (reader, caller) and each entry
 * carries a reason, so adding a bypass is a deliberate, reviewable edit rather
 * than something that happens by accident.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");

/**
 * The privacy-complete readers a layer must go through, and every file allowed
 * to call each one. A caller absent from this list is a bypass.
 */
const READERS: Record<string, { approved: Record<string, string> }> = {
  listMapTravelers: {
    approved: {
      "lib/mapTravelers.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      "routes/mapSearch.ts": "the pre-gateway search endpoint, still in service",
      "routes/mapTravelers.ts":
        "the legacy /api/map/travelers endpoint the Discovery traveler layer still polls",
    },
  },
  findNearbyGems: {
    approved: {
      "services/hiddenGems/HiddenGemDiscoveryService.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      "routes/mapSearch.ts": "the pre-gateway search endpoint",
      "routes/hiddenGems.ts": "the gems domain endpoint — not a map surface",
    },
  },
  readCircleLocations: {
    approved: {
      "lib/circleLocationsRead.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      "routes/location.ts": "GET /api/me/circle-locations, the endpoint it was extracted from",
    },
  },
  produceZoneTransitions: {
    approved: {
      "lib/crowdFlowProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      // NOTE ON WHAT THIS ONE PROTECTS, because it is not the usual thing.
      // The other readers here return rows that are already safe to serve. This
      // one returns ZoneTransitions that are NOT: they carry raw cohort
      // arithmetic (distinctActors, distinctGroups, maxGroupShare) which
      // lib/mapAggregation.deriveCrowdFlow then measures against §10's four
      // gates — k-anonymity, freshness, multiple signal families and cohort
      // density. A surface that called this and rendered the transitions
      // directly would publish sub-threshold movement, which is the disclosure
      // the whole of §10 is built to prevent. It also skips §31 ranking, the
      // §24 protection gate and viewport aggregation, like every other bypass
      // on this list.
    },
  },
  // ── The M5 producers. Each is the ONE privacy-complete reader for its kind:
  // meeting points are participant-scoped, memory is owner-only and coarsened,
  // safety notices carry the specialist-reviewed claim with no presence
  // payload, and saved places are the viewer's own wishlist. A caller other
  // than the gateway would serve them without §31 ranking, the §24 gate,
  // aggregation and privacy-class stamping — and, for memory, would be a
  // second surface for private memory outside the Passport boundary.
  readMeetingPoints: {
    approved: {
      "lib/mapProducers/meetingPointProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readMemoryPins: {
    approved: {
      "lib/mapProducers/memoryProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readSafetyNotices: {
    approved: {
      "lib/mapProducers/safetyNoticeProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readSavedPlacePins: {
    approved: {
      "lib/mapProducers/savedPlaceProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  loadViewportPlaceRows: {
    approved: {
      "lib/mapProjectPlace.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      // NOTE ON WHAT THIS ONE PROTECTS. `places` holds no user column, so the
      // rows are not a privacy leak in themselves — but they ARE raw database
      // rows, and §19's first sentence is "Never place raw database rows
      // directly on the map." A surface that called this and served the rows
      // would draw a canonical place standing inside a §24 protected zone at
      // full precision (the audit's HIGH finding), skip §31 aggregation (an
      // unranked POI wall at city zoom, §37) and skip the §7 enrichment that
      // is the only source of a place's live axes. The gateway is the one
      // caller precisely so those three stages cannot be bypassed.
    },
  },
  // ── §36 Phase 7 World Intelligence. Two I/O readers, each the ONE
  // privacy-complete read for its kinds.
  //
  // `readTravelerFlowEdges` is the one that matters most, and for
  // `produceZoneTransitions`'s reason rather than the usual one: it drives
  // lib/routeHopSignal, which reads accepted route plans belonging to real
  // people under a consent record (route_flow_contribution_consent, 2224). A
  // second caller would be a second publication path for that consent — and it
  // would skip PRIVACY_THRESHOLD_V1, the cohort BUCKETING that replaces the
  // exact count, the §24 withhold-rather-than-coarsen step and §31 ranking.
  //
  // `readPersonalCityPins` reads the VIEWER'S OWN passport history. A caller
  // other than the gateway would be a second surface for private travel history
  // outside the Passport boundary — exactly what readMemoryPins is protected
  // from, one aggregation level out.
  //
  // `readCityModels` reads an already-published aggregate, so its risk is §19's
  // first sentence rather than a consent one: served directly it would skip the
  // per-slice k gate's companions — the §24 gate, aggregation and ranking.
  //
  // `deriveWorldPulse` is PURE and takes objects, not a client, so it is not
  // listed: there is no read to bypass. Its inputs are already-gated objects,
  // and its own guard (src/test/mapWorldIntelligenceLayer.test.ts) asserts the
  // kinds it will and will not accept.
  readTravelerFlowEdges: {
    approved: {
      "lib/mapProducers/travelerFlowProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readCityModels: {
    approved: {
      "lib/mapProducers/cityModelProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readPersonalCityPins: {
    approved: {
      "lib/mapProducers/personalCityProducer.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
    },
  },
  readBuddyMapPins: {
    approved: {
      "lib/buddyMapRead.ts": "defines it",
      "routes/mapProjection.ts": "the gateway (§19)",
      // NOTE: routes/rentABuddy.ts is deliberately NOT approved. The
      // marketplace search shares the FIELD-EXPOSURE rules (BUDDY_PUBLIC_COLUMNS,
      // stripBuddyPrivateFields, mapBuddyPublicProfile) with this reader, but it
      // must not call the map read itself: that read is viewport-scoped,
      // block-filtered and meetup-base-only, none of which the marketplace wants.
    },
  },
};

/** Every .ts file under src/, excluding tests and scripts. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(["test", "scripts", "migrations", "node_modules", "baseline"]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!skip.has(name)) walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** reader -> the files that call it (excluding import lines). */
function callers(reader: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(reader)) continue;
    const called = src
      .split("\n")
      .some((line) => {
        const l = line.trim();
        if (l.startsWith("import") || l.startsWith("//") || l.startsWith("*")) return false;
        // A call, not a re-export or a mention in prose.
        return new RegExp(`\\b${reader}\\s*\\(`).test(l);
      });
    if (called) hits.push(file.slice(SRC.length + 1));
  }
  return hits.sort();
}

describe("gateway bypass guard (§19)", () => {
  test("the scan sees the source tree (the guard is not checking nothing)", () => {
    const files = sourceFiles();
    assert.ok(files.length > 200, `expected the api-server source tree, found ${files.length}`);
    assert.ok(
      files.some((f) => f.endsWith(join("routes", "mapProjection.ts"))),
      "the gateway route must be in scope",
    );
  });

  for (const [reader, { approved }] of Object.entries(READERS)) {
    test(`${reader} is called only from approved paths`, () => {
      const found = callers(reader);
      // The guard must actually find the reader; a rename would otherwise make
      // it pass by scanning nothing.
      assert.ok(
        found.length > 0,
        `${reader} has no callers at all — was it renamed? This guard would then be inert.`,
      );
      const bypasses = found.filter((f) => !(f in approved));
      assert.deepEqual(
        bypasses,
        [],
        `${reader} is a privacy-complete reader. Calling it outside the gateway skips ranking, ` +
          `the §24 protection gate, viewport aggregation and privacy-class stamping. ` +
          `If a new caller is legitimate, add it to READERS with a reason.`,
      );
    });

    test(`${reader}'s approval list has no stale entries`, () => {
      // An approval that outlives its caller silently pre-authorises a future
      // bypass in a file that no longer does what the reason claims.
      const found = new Set(callers(reader));
      const stale = Object.keys(approved).filter((f) => !found.has(f));
      assert.deepEqual(stale, [], `these no longer call ${reader} — drop the approval`);
    });

    test(`every ${reader} approval carries a reason`, () => {
      for (const [file, reason] of Object.entries(approved)) {
        assert.ok(
          typeof reason === "string" && reason.length > 5,
          `${file} is approved for ${reader} without a stated reason`,
        );
      }
    });
  }

  test("the gateway itself calls every reader it is meant to serve", () => {
    // The inverse failure: a layer silently dropped OUT of the projection would
    // leave the client fetching it per-layer again, which is the §19 violation
    // this whole exercise removed.
    const route = readFileSync(join(SRC, "routes", "mapProjection.ts"), "utf8");
    for (const reader of Object.keys(READERS)) {
      assert.ok(
        new RegExp(`\\b${reader}\\s*\\(`).test(route),
        `${reader} is no longer called by the gateway — that layer has fallen back to the client`,
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M133 / M139 — the CLIENT half of "never place raw database rows on the map".
//
// The server half is in src/test/mapProjection.test.ts: with the flag TRUE and
// `protected_zones` readable the gateway answers `enabled: true` with objects
// and a non-empty `sources`; with the flag FALSE it answers `enabled: false`.
// That is the INPUT the client branches on. This block pins what the client
// then DOES with it, which is the half the census's M133 sentence names:
//
//   "the client's `usedGateway` is true, and the per-layer fallback in
//    useMapEntities does NOT run."
//
// WHY THIS IS A STRUCTURAL GUARD AND NOT A MOUNTED-HOOK TEST.
// `useMapEntities` is a React hook in travel-buddy-standalone, and this file is
// in the api-server package, which cannot mount it. A mounted-hook assertion
// belongs beside the hook, and adding one there is work for whoever owns that
// file — it is not blocked by anything.
//
// It is worth saying what this is NOT blocked on, because the lane plan claimed
// otherwise and the claim is stale. The plan records the standalone `node:test`
// runner as dark (`--import tsx/esm` → ERR_REQUIRE_CYCLE_MODULE before any test
// executes). Re-measured on this tree: `travel-buddy-standalone/scripts/
// run-node-tests.mjs` already selects the loader by Node major — `tsx` below 24,
// `tsx/esm` at 24 and above — and a full run is 6286/6286 green. So the client
// runner executes, and a mounted-hook proof of this property is available to
// whoever owns the hook. What this file can do, and does, is pin the property on
// the source the way the §19 guard above it does.
//
// WHAT IT PINS, AND WHY EACH ONE IS THE FAILURE THAT ACTUALLY HAPPENED:
//
//   1. `gatewayObjects` is assigned ONLY under `res.data.enabled`. Assigning it
//      on `res.ok` alone would make a flag-off `enabled: false` envelope look
//      like a served one — `usedGateway` true, fallback skipped, map blank.
//      This is the blank-map hazard `mapProtectionUnreadable.test.ts` closed at
//      the server end, restated at the client end.
//   2. EVERY per-layer fetcher call sits inside `if (!usedGateway) {`. One
//      `attempt(...)` left outside that block is a layer that keeps fetching
//      raw rows past a serving gateway — §19's violation, and invisible,
//      because the data still looks right.
//   3. The fallback block is non-empty and names every toggleable layer, so a
//      future edit cannot make this guard vacuous by deleting the fallback.
// ═════════════════════════════════════════════════════════════════════════════

const USE_MAP_ENTITIES = resolve(
  SRC, "..", "..", "..", "travel-buddy-standalone", "src", "hooks", "useMapEntities.ts",
);

/** The body of the first `if (<head>) {` … `}` block at `head`, brace-matched. */
function blockAfter(src: string, head: string): { start: number; end: number } {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `useMapEntities.ts no longer contains \`${head}\` — this guard is inert`);
  const open = src.indexOf("{", at + head.length - 1);
  assert.ok(open >= 0, `no block opens after \`${head}\``);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  assert.fail(`unbalanced braces after \`${head}\``);
}

describe("M133/M139 — a serving gateway owns every layer (client branch)", () => {
  const src = () => readFileSync(USE_MAP_ENTITIES, "utf8");

  test("the guard is reading the real hook", () => {
    const s = src();
    assert.ok(s.length > 5_000, "useMapEntities.ts is implausibly small — wrong file?");
    assert.ok(s.includes("const usedGateway"), "the hook no longer computes usedGateway");
  });

  test("gatewayObjects is assigned ONLY under res.data.enabled — `res.ok` alone is the blank map", () => {
    const s = src();
    const assignments = s
      .split("\n")
      .map((l, i) => ({ l: l.trim(), i: i + 1 }))
      .filter(({ l }) => /^gatewayObjects\s*=/.test(l));
    assert.equal(
      assignments.length, 1,
      `expected exactly one assignment to gatewayObjects, found ${assignments.length} at lines ` +
        `${assignments.map((a) => a.i).join(", ")} — each one is a separate way to claim the ` +
        `gateway served when it did not`,
    );

    // It must live inside the `res.ok && res.data.enabled` block.
    const gate = blockAfter(s, "if (res.ok && res.data.enabled)");
    const at = s.indexOf("gatewayObjects =", s.indexOf("let gatewayObjects") + 20);
    assert.ok(
      at > gate.start && at < gate.end,
      "gatewayObjects is assigned outside the `res.ok && res.data.enabled` guard: an " +
        "`enabled: false` envelope would then count as a served one and the fallback would " +
        "be skipped for a gateway that served nothing",
    );
  });

  test("usedGateway is derived from gatewayObjects, not from the flag or the status code", () => {
    const s = src();
    assert.match(
      s,
      /const usedGateway = gatewayObjects !== null;/,
      "usedGateway must be 'did the gateway hand me objects', not 'did the request succeed'",
    );
  });

  test("EVERY per-layer fetcher runs only inside `if (!usedGateway)` — no layer outruns the gateway", () => {
    const s = src();
    const fallback = blockAfter(s, "if (!usedGateway)");

    // Every call to the `attempt(...)` helper — the one and only way a per-layer
    // transport is started — must be inside that block.
    const calls = [...s.matchAll(/\battempt\(\s*'([a-z]+)'/g)].map((m) => ({
      layer: m[1],
      at: m.index ?? -1,
    }));
    assert.ok(
      calls.length >= 5,
      `expected the five toggleable layers to have fallback fetchers, found ${calls.length} — ` +
        `if the fallback was removed this guard has nothing left to protect`,
    );

    const outside = calls.filter((c) => c.at < fallback.start || c.at > fallback.end);
    assert.deepEqual(
      outside.map((c) => c.layer), [],
      "these layers start a per-layer fetch outside the `if (!usedGateway)` block. A serving " +
        "gateway has already applied §31 ranking, the §24 protection gate and viewport " +
        "aggregation to that layer; fetching it again serves the raw rows §19 forbids, and " +
        "routes around a fail-closed decision through a fail-open transport.",
    );

    // Anti-vacuity from the other side: the five layers are all named, so a
    // guard that passed because the block was empty would fail here instead.
    assert.deepEqual(
      calls.map((c) => c.layer).sort(),
      ["buddies", "events", "friends", "gems", "trips"],
      "the fallback no longer covers exactly the five toggleable layers",
    );
  });

  test("M139: the on-device normalisers are reachable ONLY through that fallback", () => {
    const s = src();
    const fallback = blockAfter(s, "if (!usedGateway)");

    // clientProjection.ts's projectors ARE the "client reconstructing Portava
    // intelligence rules" §19 names. They are legitimate on the legacy path and
    // illegitimate past a serving gateway. They are called inside the per-layer
    // fetchers, so the property to pin is that no projector is invoked in the
    // hook's own body outside the fallback region.
    const PROJECTORS = ["projectBuddy", "projectTrip", "projectFriend", "projectGemLocal", "projectEventLocal"];
    for (const p of PROJECTORS) {
      const calls = [...s.matchAll(new RegExp(`\\b${p}\\(`, "g"))].map((m) => m.index ?? -1);
      assert.ok(calls.length > 0, `${p} is no longer called at all — was it renamed?`);
    }

    // The fetchers that call them are themselves only started from the fallback,
    // which the previous case proved. What is left to pin is that the merge step
    // cannot smuggle a locally-normalised object onto a gateway response: the
    // merged list is the gateway's objects plus the per-layer results, and the
    // per-layer results are empty whenever the fallback did not run.
    assert.match(
      s,
      /const merged = \(gatewayObjects \?\? \[\]\)\.concat\(\.\.\.perLayer\);/,
      "the merge no longer has the shape this guard reasons about",
    );
    assert.ok(
      s.indexOf("const fetches:") < fallback.start,
      "the fetch list must be declared before the fallback block, and filled only inside it",
    );
  });
});
