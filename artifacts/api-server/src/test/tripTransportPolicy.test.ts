/**
 * Trips spec §7.4 — route availability against a transport-mode policy
 * (census-trips TR137): "feasible by taxi but the transport-mode policy says
 * no taxi".
 *
 *   an allowed mode fits → AVAILABLE; only a disallowed mode fits →
 *   POLICY_BLOCKED with TRIP_SPATIAL_ROUTE_UNAVAILABLE and the mode named;
 *   no mode fits → NO_MODE_FITS with TRIP_TEMPORAL_INFEASIBLE (the temporal
 *   engine's verdict, agreed with, not contradicted); no estimate → UNCHECKABLE,
 *   never AVAILABLE; the provider is asked once per mode; the fold is worst-first.
 *
 * Distances come from the provider's own constants, so the hop that "fits by
 * drive but not on foot" is derived, not guessed.
 *
 * Run: node --import tsx/esm --test src/test/tripTransportPolicy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkRouteAvailability, foldRouteAvailability, isPolicyMode, NO_TRANSPORT_POLICY, POLICY_MODES,
} from "../services/trips/TripTransportPolicy.js";
import {
  straightLineTravelTimeProvider, DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_METRES_PER_SECOND,
  type TravelTimeProvider, type TravelTimeQuery,
} from "../services/trips/TravelTimeProvider.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const EARTH_RADIUS_M = 6_371_000;
const ORIGIN = { lat: 48.8566, lng: 2.3522 };
const northOf = (metres: number) => ({ lat: ORIGIN.lat + (metres / EARTH_RADIUS_M) * (180 / Math.PI), lng: ORIGIN.lng });
const DEPART = new Date("2026-10-01T09:00:00.000Z");
const after = (minutes: number) => new Date(DEPART.getTime() + minutes * 60_000);
/** 6 km: ~80 min on foot, ~15 min by road. */
const FAR = 6_000;
const walkMin = Math.ceil(FAR / WALK_METRES_PER_SECOND / 60);
const driveMin = Math.ceil((FAR / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60);
const P = straightLineTravelTimeProvider;

describe("TR137 — route availability against the policy", () => {
  it("fits by drive only, and the policy disallows drive and transit: POLICY_BLOCKED, TRIP_SPATIAL_ROUTE_UNAVAILABLE, the mode named", async () => {
    const r = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(driveMin + 5) }, { disallowedModes: ["drive", "transit"], note: "walking city" });
    assert.equal(r.verdict, "POLICY_BLOCKED"); assert.equal(r.reasonCode, "TRIP_SPATIAL_ROUTE_UNAVAILABLE");
    assert.equal(r.fitsOnlyByDisallowed, "drive"); assert.equal(r.fitsByAllowed, null);
    assert.match(r.detail, /feasible by drive/); assert.match(r.detail, /walking city/);
    assert.equal(r.byMode.find((m) => m.mode === "walk")!.fits, false);
  });
  it("the same hop with no policy: AVAILABLE by drive", async () => {
    const r = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(driveMin + 5) }, NO_TRANSPORT_POLICY);
    assert.equal(r.verdict, "AVAILABLE"); assert.equal(r.reasonCode, null); assert.equal(r.fitsByAllowed, "drive");
  });
  it("enough time to walk: AVAILABLE even with drive disallowed — walk is the allowed mode that fits", async () => {
    const r = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(walkMin + 1) }, { disallowedModes: ["drive", "transit"], note: null });
    assert.equal(r.verdict, "AVAILABLE"); assert.equal(r.fitsByAllowed, "walk");
  });
  it("prep comes out of the same budget", async () => {
    const ok = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(driveMin + 5), prepMinutes: 5 });
    const late = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(driveMin + 5), prepMinutes: 6 });
    assert.equal(ok.verdict, "AVAILABLE"); assert.equal(late.verdict, "NO_MODE_FITS");
  });
  it("no mode reaches the deadline: NO_MODE_FITS with TRIP_TEMPORAL_INFEASIBLE — a temporal verdict, not a policy one", async () => {
    const r = await checkRouteAvailability(P, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(1) }, { disallowedModes: ["drive"], note: null });
    assert.equal(r.verdict, "NO_MODE_FITS"); assert.equal(r.reasonCode, "TRIP_TEMPORAL_INFEASIBLE");
  });
  it("no coordinates: UNCHECKABLE, never AVAILABLE, and the unknown reason is on every mode", async () => {
    const r = await checkRouteAvailability(P, { from: ORIGIN, to: null, departAt: DEPART, deadline: after(600) });
    assert.equal(r.verdict, "UNCHECKABLE"); assert.equal(r.reasonCode, null);
    assert.ok(r.byMode.every((m) => m.fits === null && m.unknownReason === "NO_COORDINATES"));
  });
  it("the provider is asked once per policy mode, with the mode", async () => {
    const asked: TravelTimeQuery[] = [];
    const spy: TravelTimeProvider = { id: "spy", routed: false, estimate: async (q) => { asked.push(q); return P.estimate(q); } };
    await checkRouteAvailability(spy, { from: ORIGIN, to: northOf(FAR), departAt: DEPART, deadline: after(60) });
    assert.deepEqual(asked.map((q) => q.mode), [...POLICY_MODES]);
  });
  it("the fold is worst-first; the reason codes are Appendix B's; the vocabulary is the provider's less unknown", () => {
    const av = { verdict: "AVAILABLE" } as any, bl = { verdict: "POLICY_BLOCKED" } as any, un = { verdict: "UNCHECKABLE" } as any, no = { verdict: "NO_MODE_FITS" } as any;
    assert.equal(foldRouteAvailability([av, un, bl]), "POLICY_BLOCKED");
    assert.equal(foldRouteAvailability([av, un, no]), "NO_MODE_FITS");
    assert.equal(foldRouteAvailability([av, un]), "UNCHECKABLE");
    assert.equal(foldRouteAvailability([av]), "AVAILABLE"); assert.equal(foldRouteAvailability([]), "AVAILABLE");
    for (const c of ["TRIP_SPATIAL_ROUTE_UNAVAILABLE", "TRIP_TEMPORAL_INFEASIBLE"]) assert.ok((TRIP_REASON_CODES as readonly string[]).includes(c), c);
    assert.equal(isPolicyMode("taxi"), false); assert.equal(isPolicyMode("unknown"), false); assert.equal(isPolicyMode("drive"), true);
  });
});
