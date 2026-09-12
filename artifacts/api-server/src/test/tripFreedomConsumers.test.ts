/**
 * Trips spec §7.3 — "Discovery, Compass, Saved Ideas, and Buddy matching
 * consume these windows rather than independently calculating 'free time.'"
 * census-trips TR133: the Buddy and Discovery consumers.
 *
 *   1. fitSlotToWindows, pure: inside a window FITS (naming it); across a
 *      window's edge or inside a commitment block CONFLICT (naming the
 *      commitments); before or after every window OUTSIDE_TRIP; no windows
 *      UNPLACED. Only CONFLICT is a refusal.
 *   2. readSlotFit through the REAL freedom projection on the health
 *      fixture's Paris trip: a booking's wall time is turned into an instant
 *      in the trip's zone and judged; no start time is UNPLACED; a closed
 *      gate or a non-member is NOT_CONSULTED — never a conflict by default.
 *   3. fitInstantToWindows for an event's start.
 *
 * Run: node --import tsx/esm --test src/test/tripFreedomConsumers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fitSlotToWindows, fitInstantToWindows, readSlotFit, readTripWindows, SLOT_FIT_VERDICTS } from "../domain/trips/services/TripFreedomConsumers.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-13T12:00:00.000Z");

const W = (id: string, position: string, beginsAt: string, endsAt: string, after: string | null, before: string | null) =>
  ({ id, position, beginsAt, endsAt, afterCommitmentId: after, beforeCommitmentId: before, confidence: "LOW", certified: false } as any);
const synthetic = {
  tripId: TRIP_ID, decisionId: "d1",
  windows: [
    W("w0", "before_first", "2026-09-12T00:00:00Z", "2026-09-13T10:00:00Z", null, "A"),
    W("w1", "between",      "2026-09-13T10:00:00Z", "2026-09-13T15:30:00Z", "A", "B"),
    W("w2", "after_last",   "2026-09-13T16:00:00Z", "2026-09-15T23:59:59Z", "B", null),
  ],
};
const at = (s: string) => new Date(s);

describe("fitSlotToWindows — the verdicts", () => {
  it("inside a window: FITS, naming the window and the decision", () => {
    const r = fitSlotToWindows(synthetic, { beginsAt: at("2026-09-13T11:00:00Z"), endsAt: at("2026-09-13T12:00:00Z") });
    assert.equal(r.verdict, "FITS"); assert.equal(r.windowId, "w1"); assert.equal(r.reason, null); assert.equal(r.decisionId, "d1");
    assert.deepEqual(r.conflictingCommitmentIds, []); assert.equal(r.consulted, true);
  });
  it("across a commitment's start: CONFLICT naming it; inside the reserved gap before B: CONFLICT naming B", () => {
    let r = fitSlotToWindows(synthetic, { beginsAt: at("2026-09-13T09:30:00Z"), endsAt: at("2026-09-13T10:30:00Z") });
    assert.equal(r.verdict, "CONFLICT"); assert.deepEqual(r.conflictingCommitmentIds, ["A"]); assert.equal(r.reason, "TRIP_TEMPORAL_CONFLICT");
    r = fitSlotToWindows(synthetic, { beginsAt: at("2026-09-13T15:35:00Z"), endsAt: at("2026-09-13T15:55:00Z") });
    assert.equal(r.verdict, "CONFLICT"); assert.deepEqual(r.conflictingCommitmentIds, ["B"]);
    r = fitSlotToWindows(synthetic, { beginsAt: at("2026-09-13T15:00:00Z"), endsAt: at("2026-09-13T16:30:00Z") });
    assert.equal(r.verdict, "CONFLICT"); assert.deepEqual(r.conflictingCommitmentIds, ["B"]);
    assert.match(r.info, /runs into commitment B/);
  });
  it("before every window or after every window: OUTSIDE_TRIP, not a conflict", () => {
    assert.equal(fitSlotToWindows(synthetic, { beginsAt: at("2026-09-01T10:00:00Z"), endsAt: at("2026-09-01T11:00:00Z") }).verdict, "OUTSIDE_TRIP");
    assert.equal(fitSlotToWindows(synthetic, { beginsAt: at("2026-09-20T10:00:00Z"), endsAt: at("2026-09-20T11:00:00Z") }).verdict, "OUTSIDE_TRIP");
  });
  it("no windows, or an unusable slot: UNPLACED — consulted, but no claim", () => {
    const r = fitSlotToWindows({ tripId: TRIP_ID, decisionId: "d1", windows: [] }, { beginsAt: at("2026-09-13T11:00:00Z"), endsAt: at("2026-09-13T12:00:00Z") });
    assert.equal(r.verdict, "UNPLACED"); assert.equal(r.consulted, true); assert.match(r.info, /no windows/);
    assert.equal(fitSlotToWindows(synthetic, { beginsAt: at("2026-09-13T12:00:00Z"), endsAt: at("2026-09-13T11:00:00Z") }).verdict, "UNPLACED");
    assert.deepEqual([...SLOT_FIT_VERDICTS], ["FITS", "CONFLICT", "OUTSIDE_TRIP", "UNPLACED", "NOT_CONSULTED"]);
  });
  it("an instant is a zero-length slot", () => {
    assert.equal(fitInstantToWindows(synthetic, "2026-09-13T11:00:00Z").verdict, "FITS");
    assert.equal(fitInstantToWindows(synthetic, "2026-09-13T15:45:00Z").verdict, "CONFLICT");
    assert.equal(fitInstantToWindows(synthetic, null).verdict, "UNPLACED");
    assert.equal(fitInstantToWindows(synthetic, "not a date").verdict, "UNPLACED");
  });
});

describe("readSlotFit — a Buddy booking against the real freedom projection", () => {
  // base(): a Paris trip 2026-09-12..15 (Europe/Paris), commitment A at 10:00Z on the 13th, B due 16:00Z, ~10 km apart.
  it("13:00 local for an hour on the 13th (11:00Z) lies in the between-window: FITS", async () => {
    const r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "13:00", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "FITS", r.info); assert.equal(r.consulted, true); assert.ok(r.windowId);
    assert.deepEqual(r.slot, { beginsAt: "2026-09-13T11:00:00.000Z", endsAt: "2026-09-13T12:00:00.000Z" });
    assert.ok(r.decisionId);
  });
  it("11:30 local for an hour crosses A's 10:00Z start: CONFLICT naming A; 17:30 local runs into B's reserved travel: CONFLICT naming B", async () => {
    let r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "11:30", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "CONFLICT", r.info); assert.deepEqual(r.conflictingCommitmentIds, ["A"]); assert.equal(r.reason, "TRIP_TEMPORAL_CONFLICT");
    r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "17:30", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "CONFLICT", r.info); assert.deepEqual(r.conflictingCommitmentIds, ["B"]);
  });
  it("a date after the trip: OUTSIDE_TRIP; no start time: UNPLACED; seconds in the time are tolerated", async () => {
    let r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-20", startTime: "13:00", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "OUTSIDE_TRIP", r.info);
    r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: null, durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "UNPLACED"); assert.equal(r.consulted, true); assert.match(r.info, /no start time/);
    r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "13:00:00", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "FITS");
  });
  it("gate closed or not a member: NOT_CONSULTED, never CONFLICT", async () => {
    const t = base();
    t.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: false }];
    let r = await readSlotFit(makeClient(t) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "11:30", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "NOT_CONSULTED"); assert.equal(r.consulted, false); assert.match(r.info, /not enabled/);
    r = await readSlotFit(makeClient(base()) as any, { tripId: TRIP_ID, viewerId: OTHER_ID, date: "2026-09-13", startTime: "11:30", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "NOT_CONSULTED"); assert.match(r.info, /not a member/);
    const w = await readTripWindows(makeClient(base(), ["trip_commitments"]) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.equal(w.ok, false);
  });
  it("a trip without a timezone is judged in UTC and says so", async () => {
    const t = base();
    t.trips = t.trips!.map((x) => ({ ...x, timezone: null }));
    const r = await readSlotFit(makeClient(t) as any, { tripId: TRIP_ID, viewerId: OWNER_ID, date: "2026-09-13", startTime: "11:00", durationHours: 1 }, { now: NOW });
    assert.equal(r.verdict, "FITS", r.info); assert.match(r.info, /judged in UTC/);
    assert.equal(r.slot!.beginsAt, "2026-09-13T11:00:00.000Z");
  });
});
