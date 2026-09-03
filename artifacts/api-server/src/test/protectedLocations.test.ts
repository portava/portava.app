/**
 * protectedLocations — Map spec §24, "Protected Location and Safety Rules".
 *
 * These tests pin the five properties the module exists to guarantee:
 *
 *   1. THE ACTION TABLE IS THE RIGHT WAY ROUND. A shelter is suppressed, not
 *      coarsened; a medical facility is coarsened, not deleted. Getting this
 *      backwards is the failure that matters, so it is asserted directly rather
 *      than implied by behaviour.
 *   2. FAIL-CLOSED EVERYWHERE. Unparseable object geometry, unparseable zone
 *      geometry and an unknown category all resolve to the MORE restrictive
 *      action. There is no input that turns a doubt into an `allow`.
 *   3. ONE-WAY PRECISION. Coarsening can only ever reduce precisionRank, for
 *      every privacy class crossed with every category.
 *   4. THE REPORT CANNOT RE-LEAK. Counts only — no zone id, no label, no
 *      category, no coordinates, no per-object reasons. A report naming what it
 *      hid would republish the thing it just hid.
 *   5. SAFETY OUTRANKS THE FILTER. A safety_notice survives the pass untouched
 *      and keeps RENDERING_PRIORITY.safety, per §24's "safety and access
 *      warnings take precedence".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AMBIENT_PRESENCE_KINDS,
  CATEGORY_ACTION,
  CATEGORY_PRIVACY_FLOOR,
  PROTECTED_CATEGORIES,
  PROTECTION_ACTIONS,
  PROTECTION_EXEMPT_KINDS,
  RELATIONSHIP_GATED_KINDS,
  actionRank,
  applyProtection,
  classifyAgainstProtected,
  coarsenForZone,
  geometryPositions,
  haversineMeters,
  mostRestrictiveAction,
  normalizeLng,
  resolveZonePolicy,
  zoneAnchor,
  zoneCovers,
  type ProtectedZone,
} from "../lib/protectedLocations.js";
import {
  PRIVACY_CLASSES,
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  SOURCE_CLASSES,
  point,
  precisionRank,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from "../lib/mapObjects.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Coordinates are arbitrary points in the ocean off nowhere. Nothing in this
// file names a real protected place — see the migration header for why.

const IN_LAT = 10.0;
const IN_LNG = 20.0;
const FAR_LAT = 40.0;
const FAR_LNG = 80.0;

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: "o1",
    kind: "place",
    geometry: point(IN_LAT, IN_LNG),
    title: "Something",
    privacyClass: "precise_temporary",
    renderingPriority: 40,
    ...over,
  };
}

function circleZone(over: Partial<ProtectedZone> = {}): ProtectedZone {
  return {
    id: "zone-secret-id-7f3a",
    category: "shelter",
    shape: "circle",
    center: { lat: IN_LAT, lng: IN_LNG },
    radiusMeters: 400,
    policyRef: "policy-doc-alpha",
    label: "Operator Only Label",
    jurisdiction: "XX-99",
    ...over,
  } as ProtectedZone;
}

/** ~0.02 deg square around (IN_LAT, IN_LNG), GeoJSON [lng, lat] order. */
function polygonZone(over: Partial<ProtectedZone> = {}): ProtectedZone {
  return {
    id: "zone-poly-1",
    category: "shelter",
    shape: "polygon",
    ring: [
      [IN_LNG - 0.01, IN_LAT - 0.01],
      [IN_LNG + 0.01, IN_LAT - 0.01],
      [IN_LNG + 0.01, IN_LAT + 0.01],
      [IN_LNG - 0.01, IN_LAT + 0.01],
      [IN_LNG - 0.01, IN_LAT - 0.01],
    ],
    policyRef: "policy-doc-beta",
    ...over,
  } as ProtectedZone;
}

// ── 1. The action table ──────────────────────────────────────────────────────

