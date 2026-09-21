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
  countAdjacentActiveEvents,
  crowdValueToActivity,
  decodeCursor,
  enrichWithLiveClaims,
  eventAdjacencyLine,
  filterKinds,
  gemPrivacyClass,
  liveSubjectIdFor,
  paginate,
  parseBbox,
  parseKinds,
  projectEvent,
  projectGem,
  projectTraveler,
  qualifiedMediaLine,
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
// M179 (see the block at the foot of this file): the §24 gate is asserted on a
// real projection RESPONSE, not only on the pure function, so the route's own
// row→zone column mapping is inside the proof.
import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import { startRouterApp, type FakeState } from "./helpers/fakeMapDb.js";
import { PROTECTED_CATEGORIES, PROTECTION_ACTIONS } from "../lib/protectedLocations.js";

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

// ── §9 / Table 7: the contextual evidence lines ───────────────────────────────

describe("§9 provenance — event-adjacency and qualified-media evidence", () => {
  // Both formatters use Table 7's copy verbatim and emit null (not "") when
  // their input is absent, so an absent input is indistinguishable from "no
  // such evidence" at the panel level.
  describe("the pure line formatters", () => {
    test("event-adjacency emits Table 7's line only when an active event exists", () => {
      assert.deepEqual(eventAdjacencyLine({ count: 1 }), { text: "Active event nearby" });
      assert.deepEqual(eventAdjacencyLine({ count: 4 }), { text: "Active event nearby" });
      assert.equal(eventAdjacencyLine({ count: 0 }), null);
      assert.equal(eventAdjacencyLine(null), null);
      assert.equal(eventAdjacencyLine(undefined), null);
      assert.equal(eventAdjacencyLine({ count: Number.NaN }), null);
    });

    test("qualified-media emits Table 7's line only when qualified media exists", () => {
      assert.deepEqual(qualifiedMediaLine({ count: 2 }), { text: "Recent qualified media" });
      assert.equal(qualifiedMediaLine({ count: 0 }), null);
      assert.equal(qualifiedMediaLine(null), null);
      assert.equal(qualifiedMediaLine(undefined), null);
    });

    test("neither line ever carries a claim ref — they are not claims", () => {
      assert.equal("ref" in eventAdjacencyLine({ count: 1 })!, false);
      assert.equal("ref" in qualifiedMediaLine({ count: 1 })!, false);
    });
  });

  describe("countAdjacentActiveEvents", () => {
    // The gem sits at (16.06, 108.21). Events are placed relative to it.
    const subject = projectGem(GEM)!;
    const near = (over: Record<string, unknown>) =>
      projectEvent({ ...EVENT, ...over }, NOW)!;

    test("counts an active event within the adjacency radius", () => {
      const events = [near({ id: "a", location_lat: 16.061, location_lng: 108.211 })]; // ~150 m
      assert.equal(countAdjacentActiveEvents(subject, events, NOW), 1);
    });

    test("does not count an event outside the radius", () => {
      const events = [near({ id: "far", location_lat: 16.07, location_lng: 108.22 })]; // ~1.5 km
      assert.equal(countAdjacentActiveEvents(subject, events, NOW), 0);
    });

    test("does not count an event that has not started", () => {
      const events = [near({ id: "later", location_lat: 16.061, location_lng: 108.211, starts_at: "2026-08-31T20:00:00.000Z" })];
      assert.equal(countAdjacentActiveEvents(subject, events, NOW), 0);
    });

    test("does not count an event that has already ended", () => {
      const events = [near({
        id: "over", location_lat: 16.061, location_lng: 108.211,
        starts_at: "2026-08-31T10:00:00.000Z", ends_at: "2026-08-31T11:00:00.000Z",
      })];
      assert.equal(countAdjacentActiveEvents(subject, events, NOW), 0);
    });

    test("counts several adjacent active events", () => {
      const events = [
        near({ id: "a", location_lat: 16.0605, location_lng: 108.2105 }),
        near({ id: "b", location_lat: 16.0608, location_lng: 108.2108 }),
        near({ id: "far", location_lat: 16.07, location_lng: 108.22 }),
      ];
      assert.equal(countAdjacentActiveEvents(subject, events, NOW), 2);
    });
  });

  describe("applyLiveClaims appends the evidence lines — but only to a real panel", () => {
    test("event-adjacency and qualified-media lines follow the per-claim lines", () => {
      const merged = applyLiveClaims(projectGem(GEM)!, [claim()], NOW, {
        eventNearby: { count: 2 },
        qualifiedMedia: { count: 1 },
      });
      const texts = merged.provenance!.lines.map((l) => l.text);
      assert.equal(texts[0], merged.provenance!.lines[0].text); // claim line first
      assert.ok(texts.includes("Active event nearby"));
      assert.ok(texts.includes("Recent qualified media"));
      // The claim line still carries its ref; the evidence lines do not.
      assert.equal(merged.provenance!.lines[0].ref, "snap-1");
    });

    test("absent evidence adds nothing (the common path is a no-op)", () => {
      const withEvidence = applyLiveClaims(projectGem(GEM)!, [claim()], NOW, {});
      const without = applyLiveClaims(projectGem(GEM)!, [claim()], NOW);
      assert.deepEqual(withEvidence.provenance!.lines, without.provenance!.lines);
    });

    test("evidence NEVER manufactures a panel when there are no claims (§37)", () => {
      const obj = projectGem(GEM)!;
      const merged = applyLiveClaims(obj, [], NOW, { eventNearby: { count: 9 }, qualifiedMedia: { count: 9 } });
      assert.deepEqual(merged, obj, "no claims ⇒ object untouched, no contextual line invents a claim");
    });

    test("evidence moves no band, freshness, activity or trend", () => {
      const bare = applyLiveClaims(projectGem(GEM)!, [claim()], NOW);
      const withEv = applyLiveClaims(projectGem(GEM)!, [claim()], NOW, { eventNearby: { count: 3 } });
      assert.equal(withEv.confidence, bare.confidence);
      assert.equal(withEv.freshness, bare.freshness);
      assert.equal(withEv.activity, bare.activity);
      assert.equal(withEv.renderingPriority, bare.renderingPriority);
    });
  });

  describe("enrichWithLiveClaims threads the evidence resolver", () => {
    const events = [projectEvent({ ...EVENT, id: "near", location_lat: 16.061, location_lng: 108.211 }, NOW)!];

    test("an enriched subject with an adjacent active event gets the line", async () => {
      const res = await enrichWithLiveClaims([projectGem(GEM)!], async () => [claim()], {
        now: NOW,
        evidence: (obj) => {
          const count = countAdjacentActiveEvents(obj, events, NOW);
          return count > 0 ? { eventNearby: { count } } : null;
        },
      });
      const texts = res.objects[0].provenance!.lines.map((l) => l.text);
      assert.ok(texts.includes("Active event nearby"));
    });

    test("the resolver is not consulted for a subject with no claims", async () => {
      let consulted = 0;
      const res = await enrichWithLiveClaims([projectGem(GEM)!], async () => [], {
        now: NOW,
        evidence: () => { consulted += 1; return { eventNearby: { count: 1 } }; },
      });
      assert.equal(consulted, 0, "no claims ⇒ no panel ⇒ the evidence resolver never runs");
      assert.equal(res.objects[0].provenance, undefined);
    });

    test("a throwing evidence resolver fails soft — the claim survives, the line does not", async () => {
      const res = await enrichWithLiveClaims([projectGem(GEM)!], async () => [claim()], {
        now: NOW,
        evidence: () => { throw new Error("event read blew up"); },
      });
      assert.equal(res.enriched, 1);
      const texts = res.objects[0].provenance!.lines.map((l) => l.text);
      assert.equal(texts.includes("Active event nearby"), false);
      assert.equal(res.objects[0].confidence, "live", "the live claim is untouched by an evidence failure");
    });
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

// ═════════════════════════════════════════════════════════════════════════════
// M179 — "Suppress sensitive locations BEFORE data reaches the client."
//
// The unit half of this is already pinned in protectedLocations.test.ts. What
// was NOT pinned is the half the census's criterion actually names: that a
// PROJECTION RESPONSE, over a viewport containing a curated `protected_zones`
// row, carries `protection` non-null with at least one object coarsened or
// withheld — end to end, through `loadProtectedZones`' column mapping, with the
// row shape migration 2217 stores.
//
// THE CENSUS'S WARNING IS THE REASON THERE ARE THREE ARMS, NOT ONE:
//
//   "applying the table is necessary and NOT sufficient — an empty
//    `protected_zones` makes `applyProtection([], …)` an identity pass."
//
// So an empty table produces a response that LOOKS exactly like a healthy one:
// objects present, `enabled: true`, no refusal. A one-arm test over a seeded CI
// whose `protected_zones` holds 0 rows would be green and would have proven
// nothing. The three arms below are therefore driven by ONE fixture set and
// differ ONLY in the state of `protected_zones`:
//
//   ARM 1  curated rows present   ⇒ coarsened ≥ 1 AND suppressed ≥ 1
//   ARM 2  table readable, EMPTY  ⇒ identity pass, asserted AS an identity pass
//                                   (same objects, same geometry, zero counters)
//                                   — never "the response was empty, so pass"
//   ARM 3  table unreadable       ⇒ `protection_unreadable`, NOT an empty success
//
// Arm 2 is the one the census says is usually got wrong, so it asserts the
// POSITIVE fact (these exact objects came through untouched) rather than the
// absence of a complaint, and it names the arm-1 outcome it must differ from.
// ═════════════════════════════════════════════════════════════════════════════

const M179_HERE = dirname(fileURLToPath(import.meta.url));
const M179_VIEWER = "7f000001-0000-4000-8000-00000000d179";
const M179_TOKEN = "m179-protected-zone-token";
const M179_BBOX = "108.0,15.9,108.4,16.2";

/**
 * The curated medical zone's CENTRE, and a place INSIDE it but deliberately NOT
 * at the centre (~140 m off). The offset is the point: `coarsenForZone` snaps a
 * Point to the zone anchor, so a fixture sitting exactly on the anchor would
 * make "the coordinate moved" unfalsifiable — the coarsened and uncoarsened
 * coordinates would agree to within floating-point noise.
 */
const CLINIC_ZONE_CENTRE = { lat: 16.07, lng: 108.22 };
const CLINIC_SPOT = { lat: 16.071, lng: 108.221 };
/** Inside the curated residence zone below. */
const HOUSE_ZONE_CENTRE = { lat: 16.04, lng: 108.18 };
const HOUSE_SPOT = { lat: 16.0404, lng: 108.1804 };
/** In the viewport, inside NO zone — the control that must survive every arm. */
const OPEN_SPOT = { lat: 16.15, lng: 108.35 };

/** What PostgREST answers when 2217 has not been applied. */
const M179_RELATION_MISSING = {
  message: 'relation "public.protected_zones" does not exist',
  code: "42P01",
};

/**
 * THE CURATED ROWS, IN THE COLUMN SHAPE `loadProtectedZones` SELECTS.
 *
 * Written as DATABASE rows (snake_case, `privacy_floor`, `center_lat`), not as
 * `ProtectedZone` objects, so the route's own row→zone mapping is exercised
 * rather than bypassed. A fixture written in the domain shape would have passed
 * even if that mapping read the wrong column names.
 *
 * Every label here is cross-checked against migration 2217's CHECK lists by
 * "the curated fixture is storable" below. That check exists because this
 * suite's Supabase double implements a filter as `r[col] === val` and is
 * structurally incapable of raising 23514 — so a fixture carrying a category
 * this database would refuse ('homeless_shelter', say) would be green here and
 * un-seedable there.
 */
const CURATED_ZONE_ROWS = [
  {
    id: "zone-medical-1",
    category: "medical_facility",
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: CLINIC_ZONE_CENTRE.lat,
    center_lng: CLINIC_ZONE_CENTRE.lng,
    radius_meters: 250,
    ring: null,
    jurisdiction: "VN",
    policy_ref: "portava/map-spec-24-medical",
    // NOT decoration, and the reason this whole arm went red first: the route
    // selects the policy with `.eq("active", true)`. A curated row that omits
    // this column is filtered out, the zone list comes back EMPTY, and the
    // response is arm 2's identity pass wearing arm 1's name — the exact false
    // green the census warns about, arriving through the fixture rather than
    // through the database. The column is NOT NULL DEFAULT true in 2217, so a
    // real seeded row always has it; a fixture must say so out loud.
    active: true,
  },
  {
    id: "zone-residence-1",
    category: "private_residence",
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: HOUSE_ZONE_CENTRE.lat,
    center_lng: HOUSE_ZONE_CENTRE.lng,
    radius_meters: 120,
    ring: null,
    jurisdiction: "VN",
    policy_ref: "portava/map-spec-24-residence",
    active: true,
  },
];

/** Three places: one in the medical zone, one in the residence zone, one clear. */
const M179_PLACES = [
  {
    id: "p-clinic", name: "Riverside Clinic", primary_category: "clinic", city: "Da Nang",
    neighborhood: null, country_code: "VN",
    latitude: CLINIC_SPOT.lat, longitude: CLINIC_SPOT.lng,
    status: "active", merged_into_place_id: null,
  },
  {
    id: "p-house", name: "Anna's place", primary_category: "residence", city: "Da Nang",
    neighborhood: null, country_code: "VN",
    latitude: HOUSE_SPOT.lat, longitude: HOUSE_SPOT.lng,
    status: "active", merged_into_place_id: null,
  },
  {
    id: "p-open", name: "Han Market", primary_category: "night_market", city: "Da Nang",
    neighborhood: null, country_code: "VN",
    latitude: OPEN_SPOT.lat, longitude: OPEN_SPOT.lng,
    status: "active", merged_into_place_id: null,
  },
];

function m179World(protectedZones: unknown): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    geo_zones: [],
    event_roles: [],
    places: M179_PLACES,
    protected_zones: protectedZones as any,
  };
}

describe("M179 — protection applied before serialization, over a curated viewport", () => {
  async function project(protectedZones: unknown) {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    const app = await startRouterApp(mapProjectionRouter, m179World(protectedZones), {
      token: M179_TOKEN, userId: M179_VIEWER,
    });
    try {
      // zoom 16 = the street band, so §31 aggregation leaves individuals alone
      // and every count below describes THE PROTECTION GATE rather than binning.
      return await app.projection(`bbox=${M179_BBOX}&zoom=16&kinds=place&limit=200`);
    } finally {
      await app.close();
    }
  }

  const byId = (body: any, id: string) =>
    (body.objects as any[]).find((o) => o.id === id) ?? null;

  // ── The fixture's own validity, before any arm leans on it ────────────────
  test("the curated fixture is storable: every label is one migration 2217 admits", () => {
    const sql = readFileSync(resolve(M179_HERE, "../migrations/2217_protected_locations.sql"), "utf8");
    const inList = (col: string): Set<string> => {
      // `category text NOT NULL CHECK (category IN ( 'a', 'b' ))` — the list may
      // wrap across lines and carry comments, so take everything to the closing
      // paren and pull the quoted literals out of it.
      const at = sql.indexOf(`CHECK (${col} IN (`);
      assert.ok(at >= 0, `2217 no longer declares a CHECK list for ${col} — this guard is inert`);
      const tail = sql.slice(at);
      const close = tail.indexOf("))");
      assert.ok(close > 0, `could not find the end of ${col}'s CHECK list in 2217`);
      return new Set([...tail.slice(0, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };

    const dbCategories = inList("category");
    const dbActions = inList("action");
    assert.ok(dbCategories.size > 0 && dbActions.size > 0, "parsed an empty CHECK list");

    for (const row of CURATED_ZONE_ROWS) {
      assert.ok(
        dbCategories.has(row.category),
        `fixture zone ${row.id} uses category '${row.category}', which 2217's CHECK refuses — ` +
          `this row could never be seeded, so every arm below would be fiction`,
      );
      if (row.action !== null) {
        assert.ok(dbActions.has(row.action!), `fixture zone ${row.id} uses an unstorable action`);
      }
    }

    // The runtime vocabulary and the storable vocabulary must agree on
    // categories, and must DISAGREE on 'allow' exactly — 2217 refuses to store a
    // protection row that permits, and lib/protectedLocations says so in prose.
    assert.deepEqual(
      [...dbCategories].sort(),
      [...PROTECTED_CATEGORIES].slice().sort(),
      "2217's storable categories and PROTECTED_CATEGORIES have drifted apart",
    );
    assert.ok(
      (PROTECTION_ACTIONS as readonly string[]).includes("allow") && !dbActions.has("allow"),
      "'allow' must remain a runtime action and an UNSTORABLE one — a stored 'allow' is a hole",
    );
  });

  // ── ARM 1 — curated rows present ──────────────────────────────────────────
  test("ARM 1: a viewport containing curated zones coarsens one object and withholds another", async () => {
    const r = await project({ rows: CURATED_ZONE_ROWS });

    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true, "the gateway must be SERVING for this arm to mean anything");
    assert.equal("refusal" in r.body, false);

    // `protection` non-null is half the census's sentence.
    assert.notEqual(r.body.protection, null, "a serving response must report its protection pass");
    const report = r.body.protection;

    // …and "at least one object coarsened or withheld" is the other half. Both
    // directions are asserted, because they are different policies: the medical
    // zone coarsens (the place stays on the map, less precisely) and the
    // residence zone suppresses (the place leaves the map entirely).
    assert.ok(report.coarsened >= 1, `expected at least 1 coarsened, got ${report.coarsened}`);
    assert.ok(report.suppressed >= 1, `expected at least 1 suppressed, got ${report.suppressed}`);
    assert.equal(
      report.evaluated,
      report.allowed + report.coarsened + report.suppressed + report.safetyExempt,
      "the report must conserve every object it evaluated",
    );

    // The withheld one is GONE FROM THE WIRE — not merely counted.
    assert.equal(
      byId(r.body, "place:p-house"), null,
      "the place inside the private-residence zone reached the client",
    );

    // The coarsened one is present, at a narrower rung, snapped off its point
    // and ONTO the zone anchor. Asserting the destination — not merely "it
    // moved" — is what makes this falsifiable: a coarsening that jittered the
    // coordinate by a metre would satisfy "it moved" and disclose the building.
    const clinic = byId(r.body, "place:p-clinic");
    assert.ok(clinic, "the medical-zone place should be coarsened, not deleted");
    assert.equal(clinic.privacyClass, "approximate", "medical_facility floors at 'approximate'");
    const [lng, lat] = clinic.geometry.coordinates as [number, number];
    assert.ok(
      Math.abs(lng - CLINIC_ZONE_CENTRE.lng) < 1e-9 && Math.abs(lat - CLINIC_ZONE_CENTRE.lat) < 1e-9,
      `a coarsened object must sit on the zone anchor, not its own point; got ${lng},${lat}`,
    );
    assert.notDeepEqual(
      [lng, lat], [CLINIC_SPOT.lng, CLINIC_SPOT.lat],
      "the exact source coordinate reached the wire — nothing was coarsened",
    );

    // The control survives, so arm 1 is not "the gate deleted everything".
    const open = byId(r.body, "place:p-open");
    assert.ok(open, "a place inside no zone must be unaffected");
    assert.equal(open.privacyClass, "place_level");
    assert.deepEqual(open.geometry.coordinates, [OPEN_SPOT.lng, OPEN_SPOT.lat]);
  });

  // ── ARM 2 — table readable and EMPTY ──────────────────────────────────────
  test("ARM 2: with ZERO curated rows applyProtection is an IDENTITY PASS — stated, not inferred", async () => {
    const r = await project({ rows: [] });

    // This arm's whole point is that it is NOT an empty response. Saying so
    // first, loudly, is the difference between this test and the false green
    // the census warns about: an empty `protected_zones` is indistinguishable
    // from a healthy one unless the identity is asserted positively.
    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false);
    assert.equal(
      r.body.objects.length, M179_PLACES.length,
      "IDENTITY PASS: every object arm 1 saw must still be here. An empty table " +
        "means 'no policy exists', never 'nothing may be shown'.",
    );

    const report = r.body.protection;
    assert.notEqual(report, null, "an identity pass still reports — a null report hides the no-op");
    assert.equal(report.evaluated, M179_PLACES.length);
    assert.equal(report.allowed, M179_PLACES.length, "every object was ALLOWED, explicitly");
    assert.equal(report.coarsened, 0, "nothing was coarsened, because no policy said to");
    assert.equal(report.suppressed, 0, "nothing was withheld, because no policy said to");

    // THE NAMED CONTRAST WITH ARM 1. Same viewport, same three places, same
    // flag, same code path — only `protected_zones` differs. The two objects
    // arm 1 protected are here at FULL precision, which is precisely why
    // "2217 applied" is necessary and not sufficient: this response is what a
    // seeded-but-empty production would serve, and it protects nothing.
    const clinic = byId(r.body, "place:p-clinic");
    const house = byId(r.body, "place:p-house");
    assert.ok(clinic && house, "arm 1 coarsened one of these and withheld the other; both are here");
    assert.equal(clinic.privacyClass, "place_level", "un-coarsened: arm 1 made this 'approximate'");
    assert.deepEqual(
      clinic.geometry.coordinates, [CLINIC_SPOT.lng, CLINIC_SPOT.lat],
      "un-snapped: arm 1 moved this point to the zone anchor",
    );
    assert.deepEqual(
      house.geometry.coordinates, [HOUSE_SPOT.lng, HOUSE_SPOT.lat],
      "the private residence arm 1 WITHHELD is on the wire at its exact coordinate",
    );
  });

  // ── ARM 3 — table unreadable ──────────────────────────────────────────────
  test("ARM 3: an unreadable policy is the named refusal, never an empty success", async () => {
    const r = await project({ error: M179_RELATION_MISSING });

    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false, "an unreadable policy must not serve");
    assert.equal(r.body.refusal, "protection_unreadable");
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.protection, null);

    // The distinction this arm exists for: arm 2 also returns without
    // suppressing anything, and the two must not be confusable. "I found no
    // policy" serves three places with `enabled: true`; "I could not read the
    // policy" serves nothing with `enabled: false` and a name. A route that
    // collapsed them would answer `enabled: true, objects: []` — which the
    // client reads as "this city is empty" and never re-fetches.
    const empty = await project({ rows: [] });
    assert.notEqual(
      r.body.enabled, empty.body.enabled,
      "unreadable and empty must not produce the same envelope",
    );
    assert.ok(empty.body.objects.length > 0 && r.body.objects.length === 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M133 — "Never place raw database rows directly on the map."
//
// The census's criterion is a production one: 2217 then 2201 applied and
// `map_projection_enabled` TRUE there, so `usedGateway` is true on a real
// device. THE ORDER IS THE REQUIREMENT, not an implementation detail — flipping
// 2201 before 2217 makes every request answer `protection_unreadable`, which is
// `enabled: false`, which is the legacy path, which is a blank map for anyone
// whose client had already committed to the gateway.
//
// What is testable here is the SERVER SIDE of the contract the client branches
// on, in both directions and in both orders:
//
//   flag TRUE  + policy readable  ⇒ enabled:true, objects, sources  ⇒ usedGateway
//   flag TRUE  + policy UNREADABLE⇒ enabled:false + refusal          ⇒ fallback
//   flag FALSE                    ⇒ enabled:false, no refusal       ⇒ fallback
//
// The middle row is the ordering constraint made executable: it is exactly the
// state a production flip-before-2217 would produce, and it must be the FALLBACK
// answer rather than a served-but-empty one. The client half — that `usedGateway`
// follows `enabled` and that the per-layer fetchers run only when it is false —
// is pinned structurally in src/test/gatewayBypassGuard.test.ts.
// ═════════════════════════════════════════════════════════════════════════════
describe("M133 — the gateway serves, or it stands aside; never blank", () => {
  async function project(over: Partial<FakeState>) {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    const app = await startRouterApp(
      mapProjectionRouter,
      { ...m179World({ rows: CURATED_ZONE_ROWS }), ...over } as FakeState,
      { token: M179_TOKEN, userId: M179_VIEWER },
    );
    try {
      return await app.projection(`bbox=${M179_BBOX}&zoom=16&kinds=place&limit=200`);
    } finally {
      await app.close();
    }
  }

  test("SERVING: flag TRUE and policy readable ⇒ enabled:true with objects and named sources", async () => {
    const r = await project({});
    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false);
    assert.ok(r.body.objects.length >= 1, "a serving gateway with matching rows must return objects");
    assert.ok(
      Array.isArray(r.body.sources) && r.body.sources.length >= 1,
      "`sources` names the layers the gateway READ. The client subtracts it from its enabled " +
        "layers to build `unreadLayers`; an empty list past a serving gateway would mark every " +
        "layer unread and present a full map as a broken one.",
    );
    assert.ok(r.body.sources.includes("places"), `expected the places source, got ${r.body.sources}`);

    // The three fields the client's `usedGateway` computation consumes, asserted
    // as a set rather than one at a time: `res.ok` (HTTP 200) AND
    // `res.data.enabled` are what set `gatewayObjects`, and `objects` is what it
    // is set TO. All three together are what makes usedGateway true.
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.objects));
  });

  test("ORDER CONSTRAINT: flag TRUE before 2217 ⇒ the FALLBACK answer, not a blank served one", async () => {
    // This is "flipping 2201 before 2217" reproduced exactly: the flag is on and
    // `protected_zones` does not exist.
    const r = await project({
      protected_zones: { error: { message: 'relation "public.protected_zones" does not exist', code: "42P01" } } as any,
    });
    assert.equal(r.body.enabled, false, "must NOT claim to be serving");
    assert.equal(r.body.refusal, "protection_unreadable", "and must name why, so an operator sees the flip did not take");
    assert.deepEqual(r.body.objects, []);
    // The distinction that keeps the map drawn: `enabled:false` sends the client
    // back to the per-layer path it was already on. `enabled:true, objects:[]`
    // would have told it "this city is empty" and it would never re-fetch.
    assert.notEqual(r.body.enabled, true);
  });

  test("ANTI-VACUITY: flag FALSE ⇒ enabled:false, no refusal, nothing served — the fallback runs", async () => {
    const r = await project({ feature_flags: [{ flag: "map_projection_enabled", enabled: false }] });
    assert.equal(r.body.enabled, false);
    assert.equal("refusal" in r.body, false, "a deliberate off switch is not a refusal");
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.sources, []);
    assert.equal(r.body.protection, null);
    assert.equal(r.body.viewport, null, "the flag-off envelope does not even echo the viewport");
  });

  test("ANTI-VACUITY: an absent flag ROW is off, not on — fail-closed, not fail-open", async () => {
    // Production has no `map_projection_enabled` row at all (2201 unapplied).
    // An unknown flag must read as FALSE; reading it as TRUE would serve the
    // gateway from a database that has never been told to.
    const r = await project({ feature_flags: [] });
    assert.equal(r.body.enabled, false);
    assert.deepEqual(r.body.objects, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M139 — the client must not reconstruct Portava intelligence rules.
//
// The census is explicit that "the guard is not the blocker and never was; it
// holds today", and that M139 turns red on the same flag flip as M133. So what
// this adds is the ANTI-VACUITY half the guard could not state about itself:
// that the projection a serving gateway returns is already normalised — carrying
// the privacy class, rendering priority and protection the client's own
// projectors would otherwise have to invent — so there is nothing left for
// `clientProjection.ts` to do on that path.
// ═════════════════════════════════════════════════════════════════════════════
describe("M139 — a served object needs no client-side normalisation", () => {
  test("every served object already carries what clientProjection would otherwise mint", async () => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    const app = await startRouterApp(mapProjectionRouter, m179World({ rows: CURATED_ZONE_ROWS }), {
      token: M179_TOKEN, userId: M179_VIEWER,
    });
    let body: any;
    try {
      body = (await app.projection(`bbox=${M179_BBOX}&zoom=16&kinds=place&limit=200`)).body;
    } finally {
      await app.close();
    }

    assert.equal(body.enabled, true);
    assert.ok(body.objects.length >= 1);
    for (const o of body.objects as any[]) {
      // These four are precisely what projectBuddy/projectTrip/projectFriend/
      // projectGemLocal/projectEventLocal exist to attach on the legacy path.
      // If a served object arrived without them the client WOULD have to
      // reconstruct, and §19 would be violated by omission rather than by a
      // rogue caller.
      assert.ok(typeof o.id === "string" && o.id.includes(":"), `served object has no namespaced id: ${o.id}`);
      assert.ok(typeof o.kind === "string", "served object has no kind");
      assert.ok(typeof o.privacyClass === "string", `served ${o.id} has no privacyClass — the client would have to guess one`);
      assert.ok(Number.isFinite(o.renderingPriority), `served ${o.id} has no renderingPriority — the client would have to rank it`);
      assert.ok(o.geometry && typeof o.geometry.type === "string", `served ${o.id} has no geometry`);
    }

    // And the gate ran: `protection` is the server's statement that §24 was
    // applied before serialization. A response without it is one the client
    // cannot tell apart from an ungated one.
    assert.notEqual(body.protection, null);
  });
});
