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
exports.startSafeReturnScheduler = startSafeReturnScheduler;
exports.stopSafeReturnScheduler = stopSafeReturnScheduler;
/**
 * safeReturnScheduler
 *
 * Background job that runs periodically to:
 *  1. Detect active Safe Return sessions whose timer has expired and escalate them.
 *  2. Expire stale live-shares (status='active', expires_at < now).
 *
 * Uses the service-role client — never fires user-auth requests — so it is safe
 * to run as a true internal cron path independent of any HTTP request lifecycle.
 */
var logger_1 = require("./logger");
var supabase_1 = require("./supabase");
var SafeReturnService_1 = require("../services/safeReturn/SafeReturnService");
var SafeReturnNotificationService_1 = require("../services/safeReturn/SafeReturnNotificationService");
var SafeReturnLiveShareService_1 = require("../services/safeReturn/SafeReturnLiveShareService");
var logger = logger_1.logger.child({ job: "SafeReturnScheduler" });
var POLL_INTERVAL_MS = 60000; // every 60 seconds
// ── Inline feature-flag helper (service-role only) ────────────────────────────
function isFlagEnabled(db, flag) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("feature_flags")
                            .select("enabled")
                            .eq("key", flag)
                            .maybeSingle()];
                case 1:
                    data = (_b.sent()).data;
                    return [2 /*return*/, (data === null || data === void 0 ? void 0 : data.enabled) === true];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ── Expired session escalation ────────────────────────────────────────────────
function processExpiredSessions() {
    return __awaiter(this, void 0, void 0, function () {
        var db, flagEnabled, expired, flagTcAlerts, _i, expired_1, session, missed, contacts, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    db = (0, supabase_1.getServiceClient)();
                    if (!db) {
                        logger.warn("processExpiredSessions: no service client, skipping");
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled").catch(function () { return false; })];
                case 1:
                    flagEnabled = _a.sent();
                    if (!flagEnabled)
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, SafeReturnService_1.findExpiredActiveSessions)(db)];
                case 2:
                    expired = _a.sent();
                    if (expired.length === 0)
                        return [2 /*return*/];
                    logger.info({ count: expired.length }, "processExpiredSessions: processing sessions");
                    return [4 /*yield*/, isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled").catch(function () { return false; })];
                case 3:
                    flagTcAlerts = _a.sent();
                    _i = 0, expired_1 = expired;
                    _a.label = 4;
                case 4:
                    if (!(_i < expired_1.length)) return [3 /*break*/, 17];
                    session = expired_1[_i];
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 15, , 16]);
                    return [4 /*yield*/, (0, SafeReturnService_1.markMissed)(db, session.id, session.userId)];
                case 6:
                    missed = _a.sent();
                    if (!missed)
                        return [3 /*break*/, 16];
                    return [4 /*yield*/, (0, SafeReturnNotificationService_1.sendMissedCheckIn)(db, missed)];
                case 7:
                    _a.sent();
                    if (!(missed.escalationLevel >= 1 && flagTcAlerts)) return [3 /*break*/, 11];
                    return [4 /*yield*/, (0, SafeReturnService_1.listContacts)(db, missed.id, missed.userId)];
                case 8:
                    contacts = _a.sent();
                    return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyTrustedCircle)(db, missed, contacts)];
                case 9:
                    _a.sent();
                    return [4 /*yield*/, Promise.all(contacts.map(function (c) { return (0, SafeReturnService_1.markContactNotified)(db, c.id); }))];
                case 10:
                    _a.sent();
                    _a.label = 11;
                case 11:
                    if (!(missed.escalationLevel >= 3)) return [3 /*break*/, 14];
                    return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyHost)(db, missed)];
                case 12:
                    _a.sent();
                    return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyTripCrew)(db, missed)];
                case 13:
                    _a.sent();
                    _a.label = 14;
                case 14:
                    logger.info({ sessionId: session.id, level: session.escalationLevel }, "processExpiredSessions: escalated");
                    return [3 /*break*/, 16];
                case 15:
                    err_1 = _a.sent();
                    logger.warn({ err: err_1, sessionId: session.id }, "processExpiredSessions: error processing session");
                    return [3 /*break*/, 16];
                case 16:
                    _i++;
                    return [3 /*break*/, 4];
                case 17: return [2 /*return*/];
            }
        });
    });
}
// ── Stale live-share expiry ───────────────────────────────────────────────────
function processExpiredLiveShares() {
    return __awaiter(this, void 0, void 0, function () {
        var db, now, stale, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    db = (0, supabase_1.getServiceClient)();
                    if (!db)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .select("id")
                            .eq("status", "active")
                            .not("expires_at", "is", null)
                            .lt("expires_at", now)
                            .limit(50)];
                case 2:
                    stale = (_a.sent()).data;
                    if (!stale || stale.length === 0)
                        return [2 /*return*/];
                    logger.info({ count: stale.length }, "processExpiredLiveShares: expiring stale shares");
                    return [4 /*yield*/, Promise.allSettled(stale.map(function (row) {
                            return (0, SafeReturnLiveShareService_1.expireShare)(db, row.id).catch(function (err) {
                                return logger.warn({ err: err, shareId: row.id }, "processExpiredLiveShares: expireShare threw");
                            });
                        }))];
                case 3:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 4:
                    err_2 = _a.sent();
                    logger.warn({ err: err_2 }, "processExpiredLiveShares: threw");
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ── Ticker ────────────────────────────────────────────────────────────────────
function tick() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.allSettled([
                        processExpiredSessions(),
                        processExpiredLiveShares(),
                    ])];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
var _interval = null;
function startSafeReturnScheduler() {
    if (_interval)
        return;
    logger.info({ intervalMs: POLL_INTERVAL_MS }, "SafeReturnScheduler: starting");
    _interval = setInterval(function () {
        tick().catch(function (err) { return logger.warn({ err: err }, "SafeReturnScheduler: tick threw"); });
    }, POLL_INTERVAL_MS);
    // Run immediately on startup (brief delay to let the server finish init)
    setTimeout(function () {
        tick().catch(function (err) { return logger.warn({ err: err }, "SafeReturnScheduler: initial tick threw"); });
    }, 5000);
}
function stopSafeReturnScheduler() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}
