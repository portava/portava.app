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
exports.getMyProfile = getMyProfile;
exports.updateMyProfile = updateMyProfile;
exports.checkUsername = checkUsername;
exports.uploadAvatar = uploadAvatar;
exports.uploadCover = uploadCover;
exports.getPublicProfile = getPublicProfile;
exports.getPublicPassport = getPublicPassport;
exports.getPublicPostcards = getPublicPostcards;
exports.getMyStamps = getMyStamps;
exports.getMyPassportPostcards = getMyPassportPostcards;
exports.updatePostcard = updatePostcard;
exports.removePostcard = removePostcard;
/**
 * Profile service — wraps the API server's profile endpoints.
 * All mutations route through the API server (service-role pattern, matching
 * createTrip / createPost). Reads also go through the API server so we can
 * do server-side joins/filtering cleanly.
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
/* ---------- Own profile ---------- */
function getMyProfile() {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_1;
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/profile"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _d.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: (_c = body === null || body === void 0 ? void 0 : body.message) !== null && _c !== void 0 ? _c : "API ".concat(res.status) }];
                case 5:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_a.data = _d.sent(), _a)];
                case 7:
                    e_1 = _d.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function updateMyProfile(patch) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_2;
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/profile"), {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify(patch),
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _d.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: (_c = body === null || body === void 0 ? void 0 : body.message) !== null && _c !== void 0 ? _c : "API ".concat(res.status) }];
                case 5:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_a.data = _d.sent(), _a)];
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
/* ---------- Username check ---------- */
function checkUsername(username) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { available: false, reason: 'Backend not configured' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { available: false, reason: 'Not signed in' }];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/check-username?username=").concat(encodeURIComponent(username.toLowerCase().trim())), { headers: { Authorization: "Bearer ".concat(token) } })];
                case 3:
                    res = _b.sent();
                    if (!res.ok)
                        return [2 /*return*/, { available: false, reason: 'Could not check username' }];
                    return [4 /*yield*/, res.json()];
                case 4: return [2 /*return*/, _b.sent()];
                case 5:
                    _a = _b.sent();
                    return [2 /*return*/, { available: false, reason: 'Network error' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Avatar upload ---------- */
function uploadAvatar(uri_1) {
    return __awaiter(this, arguments, void 0, function (uri, mimeType) {
        var token, blob, resp, e_3, res, body_1, body, e_4;
        var _a;
        if (mimeType === void 0) { mimeType = 'image/jpeg'; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' }];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch(uri)];
                case 3:
                    resp = _b.sent();
                    return [4 /*yield*/, resp.blob()];
                case 4:
                    blob = _b.sent();
                    return [3 /*break*/, 6];
                case 5:
                    e_3 = _b.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'read_failed', message: 'Failed to read image file' }];
                case 6:
                    if (blob.size > 5 * 1024 * 1024) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'too_large', message: 'Avatar must be under 5 MB' }];
                    }
                    _b.label = 7;
                case 7:
                    _b.trys.push([7, 12, , 13]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/avatar/upload"), {
                            method: 'POST',
                            headers: { 'Content-Type': mimeType, Authorization: "Bearer ".concat(token) },
                            body: blob,
                        })];
                case 8:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 10];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 9:
                    body_1 = _b.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'upload_failed', message: (_a = body_1 === null || body_1 === void 0 ? void 0 : body_1.message) !== null && _a !== void 0 ? _a : "Upload failed (".concat(res.status, ")") }];
                case 10: return [4 /*yield*/, res.json()];
                case 11:
                    body = _b.sent();
                    return [2 /*return*/, { ok: true, data: { url: body.url } }];
                case 12:
                    e_4 = _b.sent();
                    if (isNetworkError(e_4))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'upload_failed', message: e_4 instanceof Error ? e_4.message : 'Unknown' }];
                case 13: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Cover photo upload ---------- */
