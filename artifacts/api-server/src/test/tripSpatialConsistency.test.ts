/**
 * Trips §7.4 — the three spatial consistency checks that are not travel feasibility.
 *
 * WHAT §7.4 ASKS FOR, AND WHAT THIS FILE PINS
 * ===========================================
 * Four checks, each with a failure example in the spec. Travel feasibility is
 * TripFeasibilityEngine. The other three are here, and the load-bearing
 * property across all of them is the same one §7 is built on, one layer up:
 *
 *   CONSISTENT / UNCHECKABLE / INCONSISTENT, and the middle one never
 *   collapses into the first.
 *
 * A plan whose stage has no dates cannot be shown to fall outside them. That is
 * not "it is fine". The tests below are mostly instances of that.
 *
 * The fourth check, route availability, is UNCHECKABLE by construction: there
 * is no transport-mode policy anywhere in either tree. It is EMITTED rather
 * than omitted, and one test exists purely to stop someone tidying it away —
 * a report covering three of four checks silently reads as clean on all four.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkStageLocality, checkPlaceIdentity, checkRouteAvailability,
  checkSpatialConsistency, foldConsistency, metresBetween,
  STAGE_LOCALITY_RADIUS_M, CONSISTENCY_VERDICTS, CONSISTENCY_REASONS,
  type PlanForConsistency, type StageForConsistency,
} from "../services/trips/TripSpatialConsistency.js";

const LISBON = { lat: 38.7223, lng: -9.1393 };
/** ~275 km from Lisbon — comfortably outside the locality radius. */
const PORTO = { lat: 41.1579, lng: -8.6291 };
/** ~25 km from Lisbon — inside it. */
const CASCAIS = { lat: 38.6979, lng: -9.4215 };

const plan = (o: Partial<PlanForConsistency> = {}): PlanForConsistency => ({
  id: "p1", stageId: "s1", startsAt: "2026-10-02T19:00:00Z", dayDate: null,
  locationName: null, placeId: null, lat: null, lng: null, ...o,
});
const stage = (o: Partial<StageForConsistency> = {}): StageForConsistency => ({
  id: "s1", startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-05T00:00:00Z",
  timezone: "Europe/Lisbon", anchor: LISBON, ...o,
});

const only = (fs: ReturnType<typeof checkStageLocality>, check: string) =>
  fs.filter((f) => f.check === check);

