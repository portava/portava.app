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
exports.followUser = followUser;
exports.unfollowUser = unfollowUser;
exports.getFollowStatus = getFollowStatus;
exports.getMyFollowing = getMyFollowing;
exports.searchUsers = searchUsers;
exports.getMyFollowers = getMyFollowers;
/**
 * follows service — wraps the API server's follow endpoints.
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
function isNetworkError(e) {
    var m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    return (m.includes('failed to fetch') ||
        m.includes('network request failed') ||
        m.includes('err_address_unreachable') ||
        m.includes('networkerror') ||
        m.includes('load failed'));
}
/* ---------- Follow ---------- */
function followUser(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_1;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(userId), "/follow"), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: body === null || body === void 0 ? void 0 : body.message }];
                case 5:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_a.data = _c.sent(), _a)];
                case 7:
                    e_1 = _c.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Unfollow ---------- */
function unfollowUser(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_2;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(userId), "/follow"), {
                            method: 'DELETE',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: body === null || body === void 0 ? void 0 : body.message }];
                case 5:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_a.data = _c.sent(), _a)];
                case 7:
                    e_2 = _c.sent();
                    if (isNetworkError(e_2))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_2 instanceof Error ? e_2.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Follow status ---------- */
function getFollowStatus(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_3;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(userId), "/follow-status"), { headers: { Authorization: "Bearer ".concat(token) } })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: body === null || body === void 0 ? void 0 : body.message }];
                case 5:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_a.data = _c.sent(), _a)];
                case 7:
                    e_3 = _c.sent();
                    if (isNetworkError(e_3))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_3 instanceof Error ? e_3.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/* ---------- My following list ---------- */
function getMyFollowing() {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/following"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, res.json()];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.users) !== null && _b !== void 0 ? _b : [] }];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, data: [] }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function searchUsers(query_1) {
    return __awaiter(this, arguments, void 0, function (query, limit) {
        var token, q, res, body_1, body, e_4;
        var _a, _b;
        if (limit === void 0) { limit = 20; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    q = encodeURIComponent(query.trim());
                    if (!q)
                        return [2 /*return*/, { ok: true, data: [] }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/search?q=").concat(q, "&limit=").concat(limit), { headers: { Authorization: "Bearer ".concat(token) } })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body_1 = _c.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_a = body_1 === null || body_1 === void 0 ? void 0 : body_1.error) !== null && _a !== void 0 ? _a : 'db_error', message: body_1 === null || body_1 === void 0 ? void 0 : body_1.message }];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.users) !== null && _b !== void 0 ? _b : [] }];
                case 7:
                    e_4 = _c.sent();
                    if (isNetworkError(e_4))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_4 instanceof Error ? e_4.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/* ---------- My followers list ---------- */
function getMyFollowers() {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/followers"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, res.json()];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.users) !== null && _b !== void 0 ? _b : [] }];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, data: [] }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