describe("§24 category → action table", () => {
  it("covers every example the spec names, plus the policy escape hatch", () => {
    for (const c of [
      "private_residence",
      "medical_facility",
      "shelter",
      "sensitive_government",
      "policy_defined",
    ]) {
      assert.ok(
        (PROTECTED_CATEGORIES as readonly string[]).includes(c),
        `${c} must be a protected category`,
      );
    }
  });

  it("suppresses the categories whose EXISTENCE is the disclosure", () => {
    // A shelter's address is its protection; a private residence is the
    // doxxing vector; a sensitive government site may be unlawful to publish.
    // For all three, a coarse pin is still a pin.
    assert.equal(CATEGORY_ACTION.shelter, "suppress");
    assert.equal(CATEGORY_ACTION.private_residence, "suppress");
    assert.equal(CATEGORY_ACTION.sensitive_government, "suppress");
    // policy_defined has no inherent default, so it defaults to the strong side.
    assert.equal(CATEGORY_ACTION.policy_defined, "suppress");
  });

  it("only coarsens the category that is public knowledge and safety-relevant", () => {
    // Deleting hospitals from the map would break wayfinding in an emergency,
    // which §24's own precedence sentence forbids.
    assert.equal(CATEGORY_ACTION.medical_facility, "coarsen");
  });

  it("gives every category an action and a privacy floor", () => {
    for (const c of PROTECTED_CATEGORIES) {
      assert.ok((PROTECTION_ACTIONS as readonly string[]).includes(CATEGORY_ACTION[c]));
      assert.ok((PRIVACY_CLASSES as readonly string[]).includes(CATEGORY_PRIVACY_FLOOR[c]));
    }
  });

  it("floors suppress-class categories at the unservable rung as defence in depth", () => {
    for (const c of PROTECTED_CATEGORIES) {
      if (CATEGORY_ACTION[c] === "suppress" && c !== "policy_defined") {
        assert.equal(CATEGORY_PRIVACY_FLOOR[c], "none");
      }
    }
  });

  it("mostRestrictiveAction never moves down the ladder", () => {
    for (const a of PROTECTION_ACTIONS) {
      for (const b of PROTECTION_ACTIONS) {
        const r = mostRestrictiveAction(a, b);
        assert.ok(actionRank(r) >= actionRank(a));
        assert.ok(actionRank(r) >= actionRank(b));
      }
    }
  });
});

// ── 2. Zone policy resolution ────────────────────────────────────────────────

describe("zone policy resolution", () => {
  it("lets a known category's row TIGHTEN but never loosen", () => {
    const loosened = resolveZonePolicy(
      circleZone({ category: "medical_facility", action: "allow" } as Partial<ProtectedZone>),
    );
    assert.equal(loosened.action, "coarsen", "'allow' on a known category is inert");

    const tightened = resolveZonePolicy(
      circleZone({ category: "medical_facility", action: "suppress" } as Partial<ProtectedZone>),
    );
    assert.equal(tightened.action, "suppress");
  });

  it("takes a policy_defined row's action as written — it IS the policy", () => {
    assert.equal(
      resolveZonePolicy(
        circleZone({ category: "policy_defined", action: "coarsen" } as Partial<ProtectedZone>),
      ).action,
      "coarsen",
    );
  });

  it("suppresses a policy_defined row that declares no action", () => {
    assert.equal(
      resolveZonePolicy(circleZone({ category: "policy_defined" } as Partial<ProtectedZone>)).action,
      "suppress",
    );
  });

  it("suppresses an unknown category rather than ignoring it", () => {
    const p = resolveZonePolicy(
      circleZone({ category: "municipal_something_new" } as unknown as Partial<ProtectedZone>),
    );
    assert.equal(p.action, "suppress");
    assert.equal(p.unknownCategory, true);
    assert.equal(p.privacyFloor, "none");
  });

  it("lets a row's privacyFloor tighten but not loosen the category floor", () => {
    const tighter = resolveZonePolicy(
      circleZone({
        category: "medical_facility",
        privacyFloor: "aggregate_only",
      } as Partial<ProtectedZone>),
    );
    assert.equal(tighter.privacyFloor, "aggregate_only");

    const looser = resolveZonePolicy(
      circleZone({
        category: "medical_facility",
        privacyFloor: "precise_temporary",
      } as Partial<ProtectedZone>),
    );
    assert.equal(looser.privacyFloor, "approximate", "a row cannot buy back precision");
  });
});

// ── 3. Geometry ──────────────────────────────────────────────────────────────

