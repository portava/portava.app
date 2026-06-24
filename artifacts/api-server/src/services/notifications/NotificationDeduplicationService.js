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
exports.NotificationDeduplicationService = void 0;
var logger_js_1 = require("../../lib/logger.js");
var logger = logger_js_1.logger.child({ service: "NotificationDeduplicationService" });
var COALESCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes for message coalescence
var NEARBY_THROTTLE_MS = 60 * 60 * 1000; // 1 hour for nearby recommendations
var COMPASS_DAILY_LIMIT = 3; // max Compass suggestions per day
var DEFAULT_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes for general dedup
var NotificationDeduplicationService = /** @class */ (function () {
    function NotificationDeduplicationService(db) {
        this.db = db;
    }
    /**
     * Check whether a notification should be suppressed as a duplicate.
     * Returns { isDuplicate: true } when the notification should be skipped.
     */
    NotificationDeduplicationService.prototype.check = function (params) {
        return __awaiter(this, void 0, void 0, function () {
            var userId, category, eventType, sourceType, sourceId, isDup, isDup, count, isDup;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        userId = params.userId, category = params.category, eventType = params.eventType, sourceType = params.sourceType, sourceId = params.sourceId;
                        if (!(category === 'telegraph' && eventType === 'telegraph.message' && sourceId)) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.hasRecentNotification(userId, category, sourceType !== null && sourceType !== void 0 ? sourceType : 'thread', sourceId, COALESCE_WINDOW_MS)];
                    case 1:
                        isDup = _a.sent();
                        if (isDup) {
                            logger.debug({ userId: userId, sourceId: sourceId }, 'dedup: coalescing telegraph.message');
                            return [2 /*return*/, { isDuplicate: true, reason: 'message_coalesced' }];
                        }
                        _a.label = 2;
                    case 2:
                        if (!(category === 'location' && (eventType === 'location.nearby_traveler' || eventType === 'airport.traveler_nearby'))) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.hasRecentNotification(userId, category, sourceType !== null && sourceType !== void 0 ? sourceType : 'area', sourceId !== null && sourceId !== void 0 ? sourceId : '', NEARBY_THROTTLE_MS)];
                    case 3:
                        isDup = _a.sent();
                        if (isDup) {
                            logger.debug({ userId: userId }, 'dedup: throttling nearby recommendation');
                            return [2 /*return*/, { isDuplicate: true, reason: 'nearby_throttled' }];
                        }
                        _a.label = 4;
                    case 4:
                        if (!(category === 'compass' && eventType === 'compass.recommendation')) return [3 /*break*/, 6];
                        return [4 /*yield*/, this.countTodayNotifications(userId, category)];
                    case 5:
                        count = _a.sent();
                        if (count >= COMPASS_DAILY_LIMIT) {
                            logger.debug({ userId: userId, count: count }, 'dedup: compass daily limit reached');
                            return [2 /*return*/, { isDuplicate: true, reason: 'compass_rate_limited' }];
                        }
                        _a.label = 6;
                    case 6:
                        if (!(sourceType && sourceId)) return [3 /*break*/, 8];
                        return [4 /*yield*/, this.hasRecentNotification(userId, category, sourceType, sourceId, DEFAULT_DEDUP_WINDOW_MS)];
                    case 7:
                        isDup = _a.sent();
                        if (isDup) {
                            logger.debug({ userId: userId, category: category, sourceType: sourceType, sourceId: sourceId }, 'dedup: general dedup hit');
                            return [2 /*return*/, { isDuplicate: true, reason: 'general_dedup' }];
                        }
                        _a.label = 8;
                    case 8: return [2 /*return*/, { isDuplicate: false }];
                }
            });
        });
    };
    NotificationDeduplicationService.prototype.hasRecentNotification = function (userId, category, sourceType, sourceId, windowMs) {
        return __awaiter(this, void 0, void 0, function () {
            var since, data, err_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        since = new Date(Date.now() - windowMs).toISOString();
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .select('id')
                                .eq('user_id', userId)
                                .eq('category', category)
                                .eq('source_type', sourceType)
                                .eq('source_id', sourceId)
                                .gt('created_at', since)
                                .limit(1)];
                    case 1:
                        data = (_a.sent()).data;
                        return [2 /*return*/, Array.isArray(data) && data.length > 0];
                    case 2:
                        err_1 = _a.sent();
                        logger.warn({ err: err_1 }, 'dedup: DB check failed, allowing notification');
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    NotificationDeduplicationService.prototype.countTodayNotifications = function (userId, category) {
        return __awaiter(this, void 0, void 0, function () {
            var startOfDay, data, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        startOfDay = new Date();
                        startOfDay.setHours(0, 0, 0, 0);
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .select('id')
                                .eq('user_id', userId)
                                .eq('category', category)
                                .gt('created_at', startOfDay.toISOString())];
                    case 1:
                        data = (_b.sent()).data;
                        return [2 /*return*/, Array.isArray(data) ? data.length : 0];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, 0];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return NotificationDeduplicationService;
}());
exports.NotificationDeduplicationService = NotificationDeduplicationService;
