"use strict";
/**
 * Daily Brief Cleanup
 *
 * Purges daily_briefs rows older than DAILY_BRIEF_RETENTION_DAYS (default 60) days so the table does not grow
 * unbounded. Runs once immediately on startup (after a short delay to let
 * the server fully initialise) and then every 24 hours.
 *
 * The delete uses the brief_date index added in migration 0013 so the scan
 * is cheap regardless of table size.
 *
 * Failures are logged and swallowed — the cleanup is best-effort and must
 * never crash the server. Failed purges increment a consecutive-failure
 * counter so monitoring can key on the ERROR log event or the
 * GET /healthz/cleanup endpoint.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports._purgeCallCount = exports.STARTUP_DELAY_MS = exports.INTERVAL_MS = void 0;
exports._setTestJobHealthClient = _setTestJobHealthClient;
exports.parseRetentionDays = parseRetentionDays;
exports.parseIntervalHours = parseIntervalHours;
exports.getCleanupStatus = getCleanupStatus;
exports.computeCleanupStatus = computeCleanupStatus;
exports.queryCleanupHealth = queryCleanupHealth;
exports.purgeOldBriefs = purgeOldBriefs;
exports.startDailyBriefCleanup = startDailyBriefCleanup;
var supabase_js_1 = require("./supabase.js");
var logger_js_1 = require("./logger.js");
// ---------------------------------------------------------------------------
// Test-only client injection — lets unit tests drive queryCleanupHealth with
// a fake job_health table without needing a live Supabase connection.
// Never set in production (env has no test vars that trigger this path).
// ---------------------------------------------------------------------------
var _testJobHealthClient = null;
/** Inject a fake client for queryCleanupHealth in unit tests. Pass null to clear. */
function _setTestJobHealthClient(client) {
    _testJobHealthClient = client;
}
// ─── Exported for unit testing ───────────────────────────────────────────────
/**
 * Parse DAILY_BRIEF_RETENTION_DAYS. Returns 60 (default) when the value is
 * missing, non-numeric, zero, or negative.
 */
function parseRetentionDays(raw) {
    var parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}
/**
 * Parse DAILY_BRIEF_CLEANUP_INTERVAL_HOURS. Returns 24 (default) when the
 * value is missing, non-numeric, zero, or negative. Accepts fractional values
 * (e.g. 0.5 → every 30 minutes).
 */
function parseIntervalHours(raw) {
    var parsed = raw !== undefined ? parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}
// ─── Module-level constants (resolved once at startup) ───────────────────────
var RETENTION_DAYS = parseRetentionDays(process.env.DAILY_BRIEF_RETENTION_DAYS);
var CLEANUP_INTERVAL_HOURS = parseIntervalHours(process.env.DAILY_BRIEF_CLEANUP_INTERVAL_HOURS);
/** Exported for unit tests so they can advance fake timers by the right amount. */
exports.INTERVAL_MS = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
/** Exported for unit tests so they can advance fake timers by the right amount. */
exports.STARTUP_DELAY_MS = 30 * 1000;
var _status = {
    lastRunAt: null,
    lastOutcome: null,
    lastDeletedCount: null,
    consecutiveFailures: 0,
};
/** Return a snapshot of the most recent cleanup run status. */
function getCleanupStatus() {
    return __assign({}, _status);
}
/**
 * Classify the cleanup job's staleness into three levels.
 *
 * | Elapsed since last run | Status   | Log level |
 * |------------------------|----------|-----------|
 * | < INTERVAL + 1 h grace | ok       | —         |
 * | INTERVAL + 1 h – 2×INT | overdue  | warn      |
 * | ≥ 2 × INTERVAL, or null | critical | error     |
 *
 * For a default 24-hour job: ok < 25 h, overdue 25–48 h, critical ≥ 48 h.
 */
function computeCleanupStatus(lastRunAt) {
    if (!lastRunAt)
        return "critical";
    var elapsed = Date.now() - new Date(lastRunAt).getTime();
    var overdueMs = exports.INTERVAL_MS + 3600000; // interval + 1 h grace
    var criticalMs = 2 * exports.INTERVAL_MS; // 2× interval (48 h for daily)
    if (elapsed < overdueMs)
        return "ok";
    if (elapsed < criticalMs)
        return "overdue";
    return "critical";
}
/**
 * Query the persistent `job_health` table for the cleanup job's last run time
 * and classify its status.
 *
 * Falls back to { cleanupStatus: "critical", lastRunAt: null } when the service
 * client is unavailable or the table does not yet exist — treats an unknown
 * state as the most severe level so operators are alerted.
 */