describe("geometry", () => {
  it("normalizes longitude into [-180, 180)", () => {
    assert.equal(normalizeLng(190), -170);
    assert.equal(normalizeLng(-190), 170);
    assert.equal(normalizeLng(20), 20);
  });

  it("haversine agrees with a known one-degree-of-latitude distance", () => {
    const m = haversineMeters(0, 0, 1, 0);
    assert.ok(Math.abs(m - 111_195) < 500, `got ${m}`);
  });

  it("returns null for geometry with no usable position", () => {
    assert.equal(geometryPositions(null), null);
    assert.equal(geometryPositions({ type: "Point", coordinates: [NaN, NaN] } as never), null);
    assert.equal(geometryPositions({ type: "Polygon", coordinates: [] } as never), null);
  });

  it("includes every vertex, so an edge inside a zone counts as inside", () => {
    const positions = geometryPositions({
      type: "Polygon",
      coordinates: [
        [
          [IN_LNG, IN_LAT],
          [FAR_LNG, FAR_LAT],
          [FAR_LNG + 1, FAR_LAT + 1],
          [IN_LNG, IN_LAT],
        ],
      ],
    });
    assert.ok(positions);
    // The centroid of that triangle is nowhere near the zone, but one vertex is.
    assert.equal(zoneCovers(circleZone(), positions!), true);
  });

  it("covers points inside a circle and not outside it", () => {
    assert.equal(zoneCovers(circleZone(), [[IN_LNG, IN_LAT]]), true);
    assert.equal(zoneCovers(circleZone(), [[FAR_LNG, FAR_LAT]]), false);
    // 400 m radius: ~0.02 deg of latitude is ~2.2 km away.
    assert.equal(zoneCovers(circleZone(), [[IN_LNG, IN_LAT + 0.02]]), false);
  });

  it("covers points inside a polygon and not outside it", () => {
    assert.equal(zoneCovers(polygonZone(), [[IN_LNG, IN_LAT]]), true);
    assert.equal(zoneCovers(polygonZone(), [[IN_LNG + 0.5, IN_LAT]]), false);
  });

  it("returns 'unknown' — never false — for an unusable zone row", () => {
    const cases: unknown[] = [
      circleZone({ radiusMeters: 0 } as Partial<ProtectedZone>),
      circleZone({ radiusMeters: Number.NaN } as Partial<ProtectedZone>),
      circleZone({ center: { lat: Number.NaN, lng: 1 } } as unknown as Partial<ProtectedZone>),
      polygonZone({ ring: [[0, 0]] } as unknown as Partial<ProtectedZone>),
      polygonZone({ ring: "not a ring" } as unknown as Partial<ProtectedZone>),
      { id: "z", category: "shelter", shape: "blob" },
      null,
    ];
    for (const z of cases) {
      assert.equal(
        zoneCovers(z as ProtectedZone, [[FAR_LNG, FAR_LAT]]),
        "unknown",
        `unusable zone must be 'unknown', not false: ${JSON.stringify(z)}`,
      );
    }
  });

  it("refuses a ring spanning more than 180 degrees rather than answering wrongly", () => {
    const wrapping = polygonZone({
      ring: [
        [-170, 10],
        [170, 10],
        [170, 11],
        [-170, 11],
        [-170, 10],
      ],
    } as unknown as Partial<ProtectedZone>);
    assert.equal(zoneCovers(wrapping, [[0, 10.5]]), "unknown");
  });

  it("anchors a circle at its centre and a polygon at its ring centroid", () => {
    assert.deepEqual(zoneAnchor(circleZone()), { lat: IN_LAT, lng: IN_LNG });
    const a = zoneAnchor(polygonZone());
    assert.ok(a);
    assert.ok(Math.abs(a!.lat - IN_LAT) < 0.02);
    assert.ok(Math.abs(a!.lng - IN_LNG) < 0.02);
  });
});

// ── 4. Classification ────────────────────────────────────────────────────────

