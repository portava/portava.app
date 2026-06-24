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
exports.sendUserReminder = sendUserReminder;
exports.sendMissedCheckIn = sendMissedCheckIn;
exports.notifyTrustedCircle = notifyTrustedCircle;
exports.notifyHost = notifyHost;
exports.notifyTripCrew = notifyTripCrew;
var push_1 = require("../../lib/push");
var logger_1 = require("../../lib/logger");
var logger = logger_1.logger.child({ service: "SafeReturnNotificationService" });
// ── Event persistence ─────────────────────────────────────────────────────────
// Advisory-only — never throws; notification failure doesn't block alert flow.
function logNotificationEvent(db_1, session_1, eventType_1) {
    return __awaiter(this, arguments, void 0, function (db, session, eventType, metadata) {
        var err_1;
        if (metadata === void 0) { metadata = {}; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("safe_return_events")
                            .insert({
                            session_id: session.id,
                            user_id: session.userId,
                            event_type: eventType,
                            metadata: metadata,
                        })];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    err_1 = _a.sent();
                    logger.warn({ err: err_1, sessionId: session.id, eventType: eventType }, "SafeReturnNotification: event write failed");
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchPushToken(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("profiles")
                            .select("expo_push_token")
                            .eq("id", userId)
                            .maybeSingle()];
                case 1:
                    data = (_c.sent()).data;
                    return [2 /*return*/, (_b = data === null || data === void 0 ? void 0 : data.expo_push_token) !== null && _b !== void 0 ? _b : null];
                case 2:
                    _a = _c.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function fetchDisplayName(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("profiles")
                            .select("display_name")
                            .eq("id", userId)
                            .maybeSingle()];
                case 1:
                    data = (_c.sent()).data;
                    return [2 /*return*/, (_b = data === null || data === void 0 ? void 0 : data.display_name) !== null && _b !== void 0 ? _b : "A traveler"];
                case 2:
                    _a = _c.sent();
                    return [2 /*return*/, "A traveler"];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Look up the user's last known city/country from user_location_state.
 *  Falls back to "an unknown area" if the table has no record.
 *  Never returns exact GPS. */
function fetchAreaLabel(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, parts, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("user_location_state")
                            .select("city, country")
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 1:
                    data = (_b.sent()).data;
                    parts = [];
                    if (data === null || data === void 0 ? void 0 : data.city)
                        parts.push(data.city);
                    if (data === null || data === void 0 ? void 0 : data.country)
                        parts.push(data.country);
                    return [2 /*return*/, parts.length > 0 ? parts.join(", ") : "an unknown area"];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, "an unknown area"];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Fetch the location name of a trip plan item (for notification context). */
function fetchPlanItemTitle(db, planItemId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!planItemId)
                        return [2 /*return*/, null];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, db
                            .from("trip_plan_items")
                            .select("location_name")
                            .eq("id", planItemId)
                            .maybeSingle()];
                case 2:
                    data = (_c.sent()).data;
                    return [2 /*return*/, (_b = data === null || data === void 0 ? void 0 : data.location_name) !== null && _b !== void 0 ? _b : null];
                case 3:
                    _a = _c.sent();
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ── Notification senders ──────────────────────────────────────────────────────
/** Remind the session owner that a check-in is due. */
function sendUserReminder(db, session) {
    return __awaiter(this, void 0, void 0, function () {
        var token, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetchPushToken(db, session.userId)];
                case 1:
                    token = _a.sent();
                    return [4 /*yield*/, (0, push_1.sendPushNotification)([token], {
                            title: "Safe Return check-in",
                            body: "Are you back okay? Tap to confirm you're safe.",
                            data: { type: "safe_return_reminder", sessionId: session.id },
                        })];
                case 2:
                    _a.sent();
                    logger.info({ sessionId: session.id }, "SafeReturnNotification: reminder sent to session owner");
                    return [3 /*break*/, 4];
                case 3:
                    err_2 = _a.sent();
                    logger.warn({ err: err_2 }, "sendUserReminder: threw");
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Alert the session owner that their check-in was missed. */
function sendMissedCheckIn(db, session) {
    return __awaiter(this, void 0, void 0, function () {
        var token, err_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetchPushToken(db, session.userId)];
                case 1:
                    token = _a.sent();
                    return [4 /*yield*/, (0, push_1.sendPushNotification)([token], {
                            title: "We couldn't confirm you're safe",
                            body: "Your Safe Return timer has expired. Tap to let us know you're okay or get help.",
                            data: { type: "safe_return_missed", sessionId: session.id, escalationLevel: session.escalationLevel },
                        })];
                case 2:
                    _a.sent();
                    logger.info({ sessionId: session.id, level: session.escalationLevel }, "SafeReturnNotification: missed check-in sent");
                    return [3 /*break*/, 4];
                case 3:
                    err_3 = _a.sent();
                    logger.warn({ err: err_3 }, "sendMissedCheckIn: threw");
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Notify selected Trusted Circle contacts (only when trusted_circle_enabled = true).
 * Sends calm, non-alarming message with display name, approximate area, and
 * missed time.  Never includes exact GPS.
 */
function notifyTrustedCircle(db, session, contacts) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, userName, area, planTitle, missedTime, locationPhrase, inAppContacts;
        var _this = this;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!session.trustedCircleEnabled) {
                        logger.info({ sessionId: session.id }, "notifyTrustedCircle: skipped (trusted_circle_enabled=false)");
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, Promise.all([
                            fetchDisplayName(db, session.userId),
                            fetchAreaLabel(db, session.userId),
                            fetchPlanItemTitle(db, session.planItemId),
                        ])];
                case 1:
                    _a = _b.sent(), userName = _a[0], area = _a[1], planTitle = _a[2];
                    missedTime = session.timerEndAt
                        ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                        : "a scheduled time";
                    locationPhrase = planTitle
                        ? "around ".concat(planTitle, " in ").concat(area)
                        : "in ".concat(area);
                    inAppContacts = contacts.filter(function (c) { return c.contactMethod === "in_app" && c.contactUserId; });
                    return [4 /*yield*/, Promise.all(inAppContacts.map(function (c) { return __awaiter(_this, void 0, void 0, function () {
                            var token, err_4;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        _a.trys.push([0, 3, , 4]);
                                        return [4 /*yield*/, fetchPushToken(db, c.contactUserId)];
                                    case 1:
                                        token = _a.sent();
                                        return [4 /*yield*/, (0, push_1.sendPushNotification)([token], {
                                                title: "".concat(userName, " missed their Safe Return check-in"),
                                                body: "They were last ".concat(locationPhrase, " and expected back by ").concat(missedTime, ". They may need support."),
                                                data: {
                                                    type: "safe_return_tc_alert",
                                                    sessionId: session.id,
                                                    contactId: c.id,
                                                },
                                            })];
                                    case 2:
                                        _a.sent();
                                        logger.info({ sessionId: session.id, contactId: c.id }, "notifyTrustedCircle: alert sent");
                                        return [3 /*break*/, 4];
                                    case 3:
                                        err_4 = _a.sent();
                                        logger.warn({ err: err_4, contactId: c.id }, "notifyTrustedCircle: per-contact send failed");
                                        return [3 /*break*/, 4];
                                    case 4: return [2 /*return*/];
                                }
                            });
                        }); }))];
                case 2:
                    _b.sent();
                    return [4 /*yield*/, logNotificationEvent(db, session, "trusted_circle_notified", {
                            contactCount: inAppContacts.length,
                        })];
                case 3:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Notify trip host (only when notify_host_enabled = true).
 * Fetches host from the trip and sends a push notification.
 */
function notifyHost(db, session) {
    return __awaiter(this, void 0, void 0, function () {
        var trip, hostId, _a, userName, area, hostToken, err_5;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!session.notifyHostEnabled || !session.tripId) {
                        logger.info({ sessionId: session.id }, "notifyHost: skipped");
                        return [2 /*return*/];
                    }
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db
                            .from("trips")
                            .select("owner_id")
                            .eq("id", session.tripId)
                            .maybeSingle()];
                case 2:
                    trip = (_b.sent()).data;
                    if (!trip || !trip.owner_id)
                        return [2 /*return*/];
                    hostId = trip.owner_id;
                    if (hostId === session.userId)
                        return [2 /*return*/]; // don't notify yourself
                    return [4 /*yield*/, Promise.all([
                            fetchDisplayName(db, session.userId),
                            fetchAreaLabel(db, session.userId),
                        ])];
                case 3:
                    _a = _b.sent(), userName = _a[0], area = _a[1];
                    return [4 /*yield*/, fetchPushToken(db, hostId)];
                case 4:
                    hostToken = _b.sent();
                    return [4 /*yield*/, (0, push_1.sendPushNotification)([hostToken], {
                            title: "".concat(userName, " missed their Safe Return check-in"),
                            body: "They were last in ".concat(area, ". As trip host, you may wish to check in."),
                            data: { type: "safe_return_host_alert", sessionId: session.id },
                        })];
                case 5:
                    _b.sent();
                    logger.info({ sessionId: session.id, hostId: hostId }, "notifyHost: sent");
                    return [4 /*yield*/, logNotificationEvent(db, session, "host_notified", { hostId: hostId })];
                case 6:
                    _b.sent();
                    return [3 /*break*/, 8];
                case 7:
                    err_5 = _b.sent();
                    logger.warn({ err: err_5 }, "notifyHost: threw");
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Notify accepted trip crew members (only when notify_trip_crew_enabled = true).
 */
function notifyTripCrew(db, session) {
    return __awaiter(this, void 0, void 0, function () {
        var members, _a, userName, area, memberIds, tokens, err_6;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!session.notifyTripCrewEnabled || !session.tripId) {
                        logger.info({ sessionId: session.id }, "notifyTripCrew: skipped");
                        return [2 /*return*/];
                    }
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db
                            .from("trip_members")
                            .select("user_id")
                            .eq("trip_id", session.tripId)
                            .in("role", ["owner", "member"])
                            .neq("user_id", session.userId)];
                case 2:
                    members = (_b.sent()).data;
                    if (!members || members.length === 0)
                        return [2 /*return*/];
                    return [4 /*yield*/, Promise.all([
                            fetchDisplayName(db, session.userId),
                            fetchAreaLabel(db, session.userId),
                        ])];
                case 3:
                    _a = _b.sent(), userName = _a[0], area = _a[1];
                    memberIds = members.map(function (m) { return m.user_id; });
                    return [4 /*yield*/, Promise.all(memberIds.map(function (id) { return fetchPushToken(db, id); }))];
                case 4:
                    tokens = _b.sent();
                    return [4 /*yield*/, (0, push_1.sendPushNotification)(tokens, {
                            title: "".concat(userName, " missed their Safe Return check-in"),
                            body: "They were last in ".concat(area, ". Reach out if you can."),
                            data: { type: "safe_return_crew_alert", sessionId: session.id },
                        })];
                case 5:
                    _b.sent();
                    logger.info({ sessionId: session.id, crewCount: memberIds.length }, "notifyTripCrew: sent");
                    return [4 /*yield*/, logNotificationEvent(db, session, "crew_notified", { crewCount: memberIds.length })];
                case 6:
                    _b.sent();
                    return [3 /*break*/, 8];
                case 7:
                    err_6 = _b.sent();
                    logger.warn({ err: err_6 }, "notifyTripCrew: threw");
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/];
            }
        });
    });
}
