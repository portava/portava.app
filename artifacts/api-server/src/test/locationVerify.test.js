"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Passport location-verification tests — node:test + node:assert only.
 * Proves the SERVER-owned trust rules. Run:
 *   node --import tsx/esm --test src/test/*.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var locationVerify_1 = require("../lib/locationVerify");
// Cebu IT Park area coordinates for realistic checks.
var CEBU = { lat: 10.3270, lng: 123.9060 };
var CEBU_NEAR = { lat: 10.3290, lng: 123.9075 }; // ~250m away
var MANILA = { lat: 14.5995, lng: 120.9842 }; // ~570km away
(0, node_test_1.test)("haversine: same point is 0m", function () {
    strict_1.default.equal(Math.round((0, locationVerify_1.calculateDistanceMeters)(CEBU.lat, CEBU.lng, CEBU.lat, CEBU.lng)), 0);
});
(0, node_test_1.test)("haversine: nearby points within ~300m", function () {
    var d = (0, locationVerify_1.calculateDistanceMeters)(CEBU.lat, CEBU.lng, CEBU_NEAR.lat, CEBU_NEAR.lng);
    strict_1.default.ok(d > 0 && d < 400, "expected <400m, got ".concat(d));
});
(0, node_test_1.test)("haversine: Cebu->Manila is hundreds of km", function () {
    var d = (0, locationVerify_1.calculateDistanceMeters)(CEBU.lat, CEBU.lng, MANILA.lat, MANILA.lng);
    strict_1.default.ok(d > 500000, "expected >500km, got ".concat(d));
});
(0, node_test_1.test)("1. GPS within radius -> verified + stamp_eligible", function () {
    var _a;
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: CEBU.lat, locationLng: CEBU.lng,
        userGpsLat: CEBU_NEAR.lat, userGpsLng: CEBU_NEAR.lng,
        locationSource: "gps",
    });
    strict_1.default.equal(r.locationVerified, true);
    strict_1.default.equal(r.stampEligible, true);
    strict_1.default.equal(r.stampReason, "gps_within_radius");
    strict_1.default.equal(r.verificationMethod, "gps_current_location");
    strict_1.default.ok(((_a = r.distanceMeters) !== null && _a !== void 0 ? _a : 0) >= 0);
});
(0, node_test_1.test)("2. manual location -> NO stamp", function () {
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: CEBU.lat, locationLng: CEBU.lng,
        userGpsLat: null, userGpsLng: null,
        locationSource: "manual",
    });
    strict_1.default.equal(r.locationVerified, false);
    strict_1.default.equal(r.stampEligible, false);
    strict_1.default.equal(r.stampReason, "manual_location_only");
    strict_1.default.equal(r.verificationMethod, "manual_only");
});
(0, node_test_1.test)("3. GPS mismatch (too far) -> NO stamp", function () {
    var _a;
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: MANILA.lat, locationLng: MANILA.lng, // tagged Manila
        userGpsLat: CEBU.lat, userGpsLng: CEBU.lng, // but actually in Cebu
        locationSource: "gps",
    });
    strict_1.default.equal(r.locationVerified, false);
    strict_1.default.equal(r.stampEligible, false);
    strict_1.default.equal(r.stampReason, "gps_location_mismatch");
    strict_1.default.equal(r.verificationMethod, "gps_mismatch");
    strict_1.default.ok(((_a = r.distanceMeters) !== null && _a !== void 0 ? _a : 0) > 500000);
});
(0, node_test_1.test)("4. GPS source but no GPS coords (permission denied) -> NO stamp", function () {
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: CEBU.lat, locationLng: CEBU.lng,
        userGpsLat: null, userGpsLng: null,
        locationSource: "gps",
    });
    strict_1.default.equal(r.stampEligible, false);
    strict_1.default.equal(r.stampReason, "gps_permission_denied");
});
(0, node_test_1.test)("5. tagged location missing coordinates -> NO stamp", function () {
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: null, locationLng: null,
        userGpsLat: CEBU.lat, userGpsLng: CEBU.lng,
        locationSource: "gps",
    });
    strict_1.default.equal(r.stampEligible, false);
    strict_1.default.equal(r.stampReason, "tagged_location_missing_coordinates");
});
(0, node_test_1.test)("6. no location -> unavailable, NO stamp", function () {
    var r = (0, locationVerify_1.verifyLocation)({ locationSource: "none" });
    strict_1.default.equal(r.stampEligible, false);
    strict_1.default.equal(r.stampReason, "verification_unavailable");
});
(0, node_test_1.test)("7. exactly at threshold edge is verified (<=)", function () {
    // pick a point and verify the boundary behavior with explicit threshold
    var d = (0, locationVerify_1.calculateDistanceMeters)(CEBU.lat, CEBU.lng, CEBU_NEAR.lat, CEBU_NEAR.lng);
    var r = (0, locationVerify_1.verifyLocation)({
        locationLat: CEBU.lat, locationLng: CEBU.lng,
        userGpsLat: CEBU_NEAR.lat, userGpsLng: CEBU_NEAR.lng,
        locationSource: "gps",
        thresholdMeters: Math.ceil(d), // threshold == distance -> <= passes
    });
    strict_1.default.equal(r.stampEligible, true);
});
(0, node_test_1.test)("8. default threshold is ~1 mile", function () {
    strict_1.default.equal(locationVerify_1.DEFAULT_THRESHOLD_METERS, 1609);
});
(0, node_test_1.test)("9. client cannot fake verification — verifyLocation ignores any client flag", function () {
    // The input type has no 'locationVerified' field; even if passed, it's unused.
    var r = (0, locationVerify_1.verifyLocation)({
        locationSource: "manual",
        locationLat: CEBU.lat, locationLng: CEBU.lng,
        // @ts-expect-error intentionally passing a bogus client flag
        locationVerified: true, stampEligible: true,
    });
    strict_1.default.equal(r.locationVerified, false);
    strict_1.default.equal(r.stampEligible, false);
});
(0, node_test_1.test)("10. postcard created only with media + add_to_passport + active", function () {
    strict_1.default.equal((0, locationVerify_1.shouldCreatePostcard)({ mediaUrls: ["x"], addToPassport: true, status: "active" }), true);
    strict_1.default.equal((0, locationVerify_1.shouldCreatePostcard)({ mediaUrls: [], addToPassport: true, status: "active" }), false); // no media
    strict_1.default.equal((0, locationVerify_1.shouldCreatePostcard)({ mediaUrls: ["x"], addToPassport: false, status: "active" }), false); // toggle off
    strict_1.default.equal((0, locationVerify_1.shouldCreatePostcard)({ mediaUrls: ["x"], addToPassport: true, status: "hidden" }), false); // not active
});