describe("classifyAgainstProtected", () => {
  it("allows an object with no zones at all", () => {
    const d = classifyAgainstProtected(obj(), []);
    assert.equal(d.action, "allow");
    assert.equal(d.reason, "no_zone_match");
  });

  it("allows an object outside every zone", () => {
    const d = classifyAgainstProtected(obj({ geometry: point(FAR_LAT, FAR_LNG) }), [circleZone()]);
    assert.equal(d.action, "allow");
  });

  it("suppresses an object standing in a shelter zone", () => {
    const d = classifyAgainstProtected(obj(), [circleZone()]);
    assert.equal(d.action, "suppress");
    assert.equal(d.reason, "inside_protected_zone");
  });

  it("coarsens — does not delete — an object at a medical facility", () => {
    const d = classifyAgainstProtected(obj(), [
      circleZone({ category: "medical_facility" } as Partial<ProtectedZone>),
    ]);
    assert.equal(d.action, "coarsen");
    assert.equal(d.privacyFloor, "approximate");
  });

  it("escalates AMBIENT presence inside a coarsen zone to suppression", () => {
    // "Someone is at the clinic" survives any amount of coordinate blurring, so
    // for these kinds the association IS the disclosure.
    for (const kind of AMBIENT_PRESENCE_KINDS) {
      const d = classifyAgainstProtected(obj({ kind }), [
        circleZone({ category: "medical_facility" } as Partial<ProtectedZone>),
      ]);
      assert.equal(d.action, "suppress", `${kind} must escalate`);
      assert.equal(d.reason, "presence_in_protected_zone");
    }
  });

  it("does NOT escalate relationship-gated kinds — that would break 'find my crew'", () => {
    for (const kind of RELATIONSHIP_GATED_KINDS) {
      const d = classifyAgainstProtected(obj({ kind }), [
        circleZone({ category: "medical_facility" } as Partial<ProtectedZone>),
      ]);
      assert.equal(d.action, "coarsen", `${kind} must not escalate`);
    }
  });

  it("takes the most restrictive action across overlapping zones", () => {
    const d = classifyAgainstProtected(obj(), [
      circleZone({ id: "z-med", category: "medical_facility" } as Partial<ProtectedZone>),
      circleZone({ id: "z-shelter", category: "shelter" } as Partial<ProtectedZone>),
    ]);
    assert.equal(d.action, "suppress");
  });

  it("hands the winning zone back to the SERVER caller (and only to it)", () => {
    const d = classifyAgainstProtected(obj(), [circleZone()]);
    assert.equal(d.zone?.id, "zone-secret-id-7f3a");
  });

  describe("fail-closed", () => {
    it("suppresses an object whose geometry cannot be parsed", () => {
      const d = classifyAgainstProtected(
        obj({ geometry: { type: "Point", coordinates: [Number.NaN, Number.NaN] } }),
        [circleZone({ center: { lat: FAR_LAT, lng: FAR_LNG } } as Partial<ProtectedZone>)],
      );
      assert.equal(d.action, "suppress");
      assert.equal(d.reason, "unparseable_object_geometry");
    });

    it("suppresses a null/garbage object", () => {
      assert.equal(classifyAgainstProtected(null, [circleZone()]).action, "suppress");
      assert.equal(
        classifyAgainstProtected("nope" as unknown as MapObject, [circleZone()]).action,
        "suppress",
      );
    });

    it("suppresses when a zone row is unusable, instead of skipping the row", () => {
      // The object is on the other side of the planet from the (broken) zone.
      // A skipped row would allow it; that is how a malformed shelter row
      // silently stops protecting anything.
      const d = classifyAgainstProtected(obj({ geometry: point(FAR_LAT, FAR_LNG) }), [
        circleZone({ radiusMeters: Number.NaN } as Partial<ProtectedZone>),
      ]);
      assert.equal(d.action, "suppress");
      assert.equal(d.reason, "unparseable_zone_geometry");
    });

    it("suppresses an unknown category rather than allowing it", () => {
      const d = classifyAgainstProtected(obj(), [
        circleZone({ category: "brand_new_kind_of_place" } as unknown as Partial<ProtectedZone>),
      ]);
      assert.equal(d.action, "suppress");
      assert.equal(d.reason, "unknown_zone_category");
    });

    it("never returns 'allow' from any doubtful input", () => {
      const doubtful: (MapObject | null)[] = [
        null,
        obj({ geometry: { type: "Point", coordinates: [Number.NaN, 0] } }),
        obj({ geometry: { type: "Polygon", coordinates: [] } }),
      ];
      for (const o of doubtful) {
        assert.notEqual(classifyAgainstProtected(o, [circleZone()]).action, "allow");
      }
    });
  });
});

