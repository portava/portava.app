"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Composer logic tests — node:test + node:assert only. Verifies the pure
 * submit/passport/location rules the composer relies on.
 * Run: node --import tsx/esm --test src/lib/composerLogic.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var composerLogic_1 = require("./composerLogic");
(0, node_test_1.test)('1. media required before submit', function () {
    strict_1.default.equal((0, composerLogic_1.canSubmit)({ hasMedia: false, submitting: false }), false);
    strict_1.default.equal((0, composerLogic_1.canSubmit)({ hasMedia: true, submitting: false }), true);
});
(0, node_test_1.test)('2. cannot submit while submitting', function () {
    strict_1.default.equal((0, composerLogic_1.canSubmit)({ hasMedia: true, submitting: true }), false);
});
(0, node_test_1.test)('3. passport toggle defaults ON with media', function () {
    strict_1.default.equal((0, composerLogic_1.defaultPassportToggle)(true), true);
    strict_1.default.equal((0, composerLogic_1.defaultPassportToggle)(false), false);
});
(0, node_test_1.test)('4. GPS selection sends gps source + both tagged and userGps coords', function () {
    var p = (0, composerLogic_1.buildLocationPayload)({ source: 'gps', lat: 10.32, lng: 123.9, name: 'IT Park', city: 'Cebu', country: 'PH' });
    strict_1.default.equal(p.locationSource, 'gps');
    strict_1.default.equal(p.locationLat, 10.32);
    strict_1.default.equal(p.userGpsLat, 10.32);
    strict_1.default.equal(p.userGpsLng, 123.9);
    strict_1.default.equal(p.locationCity, 'Cebu');
});
(0, node_test_1.test)('5. manual selection sends manual source + NO coordinates', function () {
    var p = (0, composerLogic_1.buildLocationPayload)({ source: 'manual', name: 'Some Cafe' });
    strict_1.default.equal(p.locationSource, 'manual');
    strict_1.default.equal(p.locationName, 'Some Cafe');
    strict_1.default.equal('locationLat' in p, false);
    strict_1.default.equal('userGpsLat' in p, false);
});
(0, node_test_1.test)('6. empty manual name falls back to none', function () {
    var p = (0, composerLogic_1.buildLocationPayload)({ source: 'manual', name: '   ' });
    strict_1.default.equal(p.locationSource, 'none');
});
(0, node_test_1.test)('7. gps without coords falls back to none', function () {
    var p = (0, composerLogic_1.buildLocationPayload)({ source: 'gps', lat: null, lng: null });
    strict_1.default.equal(p.locationSource, 'none');
});
(0, node_test_1.test)('8. no location -> none', function () {
    var p = (0, composerLogic_1.buildLocationPayload)({ source: 'none' });
    strict_1.default.equal(p.locationSource, 'none');
});
(0, node_test_1.test)('9. frontend payload NEVER includes a trusted location_verified/stamp_eligible', function () {
    var gps = (0, composerLogic_1.buildLocationPayload)({ source: 'gps', lat: 1, lng: 2 });
    var manual = (0, composerLogic_1.buildLocationPayload)({ source: 'manual', name: 'X' });
    var none = (0, composerLogic_1.buildLocationPayload)({ source: 'none' });
    for (var _i = 0, _a = [gps, manual, none]; _i < _a.length; _i++) {
        var p = _a[_i];
        strict_1.default.equal((0, composerLogic_1.payloadHasForbiddenKeys)(p), false);
    }
});
(0, node_test_1.test)('10. forbidden-key detector catches a spoofed flag', function () {
    strict_1.default.equal((0, composerLogic_1.payloadHasForbiddenKeys)({ locationSource: 'manual', location_verified: true }), true);
    strict_1.default.equal((0, composerLogic_1.payloadHasForbiddenKeys)({ locationSource: 'manual', stampEligible: true }), true);
});
