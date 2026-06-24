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
 * Unit tests for dailyBriefCleanup.ts
 *
 * Covers:
 *   G1–G8:   parseRetentionDays — default fallback, valid overrides, edge cases
 *   G9–G16:  parseIntervalHours — default fallback, fractional values, edge cases
 *   G17–G24: purgeOldBriefs — fake Supabase client, cutoff date math, error handling
 *   G25–G30: startDailyBriefCleanup — scheduler timing wiring via fake timers
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/dailyBriefCleanup.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var dailyBriefCleanup_js_1 = require("../lib/dailyBriefCleanup.js");
// Namespace import so we can read live bindings (_purgeCallCount is a `let`
// that increments on every purgeOldBriefs call; the namespace always reflects
// the current value, which is what the scheduler tests need).
var cleanup = require("../lib/dailyBriefCleanup.js");
var startDailyBriefCleanup = cleanup.startDailyBriefCleanup, STARTUP_DELAY_MS = cleanup.STARTUP_DELAY_MS, INTERVAL_MS = cleanup.INTERVAL_MS;
// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Build a minimal fake Supabase client that records the `lt` filter value
 * passed to daily_briefs delete and returns a configurable result.
 */
function makeFakeClient(opts) {
    if (opts === void 0) { opts = {}; }
    var calls = [];
    var capturedLtValue;
    function from(table) {
        var builder = {
            delete: function (_opts) { return builder; },
            lt: function (col, val) {
                capturedLtValue = val;
                calls.push({ table: table, ltValue: val });
                return builder;
            },
            then: function (onF, onR) {
                var _a, _b;
                if (opts.throwOnDelete) {
                    return Promise.reject(new Error("DB connection lost")).then(onF, onR);
                }
                return Promise.resolve({
                    count: (_a = opts.count) !== null && _a !== void 0 ? _a : 0,
                    error: (_b = opts.error) !== null && _b !== void 0 ? _b : null,
                }).then(onF, onR);
            },
        };
        return builder;
    }
    return {
        from: from,
        getCalls: function () { return calls; },
        getCapturedLtValue: function () { return capturedLtValue; },
    };
}
// ══════════════════════════════════════════════════════════════════════════════
// G1–G8: parseRetentionDays
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — parseRetentionDays", function () {
    (0, node_test_1.it)("G1: undefined input returns default 60", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)(undefined), 60);
    });
    (0, node_test_1.it)("G2: empty string returns default 60", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)(""), 60);
    });
    (0, node_test_1.it)("G3: non-numeric string returns default 60", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("abc"), 60);
    });
    (0, node_test_1.it)("G4: zero returns default 60", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("0"), 60);
    });
    (0, node_test_1.it)("G5: negative number returns default 60", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("-10"), 60);
    });
    (0, node_test_1.it)("G6: valid positive integer is honoured", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("30"), 30);
    });
    (0, node_test_1.it)("G7: large valid value is honoured", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("365"), 365);
    });
    (0, node_test_1.it)("G8: float string is truncated by parseInt (e.g. '45.9' → 45)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseRetentionDays)("45.9"), 45);
    });
});
// ══════════════════════════════════════════════════════════════════════════════
// G9–G16: parseIntervalHours
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — parseIntervalHours", function () {
    (0, node_test_1.it)("G9: undefined input returns default 24", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)(undefined), 24);
    });
    (0, node_test_1.it)("G10: empty string returns default 24", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)(""), 24);
    });
    (0, node_test_1.it)("G11: non-numeric string returns default 24", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("never"), 24);
    });
    (0, node_test_1.it)("G12: zero returns default 24", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("0"), 24);
    });
    (0, node_test_1.it)("G13: negative number returns default 24", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("-1"), 24);
    });
    (0, node_test_1.it)("G14: valid whole-number hours are honoured", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("12"), 12);
    });
    (0, node_test_1.it)("G15: fractional hours are preserved (0.5 → every 30 min)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("0.5"), 0.5);
    });
    (0, node_test_1.it)("G16: fractional hours with multiple decimal places are preserved", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.parseIntervalHours)("1.25"), 1.25);
    });
});
// ══════════════════════════════════════════════════════════════════════════════
// G17–G24: purgeOldBriefs
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — purgeOldBriefs", function () {
    (0, node_test_1.it)("G17: no client provided returns { deleted: null, error: null }", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: undefined, retentionDays: 60 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, null);
                    strict_1.default.equal(result.error, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G18: successful delete returns correct deleted count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ count: 7 });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, 7);
                    strict_1.default.equal(result.error, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G19: zero deleted rows is reported correctly", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ count: 0 });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, 0);
                    strict_1.default.equal(result.error, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G20: DB error is returned, not thrown", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ error: { message: "relation does not exist" } });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, null);
                    strict_1.default.ok(result.error !== null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G21: unexpected throw is caught and returned as error", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ throwOnDelete: true });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, null);
                    strict_1.default.ok(result.error instanceof Error);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G22: cutoff date is N days before today (retention=1 → yesterday)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, before, expectedCutoff, ltValue;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ count: 0 });
                    before = new Date();
                    before.setUTCDate(before.getUTCDate() - 1);
                    expectedCutoff = before.toISOString().slice(0, 10);
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 1 })];
                case 1:
                    _a.sent();
                    ltValue = client.getCapturedLtValue();
                    strict_1.default.equal(ltValue, expectedCutoff);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G23: cutoff date respects custom retention of 30 days", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, cutoff, expectedCutoff, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ count: 3 });
                    cutoff = new Date();
                    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
                    expectedCutoff = cutoff.toISOString().slice(0, 10);
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 30 })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.deleted, 3);
                    strict_1.default.equal(client.getCapturedLtValue(), expectedCutoff);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G24: delete is called on the daily_briefs table", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ count: 1 });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    _a.sent();
                    calls = client.getCalls();
                    strict_1.default.ok(calls.some(function (c) { return c.table === "daily_briefs"; }));
                    return [2 /*return*/];
            }
        });
    }); });
});
// ══════════════════════════════════════════════════════════════════════════════
// G25–G30: startDailyBriefCleanup — scheduler timing wiring
//
// Uses node:test fake timers to control setTimeout/setInterval without real
// delays. The key invariant: purgeOldBriefs increments _purgeCallCount
// synchronously before any await, so ticking a fake timer immediately updates
// the counter with no additional await needed.
//
// In the test environment SUPABASE_URL/SERVICE_ROLE_KEY are unset, so every
// purgeOldBriefs call skips immediately (no network I/O) — the tests are
// purely about whether the scheduler wires up the timers correctly.
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — startDailyBriefCleanup scheduler", function () {
    var handle;
    (0, node_test_1.beforeEach)(function () {
        node_test_1.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    });
    (0, node_test_1.afterEach)(function () {
        clearInterval(handle);
        node_test_1.mock.timers.reset();
    });
    (0, node_test_1.it)("G25: returns a clearable interval handle", function () {
        handle = startDailyBriefCleanup();
        strict_1.default.doesNotThrow(function () { return clearInterval(handle); });
    });
    (0, node_test_1.it)("G26: purge does not fire before STARTUP_DELAY_MS elapses", function () {
        var before = cleanup._purgeCallCount;
        handle = startDailyBriefCleanup();
        node_test_1.mock.timers.tick(STARTUP_DELAY_MS - 1);
        strict_1.default.equal(cleanup._purgeCallCount, before);
    });
    (0, node_test_1.it)("G27: initial purge fires exactly once after STARTUP_DELAY_MS", function () {
        var before = cleanup._purgeCallCount;
        handle = startDailyBriefCleanup();
        node_test_1.mock.timers.tick(STARTUP_DELAY_MS);
        strict_1.default.equal(cleanup._purgeCallCount, before + 1);
    });
    (0, node_test_1.it)("G28: interval fires once more after STARTUP_DELAY_MS + INTERVAL_MS", function () {
        var before = cleanup._purgeCallCount;
        handle = startDailyBriefCleanup();
        // Tick past the initial delay and one full interval period.
        // Expected: initial timeout (1) + first interval tick (1) = 2 additional calls.
        node_test_1.mock.timers.tick(STARTUP_DELAY_MS + INTERVAL_MS);
        strict_1.default.equal(cleanup._purgeCallCount, before + 2);
    });
    (0, node_test_1.it)("G29: interval fires again after a second INTERVAL_MS", function () {
        var before = cleanup._purgeCallCount;
        handle = startDailyBriefCleanup();
        // Tick past the initial delay and two full interval periods.
        // Expected: initial timeout (1) + two interval ticks (2) = 3 additional calls.
        node_test_1.mock.timers.tick(STARTUP_DELAY_MS + INTERVAL_MS * 2);
        strict_1.default.equal(cleanup._purgeCallCount, before + 3);
    });
    (0, node_test_1.it)("G30: clearing the returned handle stops further interval fires", function () {
        handle = startDailyBriefCleanup();
        // Fire the initial delayed purge.
        node_test_1.mock.timers.tick(STARTUP_DELAY_MS);
        var afterInitial = cleanup._purgeCallCount;
        // Cancel the repeating interval.
        clearInterval(handle);
        // Tick through multiple interval periods — interval must not fire.
        node_test_1.mock.timers.tick(INTERVAL_MS * 3);
        strict_1.default.equal(cleanup._purgeCallCount, afterInitial);
    });
});
// ══════════════════════════════════════════════════════════════════════════════
// G31–G35: computeCleanupStatus — threshold boundary classification
//
// INTERVAL_MS defaults to 24 h (86_400_000 ms) in test env.
// overdueMs  = INTERVAL_MS + 3_600_000  = 25 h (90_000_000 ms)
// criticalMs = 2 × INTERVAL_MS          = 48 h (172_800_000 ms)
//
// Timestamps are expressed as "N ms ago" relative to now to avoid relying on
// wall-clock dates in assertions.
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — computeCleanupStatus", function () {
    function minsAgo(mins) {
        return new Date(Date.now() - mins * 60000).toISOString();
    }
    (0, node_test_1.it)("G31: null lastRunAt → critical (job has never run)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.computeCleanupStatus)(null), "critical");
    });
    (0, node_test_1.it)("G32: ran 1 h ago → ok (well within window)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.computeCleanupStatus)(minsAgo(60)), "ok");
    });
    (0, node_test_1.it)("G33: ran 24 h 58 min ago → ok (just inside overdue boundary)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.computeCleanupStatus)(minsAgo(24 * 60 + 58)), "ok");
    });
    (0, node_test_1.it)("G34: ran 26 h ago → overdue (past interval+grace, before 2×interval)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.computeCleanupStatus)(minsAgo(26 * 60)), "overdue");
    });
    (0, node_test_1.it)("G35: ran 49 h ago → critical (past 2×interval)", function () {
        strict_1.default.equal((0, dailyBriefCleanup_js_1.computeCleanupStatus)(minsAgo(49 * 60)), "critical");
    });
});
// ══════════════════════════════════════════════════════════════════════════════
// G36–G38: failure counter — increment on error, accumulate, reset on success
//
// Uses getCleanupStatus() to observe the in-memory _status object.
// Tests check deltas (before/after) rather than absolute values so they are
// order-independent within the suite.
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — failure counter", function () {
    (0, node_test_1.it)("G36: consecutiveFailures increments by 1 on each DB error", function () { return __awaiter(void 0, void 0, void 0, function () {
        var before, client;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    before = (0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures;
                    client = makeFakeClient({ error: { message: "timeout" } });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    _a.sent();
                    strict_1.default.equal((0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures, before + 1);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G37: consecutiveFailures accumulates across multiple consecutive errors", function () { return __awaiter(void 0, void 0, void 0, function () {
        var before, client;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    before = (0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures;
                    client = makeFakeClient({ error: { message: "timeout" } });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: client, retentionDays: 60 })];
                case 2:
                    _a.sent();
                    strict_1.default.equal((0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures, before + 2);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G38: consecutiveFailures resets to 0 after a successful purge", function () { return __awaiter(void 0, void 0, void 0, function () {
        var errClient, okClient;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    errClient = makeFakeClient({ error: { message: "fail" } });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: errClient, retentionDays: 60 })];
                case 1:
                    _a.sent();
                    strict_1.default.ok((0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures > 0);
                    okClient = makeFakeClient({ count: 3 });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.purgeOldBriefs)({ client: okClient, retentionDays: 60 })];
                case 2:
                    _a.sent();
                    strict_1.default.equal((0, dailyBriefCleanup_js_1.getCleanupStatus)().consecutiveFailures, 0);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ══════════════════════════════════════════════════════════════════════════════
// G39–G43: queryCleanupHealth — classifies DB-backed timestamps correctly
//
// Uses _setTestJobHealthClient to inject a fake job_health table so the
// function can be tested without a live Supabase connection.
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("G — queryCleanupHealth", function () {
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
    (0, node_test_1.afterEach)(function () {
        (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(null);
    });
    (0, node_test_1.it)("G39: no job_health row → cleanupStatus = 'critical', lastRunAt = null", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(null));
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.cleanupStatus, "critical");
                    strict_1.default.equal(result.lastRunAt, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G40: last_run_at 1 h ago → cleanupStatus = 'ok'", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(60));
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.cleanupStatus, "ok");
                    strict_1.default.ok(result.lastRunAt !== null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G41: last_run_at 30 h ago → cleanupStatus = 'overdue'", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(30 * 60));
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.cleanupStatus, "overdue");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G42: last_run_at 55 h ago → cleanupStatus = 'critical'", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)(makeJobHealthClient(55 * 60));
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.cleanupStatus, "critical");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G43: DB error → falls back to cleanupStatus = 'critical', lastRunAt = null", function () { return __awaiter(void 0, void 0, void 0, function () {
        var result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, dailyBriefCleanup_js_1._setTestJobHealthClient)({
                        from: function (_table) {
                            return {
                                select: function () { return this; },
                                eq: function () { return this; },
                                maybeSingle: function () { return Promise.resolve({ data: null, error: { message: "permission denied" } }); },
                            };
                        },
                    });
                    return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.cleanupStatus, "critical");
                    strict_1.default.equal(result.lastRunAt, null);
                    return [2 /*return*/];
            }
        });
    }); });
});
