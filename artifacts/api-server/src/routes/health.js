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
var express_1 = require("express");
var api_zod_1 = require("@workspace/api-zod");
var dailyBriefCleanup_js_1 = require("../lib/dailyBriefCleanup.js");
var weatherCacheCleanup_js_1 = require("../lib/weatherCacheCleanup.js");
var logger_js_1 = require("../lib/logger.js");
var router = (0, express_1.Router)();
router.get("/healthz", function (_req, res) {
    var data = api_zod_1.HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
});
router.get("/healthz/cleanup", function (_req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var inMem, _a, cleanupStatus, lastRunAt, data;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                inMem = (0, dailyBriefCleanup_js_1.getCleanupStatus)();
                return [4 /*yield*/, (0, dailyBriefCleanup_js_1.queryCleanupHealth)()];
            case 1:
                _a = _b.sent(), cleanupStatus = _a.cleanupStatus, lastRunAt = _a.lastRunAt;
                if (cleanupStatus === "critical") {
                    logger_js_1.logger.error({ lastRunAt: lastRunAt, consecutiveFailures: inMem.consecutiveFailures }, "cleanupHealthCheck: cleanup job is critically overdue — immediate attention required");
                }
                else if (cleanupStatus === "overdue") {
                    logger_js_1.logger.warn({ lastRunAt: lastRunAt, consecutiveFailures: inMem.consecutiveFailures }, "cleanupHealthCheck: cleanup job has not run within the expected window");
                }
                data = api_zod_1.CleanupHealthCheckResponse.parse({
                    cleanupStatus: cleanupStatus,
                    lastRunAt: lastRunAt,
                    lastOutcome: inMem.lastOutcome,
                    lastDeletedCount: inMem.lastDeletedCount,
                    consecutiveFailures: inMem.consecutiveFailures,
                });
                res.json(data);
                return [2 /*return*/];
        }
    });
}); });
/**
 * POST /admin/cleanup/weather-cache
 *
 * Internal endpoint — triggers an immediate weather cache purge and returns
 * the number of rows deleted. No external auth required; intended for
 * server-side or scheduled invocation only (not exposed to mobile clients).
 */
router.post("/admin/cleanup/weather-cache", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var secret, provided, _a, deleted, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                secret = process.env.CLEANUP_ADMIN_SECRET;
                if (secret) {
                    provided = req.headers["x-cleanup-secret"];
                    if (provided !== secret) {
                        res.status(401).json({ error: "unauthorized" });
                        return [2 /*return*/];
                    }
                }
                return [4 /*yield*/, (0, weatherCacheCleanup_js_1.purgeOldWeatherCache)()];
            case 1:
                _a = _b.sent(), deleted = _a.deleted, error = _a.error;
                if (error) {
                    logger_js_1.logger.error({ err: error }, "admin/cleanup/weather-cache: purge failed");
                    res.status(500).json({ error: "purge_failed" });
                    return [2 /*return*/];
                }
                res.json({ deleted: deleted !== null && deleted !== void 0 ? deleted : 0 });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
