/**
 * mapProjection — the Map Intelligence Gateway's shaping layer.
 *
 * These tests exist mainly to hold three invariants that a projection layer is
 * uniquely positioned to break, and which no downstream test would catch:
 *
 *   1. It never SHARPENS a coordinate or a privacy rung (spec §19, §23).
 *   2. It never INVENTS freshness or confidence (spec §37).
 *   3. It never SILENTLY truncates (a capped live enrichment must be reported,
 *      or "we only looked at 25 of them" reads as "there is nothing here").
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyLiveClaims,
  bboxToCenterRadius,
  crowdValueToActivity,
  decodeCursor,
  enrichWithLiveClaims,
  filterKinds,
  gemPrivacyClass,
  liveSubjectIdFor,
  paginate,
  parseBbox,
  parseKinds,
  projectEvent,
  projectGem,
  projectTraveler,
  rankObjects,
  servableOnly,
  travelerPrivacyClass,
  type LiveClaimLike,
} from "../lib/mapProjection.js";
import {
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  isServable,
  type MapObject,
} from "../lib/mapObjects.js";
import { CLAIM_TYPES, LEGACY_CLAIM_TYPES } from "../lib/intelContracts.js";
import { mapQuickSignal } from "../lib/quickSignal.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const AREA_TRAVELER = {
  id: "u1",
  handle: "nomad",
  displayName: "Ada",
  avatarUrl: "https://cdn.example/a.jpg",
  verified: true,
  openToMeet: true,
  city: "Da Nang",
  country: "VN",
  freshness: "live",
  precision: "area",
  lat: 16.05,
  lng: 108.2,
};

const CITY_TRAVELER = { ...AREA_TRAVELER, id: "u2", precision: "city" };

// Shaped like what actually reaches projectGem: a hidden_gems row restricted to
// findNearbyGems' select list, then passed through applyGemPrivacy — which drops
// latitude/longitude/approx_* and adds camelCase lat/lng/coordsPrecision.
//
// It used to carry `thumbnail_url`, which is not a column on hidden_gems at all.
// The fixture invented it, projectGem read it, and the test asserted the result —
// so a field that was ALWAYS null in production looked covered. The
// select-list guard at the bottom of this file now makes that impossible.
const GEM = {
  id: "g1",
  // The bridge to the live-claim subject space. HiddenGemDiscoveryService
  // selects this column (:106), so a fixture without it is not the shape
  // production emits — and its absence is exactly what let the id-space bug
  // sit behind a green suite.
  canonical_place_id: "place-uuid-for-g1",
  name: "Rooftop stairwell",
  category: "viewpoint",
  city: "Da Nang",
  status: "active",
  image_url: "https://cdn.example/gem.jpg",
  verification_level: "community",
  coordsPrecision: "exact",
  lat: 16.06,
  lng: 108.21,
};

// Shaped like an events row as loadNearbyEvents selects it. `ends_at` was
// missing from both this fixture AND that select, so `expiresAt` was silently
// undefined on every gateway-served event.
const EVENT = {
  id: "e1",
  title: "Night market",
  location_name: "Han River",
  location_lat: 16.07,
  location_lng: 108.22,
  starts_at: "2026-08-31T12:00:00.000Z",
  ends_at: "2026-08-31T18:00:00.000Z",
  cover_url: null,
  visibility: "public",
};

/**
 * THE FIXTURE IS DERIVED, NOT WRITTEN.
 *
 * This helper used to hard-code `claimType: "crowd", value: "busy"` — a shape
 * production has never emitted. "crowd" is a LEGACY flat type
 * (intelContracts.LEGACY_CLAIM_TYPES, seeded by migration 2122); what the
 * capture path writes is `crowd.level` with `{ level }` (lib/quickSignal,
 * routes/mapObservations). Every assertion below therefore passed against
 * fiction while §7's Activity axis was dead in production.
 *
 * So the fixture now ASKS THE PRODUCER what a claim looks like. If
 * `mapQuickSignal` ever changes the type or the value shape, these tests move
 * with it instead of pinning a shape nobody writes any more.
 */