// ── 5. Safety precedence (§24) ───────────────────────────────────────────────

describe("safety and access warnings take precedence", () => {
  const notice = obj({
    id: "warn-1",
    kind: "safety_notice",
    title: "Flooding reported",
    renderingPriority: RENDERING_PRIORITY.safety,
  });

  it("exempts safety_notice, and only safety_notice", () => {
    assert.deepEqual([...PROTECTION_EXEMPT_KINDS], ["safety_notice"]);
  });

  it("survives a suppress-class zone it stands inside", () => {
    const d = classifyAgainstProtected(notice, [circleZone()]);
    assert.equal(d.action, "allow");
    assert.equal(d.reason, "safety_notice_exempt");
  });

  it("keeps its priority and geometry through applyProtection", () => {
    const { objects, report } = applyProtection([notice], [circleZone()]);
    assert.equal(objects.length, 1);
    assert.equal(objects[0].renderingPriority, RENDERING_PRIORITY.safety);
    assert.deepEqual(objects[0].geometry, notice.geometry);
    assert.equal(objects[0], notice, "an allowed object is passed through by reference");
    assert.equal(report.safetyExempt, 1);
    assert.equal(report.suppressed, 0);
  });

  it("outranks a normal object suppressed by the same zone", () => {
    const { objects } = applyProtection([obj({ id: "hidden" }), notice], [circleZone()]);
    assert.deepEqual(
      objects.map((o) => o.id),
      ["warn-1"],
    );
  });

  it("survives even an unusable zone row", () => {
    const { objects } = applyProtection(
      [notice],
      [circleZone({ radiusMeters: -1 } as Partial<ProtectedZone>)],
    );
    assert.equal(objects.length, 1);
  });
});

// ── 6. Coarsening is monotone ────────────────────────────────────────────────

