/**
 * Passport location-verification tests — node:test + node:assert only.
 * Proves the SERVER-owned trust rules. Run:
 *   node --import tsx/esm --test src/test/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateDistanceMeters,
  verifyLocation,
  shouldCreatePostcard,
  DEFAULT_THRESHOLD_METERS,
} from "../lib/locationVerify.ts";

// Cebu IT Park area coordinates for realistic checks.
const CEBU = { lat: 10.3270, lng: 123.9060 };
const CEBU_NEAR = { lat: 10.3290, lng: 123.9075 }; // ~250m away
const MANILA = { lat: 14.5995, lng: 120.9842 };    // ~570km away

test("haversine: same point is 0m", () => {
  assert.equal(Math.round(calculateDistanceMeters(CEBU.lat, CEBU.lng, CEBU.lat, CEBU.lng)), 0);
});

test("haversine: nearby points within ~300m", () => {
  const d = calculateDistanceMeters(CEBU.lat, CEBU.lng, CEBU_NEAR.lat, CEBU_NEAR.lng);
  assert.ok(d > 0 && d < 400, `expected <400m, got ${d}`);
});

test("haversine: Cebu->Manila is hundreds of km", () => {
  const d = calculateDistanceMeters(CEBU.lat, CEBU.lng, MANILA.lat, MANILA.lng);
  assert.ok(d > 500000, `expected >500km, got ${d}`);
});

test("1. GPS within radius -> verified + stamp_eligible", () => {
  const r = verifyLocation({
    locationLat: CEBU.lat, locationLng: CEBU.lng,
    userGpsLat: CEBU_NEAR.lat, userGpsLng: CEBU_NEAR.lng,
    locationSource: "gps",
  });
  assert.equal(r.locationVerified, true);
  assert.equal(r.stampEligible, true);
  assert.equal(r.stampReason, "gps_within_radius");
  assert.equal(r.verificationMethod, "gps_current_location");
  assert.ok((r.distanceMeters ?? 0) >= 0);
});

test("2. manual location -> NO stamp", () => {
  const r = verifyLocation({
    locationLat: CEBU.lat, locationLng: CEBU.lng,
    userGpsLat: null, userGpsLng: null,
    locationSource: "manual",
  });
  assert.equal(r.locationVerified, false);
  assert.equal(r.stampEligible, false);
  assert.equal(r.stampReason, "manual_location_only");
  assert.equal(r.verificationMethod, "manual_only");
});

test("3. GPS mismatch (too far) -> NO stamp", () => {
  const r = verifyLocation({
    locationLat: MANILA.lat, locationLng: MANILA.lng,   // tagged Manila
    userGpsLat: CEBU.lat, userGpsLng: CEBU.lng,         // but actually in Cebu
    locationSource: "gps",
  });
  assert.equal(r.locationVerified, false);
  assert.equal(r.stampEligible, false);
  assert.equal(r.stampReason, "gps_location_mismatch");
  assert.equal(r.verificationMethod, "gps_mismatch");
  assert.ok((r.distanceMeters ?? 0) > 500000);
});

test("4. GPS source but no GPS coords (permission denied) -> NO stamp", () => {
  const r = verifyLocation({
    locationLat: CEBU.lat, locationLng: CEBU.lng,
    userGpsLat: null, userGpsLng: null,
    locationSource: "gps",
  });
  assert.equal(r.stampEligible, false);
  assert.equal(r.stampReason, "gps_permission_denied");
});

test("5. tagged location missing coordinates -> NO stamp", () => {
  const r = verifyLocation({
    locationLat: null, locationLng: null,
    userGpsLat: CEBU.lat, userGpsLng: CEBU.lng,
    locationSource: "gps",
  });
  assert.equal(r.stampEligible, false);
  assert.equal(r.stampReason, "tagged_location_missing_coordinates");
});

test("6. no location -> unavailable, NO stamp", () => {
  const r = verifyLocation({ locationSource: "none" });
  assert.equal(r.stampEligible, false);
  assert.equal(r.stampReason, "verification_unavailable");
});

test("7. exactly at threshold edge is verified (<=)", () => {
  // pick a point and verify the boundary behavior with explicit threshold
  const d = calculateDistanceMeters(CEBU.lat, CEBU.lng, CEBU_NEAR.lat, CEBU_NEAR.lng);
  const r = verifyLocation({
    locationLat: CEBU.lat, locationLng: CEBU.lng,
    userGpsLat: CEBU_NEAR.lat, userGpsLng: CEBU_NEAR.lng,
    locationSource: "gps",
    thresholdMeters: Math.ceil(d), // threshold == distance -> <= passes
  });
  assert.equal(r.stampEligible, true);
});

test("8. default threshold is ~1 mile", () => {
  assert.equal(DEFAULT_THRESHOLD_METERS, 1609);
});

test("9. client cannot fake verification — verifyLocation ignores any client flag", () => {
  // The input type has no 'locationVerified' field; even if passed, it's unused.
  const r = verifyLocation({
    locationSource: "manual",
    locationLat: CEBU.lat, locationLng: CEBU.lng,
    // @ts-expect-error intentionally passing a bogus client flag
    locationVerified: true, stampEligible: true,
  });
  assert.equal(r.locationVerified, false);
  assert.equal(r.stampEligible, false);
});

test("10. postcard created only with media + add_to_passport + active", () => {
  assert.equal(shouldCreatePostcard({ mediaUrls: ["x"], addToPassport: true, status: "active" }), true);
  assert.equal(shouldCreatePostcard({ mediaUrls: [], addToPassport: true, status: "active" }), false); // no media
  assert.equal(shouldCreatePostcard({ mediaUrls: ["x"], addToPassport: false, status: "active" }), false); // toggle off
  assert.equal(shouldCreatePostcard({ mediaUrls: ["x"], addToPassport: true, status: "hidden" }), false); // not active
});
