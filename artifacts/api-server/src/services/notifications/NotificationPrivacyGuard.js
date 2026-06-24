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
exports.NotificationPrivacyGuard = void 0;
exports.stripGPSCoordinates = stripGPSCoordinates;
var logger_js_1 = require("../../lib/logger.js");
var logger = logger_js_1.logger.child({ service: "NotificationPrivacyGuard" });
// ── GPS coordinate stripper ───────────────────────────────────────────────────
// Matches common coordinate patterns: "12.3456, -78.9012" or "(lat: 12.34, lng: -78.90)"
var GPS_PATTERN = /[-+]?\d{1,3}\.\d{4,}[,\s]+[-+]?\d{1,3}\.\d{4,}/g;
var LAT_LNG_LABEL_PATTERN = /\b(lat(itude)?|lng|lon(gitude)?)\s*[:=]\s*[-+]?\d+\.\d+/gi;
function stripGPSCoordinates(text) {
    return text
        .replace(GPS_PATTERN, '[location]')
        .replace(LAT_LNG_LABEL_PATTERN, '[location]');
}
// ── Context checked categories that need privacy rules ────────────────────────
var LOCATION_CATEGORIES = new Set(['location', 'safe_return']);
var TRUST_CATEGORIES = new Set(['trust']);
var NotificationPrivacyGuard = /** @class */ (function () {
    function NotificationPrivacyGuard(db) {
        this.db = db;
    }
    /**
     * Sanitise a notification before delivery.
     * Returns { blocked: true } when the notification must be silently dropped.
     */
    NotificationPrivacyGuard.prototype.sanitise = function (title, body, ctx) {
        return __awaiter(this, void 0, void 0, function () {
            var safeTitle, safeBody, sanitizeText, isGhost, isRemoved, isPending, privacyLevel;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        safeTitle = stripGPSCoordinates(title);
                        safeBody = stripGPSCoordinates(body);
                        // 2. Suppress live-share exact coordinates in push previews
                        if (ctx.isLiveShare && ctx.isPushPreview) {
                            safeBody = 'Live location active — open the app to view.';
                        }
                        // 3. Trust notifications: hide reporter identity (apply to both title and body)
                        if (TRUST_CATEGORIES.has(ctx.category)) {
                            sanitizeText = function (text) { return text
                                .replace(/reported by [^.\n]+/gi, 'reported by a community member')
                                .replace(/reporter\s*:[^\n]+/gi, 'reporter: [protected]'); };
                            safeTitle = sanitizeText(safeTitle);
                            safeBody = sanitizeText(safeBody);
                        }
                        if (!(ctx.senderId && LOCATION_CATEGORIES.has(ctx.category))) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.isUserInGhostMode(ctx.senderId)];
                    case 1:
                        isGhost = _a.sent();
                        if (isGhost) {
                            logger.info({ senderId: ctx.senderId, category: ctx.category }, 'PrivacyGuard: blocked — sender in Ghost Mode');
                            return [2 /*return*/, { title: safeTitle, body: safeBody, blocked: true, blockReason: 'ghost_mode', privacyLevel: 'ghost_hidden' }];
                        }
                        _a.label = 2;
                    case 2:
                        if (!(ctx.tripId && (ctx.category === 'trips' || ctx.category === 'plans'))) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.isTripMemberRemoved(ctx.recipientId, ctx.tripId)];
                    case 3:
                        isRemoved = _a.sent();
                        if (isRemoved) {
                            logger.info({ recipientId: ctx.recipientId, tripId: ctx.tripId }, 'PrivacyGuard: blocked — recipient removed from trip');
                            return [2 /*return*/, { title: safeTitle, body: safeBody, blocked: true, blockReason: 'removed_from_trip', privacyLevel: 'standard' }];
                        }
                        _a.label = 4;
                    case 4:
                        if (!(ctx.tripId && ctx.category === 'plans' && ctx.eventType === 'plan.item_added')) return [3 /*break*/, 6];
                        return [4 /*yield*/, this.isTripMemberPending(ctx.recipientId, ctx.tripId)];
                    case 5:
                        isPending = _a.sent();
                        if (isPending) {
                            logger.info({ recipientId: ctx.recipientId, tripId: ctx.tripId }, 'PrivacyGuard: blocked — recipient is pending trip member');
                            return [2 /*return*/, { title: safeTitle, body: safeBody, blocked: true, blockReason: 'pending_member', privacyLevel: 'sensitive' }];
                        }
                        _a.label = 6;
                    case 6:
                        privacyLevel = LOCATION_CATEGORIES.has(ctx.category) ? 'sensitive' : 'standard';
                        return [2 /*return*/, { title: safeTitle, body: safeBody, blocked: false, privacyLevel: privacyLevel }];
                }
            });
        });
    };
    NotificationPrivacyGuard.prototype.isUserInGhostMode = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var data, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.db
                                .from('location_preferences')
                                .select('location_mode')
                                .eq('user_id', userId)
                                .maybeSingle()];
                    case 1:
                        data = (_b.sent()).data;
                        return [2 /*return*/, (data === null || data === void 0 ? void 0 : data.location_mode) === 'ghost'];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    NotificationPrivacyGuard.prototype.isTripMemberRemoved = function (userId, tripId) {
        return __awaiter(this, void 0, void 0, function () {
            var data, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.db
                                .from('trip_members')
                                .select('role')
                                .eq('user_id', userId)
                                .eq('trip_id', tripId)
                                .maybeSingle()];
                    case 1:
                        data = (_b.sent()).data;
                        // No row = removed/never member; "removed" role if that exists
                        if (!data)
                            return [2 /*return*/, true];
                        return [2 /*return*/, data.role === 'removed'];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    NotificationPrivacyGuard.prototype.isTripMemberPending = function (userId, tripId) {
        return __awaiter(this, void 0, void 0, function () {
            var data, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.db
                                .from('trip_members')
                                .select('role')
                                .eq('user_id', userId)
                                .eq('trip_id', tripId)
                                .maybeSingle()];
                    case 1:
                        data = (_b.sent()).data;
                        return [2 /*return*/, (data === null || data === void 0 ? void 0 : data.role) === 'invited'];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return NotificationPrivacyGuard;
}());
exports.NotificationPrivacyGuard = NotificationPrivacyGuard;