describe("coarsening only ever reduces precision", () => {
  it("never raises precisionRank, for every class × every category", () => {
    for (const cls of PRIVACY_CLASSES) {
      for (const cat of PROTECTED_CATEGORIES) {
        const before = obj({ privacyClass: cls as PrivacyClass });
        const after = coarsenForZone(before, CATEGORY_PRIVACY_FLOOR[cat], circleZone());
        assert.ok(
          precisionRank(after.privacyClass) <= precisionRank(before.privacyClass),
          `${cls} × ${cat}: ${before.privacyClass} → ${after.privacyClass} raised precision`,
        );
      }
    }
  });

  it("caps a precise object at the medical-facility floor", () => {
    const after = coarsenForZone(obj({ privacyClass: "precise_temporary" }), "approximate");
    assert.equal(after.privacyClass, "approximate");
  });

  it("leaves an already-narrower class alone", () => {
    const after = coarsenForZone(obj({ privacyClass: "aggregate_only" }), "approximate");
    assert.equal(after.privacyClass, "aggregate_only");
  });

  it("snaps a Point to the zone anchor, so the wire carries the zone's precision", () => {
    const zone = circleZone({ category: "medical_facility" } as Partial<ProtectedZone>);
    const before = obj({ geometry: point(IN_LAT + 0.001, IN_LNG + 0.001) });
    const after = coarsenForZone(before, "approximate", zone);
    assert.deepEqual(after.geometry, { type: "Point", coordinates: [IN_LNG, IN_LAT] });
  });

  it("drops live signals, back-references and distance", () => {
    const before = obj({
      activity: "busy",
      trend: "getting_busier",
      sourceClass: "verified_firsthand",
      count: 12,
      freshness: "live",
      observedAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-08-31T01:00:00.000Z",
      sourceRefs: ["obs-1", "obs-2"],
      provenance: { lines: [{ text: "3 travelers confirmed", ref: "snap-1" }], confidence: "high" },
      distanceKm: 0.4,
    });
    const after = coarsenForZone(before, "approximate", circleZone());
    for (const k of [
      "activity",
      "trend",
      "sourceClass",
      "count",
      "freshness",
      "observedAt",
      "expiresAt",
      "sourceRefs",
      "provenance",
    ]) {
      assert.equal((after as Record<string, unknown>)[k], undefined, `${k} must be dropped`);
    }
    assert.equal(after.distanceKm, null);
  });

  /**
   * THE LOAD-BEARING ONE.
   *
   * `sourceClass` is an epistemic label, so it is tempting to file it with the
   * harmless metadata. It is not harmless. `verified_firsthand` means "a
   * presence-verified person observed this place", and that survives the removal
   * of the coordinate, every timestamp, the freshness, the provenance and every
   * back-reference. A coarsened medical-facility pin that still carried it would
   * publish exactly the §24 fact — someone is here right now — with all the
   * supporting detail stripped and the disclosure intact.
   *
   * The assertion is on the SERIALIZED BYTES rather than on a property read,
   * because a property read of `undefined` cannot distinguish "deleted" from
   * "present and undefined", and only the former is actually absent from the
   * wire in every serializer. The sentinel is a string that cannot occur
   * anywhere else in this object, so a hit is unambiguous.
   *
   * MUTATION PROOF: deleting the `delete out.sourceClass` line in
   * lib/protectedLocations must fail this test.
   */
  it("§24: a coarsened object carries NO sourceClass — proven on the serialized bytes", () => {
    const SENTINEL = "SENTINEL_SOURCE_CLASS_7f3a";
    const before = obj({
      sourceClass: SENTINEL as unknown as MapObject["sourceClass"],
      activity: "busy",
      freshness: "live",
      observedAt: "2026-08-31T00:00:00.000Z",
    });
    const after = coarsenForZone(
      before,
      "approximate",
      circleZone({ category: "medical_facility" } as Partial<ProtectedZone>),
    );

    const wire = JSON.stringify(after);
    assert.ok(
      !wire.includes(SENTINEL),
      `the source class survived coarsening and reached the wire: ${wire}`,
    );
    assert.ok(
      !wire.includes("sourceClass"),
      `the attribution key survived coarsening: ${wire}`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(after, "sourceClass"),
      false,
      "the key must be deleted, not merely set to undefined",
    );

    // The input is a caller's object and must come back untouched, or the gate
    // would be corrupting the very list it is filtering.
    assert.equal(before.sourceClass as unknown as string, SENTINEL);
  });

  it("§24: a real class is stripped for every source class the wire declares", () => {
    for (const cls of SOURCE_CLASSES) {
      const after = coarsenForZone(obj({ sourceClass: cls }), "approximate", circleZone());
      assert.equal(after.sourceClass, undefined, `${cls} survived coarsening`);
      assert.ok(!JSON.stringify(after).includes(cls), `${cls} appeared in the serialized object`);
    }
  });

  it("never mutates the input object", () => {
    const before = obj({ activity: "busy", distanceKm: 0.4 });
    const snapshot = JSON.parse(JSON.stringify(before));
    coarsenForZone(before, "approximate", circleZone());
    assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot);
  });
});

// ── 7. applyProtection ───────────────────────────────────────────────────────

