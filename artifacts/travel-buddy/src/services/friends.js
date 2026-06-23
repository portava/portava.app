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
exports.getFriendStatus = getFriendStatus;
exports.sendFriendRequest = sendFriendRequest;
exports.acceptFriendRequest = acceptFriendRequest;
exports.declineFriendRequest = declineFriendRequest;
exports.cancelFriendRequest = cancelFriendRequest;
exports.getIncomingFriendRequests = getIncomingFriendRequests;
exports.getOutgoingFriendRequests = getOutgoingFriendRequests;
exports.getMyFriends = getMyFriends;
exports.getTripMembers = getTripMembers;
exports.getCircleMembers = getCircleMembers;
exports.getTripInvitableUsers = getTripInvitableUsers;
exports.getCircleInvitableUsers = getCircleInvitableUsers;
exports.getProfileByHandle = getProfileByHandle;
exports.getProfileById = getProfileById;
exports.sendCircleInvite = sendCircleInvite;
exports.acceptCircleInvite = acceptCircleInvite;
exports.declineCircleInvite = declineCircleInvite;
exports.sendTripInvite = sendTripInvite;
exports.acceptTripInvite = acceptTripInvite;
exports.declineTripInvite = declineTripInvite;
/**
 * Friends service — typed client over the API server for friend requests,
 * friendships, circle invites, and profile-by-handle lookup.
 *
 * All writes go through the API server (service-role + user JWT verification).
 * The client never writes directly to friend_requests or user_friendships.
 */
var supabase_1 = require("../lib/supabase");
function apiBase() { var _a; return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''; }
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
    return { ok: false, data: null, errorKind: known.includes(code) ? code : 'db_error', message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(status) };
}
function isNetworkError(e) {
    if (!(e instanceof Error))
        return false;
    return e.message.includes('Network request failed') || e.message.includes('fetch');
}
function apiPost(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_1;
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
                    e_1 = _d.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiGet(path) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_2;
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
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), { headers: { Authorization: "Bearer ".concat(token) } })];
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
// ── Friend requests ──────────────────────────────────────────────────────────
function getFriendStatus(userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/users/".concat(userId, "/friend-status"))];
        });
    });
}
function sendFriendRequest(userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/users/".concat(userId, "/friend-request"))];
        });
    });
}
function acceptFriendRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/friend-requests/".concat(requestId, "/accept"))];
        });
    });
}
function declineFriendRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/friend-requests/".concat(requestId, "/decline"))];
        });
    });
}
function cancelFriendRequest(requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/friend-requests/".concat(requestId, "/cancel"))];
        });
    });
}
function getIncomingFriendRequests() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/friend-requests/incoming')];
        });
    });
}
function getOutgoingFriendRequests() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/friend-requests/outgoing')];
        });
    });
}
function getMyFriends() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/friends')];
        });
    });
}
function getTripMembers(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/trips/".concat(encodeURIComponent(tripId), "/members"))];
        });
    });
}
function getCircleMembers(circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/circles/".concat(encodeURIComponent(circleOwnerId), "/members"))];
        });
    });
}
function getTripInvitableUsers(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/trips/".concat(encodeURIComponent(tripId), "/invitable-users"))];
        });
    });
}
function getCircleInvitableUsers(circleOwnerId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/circles/".concat(encodeURIComponent(circleOwnerId), "/invitable-users"))];
        });
    });
}
// ── Profile lookup ───────────────────────────────────────────────────────────
function getProfileByHandle(handle) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/users/by-handle/".concat(encodeURIComponent(handle)))];
        });
    });
}
function getProfileById(userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet("/api/users/".concat(userId))];
        });
    });
}
// ── Circle invites ───────────────────────────────────────────────────────────
function sendCircleInvite(recipientId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost('/api/circle-invites', { recipientId: recipientId })];
        });
    });
}
function acceptCircleInvite(inviteId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/circle-invites/".concat(inviteId, "/accept"))];
        });
    });
}
function declineCircleInvite(inviteId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/circle-invites/".concat(inviteId, "/decline"))];
        });
    });
}
// ── Trip invites ─────────────────────────────────────────────────────────────
function sendTripInvite(tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/trips/".concat(tripId, "/invite"), { userId: userId })];
        });
    });
}
function acceptTripInvite(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/trips/".concat(tripId, "/accept-invite"))];
        });
    });
}
function declineTripInvite(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/trips/".concat(tripId, "/decline-invite"))];
        });
    });
}
