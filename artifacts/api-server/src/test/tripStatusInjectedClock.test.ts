/**
 * tripStatusInjectedClock — `computeTripStatus` must answer the clock it is
 * GIVEN, not the one on the wall.
 *
 * Run: node --import tsx/esm --test src/test/tripStatusInjectedClock.test.ts
 *
 * HOW THIS WAS FOUND, AND WHY IT IS WORTH A FILE
 * ==============================================
 * `tripHealthProjection.test.ts` pins `now` at 2026-09-13T12:00Z and asserts the
 * trip it built — `end_date 2026-09-15`, timezone `Europe/Paris` — reads
 * `tripStatus: "active"`. It passed for three days and then went RED, in 17
 * places at once, at 22:00 UTC on 2026-09-15: midnight in Paris, the moment the
 * REAL date moved past the fixture's end date. The injected clock had nothing to
 * do with it.
 *
 * `buildTripHealthProjection` threads its `now` into `liveEnvelope`, into
 * `buildTripFreedomProjection`, into `operationalState` and into the phase
 * inputs — into every clock read but ONE. `computeTripStatus` took no `now` at
 * all, so one projection answered from two different clocks, and the field that
 * says whether a trip is over was the one that drifted.
 *
 * `todayInTimezone`'s own header already argued the fix: *"`now` is a parameter
 * and not a hidden `new Date()` because a function whose answer depends on the
 * wall clock cannot be tested at the boundary that matters."* It got the
 * parameter; the function that calls it did not.
 *
 * WHY A FAILING FIXTURE IS NOT ENOUGH ON ITS OWN. The case that went red would
 * go green again on its own if the fixture dates were bumped, and it would be
 * armed to detonate on the next date. Every case below fixes BOTH clocks — the
 * fixture's dates and the `now` it is asked about — so none of them can pass or
 * fail because of what day it is when they run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTripStatus, todayInTimezone } from "../domain/trips/invariants/tripStatus.js";

const PARIS = "Europe/Paris";
const trip = (start: string | null, end: string | null, now: Date, tz: string | null = PARIS) =>
  computeTripStatus("Paris", "Paris", start, end, "active", tz, now);

describe("computeTripStatus — the injected clock", () => {
  it("C1 — a trip is ACTIVE on its last day, asked about from inside that day", () => {
    assert.equal(trip("2026-09-12", "2026-09-15", new Date("2026-09-13T12:00:00.000Z")), "active");
    assert.equal(trip("2026-09-12", "2026-09-15", new Date("2026-09-15T12:00:00.000Z")), "active");
  });

  it("C2 — and COMPLETED once the injected clock passes it, in the trip's own zone", () => {
    assert.equal(trip("2026-09-12", "2026-09-15", new Date("2026-09-16T12:00:00.000Z")), "completed");
  });

  it("C3 — UPCOMING before the start, from the injected clock", () => {
    assert.equal(trip("2026-09-12", "2026-09-15", new Date("2026-09-01T12:00:00.000Z")), "upcoming");
  });

  it("C4 — the boundary the timezone decides, which is the case a wall clock cannot reach", () => {
    // 22:30 UTC on the end date is already the 16th in Paris and still the 15th
    // in UTC. The same instant, the same trip, two answers — and only the zone
    // may decide which. This is the exact hour that detonated the fixture.
    const instant = new Date("2026-09-15T22:30:00.000Z");
    assert.equal(todayInTimezone(PARIS, instant), "2026-09-16");
    assert.equal(todayInTimezone("UTC", instant), "2026-09-15");
    assert.equal(trip("2026-09-12", "2026-09-15", instant, PARIS), "completed");
    assert.equal(trip("2026-09-12", "2026-09-15", instant, "UTC"), "active");
  });

  it("C5 — an omitted `now` still means the wall clock, so no existing caller changes", () => {
    // The parameter is additive. Called without it, the answer is whatever the
    // real date gives, which is what every call site outside this file gets —
    // and it agrees with passing `new Date()` explicitly.
    const today = new Date();
    assert.equal(
      computeTripStatus("Paris", "Paris", "2026-09-12", "2026-09-15", "active", PARIS),
      computeTripStatus("Paris", "Paris", "2026-09-12", "2026-09-15", "active", PARIS, today),
    );
    assert.equal(todayInTimezone(PARIS), todayInTimezone(PARIS, today));
  });

  it("C6 — terminal and draft states are decided before any clock is read", () => {
    const far = new Date("2099-01-01T00:00:00.000Z");
    assert.equal(computeTripStatus("Paris", "Paris", "2026-09-12", "2026-09-15", "cancelled", PARIS, far), "cancelled");
    assert.equal(computeTripStatus("Paris", "Paris", "2026-09-12", "2026-09-15", "archived", PARIS, far), "archived");
    assert.equal(computeTripStatus(null, "Paris", "2026-09-12", "2026-09-15", "active", PARIS, far), "draft");
    assert.equal(computeTripStatus("Paris", "Paris", null, null, "active", PARIS, far), "planning");
  });

  it("C7 — an open-ended trip never completes, however late the injected clock is", () => {
    assert.equal(trip("2026-09-12", null, new Date("2099-01-01T00:00:00.000Z")), "active");
  });
});

// ── THE UTC-vs-ZONE VARIANT, PINNED SO IT NEEDS NO WAITING ───────────────────
//
// The cases above fix both clocks and are safe. A LATER defect got past them,
// because it was not a pinned constant at all: `tripKernelExpansion.test.ts`
// derived its window from `Date.now()` — correctly — and then formatted it
// with `.toISOString()`, which is UTC, while `computeTripStatus` judges against
// `todayInTimezone(trip.timezone)`. For the hour between 23:00 UTC and UTC
// midnight, a zone ahead of UTC is already on the next date, so "tomorrow in
// UTC" is TODAY there and an upcoming trip reads `active`.
//
// It fired in CI at 23:28 UTC on 2026-09-20. The fix was proven by mutation
// inside that window, which is the only hour it could be proven in — and that
// is exactly the property this block removes. `now` is PINNED to the failing
// instant, so these run identically at any hour of any day.
//
// 2026-09-20T23:36:47Z is 00:36 on the 21st in Lisbon (UTC+1, WEST).
describe("computeTripStatus — a window derived in UTC is not a window derived in the trip's zone", () => {
  const LISBON = "Europe/Lisbon";
  const BOUNDARY = new Date("2026-09-20T23:36:47.000Z");
  const DAY_MS = 24 * 60 * 60 * 1_000;

  /** How the defect formatted the bounds: UTC, regardless of the trip's zone. */
  const utcOffset = (days: number) =>
    new Date(BOUNDARY.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  /** How they are formatted now: through the same function the code judges with. */
  const zoneOffset = (days: number) =>
    todayInTimezone(LISBON, new Date(BOUNDARY.getTime() + days * DAY_MS));

  it("the two derivations genuinely disagree at this instant — otherwise nothing below is a test", () => {
    // Anti-vacuity. If these ever agreed, both cases would pass for free.
    assert.equal(utcOffset(1), "2026-09-21");
    assert.equal(zoneOffset(1), "2026-09-22");
    assert.equal(todayInTimezone(LISBON, BOUNDARY), "2026-09-21");
  });

  it("REPRODUCES THE DEFECT: a UTC-derived +1/+5 window reads `active`, not `upcoming`", () => {
    // start_date == today-in-Lisbon, so the trip has already begun there.
    const status = computeTripStatus(
      "Lisboa", "Lisboa", utcOffset(1), utcOffset(5), "upcoming", LISBON, BOUNDARY,
    );
    assert.equal(status, "active");
  });

  it("THE FIX: a zone-derived +1/+5 window reads `upcoming` at the same instant", () => {
    const status = computeTripStatus(
      "Lisboa", "Lisboa", zoneOffset(1), zoneOffset(5), "upcoming", LISBON, BOUNDARY,
    );
    assert.equal(status, "upcoming");
  });

  it("the fuse is as wide as the offset — thirteen hours at UTC+13, not one", () => {
    // Pacific/Auckland, and the date is deliberate. On 2026-09-20 Auckland is
    // UTC+12, so the window opens at 12:00 UTC — my first draft of this case
    // used 11:36 UTC and FAILED, because at that instant Auckland was still on
    // the same date. NZDT starts 2026-09-27, so 2026-10-05 is UTC+13 and the
    // window opens an hour earlier, at 11:00 UTC. The width of the fuse is the
    // size of the offset, which is the point: at UTC+1 it is one hour a day.
    const AUCKLAND = "Pacific/Auckland";
    const midday = new Date("2026-10-05T11:36:47.000Z");
    const utc1 = new Date(midday.getTime() + DAY_MS).toISOString().slice(0, 10);
    const zone1 = todayInTimezone(AUCKLAND, new Date(midday.getTime() + DAY_MS));
    assert.notEqual(utc1, zone1);
    assert.equal(
      computeTripStatus("Auckland", "Auckland", utc1, utc1, "upcoming", AUCKLAND, midday),
      "active",
    );
    assert.equal(
      computeTripStatus("Auckland", "Auckland", zone1, zone1, "upcoming", AUCKLAND, midday),
      "upcoming",
    );
  });
});
