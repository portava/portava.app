"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Unit tests for stampHelper.ts — pure logic only (no DB or HTTP).
 * Run: node --import tsx/esm --test src/test/stampHelper.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var stampHelper_1 = require("../lib/stampHelper");
var YEAR = new Date().getFullYear();
(0, node_test_1.describe)("buildCityStampLabels", function () {
    (0, node_test_1.it)("uppercases city label", function () {
        var label = (0, stampHelper_1.buildCityStampLabels)("cebu", "Philippines").label;
        strict_1.default.equal(label, "CEBU");
    });
    (0, node_test_1.it)("trims whitespace from city", function () {
        var label = (0, stampHelper_1.buildCityStampLabels)("  tokyo  ", "Japan").label;
        strict_1.default.equal(label, "TOKYO");
    });
    (0, node_test_1.it)("uses 2-char country code + year in sublabel", function () {
        var sublabel = (0, stampHelper_1.buildCityStampLabels)("cebu", "Philippines").sublabel;
        strict_1.default.equal(sublabel, "PH \u00B7 ".concat(YEAR));
    });
    (0, node_test_1.it)("uses 2-char code from short country string", function () {
        var sublabel = (0, stampHelper_1.buildCityStampLabels)("bangkok", "TH").sublabel;
        strict_1.default.equal(sublabel, "TH \u00B7 ".concat(YEAR));
    });
    (0, node_test_1.it)("falls back to year-only when country is null", function () {
        var sublabel = (0, stampHelper_1.buildCityStampLabels)("somewhere", null).sublabel;
        strict_1.default.equal(sublabel, String(YEAR));
    });
    (0, node_test_1.it)("handles mixed-case country", function () {
        var sublabel = (0, stampHelper_1.buildCityStampLabels)("berlin", "germany").sublabel;
        strict_1.default.equal(sublabel, "GE \u00B7 ".concat(YEAR));
    });
    (0, node_test_1.it)("preserves city with special chars", function () {
        var label = (0, stampHelper_1.buildCityStampLabels)("ho chi minh", "VN").label;
        strict_1.default.equal(label, "HO CHI MINH");
    });
});
