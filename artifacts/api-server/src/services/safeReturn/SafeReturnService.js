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
exports.createSession = createSession;
exports.startSession = startSession;
exports.extendTimer = extendTimer;
exports.confirmSafe = confirmSafe;
exports.cancelSession = cancelSession;
exports.markMissed = markMissed;
exports.getActiveSession = getActiveSession;
exports.getSessionById = getSessionById;
exports.listHistory = listHistory;
exports.listContacts = listContacts;
exports.findExpiredActiveSessions = findExpiredActiveSessions;
exports.closeSession = closeSession;
exports.markContactNotified = markContactNotified;
var logger_1 = require("../../lib/logger");
var logger = logger_1.logger.child({ service: "SafeReturnService" });
// ── Mapper ────────────────────────────────────────────────────────────────────
function mapSession(r) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return {
        id: r.id,
        userId: r.user_id,
        planItemId: (_a = r.plan_item_id) !== null && _a !== void 0 ? _a : null,
        tripId: (_b = r.trip_id) !== null && _b !== void 0 ? _b : null,
        status: r.status,
        triggerReason: (_c = r.trigger_reason) !== null && _c !== void 0 ? _c : null,
        escalationLevel: Number((_d = r.escalation_level) !== null && _d !== void 0 ? _d : 0),
        timerStartAt: (_e = r.timer_start_at) !== null && _e !== void 0 ? _e : null,
        timerEndAt: (_f = r.timer_end_at) !== null && _f !== void 0 ? _f : null,
        lastPromptAt: (_g = r.last_prompt_at) !== null && _g !== void 0 ? _g : null,
        lastSafeConfirmationAt: (_h = r.last_safe_confirmation_at) !== null && _h !== void 0 ? _h : null,
        trustedCircleEnabled: Boolean(r.trusted_circle_enabled),
        liveShareEnabled: Boolean(r.live_share_enabled),
        notifyHostEnabled: Boolean(r.notify_host_enabled),
        notifyTripCrewEnabled: Boolean(r.notify_trip_crew_enabled),
        emergencyNote: (_j = r.emergency_note) !== null && _j !== void 0 ? _j : null,
        closedAt: (_k = r.closed_at) !== null && _k !== void 0 ? _k : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function mapContact(r) {
    var _a, _b, _c, _d, _e, _f;
    return {
        id: r.id,
        sessionId: r.session_id,
        contactUserId: (_a = r.contact_user_id) !== null && _a !== void 0 ? _a : null,
        contactName: (_b = r.contact_name) !== null && _b !== void 0 ? _b : null,
        contactPhone: (_c = r.contact_phone) !== null && _c !== void 0 ? _c : null,
        contactEmail: (_d = r.contact_email) !== null && _d !== void 0 ? _d : null,
        contactMethod: r.contact_method,
        canReceiveLiveLocation: Boolean(r.can_receive_live_location),
        notifiedAt: (_e = r.notified_at) !== null && _e !== void 0 ? _e : null,
        acknowledgedAt: (_f = r.acknowledged_at) !== null && _f !== void 0 ? _f : null,
    };
}
// ── Event writer ──────────────────────────────────────────────────────────────
function writeEvent(db_1, sessionId_1, userId_1, eventType_1) {
    return __awaiter(this, arguments, void 0, function (db, sessionId, userId, eventType, metadata) {
        var err_1;
        if (metadata === void 0) { metadata = {}; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db.from("safe_return_events").insert({ session_id: sessionId, user_id: userId, event_type: eventType, metadata: metadata })];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    err_1 = _a.sent();
                    logger.warn({ err: err_1, sessionId: sessionId, eventType: eventType }, "SafeReturnService: event write failed (non-fatal)");
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ── Service functions ─────────────────────────────────────────────────────────
/**
 * Create a new Safe Return session (status = pending).
 * Optionally inserts contacts.  Returns the new session.
 */
function createSession(db, input) {
    return __awaiter(this, void 0, void 0, function () {
        var timerEndAt, _a, data, error, session_1, contactRows, cErr, err_2;
        var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        return __generator(this, function (_m) {
            switch (_m.label) {
                case 0:
                    timerEndAt = input.timerMinutes
                        ? new Date(Date.now() + input.timerMinutes * 60000).toISOString()
                        : null;
                    _m.label = 1;
                case 1:
                    _m.trys.push([1, 6, , 7]);
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .insert({
                            user_id: input.userId,
                            plan_item_id: (_b = input.planItemId) !== null && _b !== void 0 ? _b : null,
                            trip_id: (_c = input.tripId) !== null && _c !== void 0 ? _c : null,
                            trigger_reason: (_d = input.triggerReason) !== null && _d !== void 0 ? _d : null,
                            escalation_level: (_e = input.escalationLevel) !== null && _e !== void 0 ? _e : 0,
                            timer_end_at: timerEndAt,
                            trusted_circle_enabled: (_f = input.trustedCircleEnabled) !== null && _f !== void 0 ? _f : false,
                            live_share_enabled: (_g = input.liveShareEnabled) !== null && _g !== void 0 ? _g : false,
                            notify_host_enabled: (_h = input.notifyHostEnabled) !== null && _h !== void 0 ? _h : false,
                            notify_trip_crew_enabled: (_j = input.notifyTripCrewEnabled) !== null && _j !== void 0 ? _j : false,
                            emergency_note: (_k = input.emergencyNote) !== null && _k !== void 0 ? _k : null,
                        })
                            .select("*")
                            .single()];
                case 2:
                    _a = _m.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "createSession: insert failed");
                        return [2 /*return*/, null];
                    }
                    session_1 = mapSession(data);
                    if (!(input.contacts && input.contacts.length > 0)) return [3 /*break*/, 4];
                    contactRows = input.contacts.map(function (c) {
                        var _a, _b, _c, _d, _e;
                        return ({
                            session_id: session_1.id,
                            contact_user_id: (_a = c.contactUserId) !== null && _a !== void 0 ? _a : null,
                            contact_name: (_b = c.contactName) !== null && _b !== void 0 ? _b : null,
                            contact_phone: (_c = c.contactPhone) !== null && _c !== void 0 ? _c : null,
                            contact_email: (_d = c.contactEmail) !== null && _d !== void 0 ? _d : null,
                            contact_method: c.contactMethod,
                            can_receive_live_location: (_e = c.canReceiveLiveLocation) !== null && _e !== void 0 ? _e : false,
                        });
                    });
                    return [4 /*yield*/, db.from("safe_return_contacts").insert(contactRows)];
                case 3:
                    cErr = (_m.sent()).error;
                    if (cErr)
                        logger.warn({ err: cErr }, "createSession: contact insert failed (non-fatal)");
                    _m.label = 4;
                case 4: return [4 /*yield*/, writeEvent(db, session_1.id, input.userId, "session_created", {
                        escalationLevel: session_1.escalationLevel,
                        timerMinutes: (_l = input.timerMinutes) !== null && _l !== void 0 ? _l : null,
                    })];
                case 5:
                    _m.sent();
                    return [2 /*return*/, session_1];
                case 6:
                    err_2 = _m.sent();
                    logger.warn({ err: err_2 }, "createSession: threw");
                    return [2 /*return*/, null];
                case 7: return [2 /*return*/];
            }
        });
    });
}
/** Start the timer (status pending → active, sets timer_start_at). */
function startSession(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, err_3;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .update({ status: "active", timer_start_at: now, updated_at: now })
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .eq("status", "pending")
                            .select("*")
                            .single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "startSession: update failed");
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, writeEvent(db, sessionId, userId, "session_started")];
                case 2:
                    _b.sent();
                    return [2 /*return*/, mapSession(data)];
                case 3:
                    err_3 = _b.sent();
                    logger.warn({ err: err_3 }, "startSession: threw");
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Extend timer_end_at by `minutes`. */
function extendTimer(db, sessionId, userId, minutes) {
    return __awaiter(this, void 0, void 0, function () {
        var cur, base, newEnd, now, _a, data, error, err_4;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 4, , 5]);
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .select("timer_end_at, status")
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 1:
                    cur = (_b.sent()).data;
                    if (!cur)
                        return [2 /*return*/, null];
                    if (cur.status !== "active" && cur.status !== "missed")
                        return [2 /*return*/, null];
                    base = cur.timer_end_at ? new Date(cur.timer_end_at) : new Date();
                    newEnd = new Date(Math.max(base.getTime(), Date.now()) + minutes * 60000).toISOString();
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .update({ timer_end_at: newEnd, status: "active", updated_at: now })
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .select("*")
                            .single()];
                case 2:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "extendTimer: update failed");
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, writeEvent(db, sessionId, userId, "timer_extended", { minutes: minutes, newEnd: newEnd })];
                case 3:
                    _b.sent();
                    return [2 /*return*/, mapSession(data)];
                case 4:
                    err_4 = _b.sent();
                    logger.warn({ err: err_4 }, "extendTimer: threw");
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
/** User confirms they are safe (status → safe). */
function confirmSafe(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, err_5;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .update({
                            status: "safe",
                            last_safe_confirmation_at: now,
                            closed_at: now,
                            updated_at: now,
                        })
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .in("status", ["active", "missed", "pending"])
                            .select("*")
                            .single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "confirmSafe: update failed");
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, writeEvent(db, sessionId, userId, "safe_confirmed")];
                case 2:
                    _b.sent();
                    return [2 /*return*/, mapSession(data)];
                case 3:
                    err_5 = _b.sent();
                    logger.warn({ err: err_5 }, "confirmSafe: threw");
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** User explicitly cancels before expiry (status → cancelled). */
function cancelSession(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, err_6;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .update({ status: "cancelled", closed_at: now, updated_at: now })
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .in("status", ["pending", "active"])
                            .select("*")
                            .single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "cancelSession: update failed");
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, writeEvent(db, sessionId, userId, "session_cancelled")];
                case 2:
                    _b.sent();
                    return [2 /*return*/, mapSession(data)];
                case 3:
                    err_6 = _b.sent();
                    logger.warn({ err: err_6 }, "cancelSession: threw");
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Mark session as missed (internal/cron — service-role only).
 * Called when timer_end_at has passed without safe confirmation.
 */