const PRODUCTION_CROWD_CLAIM = mapQuickSignal("arrival", "busy")!;

/** The canonical claim-type registry — read from the contract, not retyped. */
const CANONICAL_CLAIM_TYPES: ReadonlySet<string> = new Set(CLAIM_TYPES.map((s) => s.claimType));

function claim(over: Partial<LiveClaimLike> = {}): LiveClaimLike {
  return {
    id: "snap-1",
    claimType: PRODUCTION_CROWD_CLAIM.claimType,
    value: PRODUCTION_CROWD_CLAIM.value,
    confidence: 0.8,
    band: "live",
    sourceCountBucket: "several",
    sourceClass: "firsthand_unverified",
    observedAt: "2026-08-31T11:58:00.000Z",
    validUntil: "2026-08-31T12:13:00.000Z",
    state: "live",
    ...over,
  };
}

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

// ── privacy: the rung is recorded, never widened ──────────────────────────────

describe("privacy class mapping", () => {
  test("traveler precision maps onto the §23 ladder, unknown fails closed", () => {
    assert.equal(travelerPrivacyClass("area"), "approximate");
    assert.equal(travelerPrivacyClass("city"), "aggregate_only");
    // The fail-closed direction is the whole point: an unrecognised precision
    // must never be treated as more precise than we can justify.
    assert.equal(travelerPrivacyClass("exact"), "aggregate_only");
    assert.equal(travelerPrivacyClass(null), "aggregate_only");
    assert.equal(travelerPrivacyClass(undefined), "aggregate_only");
  });

  test("gem coordsPrecision only yields place_level for an explicit 'exact'", () => {
    assert.equal(gemPrivacyClass("exact"), "place_level");
    assert.equal(gemPrivacyClass("approximate"), "approximate");
    assert.equal(gemPrivacyClass(null), "approximate");
    assert.equal(gemPrivacyClass("something-new"), "approximate");
  });
});

describe("identity suppression (spec §23, §37)", () => {
  test("a city-precision traveler carries NO identifying field", () => {
    const obj = projectTraveler(CITY_TRAVELER)!;
    assert.equal(obj.privacyClass, "aggregate_only");
    assert.equal(obj.title, "Traveler nearby");

    const serialized = JSON.stringify(obj);
    for (const leaked of ["Ada", "nomad", "cdn.example"]) {
      assert.ok(
        !serialized.includes(leaked),
        `aggregate-rung traveler must not carry "${leaked}" — the client cannot leak what it never received`,
      );
    }
    assert.deepEqual(Object.keys(obj.payload as object).sort(), ["openToMeet", "precision"]);
  });

  test("an area-precision traveler may carry identity", () => {
    const obj = projectTraveler(AREA_TRAVELER)!;
    assert.equal(obj.privacyClass, "approximate");
    assert.equal(obj.title, "Ada");
    assert.equal((obj.payload as any).avatarUrl, "https://cdn.example/a.jpg");
  });

  test("aggregate travelers get no interaction beyond 'view'", () => {
    assert.deepEqual(projectTraveler(CITY_TRAVELER)!.interaction!.actions, ["view"]);
    assert.ok(projectTraveler(AREA_TRAVELER)!.interaction!.actions.includes("message"));
  });

  test("a traveler is a social_zone, never an identified person kind", () => {
    assert.equal(projectTraveler(AREA_TRAVELER)!.kind, "social_zone");
  });
});

// ── coordinates are passed through, never sharpened ───────────────────────────