describe("§7.4 stage locality — time", () => {
  it("a plan inside its stage's dates produces no time finding", () => {
    const fs = only(checkStageLocality([plan({ lat: LISBON.lat, lng: LISBON.lng })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.deepEqual(fs, []);
  });

  it("a plan scheduled outside its stage's dates is INCONSISTENT", () => {
    // The §7.4 example: "Plan belongs to a stage whose location/timezone does
    // not contain it."
    const fs = only(checkStageLocality([plan({ startsAt: "2026-10-09T19:00:00Z" })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.equal(fs.length, 1);
    assert.equal(fs[0]!.verdict, "INCONSISTENT");
    assert.equal(fs[0]!.reason, "PLAN_OUTSIDE_STAGE_INTERVAL");
  });

  it("the boundary is INCLUSIVE at both ends", () => {
    const atStart = only(checkStageLocality([plan({ startsAt: "2026-10-01T00:00:00Z" })], [stage()]), "STAGE_LOCALITY_TIME");
    const atEnd = only(checkStageLocality([plan({ startsAt: "2026-10-05T00:00:00Z" })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.deepEqual(atStart, []);
    assert.deepEqual(atEnd, []);
    const justAfter = only(checkStageLocality([plan({ startsAt: "2026-10-05T00:00:01Z" })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.equal(justAfter[0]!.verdict, "INCONSISTENT");
  });

  it("a stage with NO dates is UNCHECKABLE, never consistent", () => {
    // Nothing can be shown to fall outside an interval that does not exist.
    const fs = only(
      checkStageLocality([plan()], [stage({ startsAt: null, endsAt: null })]),
      "STAGE_LOCALITY_TIME",
    );
    assert.equal(fs[0]!.verdict, "UNCHECKABLE");
    assert.equal(fs[0]!.reason, "STAGE_HAS_NO_INTERVAL");
  });

  it("a stage date that will not PARSE is UNCHECKABLE, not an open bound", () => {
    // Treating an unreadable date as "no limit" turns a data defect into
    // permission — the exact shape this pass exists to remove.
    const fs = only(
      checkStageLocality([plan({ startsAt: "2020-01-01T00:00:00Z" })], [stage({ startsAt: "not-a-date" })]),
      "STAGE_LOCALITY_TIME",
    );
    assert.equal(fs[0]!.verdict, "UNCHECKABLE");
  });

  it("an OPEN-ended stage bounds only the end it declares", () => {
    // A genuinely null bound is different from an unreadable one: it really is
    // open, and it is the caller who wrote null.
    const openEnd = only(
      checkStageLocality([plan({ startsAt: "2030-01-01T00:00:00Z" })], [stage({ endsAt: null })]),
      "STAGE_LOCALITY_TIME",
    );
    assert.deepEqual(openEnd, []);
    const beforeStart = only(
      checkStageLocality([plan({ startsAt: "2020-01-01T00:00:00Z" })], [stage({ endsAt: null })]),
      "STAGE_LOCALITY_TIME",
    );
    assert.equal(beforeStart[0]!.verdict, "INCONSISTENT");
  });

  it("a plan with NO time is UNCHECKABLE", () => {
    const fs = only(
      checkStageLocality([plan({ startsAt: null, dayDate: null })], [stage()]),
      "STAGE_LOCALITY_TIME",
    );
    assert.equal(fs[0]!.reason, "PLAN_HAS_NO_TIME");
  });

  it("a plan with only a DAY is checked against that day", () => {
    const inside = only(checkStageLocality([plan({ startsAt: null, dayDate: "2026-10-03" })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.deepEqual(inside, []);
    const outside = only(checkStageLocality([plan({ startsAt: null, dayDate: "2026-10-09" })], [stage()]), "STAGE_LOCALITY_TIME");
    assert.equal(outside[0]!.verdict, "INCONSISTENT");
  });

  it("a plan naming a stage that is not on this trip is UNCHECKABLE", () => {
    const fs = checkStageLocality([plan({ stageId: "s-elsewhere" })], [stage()]);
    assert.equal(fs.length, 1);
    assert.equal(fs[0]!.reason, "STAGE_NOT_FOUND");
    assert.equal(fs[0]!.verdict, "UNCHECKABLE");
  });

  it("a plan attached to NO stage produces nothing at all", () => {
    // There is nothing for it to be outside of. Not a finding, not an unknown.
    assert.deepEqual(checkStageLocality([plan({ stageId: null })], [stage()]), []);
  });
});

describe("§7.4 stage locality — place", () => {
  it("a plan near its stage's anchor produces no place finding", () => {
    const fs = only(
      checkStageLocality([plan({ lat: CASCAIS.lat, lng: CASCAIS.lng })], [stage({ anchor: LISBON })]),
      "STAGE_LOCALITY_PLACE",
    );
    assert.deepEqual(fs, []);
  });

  it("a plan far from its stage's anchor is INCONSISTENT and says how far", () => {
    const fs = only(
      checkStageLocality([plan({ lat: PORTO.lat, lng: PORTO.lng })], [stage({ anchor: LISBON })]),
      "STAGE_LOCALITY_PLACE",
    );
    assert.equal(fs[0]!.verdict, "INCONSISTENT");
    assert.equal(fs[0]!.reason, "PLAN_FAR_FROM_STAGE_ANCHOR");
    assert.match(fs[0]!.detail, /2\d\d km/);
  });

  it("a missing coordinate at EITHER end is UNCHECKABLE", () => {
    for (const [p, s] of [
      [plan({ lat: null, lng: null }), stage({ anchor: LISBON })],
      [plan({ lat: LISBON.lat, lng: LISBON.lng }), stage({ anchor: null })],
    ] as const) {
      const fs = only(checkStageLocality([p], [s]), "STAGE_LOCALITY_PLACE");
      assert.equal(fs[0]!.verdict, "UNCHECKABLE");
      assert.equal(fs[0]!.reason, "NO_COORDINATES");
    }
  });

  it("the Da Nang / Hoi An pair is deliberately NOT a locality finding", () => {
    // 30 km apart. §7.4 files that pair under travel FEASIBILITY, and flagging
    // it here too would report one problem as two.
    const daNang = { lat: 16.0544, lng: 108.2022 };
    const hoiAn = { lat: 15.8801, lng: 108.3380 };
    assert.ok(metresBetween(daNang, hoiAn) < STAGE_LOCALITY_RADIUS_M);
    const fs = only(
      checkStageLocality([plan({ lat: hoiAn.lat, lng: hoiAn.lng })], [stage({ anchor: daNang })]),
      "STAGE_LOCALITY_PLACE",
    );
    assert.deepEqual(fs, []);
  });

  it("time and place are reported SEPARATELY when both fail", () => {
    // They are fixed differently: the wrong day is a scheduling mistake, the
    // wrong city is an attachment mistake.
    const fs = checkStageLocality(
      [plan({ startsAt: "2026-10-09T19:00:00Z", lat: PORTO.lat, lng: PORTO.lng })],
      [stage({ anchor: LISBON })],
    );
    assert.equal(fs.length, 2);
    assert.deepEqual(fs.map((f) => f.check).sort(), ["STAGE_LOCALITY_PLACE", "STAGE_LOCALITY_TIME"]);
  });
});

describe("§7.4 place identity", () => {
  it("two plans sharing a name and disagreeing on place id is INCONSISTENT", () => {
    // The §7.4 example: "External booking and hidden gem share a name but not
    // canonical identity."
    const fs = checkPlaceIdentity([
      plan({ id: "a", locationName: "Time Out Market", placeId: "place-1" }),
      plan({ id: "b", locationName: "Time Out Market", placeId: "place-2" }),
    ]);
    const hit = fs.find((f) => f.verdict === "INCONSISTENT")!;
    assert.equal(hit.reason, "SAME_NAME_DIFFERENT_PLACE");
    assert.deepEqual(hit.planIds.sort(), ["a", "b"]);
  });

  it("two plans sharing a name AND a place id are consistent", () => {
    const fs = checkPlaceIdentity([
      plan({ id: "a", locationName: "Time Out Market", placeId: "place-1" }),
      plan({ id: "b", locationName: "Time Out Market", placeId: "place-1" }),
    ]);
    assert.deepEqual(fs.filter((f) => f.verdict === "INCONSISTENT"), []);
  });

  it("an UNRESOLVED plan is uncheckable, not a collision", () => {
    // "This plan has no canonical place" and "this plan points at a different
    // place" are different situations; reporting the first as the second would
    // bury the second in noise.
    const fs = checkPlaceIdentity([
      plan({ id: "a", locationName: "Cafe", placeId: "place-1" }),
      plan({ id: "b", locationName: "Cafe", placeId: null }),
    ]);
    assert.deepEqual(fs.filter((f) => f.verdict === "INCONSISTENT"), []);
    const unknown = fs.find((f) => f.verdict === "UNCHECKABLE")!;
    assert.deepEqual(unknown.planIds, ["b"]);
  });

  it("matching is case- and whitespace-insensitive, and a nameless plan collides with nothing", () => {
    const fs = checkPlaceIdentity([
      plan({ id: "a", locationName: "  Time Out Market ", placeId: "p1" }),
      plan({ id: "b", locationName: "time out market", placeId: "p2" }),
      plan({ id: "c", locationName: null, placeId: "p3" }),
      plan({ id: "d", locationName: "   ", placeId: "p4" }),
    ]);
    assert.equal(fs.filter((f) => f.verdict === "INCONSISTENT").length, 1);
    const hit = fs.find((f) => f.verdict === "INCONSISTENT")!;
    assert.deepEqual(hit.planIds.sort(), ["a", "b"]);
  });

  it("a single plan with a name is not a collision with itself", () => {
    assert.deepEqual(checkPlaceIdentity([plan({ locationName: "Cafe", placeId: "p1" })]), []);
  });
});

describe("§7.4 route availability — the check that cannot be run", () => {
  it("always emits exactly one UNCHECKABLE finding, and says why", () => {
    const fs = checkRouteAvailability();
    assert.equal(fs.length, 1);
    assert.equal(fs[0]!.verdict, "UNCHECKABLE");
    assert.equal(fs[0]!.reason, "NO_TRANSPORT_MODE_POLICY");
    assert.match(fs[0]!.detail, /transport modes/);
  });

  it("it is INCLUDED in the full check, not quietly dropped", () => {
    // A report covering three of §7.4's four checks reads as a clean bill of
    // health on all four. This test exists to stop it being tidied away.
    const fs = checkSpatialConsistency([], []);
    assert.equal(fs.filter((f) => f.check === "ROUTE_AVAILABILITY").length, 1);
  });

  it("so a trip can never fold to CONSISTENT today, and that is correct", () => {
    // One of the four checks cannot be run. A green verdict would claim
    // otherwise.
    assert.equal(foldConsistency(checkSpatialConsistency([], [])), "UNCHECKABLE");
  });
});

describe("§7.4 — the fold", () => {
  it("INCONSISTENT beats UNCHECKABLE beats CONSISTENT", () => {
    assert.deepEqual([...CONSISTENCY_VERDICTS], ["CONSISTENT", "UNCHECKABLE", "INCONSISTENT"]);
    const bad = checkSpatialConsistency(
      [plan({ startsAt: "2026-10-09T19:00:00Z", lat: LISBON.lat, lng: LISBON.lng })],
      [stage()],
    );
    assert.equal(foldConsistency(bad), "INCONSISTENT");
  });

  it("an EMPTY finding list is the only thing that folds to CONSISTENT", () => {
    assert.equal(foldConsistency([]), "CONSISTENT");
  });

  it("every declared reason is producible by some path", () => {
    const emitted = new Set<string>();
    const collect = (fs: Array<{ reason: string }>) => fs.forEach((f) => emitted.add(f.reason));
    collect(checkStageLocality([plan({ startsAt: "2026-10-09T19:00:00Z" })], [stage()]));
    collect(checkStageLocality([plan({ lat: PORTO.lat, lng: PORTO.lng })], [stage()]));
    collect(checkStageLocality([plan()], [stage({ startsAt: null, endsAt: null })]));
    collect(checkStageLocality([plan({ startsAt: null, dayDate: null })], [stage()]));
    collect(checkStageLocality([plan({ stageId: "gone" })], [stage()]));
    collect(checkPlaceIdentity([
      plan({ id: "a", locationName: "X", placeId: "p1" }),
      plan({ id: "b", locationName: "X", placeId: "p2" }),
    ]));
    collect(checkRouteAvailability());
    const missing = CONSISTENCY_REASONS.filter((r) => !emitted.has(r));
    assert.deepEqual(missing, [], `declared but unreachable: ${missing.join(", ")}`);
  });
});