function markMissed(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, err_7;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .update({ status: "missed", last_prompt_at: now, updated_at: now })
                            .eq("id", sessionId)
                            .eq("status", "active")
                            .select("*")
                            .single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data) {
                        logger.warn({ err: error }, "markMissed: update failed");
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, writeEvent(db, sessionId, userId, "check_in_missed")];
                case 2:
                    _b.sent();
                    return [2 /*return*/, mapSession(data)];
                case 3:
                    err_7 = _b.sent();
                    logger.warn({ err: err_7 }, "markMissed: threw");
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Get the most recent active/pending session for a user. */
function getActiveSession(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .select("*")
                            .eq("user_id", userId)
                            .in("status", ["pending", "active", "missed"])
                            .order("created_at", { ascending: false })
                            .limit(1)
                            .maybeSingle()];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapSession(data)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Get a single session by ID, scoped to the user. */
function getSessionById(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .select("*")
                            .eq("id", sessionId)
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapSession(data)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** List past sessions for a user (history), ordered newest-first. */
function listHistory(db_1, userId_1) {
    return __awaiter(this, arguments, void 0, function (db, userId, limit) {
        var _a, data, error, _b;
        if (limit === void 0) { limit = 20; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .select("*")
                            .eq("user_id", userId)
                            .order("created_at", { ascending: false })
                            .limit(limit)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapSession)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** List contacts for a session (scoped to session owner). */
function listContacts(db, sessionId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var session, _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, getSessionById(db, sessionId, userId)];
                case 1:
                    session = _c.sent();
                    if (!session)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, db
                            .from("safe_return_contacts")
                            .select("*")
                            .eq("session_id", sessionId)];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapContact)];
                case 3:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Find all active sessions whose timer has expired.
 * Intended for the background scheduler only (service-role client).
 */
function findExpiredActiveSessions(db) {
    return __awaiter(this, void 0, void 0, function () {
        var now, _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    now = new Date().toISOString();
                    return [4 /*yield*/, db
                            .from("safe_return_sessions")
                            .select("*")
                            .eq("status", "active")
                            .not("timer_end_at", "is", null)
                            .lt("timer_end_at", now)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapSession)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Unified session closer — delegates to confirmSafe or cancelSession.
 * Prefer calling confirmSafe / cancelSession directly when the intent is
 * unambiguous; use closeSession when the call site receives mode from user
 * input or a shared utility.
 */
function closeSession(db_1, sessionId_1, userId_1) {
    return __awaiter(this, arguments, void 0, function (db, sessionId, userId, mode) {
        if (mode === void 0) { mode = "safe"; }
        return __generator(this, function (_a) {
            return [2 /*return*/, mode === "cancel"
                    ? cancelSession(db, sessionId, userId)
                    : confirmSafe(db, sessionId, userId)];
        });
    });
}
/** Mark a contact as notified. */
function markContactNotified(db, contactId) {
    return __awaiter(this, void 0, void 0, function () {
        var err_8;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("safe_return_contacts")
                            .update({ notified_at: new Date().toISOString() })
                            .eq("id", contactId)
                            .is("notified_at", null)];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    err_8 = _a.sent();
                    logger.warn({ err: err_8 }, "markContactNotified: threw");
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
