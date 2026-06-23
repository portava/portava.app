"use strict";
/**
 * Weather Cache Cleanup
 *
 * Purges weather_cache rows older than WEATHER_CACHE_RETENTION_HOURS (default 48)
 * hours so the table does not grow unbounded. Runs once on startup (after a short
 * delay) and then every 24 hours.
 *
 * Only rows outside the active cache TTL window are deleted — rows that would
 * still be served from cache are always younger than the 6-hour TTL, so the
 * 48-hour retention window leaves plenty of headroom.
 *
 * Failures are logged and swallowed — the cleanup is best-effort and must
 * never crash the server.
 */
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
exports.STARTUP_DELAY_MS = exports.CLEANUP_INTERVAL_MS = void 0;
exports.parseRetentionHours = parseRetentionHours;
exports.purgeOldWeatherCache = purgeOldWeatherCache;
exports.startWeatherCacheCleanup = startWeatherCacheCleanup;
var supabase_js_1 = require("./supabase.js");
var logger_js_1 = require("./logger.js");
// ─── Configuration ────────────────────────────────────────────────────────────
/** Parse WEATHER_CACHE_RETENTION_HOURS. Returns 48 (default) when missing/invalid. */
function parseRetentionHours(raw) {
    var parsed = raw !== undefined ? parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 48;
}
var RETENTION_HOURS = parseRetentionHours(process.env.WEATHER_CACHE_RETENTION_HOURS);
/** How long between cleanup runs (ms). Exported for unit tests. */
exports.CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Initial delay before the first run (ms). Slightly after the brief cleanup. */
exports.STARTUP_DELAY_MS = 35 * 1000;
// ─── Purge logic ─────────────────────────────────────────────────────────────
/**
 * Delete weather_cache rows whose cached_at is older than `retentionHours`.
 *
 * Accepts optional overrides so unit tests can inject a fake Supabase client
 * and a custom retention window without touching env vars.
 *
 * Returns { deleted, error } — never throws.
 */
function purgeOldWeatherCache(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var client, retentionHours, cutoff, _a, error, count, deleted, err_1;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    client = (_b = opts === null || opts === void 0 ? void 0 : opts.client) !== null && _b !== void 0 ? _b : (supabase_js_1.isServiceClientReady ? (0, supabase_js_1.getServiceClient)() : null);
                    retentionHours = (_c = opts === null || opts === void 0 ? void 0 : opts.retentionHours) !== null && _c !== void 0 ? _c : RETENTION_HOURS;
                    if (!client) {
                        logger_js_1.logger.warn("weatherCacheCleanup: service client not ready — skipping purge");
                        return [2 /*return*/, { deleted: null, error: null }];
                    }
                    cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client
                            .from("weather_cache")
                            .delete({ count: "exact" })
                            .lt("fetched_at", cutoff)];
                case 2:
                    _a = _d.sent(), error = _a.error, count = _a.count;
                    if (error) {
                        logger_js_1.logger.error({ err: error }, "weatherCacheCleanup: purge failed");
                        return [2 /*return*/, { deleted: null, error: error }];
                    }
                    deleted = count !== null && count !== void 0 ? count : 0;
                    logger_js_1.logger.info({ deleted: deleted, cutoff: cutoff, retentionHours: retentionHours }, "weatherCacheCleanup: purged stale weather cache rows");
                    return [2 /*return*/, { deleted: deleted, error: null }];
                case 3:
                    err_1 = _d.sent();
                    logger_js_1.logger.error({ err: err_1 }, "weatherCacheCleanup: purge threw unexpectedly");
                    return [2 /*return*/, { deleted: null, error: err_1 }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ─── Scheduler ───────────────────────────────────────────────────────────────
/**
 * Start the background weather cache cleanup scheduler.
 * Returns the interval handle so callers can cancel it in tests if needed.
 */
function startWeatherCacheCleanup() {
    var initialTimer = setTimeout(function () {
        purgeOldWeatherCache().catch(function () { });
    }, exports.STARTUP_DELAY_MS);
    var interval = setInterval(function () {
        purgeOldWeatherCache().catch(function () { });
    }, exports.CLEANUP_INTERVAL_MS);
    interval.unref();
    if (typeof initialTimer.unref === "function") {
        initialTimer.unref();
    }
    logger_js_1.logger.info({ retentionHours: RETENTION_HOURS, intervalHours: exports.CLEANUP_INTERVAL_MS / 3600000 }, "weatherCacheCleanup: scheduler started");
    return interval;
}
