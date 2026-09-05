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
const READERS: Record<
  string,
  {
    approved: Record<string, string>;
    /**
     * FALSE for a privacy-complete reader that is NOT a map-projection layer.
     * The caller allow-list applies to every entry; only the inverse check
     * ("the gateway still calls this") is skipped, because asserting that
     * routes/mapProjection.ts calls a trip-crew reader would be asserting a
     * bypass rather than forbidding one. Defaults to true, so a new layer that
     * forgets this field is held to the stricter rule.
     */
    gatewayLayer?: boolean;
  }
> = {
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
  getCrewMap: {
    // Not a §19 map layer: the crew map is its own trip-scoped endpoint, and
    // routes/mapProjection.ts must NOT call it.
    gatewayLayer: false,
    approved: {
      "services/tripCrew/TripCrewLocationService.ts": "defines it",
      "routes/tripCrewLocation.ts": "GET /api/trips/:tripId/crew/map — the crew map itself",
      "routes/mapJourney.ts":
        "§36 Phase-6 group decision, which projects the cards through toCrewAreas " +
        "(a type with no coordinate field) before they can reach a response",
      // NOTE ON WHAT THIS ONE PROTECTS. `getCrewMap` is the ONE reader that
      // applies ghost mode, per-member visibility, the bidirectional block
      // filter and the fail-closed "no blocks read ⇒ no members" rule to a
      // trip's crew — and its `CrewMemberCard`s MAY carry `exactCoords` when a
      // member has granted the viewer a live share. A second caller that read
      // it and serialized the cards would republish a live-share coordinate on
      // a surface the share was never granted for (§23). Phase 6 was the first
      // new caller in a long while and was NOT on this list, which is exactly
      // the gap this entry closes.
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
    let checked = 0;
    for (const [reader, spec] of Object.entries(READERS)) {
      if (spec.gatewayLayer === false) continue;
      checked += 1;
      assert.ok(
        new RegExp(`\\b${reader}\\s*\\(`).test(route),
        `${reader} is no longer called by the gateway — that layer has fallen back to the client`,
      );
    }
    // The opt-out above must stay an exception. If it ever swallowed the whole
    // list this test would pass by checking nothing.
    assert.ok(checked >= Object.keys(READERS).length - 1, "gatewayLayer:false is for exceptions");
  });
});