describe("coordinate contract", () => {
  test("projection echoes the source coordinates exactly", () => {
    const obj = projectTraveler(AREA_TRAVELER)!;
    assert.deepEqual(obj.geometry, { type: "Point", coordinates: [108.2, 16.05] });
  });

  test("an event whose coordinates the source redacted produces no object", () => {
    // loadNearbyEvents NULLs coords when show_exact_location is false and the
    // viewer is not the host. No coordinates must mean no pin — never a
    // fallback to a city centroid, which would re-expose a hidden venue.
    assert.equal(projectEvent({ ...EVENT, location_lat: null, location_lng: null }, NOW), null);
  });

  test("a coordinate-less traveler or gem produces no object", () => {
    assert.equal(projectTraveler({ ...AREA_TRAVELER, lat: null }), null);
    assert.equal(projectGem({ ...GEM, lng: null }), null);
  });

  test("a non-active gem is dropped", () => {
    assert.equal(projectGem({ ...GEM, status: "pending" }), null);
  });
});

// ── confidence and freshness are never invented ───────────────────────────────

describe("no invented intelligence (spec §37)", () => {
  test("a gem carries no confidence band despite having a verification level", () => {
    const obj = projectGem(GEM)!;
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.freshness, undefined);
    // The verification level still travels — as a payload fact, not as evidence
    // about current conditions.
    assert.equal((obj.payload as any).verificationLevel, "community");
  });

  test("an event carries no confidence or freshness from its schedule", () => {
    const obj = projectEvent(EVENT, NOW)!;
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.freshness, undefined);
  });

  test("an unrecognised traveler freshness becomes 'unknown', not a guess", () => {
    assert.equal(projectTraveler({ ...AREA_TRAVELER, freshness: "stale-ish" })!.freshness, "unknown");
    assert.equal(projectTraveler({ ...AREA_TRAVELER, freshness: undefined })!.freshness, "unknown");
  });

  test("the live-claim fixture is a shape production actually emits", () => {
    // The guard that would have caught the original defect: assert the fixture's
    // claim type against the real registry, so a future rename fails here rather
    // than passing green against a type nobody writes.
    assert.ok(
      CANONICAL_CLAIM_TYPES.has(PRODUCTION_CROWD_CLAIM.claimType),
      `fixture claim type ${PRODUCTION_CROWD_CLAIM.claimType} is not in the canonical registry`,
    );
    assert.ok(
      !(LEGACY_CLAIM_TYPES as readonly string[]).includes(PRODUCTION_CROWD_CLAIM.claimType),
      "the fixture must not be a LEGACY flat claim type — production stopped writing those",
    );
    assert.equal(PRODUCTION_CROWD_CLAIM.claimType, "crowd.level");
  });

  test("an unmapped crowd value does not become 'moderate'", () => {
    assert.equal(crowdValueToActivity(claim({ value: { level: "rammed" } })), undefined);
    assert.equal(crowdValueToActivity(claim({ claimType: "vibe.state", value: { state: "social" } })), undefined);
    // The real production shape: crowd.level carrying { level }.
    assert.equal(crowdValueToActivity(claim()), "busy");
    // `peak` is §7 DISPLAY vocabulary, never a claim value. The old assertion
    // here asserted the opposite and was green because the mapper switched over
    // the display vocabulary instead of intelContracts.CROWD_LEVELS.
    assert.equal(crowdValueToActivity(claim({ value: { level: "peak" } })), undefined);
  });
});

// ── live claim merge ──────────────────────────────────────────────────────────

