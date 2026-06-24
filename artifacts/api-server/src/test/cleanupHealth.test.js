"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * HTTP-level tests for GET /api/healthz/cleanup
 *
 * Covers:
 *   H1: responds 200 with all required fields in the response shape
 *   H2: cleanupStatus = "ok" when job ran recently
 *   H3: cleanupStatus = "overdue" when job ran 30 h ago
 *   H4: cleanupStatus = "critical" when job ran 55 h ago
 *   H5: cleanupStatus = "critical" when job has never run (no row)
 *   H6: cleanupStatus = "critical" when job_health query fails
 *   H7: returns HTTP 200 even when cleanupStatus is "critical" (critical state is not a server error)
 *   H8: returns HTTP 200 even when cleanupStatus is "overdue"
 *   H9: response shape matches the documented contract exactly — no extra or missing fields
 *
 * Runtime: node:test + fetch() on a real in-process Express server.
 * Fake job_health client injected via _setTestJobHealthClient so no live
 * Supabase connection is required.
 *
 * Run: node --import tsx/esm --test src/test/cleanupHealth.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var dailyBriefCleanup_js_1 = require("../lib/dailyBriefCleanup.js");
var health_js_1 = require("../routes/health.js");
// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Build a fake job_health Supabase client that returns a controlled row.
 * minsAgo = null  → no row exists (first-run scenario)
 * minsAgo = N     → row with last_run_at = N minutes before now
 */
function makeJobHealthClient(minsAgo) {
    return {
        from: function (_table) {
            var builder = {
                select: function () { return builder; },
                eq: function () { return builder; },
                maybeSingle: function () {
                    if (minsAgo === null)
                        return Promise.resolve({ data: null, error: null });
                    return Promise.resolve({
                        data: { last_run_at: new Date(Date.now() - minsAgo * 60000).toISOString() },
                        error: null,
                    });
                },
            };
            return builder;
        },
    };
}
function makeErrorClient() {
    return {
        from: function (_table) {
            return {
                select: function () { return this; },
                eq: function () { return this; },
                maybeSingle: function () {
                    return Promise.resolve({ data: null, error: { message: "connection refused" } });
                },
            };
        },
    };
}
// ── Server setup ──────────────────────────────────────────────────────────────
var server;
var base;
(0, node_test_1.before)(function () { return __awaiter(void 0, void 0, void 0, function () {
    var app, addr;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                app = (0, express_1.default)();
                app.use(express_1.default.json());
                // Suppress pino output during tests — attach a no-op req.log just in case
                // any middleware reaches for it (the health route uses the module logger,
                // not req.log, so this is a belt-and-suspenders precaution only).
                app.use(function (_req, _res, next) { _req.log = { error: function () { }, warn: function () { }, info: function () { } }; next(); });
                app.use("/api", health_js_1.default);
                server = (0, node_http_1.createServer)(app);
                return [4 /*yield*/, new Promise(function (resolve) { return server.listen(0, "127.0.0.1", resolve); })];
            case 1:
                _a.sent();
                addr = server.address();
                base = "http://127.0.0.1:".concat(addr.port, "/api");
                return [2 /*return*/];
        }
    });
}); });
(0, node_test_1.after)(function () {
    server.close();
});
(0, node_test_1.afterEach)(function () {
    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(null);
});
// ══════════════════════════════════════════════════════════════════════════════
// H1–H9: GET /api/healthz/cleanup
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("H — GET /api/healthz/cleanup", function () {
    (0, node_test_1.it)("H1: responds 200 with all required fields", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(60)); // 1h ago → ok
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    strict_1.default.equal(res.status, 200);
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.ok("cleanupStatus" in body, "missing cleanupStatus");
                    strict_1.default.ok("lastRunAt" in body, "missing lastRunAt");
                    strict_1.default.ok("lastOutcome" in body, "missing lastOutcome");
                    strict_1.default.ok("lastDeletedCount" in body, "missing lastDeletedCount");
                    strict_1.default.ok("consecutiveFailures" in body, "missing consecutiveFailures");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H2: cleanupStatus = 'ok' when job ran 1 h ago", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(60));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "ok");
                    strict_1.default.ok(typeof body.lastRunAt === "string", "lastRunAt should be a string");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H3: cleanupStatus = 'overdue' when job ran 30 h ago", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(30 * 60));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "overdue");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H4: cleanupStatus = 'critical' when job ran 55 h ago", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(55 * 60));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "critical");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H5: cleanupStatus = 'critical' when no job_health row exists (never ran)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(null));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "critical");
                    strict_1.default.equal(body.lastRunAt, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H6: cleanupStatus = 'critical' when job_health query returns an error", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeErrorClient());
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "critical");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H7: HTTP 200 even when cleanupStatus is 'critical' — health endpoints must always respond", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    // No row = critical; endpoint must still return 200, not 5xx or 4xx.
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(null));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    strict_1.default.equal(res.status, 200, "expected 200 even for critical cleanup status");
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "critical");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H8: HTTP 200 even when cleanupStatus is 'overdue'", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(30 * 60));
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _a.sent();
                    strict_1.default.equal(res.status, 200, "expected 200 even for overdue cleanup status");
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _a.sent();
                    strict_1.default.equal(body.cleanupStatus, "overdue");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H9: response contains exactly the five documented fields — no extras, no missing", function () { return __awaiter(void 0, void 0, void 0, function () {
        var res, body, EXPECTED_KEYS, actualKeys, _i, EXPECTED_KEYS_1, key, _a, actualKeys_1, key;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(60)); // ok
                    return [4 /*yield*/, fetch("".concat(base, "/healthz/cleanup"))];
                case 1:
                    res = _b.sent();
                    strict_1.default.equal(res.status, 200);
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _b.sent();
                    EXPECTED_KEYS = new Set([
                        "cleanupStatus",
                        "lastRunAt",
                        "lastOutcome",
                        "lastDeletedCount",
                        "consecutiveFailures",
                    ]);
                    actualKeys = new Set(Object.keys(body));
                    // All required keys must be present.
                    for (_i = 0, EXPECTED_KEYS_1 = EXPECTED_KEYS; _i < EXPECTED_KEYS_1.length; _i++) {
                        key = EXPECTED_KEYS_1[_i];
                        strict_1.default.ok(actualKeys.has(key), "missing required field: ".concat(key));
                    }
                    // No extra keys beyond the documented contract.
                    for (_a = 0, actualKeys_1 = actualKeys; _a < actualKeys_1.length; _a++) {
                        key = actualKeys_1[_a];
                        strict_1.default.ok(EXPECTED_KEYS.has(key), "unexpected extra field in response: ".concat(key));
                    }
                    // Type guards for the fields that have fixed types.
                    strict_1.default.ok(["ok", "overdue", "critical"].includes(body.cleanupStatus), "cleanupStatus must be 'ok' | 'overdue' | 'critical'");
                    strict_1.default.ok(typeof body.consecutiveFailures === "number", "consecutiveFailures must be a number");
                    return [2 /*return*/];
            }
        });
    }); });
});
