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
exports.createPost = createPost;
exports.listGlobalPosts = listGlobalPosts;
exports.listTripPosts = listTripPosts;
exports.updatePost = updatePost;
exports.deletePost = deletePost;
/**
 * Posts service — typed client over the API SERVER (not supabase tables).
 *
 * Posts are written/read through the API server (service-role, server-side
 * authorization), mirroring how createTrip() works. The client NEVER writes
 * posts directly via supabase-js, and never sees the service-role key. We send
 * the user's Bearer access token; the server derives author_id from it.
 *
 * UI calls these functions; it never calls fetch or supabase for posts itself.
 */
var supabase_1 = require("../lib/supabase");
function mapPost(r) {
    var _a, _b, _c;
    return {
        id: r.id,
        authorId: r.author_id,
        tripId: (_a = r.trip_id) !== null && _a !== void 0 ? _a : null,
        content: (_b = r.content) !== null && _b !== void 0 ? _b : '',
        mediaUrls: (_c = r.media_urls) !== null && _c !== void 0 ? _c : [],
        visibility: r.visibility,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
/** Fresh token, mirroring createTrip(): refresh then fall back to current session. */
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
/** Map an API error envelope { error, message } to our typed result. */
function mapApiError(status, body) {
    var _a, _b;
    var code = (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : 'db_error';
    var known = [
        'unauthenticated', 'forbidden', 'not_member', 'invalid_payload', 'not_found', 'db_error',
    ];
    var errorKind = known.includes(code) ? code : 'db_error';
    return { ok: false, data: null, errorKind: errorKind, message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(status) };
}
function isNetworkError(e) {
    var m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    return (m.includes('failed to fetch') ||
        m.includes('network request failed') ||
        m.includes('err_address_unreachable') ||
        m.includes('networkerror') ||
        m.includes('load failed'));
}
function createPost(input) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, _a, e_1;
        var _b;
        var _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
        return __generator(this, function (_t) {
            switch (_t.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    if (!apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'API base URL not set' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _t.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated', message: 'Please sign in' }];
                    _t.label = 2;
                case 2:
                    _t.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/posts"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify({
                                content: (_c = input.content) !== null && _c !== void 0 ? _c : '',
                                mediaUrls: (_d = input.mediaUrls) !== null && _d !== void 0 ? _d : [],
                                tripId: (_e = input.tripId) !== null && _e !== void 0 ? _e : null,
                                visibility: (_f = input.visibility) !== null && _f !== void 0 ? _f : 'public',
                                // media + passport
                                mediaType: (_g = input.mediaType) !== null && _g !== void 0 ? _g : null,
                                addToPassport: (_h = input.addToPassport) !== null && _h !== void 0 ? _h : true,
                                // tagged location (NOTE: we never send location_verified — the server decides)
                                locationName: (_j = input.locationName) !== null && _j !== void 0 ? _j : null,
                                locationPlaceId: (_k = input.locationPlaceId) !== null && _k !== void 0 ? _k : null,
                                locationCity: (_l = input.locationCity) !== null && _l !== void 0 ? _l : null,
                                locationCountry: (_m = input.locationCountry) !== null && _m !== void 0 ? _m : null,
                                locationLat: (_o = input.locationLat) !== null && _o !== void 0 ? _o : null,
                                locationLng: (_p = input.locationLng) !== null && _p !== void 0 ? _p : null,
                                // private GPS for server-side verification only
                                userGpsLat: (_q = input.userGpsLat) !== null && _q !== void 0 ? _q : null,
                                userGpsLng: (_r = input.userGpsLng) !== null && _r !== void 0 ? _r : null,
                                locationSource: (_s = input.locationSource) !== null && _s !== void 0 ? _s : 'none',
                            }),
                        })];
                case 3:
                    res = _t.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _t.sent();
                    return [2 /*return*/, mapApiError(res.status, body)];
                case 5:
                    _b = { ok: true };
                    _a = mapPost;
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_b.data = _a.apply(void 0, [_t.sent()]), _b)];
                case 7:
                    e_1 = _t.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/** Global feed: public standalone active posts. */
function listGlobalPosts(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var token, params, qs, res, body_1, body, e_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    params = new URLSearchParams();
                    if (opts === null || opts === void 0 ? void 0 : opts.limit)
                        params.set('limit', String(opts.limit));
                    if (opts === null || opts === void 0 ? void 0 : opts.before)
                        params.set('before', opts.before);
                    qs = params.toString() ? "?".concat(params.toString()) : '';
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/posts").concat(qs), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body_1 = _b.sent();
                    return [2 /*return*/, mapApiError(res.status, body_1)];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _b.sent();
                    return [2 /*return*/, { ok: true, data: ((_a = body.posts) !== null && _a !== void 0 ? _a : []).map(mapPost) }];
                case 7:
                    e_2 = _b.sent();
                    if (isNetworkError(e_2))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_2 instanceof Error ? e_2.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/** Trip feed: posts for a trip (trip_only only returned to accepted members). */
function listTripPosts(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body_2, body, e_3;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/posts"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body_2 = _b.sent();
                    return [2 /*return*/, mapApiError(res.status, body_2)];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _b.sent();
                    return [2 /*return*/, { ok: true, data: ((_a = body.posts) !== null && _a !== void 0 ? _a : []).map(mapPost), isMember: Boolean(body.isMember) }];
                case 7:
                    e_3 = _b.sent();
                    if (isNetworkError(e_3))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_3 instanceof Error ? e_3.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function updatePost(postId, patch) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, _a, e_4;
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
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/posts/").concat(postId), {
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
                    return [2 /*return*/, mapApiError(res.status, body)];
                case 5:
                    _b = { ok: true };
                    _a = mapPost;
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_b.data = _a.apply(void 0, [_c.sent()]), _b)];
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
/** Soft delete (author only, enforced server-side). */
function deletePost(postId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, e_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _a.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/posts/").concat(postId), {
                            method: 'DELETE',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _a.sent();
                    if (res.status === 204)
                        return [2 /*return*/, { ok: true, data: null }];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _a.sent();
                    return [2 /*return*/, mapApiError(res.status, body)];
                case 5:
                    e_5 = _a.sent();
                    if (isNetworkError(e_5))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_5 instanceof Error ? e_5.message : 'Unknown' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