function queryCleanupHealth() {
    return __awaiter(this, void 0, void 0, function () {
        var client, _a, data, error, lastRunAt, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = _testJobHealthClient !== null && _testJobHealthClient !== void 0 ? _testJobHealthClient : (supabase_js_1.isServiceClientReady ? (0, supabase_js_1.getServiceClient)() : null);
                    if (!client)
                        return [2 /*return*/, { cleanupStatus: "critical", lastRunAt: null }];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client
                            .from("job_health")
                            .select("last_run_at")
                            .eq("job", "cleanup")
                            .maybeSingle()];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, { cleanupStatus: "critical", lastRunAt: null }];
                    lastRunAt = data.last_run_at;
                    return [2 /*return*/, { cleanupStatus: computeCleanupStatus(lastRunAt), lastRunAt: lastRunAt }];
                case 3:
                    _b = _c.sent();
                    return [2 /*return*/, { cleanupStatus: "critical", lastRunAt: null }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function recordSuccess(deleted) {
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "success";
    _status.lastDeletedCount = deleted;
    _status.consecutiveFailures = 0;
}
function recordError(err) {
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "error";
    _status.lastDeletedCount = null;
    _status.consecutiveFailures += 1;
    logger_js_1.logger.error({ err: err, consecutiveFailures: _status.consecutiveFailures }, "dailyBriefCleanup: purge failed — consecutive failure alert");
}
function recordSkipped() {
    _status.lastRunAt = new Date().toISOString();
    _status.lastOutcome = "skipped";
    _status.lastDeletedCount = null;
}
// ─── Test instrumentation ────────────────────────────────────────────────────
/**
 * Incremented every time purgeOldBriefs is invoked. Exported so scheduler
 * unit tests can assert how many purge calls fired without relying on timing.
 * Not meaningful in production — reads are always zero-cost.
 */
exports._purgeCallCount = 0;
// ─── Purge logic ─────────────────────────────────────────────────────────────
/**
 * Delete daily_briefs rows whose brief_date is older than `retentionDays`.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * and a custom retention window without touching env vars or module state.
 *
 * Returns { deleted, error } so callers (and tests) can inspect the outcome.
 * Never throws — errors are logged and returned.
 */
function purgeOldBriefs(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var client, retentionDays, cutoff, cutoffDate, purgeResult, _a, error, count, deleted, err_1, sc, upsertErr, persistErr_1;
        var _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    exports._purgeCallCount++;
                    client = (_b = opts === null || opts === void 0 ? void 0 : opts.client) !== null && _b !== void 0 ? _b : (supabase_js_1.isServiceClientReady ? (0, supabase_js_1.getServiceClient)() : null);
                    retentionDays = (_c = opts === null || opts === void 0 ? void 0 : opts.retentionDays) !== null && _c !== void 0 ? _c : RETENTION_DAYS;
                    if (!client) {
                        logger_js_1.logger.warn("dailyBriefCleanup: service client not ready — skipping purge");
                        recordSkipped();
                        return [2 /*return*/, { deleted: null, error: null }];
                    }
                    cutoff = new Date();
                    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
                    cutoffDate = cutoff.toISOString().slice(0, 10);
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client
                            .from("daily_briefs")
                            .delete({ count: "exact" })
                            .lt("brief_date", cutoffDate)];
                case 2:
                    _a = _e.sent(), error = _a.error, count = _a.count;
                    if (error) {
                        recordError(error);
                        purgeResult = { deleted: null, error: error };
                    }
                    else {
                        deleted = count !== null && count !== void 0 ? count : 0;
                        recordSuccess(deleted);
                        logger_js_1.logger.info({ deleted: deleted, cutoffDate: cutoffDate }, "dailyBriefCleanup: purged old briefs");
                        purgeResult = { deleted: deleted, error: null };
                    }
                    return [3 /*break*/, 4];
                case 3:
                    err_1 = _e.sent();
                    recordError(err_1);
                    purgeResult = { deleted: null, error: err_1 };
                    return [3 /*break*/, 4];
                case 4:
                    if (!(purgeResult.error === null && _status.lastOutcome === "success")) return [3 /*break*/, 8];
                    sc = (_d = opts === null || opts === void 0 ? void 0 : opts.client) !== null && _d !== void 0 ? _d : (supabase_js_1.isServiceClientReady ? (0, supabase_js_1.getServiceClient)() : null);
                    if (!sc) return [3 /*break*/, 8];
                    _e.label = 5;
                case 5:
                    _e.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, sc
                            .from("job_health")
                            .upsert({ job: "cleanup", last_run_at: _status.lastRunAt, updated_at: _status.lastRunAt }, { onConflict: "job" })];
                case 6:
                    upsertErr = (_e.sent()).error;
                    if (upsertErr) {
                        logger_js_1.logger.warn({ err: upsertErr }, "dailyBriefCleanup: could not persist job health — table may not exist yet");
                    }
                    return [3 /*break*/, 8];
                case 7:
                    persistErr_1 = _e.sent();
                    logger_js_1.logger.warn({ err: persistErr_1 }, "dailyBriefCleanup: could not persist job health");
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/, purgeResult];
            }
        });
    });
}
// ─── Scheduler ───────────────────────────────────────────────────────────────
/**
 * Start the background cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
function startDailyBriefCleanup() {
    var initialTimer = setTimeout(function () {
        purgeOldBriefs().catch(function () { });
    }, exports.STARTUP_DELAY_MS);
    var interval = setInterval(function () {
        purgeOldBriefs().catch(function () { });
    }, exports.INTERVAL_MS);
    interval.unref();
    if (typeof initialTimer.unref === "function") {
        initialTimer.unref();
    }
    logger_js_1.logger.info({ retentionDays: RETENTION_DAYS, intervalHours: exports.INTERVAL_MS / 3600000 }, "dailyBriefCleanup: scheduler started");
    return interval;
}
