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
exports.startShare = startShare;
exports.stopShare = stopShare;
exports.expireShare = expireShare;
exports.getRecipientView = getRecipientView;
var logger_1 = require("../../lib/logger");
var logger = logger_1.logger.child({ service: "SafeReturnLiveShareService" });
// ── Default share duration ────────────────────────────────────────────────────
var DEFAULT_SHARE_DURATION_MINUTES = 60;
// ── Mapper ────────────────────────────────────────────────────────────────────
function mapShare(r) {
    var _a, _b, _c, _d;
    return {
        id: r.id,
        sessionId: r.session_id,
        userId: r.user_id,
        recipientUserId: (_a = r.recipient_user_id) !== null && _a !== void 0 ? _a : null,
        recipientContactId: (_b = r.recipient_contact_id) !== null && _b !== void 0 ? _b : null,
        status: r.status,
        startedAt: r.started_at,
        expiresAt: (_c = r.expires_at) !== null && _c !== void 0 ? _c : null,
        stoppedAt: (_d = r.stopped_at) !== null && _d !== void 0 ? _d : null,
    };
}
// ── Service functions ─────────────────────────────────────────────────────────
/**
 * Start a live share for a given contact.
 * Requires live_share_enabled = true on the session (caller must verify).
 */
function startShare(db_1, sessionId_1, userId_1, recipientUserId_1, recipientContactId_1) {
    return __awaiter(this, arguments, void 0, function (db, sessionId, userId, recipientUserId, recipientContactId, durationMinutes) {
        var expiresAt, _a, data, error, _b, err_1;
        if (durationMinutes === void 0) { durationMinutes = DEFAULT_SHARE_DURATION_MINUTES; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    expiresAt = new Date(Date.now() + durationMinutes * 60000).toISOString();
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .insert({
                            session_id: sessionId,
                            user_id: userId,
                            recipient_user_id: recipientUserId,
                            recipient_contact_id: recipientContactId,
                            expires_at: expiresAt,
                        })
                            .select("*")
                            .single()];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "startShare: insert failed");
                        return [2 /*return*/, null];
                    }
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, db.from("safe_return_events").insert({
                            session_id: sessionId,
                            user_id: userId,
                            event_type: "live_share_started",
                            metadata: { shareId: data.id, recipientUserId: recipientUserId, durationMinutes: durationMinutes },
                        })];
                case 4:
                    _c.sent();
                    return [3 /*break*/, 6];
                case 5:
                    _b = _c.sent();
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/, mapShare(data)];
                case 7:
                    err_1 = _c.sent();
                    logger.warn({ err: err_1 }, "startShare: threw");
                    return [2 /*return*/, null];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * User explicitly stops the live share.
 */
function stopShare(db, shareId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, _b, err_2;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 6, , 7]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .update({ status: "stopped", stopped_at: now })
                            .eq("id", shareId)
                            .eq("user_id", userId)
                            .eq("status", "active")
                            .select("*")
                            .single()];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "stopShare: update failed");
                        return [2 /*return*/, null];
                    }
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, db.from("safe_return_events").insert({
                            session_id: data.session_id,
                            user_id: userId,
                            event_type: "live_share_stopped",
                            metadata: { shareId: shareId },
                        })];
                case 3:
                    _c.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _b = _c.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/, mapShare(data)];
                case 6:
                    err_2 = _c.sent();
                    logger.warn({ err: err_2 }, "stopShare: threw");
                    return [2 /*return*/, null];
                case 7: return [2 /*return*/];
            }
        });
    });
}
/**
 * Mark a share as expired (called by cron/background job).
 * Service-role only (no userId ownership check).
 */