describe("applyProtection", () => {
  it("is an identity pass when no zones are configured", () => {
    const input = [obj({ id: "a" }), obj({ id: "b", kind: "event" })];
    const { objects, report } = applyProtection(input, []);
    assert.deepEqual(objects, input);
    assert.equal(report.evaluated, 2);
    assert.equal(report.allowed, 2);
    assert.equal(report.suppressed, 0);
    assert.equal(report.coarsened, 0);
  });

  it("conserves every input object across the four buckets", () => {
    const zones = [
      circleZone({ id: "z-shelter" } as Partial<ProtectedZone>),
      circleZone({
        id: "z-med",
        category: "medical_facility",
        center: { lat: FAR_LAT, lng: FAR_LNG },
        radiusMeters: 800,
      } as Partial<ProtectedZone>),
    ];
    const input = [
      obj({ id: "in-shelter" }),
      obj({ id: "at-clinic", geometry: point(FAR_LAT, FAR_LNG) }),
      obj({ id: "elsewhere", geometry: point(-30, -60) }),
      obj({ id: "warn", kind: "safety_notice" }),
      obj({ id: "broken", geometry: { type: "Point", coordinates: [Number.NaN, 0] } }),
    ];
    const { objects, report } = applyProtection(input, zones);

    assert.equal(report.evaluated, input.length);
    assert.equal(
      report.allowed + report.coarsened + report.suppressed + report.safetyExempt,
      report.evaluated,
      "conservation: nothing may vanish unaccounted for",
    );
    assert.equal(objects.length, report.allowed + report.coarsened + report.safetyExempt);

    assert.deepEqual(
      objects.map((o) => o.id).sort(),
      ["at-clinic", "elsewhere", "warn"],
      "in-shelter and broken are withheld",
    );
    assert.equal(report.suppressed, 2);
    assert.equal(report.coarsened, 1);
    assert.equal(report.safetyExempt, 1);
    assert.equal(report.allowed, 1);
  });

  it("preserves relative order, so an upstream ranking survives", () => {
    const input = [obj({ id: "a" }), obj({ id: "b" }), obj({ id: "c" })].map((o, i) => ({
      ...o,
      geometry: point(-30 - i, -60),
    }));
    const { objects } = applyProtection(input, [circleZone()]);
    assert.deepEqual(
      objects.map((o) => o.id),
      ["a", "b", "c"],
    );
  });

  it("suppresses everything servable when the policy set is unusable", () => {
    const input = [obj({ id: "a" }), obj({ id: "b", geometry: point(FAR_LAT, FAR_LNG) })];
    const { objects, report } = applyProtection(input, [
      circleZone({ ring: undefined, radiusMeters: Number.NaN } as Partial<ProtectedZone>),
    ]);
    assert.deepEqual(objects, []);
    assert.equal(report.suppressed, 2);
  });

  it("withholds rather than emits if coarsening lands below the servable line", () => {
    // A policy_defined row that asks to coarsen with a 'none' floor produces an
    // object isServable() refuses. The two boundaries must not disagree.
    const zone = circleZone({
      category: "policy_defined",
      action: "coarsen",
      privacyFloor: "none",
    } as Partial<ProtectedZone>);
    const { objects, report } = applyProtection([obj()], [zone]);
    assert.deepEqual(objects, []);
    assert.equal(report.suppressed, 1);
    assert.equal(report.coarsened, 0);
  });

  it("fails closed on a non-array input", () => {
    const { objects, report } = applyProtection(null, [circleZone()]);
    assert.deepEqual(objects, []);
    assert.equal(report.evaluated, 0);
  });

  it("does not mutate the input array or its objects", () => {
    const input = [obj({ id: "a", activity: "busy" })];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyProtection(input, [circleZone({ category: "medical_facility" } as Partial<ProtectedZone>)]);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  });
});

// ── 8. The report cannot re-leak what it hid ─────────────────────────────────

