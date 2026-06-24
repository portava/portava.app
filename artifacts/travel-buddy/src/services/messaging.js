"use strict";
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
exports.getMyMessageSettings = getMyMessageSettings;
exports.updateMyMessageSettings = updateMyMessageSettings;
exports.getMyLanguageSettings = getMyLanguageSettings;
exports.updateMyLanguageSettings = updateMyLanguageSettings;
exports.getMessagePermission = getMessagePermission;
exports.sendMessageRequest = sendMessageRequest;
exports.getIncomingMessageRequests = getIncomingMessageRequests;
exports.getOutgoingRequestStatus = getOutgoingRequestStatus;
exports.acceptMessageRequest = acceptMessageRequest;
exports.declineMessageRequest = declineMessageRequest;
exports.cancelMessageRequest = cancelMessageRequest;
exports.getMyThreads = getMyThreads;
exports.getUnreadCounts = getUnreadCounts;
exports.markNotificationsRead = markNotificationsRead;
exports.markHighlightsViewed = markHighlightsViewed;
exports.markThreadRead = markThreadRead;
exports.openTripChat = openTripChat;
exports.openCircleChat = openCircleChat;
exports.getTripChat = getTripChat;
exports.getCircleChat = getCircleChat;
exports.syncTripChat = syncTripChat;
exports.syncCircleChat = syncCircleChat;
exports.getThreadMessages = getThreadMessages;
exports.sendMessage = sendMessage;
exports.sendTyping = sendTyping;
exports.muteThread = muteThread;
exports.leaveThread = leaveThread;
exports.sendDiscoveryCard = sendDiscoveryCard;
exports.retryTranslation = retryTranslation;
exports.editMessage = editMessage;
exports.reportThread = reportThread;
exports.reportMessage = reportMessage;
exports.deleteMessage = deleteMessage;
/**
 * Messaging service — typed client over the API server.
 *
 * Covers:
 *   - Message settings (GET/PATCH)
 *   - Language settings (GET/PATCH)
 *   - Message permission (GET verdict)
 *   - Message requests (send, accept, decline, cancel, list incoming)
 *   - Threads (list, open group chat)
 *   - Messages (list paginated, send, retry translation)
 *
 * All writes go through the API server (service-role + JWT verification).
 * No private posts, trip data, live location, or GPS are accessible here.
 */
var supabase_1 = require("../lib/supabase");
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
function freshToken() {
    return __awaiter(this, void 0, void 0, function () {
        var refreshed, session, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, supabase_1.supabase.auth.refreshSession()];
                case 1:
                    refreshed = (_d.sent()).data;
                    if (!((_b = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _b !== void 0)) return [3 /*break*/, 2];
                    _a = _b;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 3:
                    _a = (_d.sent()).data.session;
                    _d.label = 4;
                case 4:
                    session = _a;
                    return [2 /*return*/, (_c = session === null || session === void 0 ? void 0 : session.access_token) !== null && _c !== void 0 ? _c : null];
            }
        });
    });
}
function mapApiError(status, body) {
    var _a, _b;
    var code = (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : 'db_error';
    var known = ['unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error'];
    return {
        ok: false,
        data: null,
        errorKind: known.includes(code) ? code : 'db_error',
        message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(status),
    };
}
function isNetworkError(e) {
    if (!(e instanceof Error))
        return false;
    return e.message.includes('Network request failed') || e.message.includes('fetch');
}
function apiGet(path) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_1;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: null }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_1 = _d.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiPost(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_2;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: body !== undefined ? JSON.stringify(body) : undefined,
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_2 = _d.sent();
                    if (isNetworkError(e_2))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_2 instanceof Error ? e_2.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiPatch(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_3;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify(body),
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_3 = _d.sent();
                    if (isNetworkError(e_3))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_3 instanceof Error ? e_3.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
// ── Message settings ──────────────────────────────────────────────────────────
function getMyMessageSettings() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/message-settings')];
        });
    });
}
function updateMyMessageSettings(patch) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPatch('/api/me/message-settings', patch)];
        });
    });
}
// ── Language settings ─────────────────────────────────────────────────────────
function getMyLanguageSettings() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/language-settings')];
        });
    });
}
function updateMyLanguageSettings(patch) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPatch('/api/me/language-settings', patch)];
        });
    });
}
// ── Permission check ──────────────────────────────────────────────────────────
function getMessagePermission(userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/users/".concat(userId, "/message-permission"))];
        });
    });
}
// ── Message requests ──────────────────────────────────────────────────────────
function sendMessageRequest(userId, previewText) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/users/".concat(userId, "/message-request"), previewText ? { previewText: previewText } : undefined)];
        });
    });
}
function getIncomingMessageRequests() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/message-requests')];
        });
    });
}
function getOutgoingRequestStatus(userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/users/".concat(userId, "/outgoing-request"))];
        });
    });
}
function acceptMessageRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/message-requests/".concat(requestId, "/accept"))];
        });
    });
}
function declineMessageRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/message-requests/".concat(requestId, "/decline"))];
        });
    });
}
function cancelMessageRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/message-requests/".concat(requestId, "/cancel"))];
        });
    });
}
// ── Threads ───────────────────────────────────────────────────────────────────
function getMyThreads() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/threads')];
        });
    });
}
function getUnreadCounts() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/unread-counts')];
        });
    });
}
function markNotificationsRead() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost('/api/me/notifications/read-all')];
        });
    });
}
function markHighlightsViewed() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost('/api/me/highlights/mark-viewed')];
        });
    });
}
function markThreadRead(threadId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/threads/".concat(threadId, "/read"))];
        });
    });
}
// ── Group chat ────────────────────────────────────────────────────────────────
/**
 * Get (or create) the group chat thread for a trip.
 * The caller must be an accepted trip member (owner or member role).
 */