function expireShare(db, shareId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b, err_3;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 6, , 7]);
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .update({ status: "expired" })
                            .eq("id", shareId)
                            .eq("status", "active")
                            .lt("expires_at", new Date().toISOString())
                            .select("*")
                            .single()];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, db.from("safe_return_events").insert({
                            session_id: data.session_id,
                            user_id: data.user_id,
                            event_type: "live_share_expired",
                            metadata: { shareId: shareId },
                        })];
                case 3:
                    _c.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _b = _c.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/, mapShare(data)];
                case 6:
                    err_3 = _c.sent();
                    logger.warn({ err: err_3 }, "expireShare: threw");
                    return [2 /*return*/, null];
                case 7: return [2 /*return*/];
            }
        });
    });
}
/**
 * Get the recipient-safe view of a live share.
 *
 * Authorization rules (ALL must pass):
 *   1. Share exists
 *   2. Caller is the recipient_user_id (or the sharer themselves for preview)
 *   3. Contact row has can_receive_live_location = true
 *   4. status = 'active'
 *   5. expires_at has NOT passed (hard cutoff, enforced in code)
 */
function getRecipientView(db, shareId, callerUserId) {
    return __awaiter(this, void 0, void 0, function () {
        var share, s, contact, locState, parts, approximateArea, sharingUserName, profile, _a, secondsRemaining, err_4;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 9, , 10]);
                    return [4 /*yield*/, db
                            .from("safe_return_live_shares")
                            .select("*")
                            .eq("id", shareId)
                            .maybeSingle()];
                case 1:
                    share = (_c.sent()).data;
                    if (!share)
                        return [2 /*return*/, { error: "not_found" }];
                    s = mapShare(share);
                    // Hard expiry check (code-level, before DB status)
                    if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
                        // Opportunistically expire in DB (fire-and-forget)
                        expireShare(db, shareId).catch(function () { });
                        return [2 /*return*/, { error: "expired" }];
                    }
                    if (s.status === "stopped")
                        return [2 /*return*/, { error: "stopped" }];
                    if (s.status === "expired")
                        return [2 /*return*/, { error: "expired" }];
                    // Authorization: caller must be the recipient_user_id
                    if (s.recipientUserId !== callerUserId && s.userId !== callerUserId) {
                        return [2 /*return*/, { error: "forbidden" }];
                    }
                    if (!s.recipientContactId) return [3 /*break*/, 3];
                    return [4 /*yield*/, db
                            .from("safe_return_contacts")
                            .select("can_receive_live_location")
                            .eq("id", s.recipientContactId)
                            .maybeSingle()];
                case 2:
                    contact = (_c.sent()).data;
                    if (!contact || !contact.can_receive_live_location) {
                        return [2 /*return*/, { error: "forbidden" }];
                    }
                    _c.label = 3;
                case 3: return [4 /*yield*/, db
                        .from("user_location_state")
                        .select("city, country")
                        .eq("user_id", s.userId)
                        .maybeSingle()];
                case 4:
                    locState = (_c.sent()).data;
                    parts = [];
                    if (locState === null || locState === void 0 ? void 0 : locState.city)
                        parts.push(locState.city);
                    if (locState === null || locState === void 0 ? void 0 : locState.country)
                        parts.push(locState.country);
                    approximateArea = parts.length > 0 ? parts.join(", ") : "location unknown";
                    sharingUserName = "A traveler";
                    _c.label = 5;
                case 5:
                    _c.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, db
                            .from("profiles")
                            .select("display_name")
                            .eq("id", s.userId)
                            .maybeSingle()];
                case 6:
                    profile = (_c.sent()).data;
                    sharingUserName = (_b = profile === null || profile === void 0 ? void 0 : profile.display_name) !== null && _b !== void 0 ? _b : "A traveler";
                    return [3 /*break*/, 8];
                case 7:
                    _a = _c.sent();
                    return [3 /*break*/, 8];
                case 8:
                    secondsRemaining = s.expiresAt
                        ? Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000))
                        : null;
                    return [2 /*return*/, {
                            view: {
                                shareId: s.id,
                                status: s.status,
                                sharingUserName: sharingUserName,
                                approximateArea: approximateArea,
                                expiresAt: s.expiresAt,
                                secondsRemaining: secondsRemaining,
                            },
                        }];
                case 9:
                    err_4 = _c.sent();
                    logger.warn({ err: err_4 }, "getRecipientView: threw");
                    return [2 /*return*/, { error: "not_found" }];
                case 10: return [2 /*return*/];
            }
        });
    });
}