describe("the suppression report is COUNTS ONLY", () => {
  const zones: ProtectedZone[] = [
    circleZone({
      id: "zone-secret-id-7f3a",
      label: "Refuge House Operator Label",
      policyRef: "policy-doc-alpha",
      jurisdiction: "XX-99",
    } as Partial<ProtectedZone>),
  ];
  const input = [obj({ id: "in-shelter" }), obj({ id: "far", geometry: point(-30, -60) })];

  it("exposes exactly five numeric keys and nothing else", () => {
    const { report } = applyProtection(input, zones);
    assert.deepEqual(Object.keys(report).sort(), [
      "allowed",
      "coarsened",
      "evaluated",
      "safetyExempt",
      "suppressed",
    ]);
    for (const [k, v] of Object.entries(report)) {
      assert.equal(typeof v, "number", `${k} must be a number, not a descriptor`);
    }
  });

  it("names no zone, no category, no policy and no coordinate", () => {
    const { report } = applyProtection(input, zones);
    const serialized = JSON.stringify(report);
    for (const secret of [
      "zone-secret-id-7f3a",
      "Refuge House Operator Label",
      "policy-doc-alpha",
      "XX-99",
      "shelter",
      "circle",
      String(IN_LAT),
      String(IN_LNG),
      "in-shelter",
      "inside_protected_zone",
    ]) {
      assert.ok(
        !serialized.includes(secret),
        `report re-leaked ${secret}: ${serialized}`,
      );
    }
  });

  it("carries no category histogram — a per-category count is itself a leak", () => {
    // "1 shelter suppressed" inside a client-chosen viewport is a location
    // disclosure with extra steps: the viewport bounds it, the category names
    // it. So the breakdown does not exist, only the total.
    const { report } = applyProtection(input, zones);
    const keys = Object.keys(report);
    for (const c of PROTECTED_CATEGORIES) {
      assert.ok(!keys.some((k) => k.toLowerCase().includes(c.split("_")[0])));
    }
  });

  it("reports the same shape whether or not anything was hidden", () => {
    // A silent shrink is indistinguishable from an empty city, so the count
    // must always be present — it is the one deliberate, minimal disclosure.
    const hidden = applyProtection(input, zones).report;
    const clean = applyProtection(input, []).report;
    assert.deepEqual(Object.keys(hidden).sort(), Object.keys(clean).sort());
    assert.equal(hidden.suppressed, 1);
    assert.equal(clean.suppressed, 0);
  });

  it("the decision — not the report — is where the zone lives", () => {
    // The route needs the zone to make a decision; the client must never see
    // it. This asserts the split is deliberate rather than accidental.
    const decision = classifyAgainstProtected(input[0], zones);
    assert.ok(decision.zone, "server-side decision carries the zone");
    const { report } = applyProtection(input, zones);
    assert.ok(!("zone" in report));
    assert.ok(!("reason" in report));
  });
});

// ── 9. Kind coverage ─────────────────────────────────────────────────────────

describe("kind policy is disjoint and deliberate", () => {
  it("no kind is both ambient-presence and relationship-gated", () => {
    for (const k of AMBIENT_PRESENCE_KINDS) {
      assert.ok(!RELATIONSHIP_GATED_KINDS.includes(k), `${k} declared twice`);
    }
  });

  it("no exempt kind is also escalated", () => {
    for (const k of PROTECTION_EXEMPT_KINDS) {
      assert.ok(!AMBIENT_PRESENCE_KINDS.includes(k as MapObjectKind));
    }
  });
});

// ── Coarsening must reset the rank it never touched ──────────────────────────
//
// coarsenForZone deletes activity, trend, sourceClass, count, provenance,
// sourceRefs and the timestamps — precisely because each of them betrays that
// someone is there right now. It did not touch renderingPriority.
//
// applyLiveClaims promotes a place with qualifying live evidence to
// RENDERING_PRIORITY.high_confidence_live_zone, so a coarsened protected place
// kept OUTRANKING its neighbours. A protected location that sorts above
// everything around it IS the disclosure, whatever its payload says — the same
// signal, delivered through §31 instead of through a field.
//
// It is RESET rather than deleted: renderingPriority is required on a
// MapObject, so the object still renders, in the position an uncorroborated
// object of its kind would occupy.
describe("§24 — a coarsened object does not keep a live rank", () => {
  it("loses a high-confidence-live promotion", () => {
    const promoted = { ...obj({ id: "promoted" }), renderingPriority: RENDERING_PRIORITY.high_confidence_live_zone };
    assert.ok(
      promoted.renderingPriority > KIND_DEFAULT_PRIORITY[promoted.kind],
      "precondition: it must actually be promoted, or this test proves nothing",
    );
    const { objects } = applyProtection([promoted], [circleZone({ category: "medical_facility" })]);
    const out = objects.find((o) => o.id === "promoted");
    assert.ok(out, "the object should be coarsened, not suppressed");
    assert.equal(
      out.renderingPriority,
      KIND_DEFAULT_PRIORITY[out.kind],
      "a coarsened protected object must rank as an ordinary one of its kind",
    );
  });

  it("still renders — the rank is reset, not removed", () => {
    const promoted = { ...obj({ id: "p2" }), renderingPriority: RENDERING_PRIORITY.high_confidence_live_zone };
    const { objects } = applyProtection([promoted], [circleZone({ category: "medical_facility" })]);
    const out = objects.find((o) => o.id === "p2");
    assert.equal(typeof out.renderingPriority, "number");
    assert.ok(out.renderingPriority > 0);
  });
});

