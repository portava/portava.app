/**
 * mediaContributorTripExpertise — census-media §21, MD207: §25 Trip Expertise
 * ("relevant journey history") is a fourth reputation dimension, computed from
 * PUBLIC completed trips only, and never from intel or social data.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaContributorTripExpertise.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeContributorReputation,
  tripExpertise,
  TRIP_EXPERTISE_GLOBAL_SATURATION,
  TRIP_EXPERTISE_SCOPED_SATURATION,
} from "../lib/mediaContributorReputation.js";
import {
  readContributorReputation,
  readJourneySignals,
} from "../services/media/MediaContributorReputationService.js";

const C = "c0000000-0000-0000-0000-000000000001";
const OTHER = "c0000000-0000-0000-0000-000000000002";
const PLACE = "p0000000-0000-0000-0000-000000000001";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function makeDb(tables: Record<string, any[]>, opts: { failing?: string[] } = {}) {
  const reads: string[] = [];
  const from = (name: string) => {
    reads.push(name);
    const filters: Array<(r: any) => boolean> = [];
    const run = () =>
      opts.failing?.includes(name)
        ? { data: null, error: { message: `${name} unreadable` } }
        : { data: (tables[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null };
    const b: any = {
      select() { return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null }); },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { from, reads };
}

function trip(id: string, o: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: C,
    destination_city: "Hoi An",
    end_date: "2026-06-01",
    status: "completed",
    visibility: "public",
    show_destination_city: true,
    ...o,
  };
}

describe("MD207 — the pure dimension", () => {
  it("saturates: three trips to the scoped city is full expertise; ten without a scope", () => {
    assert.equal(tripExpertise({ completedTrips: 9, completedTripsInScope: 3, scoped: true }), 1);
    assert.equal(tripExpertise({ completedTrips: 9, completedTripsInScope: 1, scoped: true }), 1 / TRIP_EXPERTISE_SCOPED_SATURATION);
    assert.equal(tripExpertise({ completedTrips: 5, scoped: false }), 5 / TRIP_EXPERTISE_GLOBAL_SATURATION);
    assert.equal(tripExpertise({ completedTrips: 50, scoped: false }), 1);
    assert.equal(tripExpertise(undefined), 0);
  });

  it("is a FOURTH dimension that leaves the three intel dimensions untouched", () => {
    const intel = { acceptedObservations: 3, totalObservations: 4, placeAcceptedObservations: 2, corroboratedObservations: 1, corroborationOpportunities: 2 };
    const without = computeContributorReputation(intel);
    const withJourney = computeContributorReputation(intel, { completedTrips: 2, completedTripsInScope: 2, scoped: true });
    assert.equal(without.tripExpertise, 0);
    assert.ok(withJourney.tripExpertise > 0);
    assert.deepEqual({ ...withJourney, tripExpertise: 0 }, without);
  });

  it("a public journey alone makes a reputation non-empty", () => {
    const rep = computeContributorReputation(
      { acceptedObservations: 0, totalObservations: 0, corroboratedObservations: 0, corroborationOpportunities: 0 },
      { completedTrips: 1, scoped: false },
    );
    assert.equal(rep.isEmpty, false);
  });
});

describe("MD207 — readJourneySignals counts only COMPLETED, PUBLIC journeys", () => {
  it("counts owned and accepted-member trips; private, buddies, hidden-destination, cancelled and future trips do not count", async () => {
    const db = makeDb({
      trips: [
        trip("t-owned"),
        trip("t-joined", { owner_id: OTHER, destination_city: "Hue" }),
        trip("t-private", { visibility: "private" }),
        trip("t-buddies", { visibility: "buddies" }),
        trip("t-hidden-city", { show_destination_city: false }),
        trip("t-cancelled", { status: "cancelled", end_date: "2026-01-01" }),
        trip("t-future", { status: "upcoming", end_date: "2026-12-01" }),
        trip("t-invited", { owner_id: OTHER }),
      ],
      trip_members: [
        { trip_id: "t-joined", user_id: C, status: "accepted", role: "member" },
        { trip_id: "t-invited", user_id: C, status: "invited", role: "invited" },
      ],
      places: [{ id: PLACE, city: "Hoi An" }],
    });
    const j = await readJourneySignals(db, { contributorId: C, subjectId: PLACE }, NOW);
    assert.equal(j.completedTrips, 2, "t-owned and t-joined, nothing else");
    assert.equal(j.completedTripsInScope, 1, "only t-owned went to the scoped city");
    assert.equal(j.scoped, true);
  });

  it("an ended trip counts by date even when its status was never flipped to completed", async () => {
    const db = makeDb({ trips: [trip("t", { status: "active", end_date: "2026-09-01" })], trip_members: [] });
    assert.equal((await readJourneySignals(db, { contributorId: C }, NOW)).completedTrips, 1);
  });

  it("a failed read lowers the dimension to zero — never inflates it", async () => {
    const db = makeDb({ trips: [trip("t")], trip_members: [] }, { failing: ["trips"] });
    assert.deepEqual(await readJourneySignals(db, { contributorId: C }, NOW), { completedTrips: 0, completedTripsInScope: 0, scoped: false });
  });

  it("reaches the served reputation, and reads no social table", async () => {
    const db = makeDb({
      trips: [trip("t1"), trip("t2"), trip("t3")],
      trip_members: [],
      places: [{ id: PLACE, city: "Hoi An" }],
      intel_observations: [],
      intel_state_snapshots: [],
      passport_stamps: Array.from({ length: 50 }, (_, i) => ({ user_id: C, id: i })),
    });
    const rep = await readContributorReputation(db, { contributorId: C, subjectId: PLACE });
    assert.equal(rep.tripExpertise, 1, "three public completed trips to the scoped city");
    assert.equal(rep.isEmpty, false);
    assert.ok(!db.reads.includes("passport_stamps") && !db.reads.includes("user_follows"));
  });
});