function openTripChat(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/trips/".concat(tripId, "/chat"))];
        });
    });
}
function openCircleChat(circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/circles/".concat(circleOwnerId, "/chat"))];
        });
    });
}
function getTripChat(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/trips/".concat(tripId, "/chat"))];
        });
    });
}
function getCircleChat(circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/circles/".concat(circleOwnerId, "/chat"))];
        });
    });
}
function syncTripChat(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/trips/".concat(tripId, "/chat/sync"))];
        });
    });
}
function syncCircleChat(circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/circles/".concat(circleOwnerId, "/chat/sync"))];
        });
    });
}
// ── Messages ──────────────────────────────────────────────────────────────────
function getThreadMessages(threadId, before) {
    return __awaiter(this, void 0, void 0, function () {
        var qs;
        return __generator(this, function (_a) {
            qs = before ? "?before=".concat(encodeURIComponent(before)) : '';
            return [2 /*return*/, apiGet("/api/threads/".concat(threadId, "/messages").concat(qs))];
        });
    });
}
function sendMessage(threadId, body, opts) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/threads/".concat(threadId, "/messages"), __assign({ body: body }, opts))];
        });
    });
}
/**
 * Relay a transient typing indicator to the other thread members. Best-effort —
 * a failed call is silently ignored (typing is non-critical presence).
 */
function sendTyping(threadId, typing) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiPost("/api/threads/".concat(threadId, "/typing"), { typing: typing }).catch(function () { return undefined; })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function muteThread(threadId, muted) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPatch("/api/threads/".concat(threadId, "/mute"), { muted: muted })];
        });
    });
}
function leaveThread(threadId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/threads/".concat(threadId, "/leave"))];
        });
    });
}
function sendDiscoveryCard(threadId, payload) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, sendMessage(threadId, JSON.stringify(payload), { msgType: 'system', subtype: 'discovery_card' })];
        });
    });
}
function retryTranslation(messageId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/messages/".concat(messageId, "/translate/retry"))];
        });
    });
}
function editMessage(messageId, body) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPatch("/api/messages/".concat(messageId), { body: body })];
        });
    });
}
function reportThread(threadId, reason) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_4;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/threads/").concat(threadId, "/report"), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason: reason }),
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_4 = _d.sent();
                    if (isNetworkError(e_4))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_4 instanceof Error ? e_4.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function reportMessage(messageId, reason) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_5;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/messages/").concat(messageId, "/report"), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reason: reason }),
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_5 = _d.sent();
                    if (isNetworkError(e_5))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_5 instanceof Error ? e_5.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function deleteMessage(messageId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_6;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/messages/").concat(messageId), {
                            method: 'DELETE',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_6 = _d.sent();
                    if (isNetworkError(e_6))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_6 instanceof Error ? e_6.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