describe("applyLiveClaims", () => {
  test("no claims leaves the object untouched", () => {
    const obj = projectGem(GEM)!;
    assert.equal(applyLiveClaims(obj, [], NOW), obj);
  });

  test("a live claim attaches freshness, band, activity and provenance refs", () => {
    const merged = applyLiveClaims(projectGem(GEM)!, [claim()], NOW);
    assert.equal(merged.freshness, "live");
    assert.equal(merged.confidence, "live");
    assert.equal(merged.activity, "busy");
    assert.deepEqual(merged.sourceRefs, ["snap-1"]);
    assert.equal(merged.provenance!.confidence, "live");
    assert.equal(merged.provenance!.lines.length, 1);
  });

  test("provenance never carries a raw contributor count", () => {
    // The exact distinct-actor count IS the privacy parameter — only the coarse
    // bucket may cross the wire.
    const merged = applyLiveClaims(
      projectGem(GEM)!,
      [claim({ sourceCountBucket: "many" })],
      NOW,
    );
    const text = merged.provenance!.lines[0].text;
    assert.match(text, /Many recent traveler reports/);
    assert.ok(!/\d/.test(text), `provenance line must not contain a count: ${text}`);
  });

  test("an EXPIRED claim yields 'historical' and does not win the live-zone tier", () => {
    const expired = claim({
      observedAt: "2026-08-31T10:00:00.000Z",
      validUntil: "2026-08-31T10:15:00.000Z",
    });
    const merged = applyLiveClaims(projectGem(GEM)!, [expired], NOW);
    assert.equal(merged.freshness, "historical");
    assert.equal(
      merged.renderingPriority,
      KIND_DEFAULT_PRIORITY.hidden_gem,
      "a stale claim must not promote an object to the high-confidence live tier",
    );
  });

  test("a fresh, live-band claim promotes to the high-confidence live-zone tier", () => {
    const merged = applyLiveClaims(projectGem(GEM)!, [claim()], NOW);
    assert.equal(merged.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
  });

  test("a fresh but only likely_current claim does NOT promote", () => {
    const merged = applyLiveClaims(projectGem(GEM)!, [claim({ band: "likely_current" })], NOW);
    assert.equal(merged.renderingPriority, KIND_DEFAULT_PRIORITY.hidden_gem);
  });

  test("promotion never LOWERS an existing priority", () => {
    const safety: MapObject = {
      ...projectGem(GEM)!,
      renderingPriority: RENDERING_PRIORITY.safety,
    };
    const merged = applyLiveClaims(safety, [claim()], NOW);
    assert.equal(merged.renderingPriority, RENDERING_PRIORITY.safety);
  });
});

// ── enrichment is bounded AND reported ────────────────────────────────────────

describe("enrichWithLiveClaims", () => {
  const gems = (n: number) =>
    Array.from({ length: n }, (_, i) => projectGem({ ...GEM, id: `g${i}` })!);

  test("only place-like objects are eligible", () => {
    assert.equal(liveSubjectIdFor(projectTraveler(AREA_TRAVELER)!), null);
    assert.equal(liveSubjectIdFor(projectEvent(EVENT, NOW)!), null);
  });

  // ── The subject id must be one the claim store can actually match ──────────
  //
  // This asserted `"g1"` — the gem's OWN id. intel_state_snapshots.subject_id
  // is `uuid NOT NULL REFERENCES public.places(id)` (migration 2130), and a
  // gem id is a hidden_gems id: an independent uuid space. So the assertion
  // pinned a value that could never match anything, and every enrichment test
  // below injects a reader that ignores the id it is handed — which is why 27
  // green tests sat on top of a join that has never returned a row.
  test("a gem's live subject is its CANONICAL PLACE, not its own id", () => {
    const subject = liveSubjectIdFor(projectGem(GEM)!);
    assert.notEqual(subject, "g1", "the gem's own id cannot match places(id)");
    assert.equal(subject, "place-uuid-for-g1");
  });

  test("a gem with no canonical place has NO live subject", () => {
    // Null, never a fallback to the gem id: a wrong subject does not fail
    // safely, it eventually matches somebody else's place.
    const orphan = projectGem({ ...GEM, canonical_place_id: null })!;
    assert.equal(liveSubjectIdFor(orphan), null);
  });

  test("the subject actually reaches the reader", async () => {
    // The join, end to end. Without this the two assertions above could both
    // pass while enrichment still queried something else entirely.
    const seen: string[] = [];
    await enrichWithLiveClaims([projectGem(GEM)!], async (id) => {
      seen.push(id);
      return [];
    }, { now: NOW });
    assert.deepEqual(seen, ["place-uuid-for-g1"]);
  });

  test("a cap is REPORTED, never silent", async () => {
    const objects = [...gems(40), projectTraveler(AREA_TRAVELER)!];
    const res = await enrichWithLiveClaims(objects, async () => [claim()], { max: 25, now: NOW });

    assert.equal(res.considered, 40, "the traveler is not eligible and must not be counted");
    assert.equal(res.enriched, 25);
    assert.equal(
      res.skipped,
      15,
      "a truncated enrichment must be visible, or 'we stopped looking' reads as 'nothing is here'",
    );
    assert.equal(res.objects.length, objects.length, "capping must not drop objects");
  });

  test("a throwing read fails closed to no claim, not a stale one", async () => {
    const res = await enrichWithLiveClaims(
      gems(3),
      async () => {
        throw new Error("db down");
      },
      { now: NOW },
    );
    assert.equal(res.enriched, 0);
    for (const o of res.objects) assert.equal(o.confidence, undefined);
  });

  test("objects with no claims come back byte-identical", async () => {
    const input = gems(3);
    const res = await enrichWithLiveClaims(input, async () => [], { now: NOW });
    assert.deepEqual(res.objects, input);
  });

  test("max of 0 enriches nothing and reports everything skipped", async () => {
    const res = await enrichWithLiveClaims(gems(4), async () => [claim()], { max: 0, now: NOW });
    assert.equal(res.enriched, 0);
    assert.equal(res.skipped, 4);
  });
});

// ── ranking: priority beats proximity ─────────────────────────────────────────

describe("rankObjects (spec §5, §31)", () => {
  const at = (id: string, priority: number, lat: number, lng: number): MapObject => ({
    id,
    kind: "place",
    geometry: { type: "Point", coordinates: [lng, lat] },
    title: id,
    privacyClass: "place_level",
    renderingPriority: priority,
  });

  test("a distant safety notice outranks a place at the viewport centre", () => {
    const center = { lat: 16.05, lng: 108.2 };
    const ranked = rankObjects(
      [at("near-place", RENDERING_PRIORITY.relevant_place, 16.05, 108.2),
       at("far-safety", RENDERING_PRIORITY.safety, 16.5, 108.9)],
      center,
    );
    assert.equal(ranked[0].id, "far-safety");
  });

  test("within a tier, nearer wins", () => {
    const center = { lat: 0, lng: 0 };
    const ranked = rankObjects(
      [at("far", RENDERING_PRIORITY.relevant_place, 1, 1),
       at("near", RENDERING_PRIORITY.relevant_place, 0.01, 0.01)],
      center,
    );
    assert.equal(ranked[0].id, "near");
    assert.ok(ranked[0].distanceKm! < ranked[1].distanceKm!);
  });

  test("ordering is total and deterministic for identical priority and distance", () => {
    const center = { lat: 0, lng: 0 };
    const objs = [at("b", 40, 1, 1), at("a", 40, 1, 1), at("c", 40, 1, 1)];
    assert.deepEqual(rankObjects(objs, center).map((o) => o.id), ["a", "b", "c"]);
    assert.deepEqual(rankObjects(objs.slice().reverse(), center).map((o) => o.id), ["a", "b", "c"]);
  });
});

// ── the serialization gate ────────────────────────────────────────────────────

describe("servableOnly", () => {
  test("drops nulls, the 'none' rung, empty titles and broken geometry", () => {
    const ok = projectGem(GEM)!;
    const objs = [
      ok,
      null,
      undefined,
      { ...ok, id: "x1", privacyClass: "none" as const },
      { ...ok, id: "x2", title: "   " },
      { ...ok, id: "x3", geometry: { type: "Point", coordinates: [NaN, NaN] } as any },
    ];
    const out = servableOnly(objs);
    assert.deepEqual(out.map((o) => o.id), ["gem:g1"]);
    assert.ok(out.every(isServable));
  });
});

describe("filterKinds", () => {
  test("an empty or absent kind list means all", () => {
    const objs = [projectGem(GEM)!, projectEvent(EVENT, NOW)!];
    assert.equal(filterKinds(objs, null).length, 2);
    assert.equal(filterKinds(objs, []).length, 2);
  });

  test("filters to the requested kinds", () => {
    const objs = [projectGem(GEM)!, projectEvent(EVENT, NOW)!, projectTraveler(AREA_TRAVELER)!];
    assert.deepEqual(filterKinds(objs, ["event"]).map((o) => o.kind), ["event"]);
  });
});

// ── viewport parsing ──────────────────────────────────────────────────────────

describe("parseBbox", () => {
  test("accepts a well-formed bbox", () => {
    assert.deepEqual(parseBbox("108.1,16.0,108.3,16.1"), { west: 108.1, south: 16.0, east: 108.3, north: 16.1 });
  });

  test("rejects malformed, out-of-range, inverted and antimeridian-crossing input", () => {
    for (const bad of [
      undefined, null, 42, "", "1,2,3", "1,2,3,4,5", "a,b,c,d",
      "0,0,0,0",              // zero area
      "108.3,16.0,108.1,16.1", // inverted longitude (also the antimeridian shape)
      "108.1,16.1,108.3,16.0", // inverted latitude
      "-200,0,10,10",          // longitude out of range
      "0,-100,10,10",          // latitude out of range
      "0,0,NaN,10",
    ]) {
      assert.equal(parseBbox(bad as unknown), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("bboxToCenterRadius", () => {
  test("centres the box and clamps the radius into the sources' accepted range", () => {
    const { lat, lng, radiusKm } = bboxToCenterRadius({ west: 108.1, south: 16.0, east: 108.3, north: 16.2 });
    assert.ok(Math.abs(lat - 16.1) < 1e-9);
    assert.ok(Math.abs(lng - 108.2) < 1e-9);
    assert.ok(radiusKm >= 1 && radiusKm <= 200);
  });

  test("a tiny viewport still yields at least the 1 km floor", () => {
    const { radiusKm } = bboxToCenterRadius({ west: 0, south: 0, east: 0.0001, north: 0.0001 });
    assert.equal(radiusKm, 1);
  });

  test("a hemisphere-wide viewport is clamped to the 200 km ceiling", () => {
    const { radiusKm } = bboxToCenterRadius({ west: -170, south: -80, east: 170, north: 80 });
    assert.equal(radiusKm, 200);
  });

  test("the radius covers the corner, not just the edge", () => {
    // Half-diagonal must exceed half-height, or corner objects fall outside.
    const b = { west: 0, south: 0, east: 2, north: 2 };
    const { radiusKm } = bboxToCenterRadius(b);
    assert.ok(radiusKm > 1 * 111, "radius must reach the corner of the viewport");
  });
});

describe("parseKinds", () => {
  test("keeps only kinds in the contract's closed set", () => {
    assert.deepEqual(parseKinds("event,hidden_gem"), ["event", "hidden_gem"]);
    assert.deepEqual(parseKinds(" event , not_a_kind "), ["event"]);
  });

  test("returns null (meaning 'all') for empty or fully-unknown input", () => {
    assert.equal(parseKinds(""), null);
    assert.equal(parseKinds("   "), null);
    assert.equal(parseKinds("nope,also_nope"), null);
    assert.equal(parseKinds(undefined), null);
    assert.equal(parseKinds(123), null);
  });
});

// ── pagination ────────────────────────────────────────────────────────────────

describe("paginate", () => {
  const objs = Array.from({ length: 10 }, (_, i) => projectGem({ ...GEM, id: `g${i}` })!);

  test("pages and reports the next cursor", () => {
    const { page, nextCursor } = paginate(objs, null, 4);
    assert.equal(page.length, 4);
    assert.equal(nextCursor, "4");
  });

  test("the last page reports no next cursor", () => {
    assert.equal(paginate(objs, "8", 4).nextCursor, null);
    assert.equal(paginate(objs, "8", 4).page.length, 2);
  });

  test("a malformed cursor restarts from 0 rather than throwing", () => {
    assert.equal(decodeCursor("nonsense"), 0);
    assert.equal(decodeCursor("-5"), 0);
    assert.equal(paginate(objs, "nonsense", 3).page[0].id, "gem:g0");
  });
});

// ── The column a projector reads must be one the query actually returns ───────
//
// WHY THIS GUARD EXISTS
// =====================
// `projectGem` read `g.thumbnail_url` for months. `hidden_gems` has no such
// column — it has `image_url` — so every gem the gateway served carried a null
// thumbnail and rendered with no picture, while the client's fallback projector
// (reading the app DTO's `imageUrl`) showed one. Nothing failed: the row is
// `any`, the fixture here invented the field to match, and the assertion passed.
//
// `projectEvent` read `ev.ends_at`, which IS a column on `events` but was not in
// `loadNearbyEvents`' select list — equally undefined at runtime, equally silent.
//
// So a projector's snake_case reads are checked against BOTH:
//   1. the generated schema (src/lib/database.types.ts) — does the column exist?
//   2. the select list of the query that actually produces the row — is it fetched?
//
// Both are read as text. That is deliberate: executing the query needs a
// database, and importing the row type gives no runtime guarantee about which
// columns a particular `.select()` asked for.

describe("projector reads only columns the query returns", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectionSrc = readFileSync(resolve(here, "../lib/mapProjection.ts"), "utf8");
  const typesSrc = readFileSync(resolve(here, "../lib/database.types.ts"), "utf8");

  /** Column names on a table's Row type in the generated schema. */
  function tableColumns(table: string): Set<string> {
    const m = new RegExp(`\\n      ${table}: \\{\\n        Row: \\{\\n([\\s\\S]*?)\\n        \\}\\n`).exec(
      typesSrc,
    );
    assert.ok(m, `table ${table} not found in database.types.ts`);
    return new Set([...m![1].matchAll(/^\s+([a-z0-9_]+)\??:/gm)].map((x) => x[1]));
  }

  /** The columns named in the first `.select("…")` / `.select(\`…\`)` of a file. */
  function selectedColumns(rawSource: string, afterMarker: string): Set<string> {
    const source = stripComments(rawSource);
    const at = source.indexOf(afterMarker);
    assert.notEqual(at, -1, `marker "${afterMarker}" not found`);
    const m = /\.select\(\s*(["'`])([\s\S]*?)\1/.exec(source.slice(at));
    assert.ok(m, `no .select(...) after "${afterMarker}"`);
    return new Set(
      m![2]
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^[a-z0-9_]+$/.test(c)),
    );
  }

  /**
   * Strip line and block comments. A guard that a COMMENT can trip is a guard
   * people route around: without this, documenting the old `g.thumbnail_url`
   * read in a comment would fail the very test that documents it.
   */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  const projectionCode = stripComments(projectionSrc);

  /** snake_case property reads off `<v>.` inside one exported function. */
  function snakeReadsIn(source: string, fnName: string, varName: string): string[] {
    const code = stripComments(source);
    const start = code.indexOf(`export function ${fnName}(`);
    assert.notEqual(start, -1, `${fnName} not found`);
    const nextFn = code.indexOf("\nexport function ", start + 1);
    const body = code.slice(start, nextFn === -1 ? undefined : nextFn);
    const re = new RegExp(`\\b${varName}[?]?\\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\\b`, "g");
    return [...new Set([...body.matchAll(re)].map((m) => m[1]))];
  }

  const snakeReads = (fnName: string, varName: string) =>
    snakeReadsIn(projectionSrc, fnName, varName);

  test("the guard is reading real data, not empty matches", () => {
    // Without this, every assertion below would pass vacuously on a parse miss.
    assert.ok(tableColumns("hidden_gems").size > 10);
    assert.ok(tableColumns("events").size > 10);
    assert.ok(snakeReads("projectGem", "g").length > 0);
    assert.ok(snakeReads("projectEvent", "ev").length > 0);
  });

  test("projectGem reads only hidden_gems columns findNearbyGems selects", () => {
    const discoverySrc = readFileSync(
      resolve(here, "../services/hiddenGems/HiddenGemDiscoveryService.ts"),
      "utf8",
    );
    const selected = selectedColumns(discoverySrc, 'from("hidden_gems")');
    const columns = tableColumns("hidden_gems");
    assert.ok(selected.size > 10, "select list did not parse");

    for (const field of snakeReads("projectGem", "g")) {
      assert.ok(columns.has(field), `projectGem reads g.${field}, not a hidden_gems column`);
      assert.ok(selected.has(field), `projectGem reads g.${field}, which findNearbyGems does not select`);
    }
  });

  test("projectEvent reads only events columns loadNearbyEvents selects", () => {
    const routeSrc = readFileSync(resolve(here, "../routes/mapSearch.ts"), "utf8");
    const selected = selectedColumns(routeSrc, "export async function loadNearbyEvents");
    const columns = tableColumns("events");
    assert.ok(selected.size > 10, "select list did not parse");

    for (const field of snakeReads("projectEvent", "ev")) {
      assert.ok(columns.has(field), `projectEvent reads ev.${field}, not an events column`);
      assert.ok(selected.has(field), `projectEvent reads ev.${field}, which loadNearbyEvents does not select`);
    }
  });

  test("the two regressions this guard was written for stay fixed", () => {
    // Named explicitly so a revert reads as what it is, not as a generic failure.
    assert.match(projectionCode, /thumbnailUrl:\s*g\.image_url/);
    assert.doesNotMatch(projectionCode, /g\.thumbnail_url/);
    const routeSrc = readFileSync(resolve(here, "../routes/mapSearch.ts"), "utf8");
    assert.ok(
      selectedColumns(routeSrc, "export async function loadNearbyEvents").has("ends_at"),
      "loadNearbyEvents must select ends_at — projectEvent turns it into expiresAt",
    );
  });

  // lib/mapSearch.ts shapes the SAME two sources for the search surface. Its
  // `normalizeGem` carried an identical `g.thumbnail_url` read, so the two
  // consumers of findNearbyGems were wrong in exactly the same way — which is
  // the argument for checking every consumer of a source, not just the one that
  // happened to be under review.
  test("mapSearch's normalizers read only columns their queries return", () => {
    const searchLib = readFileSync(resolve(here, "../lib/mapSearch.ts"), "utf8");
    const discoverySrc = readFileSync(
      resolve(here, "../services/hiddenGems/HiddenGemDiscoveryService.ts"),
      "utf8",
    );
    const routeSrc = readFileSync(resolve(here, "../routes/mapSearch.ts"), "utf8");

    const gemSelected = selectedColumns(discoverySrc, 'from("hidden_gems")');
    const gemColumns = tableColumns("hidden_gems");
    for (const field of snakeReadsIn(searchLib, "normalizeGem", "g")) {
      assert.ok(gemColumns.has(field), `normalizeGem reads g.${field}, not a hidden_gems column`);
      assert.ok(gemSelected.has(field), `normalizeGem reads g.${field}, which findNearbyGems does not select`);
    }

    const evSelected = selectedColumns(routeSrc, "export async function loadNearbyEvents");
    const evColumns = tableColumns("events");
    for (const field of snakeReadsIn(searchLib, "normalizeEvent", "ev")) {
      assert.ok(evColumns.has(field), `normalizeEvent reads ev.${field}, not an events column`);
      assert.ok(evSelected.has(field), `normalizeEvent reads ev.${field}, which loadNearbyEvents does not select`);
    }

    // Self-check: an empty read set would make both loops vacuous.
    assert.ok(snakeReadsIn(searchLib, "normalizeGem", "g").length > 0);
    assert.ok(snakeReadsIn(searchLib, "normalizeEvent", "ev").length > 0);
  });

  test("a gem carries the image the query fetched", () => {
    assert.equal((projectGem(GEM)!.payload as any).thumbnailUrl, GEM.image_url);
  });

  test("an event expires at its end time", () => {
    assert.equal(projectEvent(EVENT, NOW)!.expiresAt, EVENT.ends_at);
  });
});