function uploadCover(uri_1) {
    return __awaiter(this, arguments, void 0, function (uri, mimeType) {
        var token, blob, resp, e_5, res, body_2, body, e_6;
        var _a;
        if (mimeType === void 0) { mimeType = 'image/jpeg'; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' }];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch(uri)];
                case 3:
                    resp = _b.sent();
                    return [4 /*yield*/, resp.blob()];
                case 4:
                    blob = _b.sent();
                    return [3 /*break*/, 6];
                case 5:
                    e_5 = _b.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'read_failed', message: 'Failed to read image file' }];
                case 6:
                    if (blob.size > 10 * 1024 * 1024) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'too_large', message: 'Cover photo must be under 10 MB' }];
                    }
                    _b.label = 7;
                case 7:
                    _b.trys.push([7, 12, , 13]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/cover/upload"), {
                            method: 'POST',
                            headers: { 'Content-Type': mimeType, Authorization: "Bearer ".concat(token) },
                            body: blob,
                        })];
                case 8:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 10];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 9:
                    body_2 = _b.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'upload_failed', message: (_a = body_2 === null || body_2 === void 0 ? void 0 : body_2.message) !== null && _a !== void 0 ? _a : "Upload failed (".concat(res.status, ")") }];
                case 10: return [4 /*yield*/, res.json()];
                case 11:
                    body = _b.sent();
                    return [2 /*return*/, { ok: true, data: { url: body.url } }];
                case 12:
                    e_6 = _b.sent();
                    if (isNetworkError(e_6))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'upload_failed', message: e_6 instanceof Error ? e_6.message : 'Unknown' }];
                case 13: return [2 /*return*/];
            }
        });
    });
}
function getPublicProfile(username) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body, e_7;
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 6, , 7]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(username), "/profile"))];
                case 2:
                    res = _d.sent();
                    if (res.status === 404)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'not_found', message: 'User not found' }];
                    if (!!res.ok) return [3 /*break*/, 4];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 3:
                    body = _d.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_b = body === null || body === void 0 ? void 0 : body.error) !== null && _b !== void 0 ? _b : 'db_error', message: (_c = body === null || body === void 0 ? void 0 : body.message) !== null && _c !== void 0 ? _c : "API ".concat(res.status) }];
                case 4:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 5: return [2 /*return*/, (_a.data = _d.sent(), _a)];
                case 6:
                    e_7 = _d.sent();
                    if (isNetworkError(e_7))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_7 instanceof Error ? e_7.message : 'Unknown' }];
                case 7: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Public passport ---------- */
function getPublicPassport(username) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body, e_8;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!apiBase()) {
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    }
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 6, , 7]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(username), "/passport"))];
                case 2:
                    res = _c.sent();
                    if (res.status === 404)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'not_found', message: 'User not found' }];
                    if (!!res.ok) return [3 /*break*/, 4];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 3:
                    body = _c.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(res.status) }];
                case 4:
                    _a = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 5: return [2 /*return*/, (_a.data = _c.sent(), _a)];
                case 6:
                    e_8 = _c.sent();
                    if (isNetworkError(e_8))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_8 instanceof Error ? e_8.message : 'Unknown' }];
                case 7: return [2 /*return*/];
            }
        });
    });
}
function getPublicPostcards(username) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(encodeURIComponent(username), "/passport/postcards"))];
                case 2:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, res.json()];
                case 3:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.postcards) !== null && _b !== void 0 ? _b : [] }];
                case 4:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, data: [] }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Own stamps ---------- */
function getMyStamps() {
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
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/stamps"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, res.json()];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.stamps) !== null && _b !== void 0 ? _b : [] }];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, data: [] }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/* ---------- Own passport postcards ---------- */
function getMyPassportPostcards() {
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
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/me/passport/postcards"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, res.json()];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, data: (_b = body.postcards) !== null && _b !== void 0 ? _b : [] }];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, data: [] }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function updatePostcard(id, patch) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_9;
        var _a;
        var _b;
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
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/passport/postcards/").concat(id), {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify(patch),
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
                    e_9 = _c.sent();
                    if (isNetworkError(e_9))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_9 instanceof Error ? e_9.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function removePostcard(id) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_10;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/passport/postcards/").concat(id, "/remove"), {
                            method: 'PATCH',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _b.sent();
                    if (res.status === 204)
                        return [2 /*return*/, { ok: true, data: null }];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _b.sent();
                    return [2 /*return*/, { ok: false, data: null, errorKind: (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : 'db_error', message: body === null || body === void 0 ? void 0 : body.message }];
                case 5:
                    e_10 = _b.sent();
                    if (isNetworkError(e_10))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_10 instanceof Error ? e_10.message : 'Unknown' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
