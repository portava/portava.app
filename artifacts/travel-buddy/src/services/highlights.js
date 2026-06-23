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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHighlight = createHighlight;
exports.fetchUserHighlights = fetchUserHighlights;
exports.fetchActiveHighlights = fetchActiveHighlights;
exports.markHighlightViewed = markHighlightViewed;
exports.toggleHighlightLike = toggleHighlightLike;
exports.fetchHighlightViewers = fetchHighlightViewers;
exports.replyToHighlight = replyToHighlight;
exports.deleteHighlight = deleteHighlight;
exports.reportHighlight = reportHighlight;
exports.fetchFollowingHighlightsFeed = fetchFollowingHighlightsFeed;
exports.fetchHighlightRingStates = fetchHighlightRingStates;
/**
 * Highlights service — typed fetch wrappers for all highlight API endpoints.
 * Follows the freshToken / apiFetch pattern used by posts.ts and other services.
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
    var known = [
        'unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error',
    ];
    var errorKind = known.includes(code) ? code : 'db_error';
    return { ok: false, data: null, errorKind: errorKind, message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(status) };
}
function isNetworkError(e) {
    var m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    return (m.includes('failed to fetch') ||
        m.includes('network request failed') ||
        m.includes('networkerror') ||
        m.includes('load failed'));
}
function mapHighlight(r) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    return {
        id: r.id,
        ownerId: r.owner_id,
        mediaUrl: r.media_url,
        mediaType: r.media_type,
        videoDurationSeconds: (_a = r.video_duration_seconds) !== null && _a !== void 0 ? _a : null,
        caption: (_b = r.caption) !== null && _b !== void 0 ? _b : null,
        locationName: (_c = r.location_name) !== null && _c !== void 0 ? _c : null,
        locationCity: (_d = r.location_city) !== null && _d !== void 0 ? _d : null,
        locationCountry: (_e = r.location_country) !== null && _e !== void 0 ? _e : null,
        visibility: r.visibility,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        deletedAt: (_f = r.deleted_at) !== null && _f !== void 0 ? _f : null,
        author: r.author
            ? { id: r.author.id, handle: r.author.handle, name: r.author.name, avatarUrl: (_g = r.author.avatarUrl) !== null && _g !== void 0 ? _g : null }
            : null,
        viewCount: (_h = r.viewCount) !== null && _h !== void 0 ? _h : 0,
        likeCount: (_j = r.likeCount) !== null && _j !== void 0 ? _j : 0,
        viewedByMe: (_k = r.viewedByMe) !== null && _k !== void 0 ? _k : false,
        likedByMe: (_l = r.likedByMe) !== null && _l !== void 0 ? _l : false,
        filterId: (_m = r.filter_id) !== null && _m !== void 0 ? _m : 'original',
        filterIntensity: (_o = r.filter_intensity) !== null && _o !== void 0 ? _o : 100,
        mediaThumbnailUrl: (_p = r.media_thumbnail_url) !== null && _p !== void 0 ? _p : null,
        mediaDurationSeconds: (_q = r.media_duration_seconds) !== null && _q !== void 0 ? _q : null,
    };
}
function createHighlight(input) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, _c, e_1;
        var _d;
        var _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
        return __generator(this, function (_r) {
            switch (_r.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _r.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _r.label = 2;
                case 2:
                    _r.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify({
                                mediaUrl: input.mediaUrl,
                                mediaType: input.mediaType,
                                videoDurationSeconds: (_e = input.videoDurationSeconds) !== null && _e !== void 0 ? _e : null,
                                caption: (_f = input.caption) !== null && _f !== void 0 ? _f : null,
                                locationName: (_g = input.locationName) !== null && _g !== void 0 ? _g : null,
                                locationCity: (_h = input.locationCity) !== null && _h !== void 0 ? _h : null,
                                locationCountry: (_j = input.locationCountry) !== null && _j !== void 0 ? _j : null,
                                visibility: (_k = input.visibility) !== null && _k !== void 0 ? _k : 'public',
                                expiresInHours: (_l = input.expiresInHours) !== null && _l !== void 0 ? _l : 24,
                                filterId: (_m = input.filterId) !== null && _m !== void 0 ? _m : 'original',
                                filterIntensity: (_o = input.filterIntensity) !== null && _o !== void 0 ? _o : 100,
                                mediaThumbnailUrl: (_p = input.mediaThumbnailUrl) !== null && _p !== void 0 ? _p : null,
                                mediaDurationSeconds: (_q = input.mediaDurationSeconds) !== null && _q !== void 0 ? _q : null,
                            }),
                        })];
                case 3:
                    res = _r.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_r.sent()]))];
                case 5:
                    _d = { ok: true };
                    _c = mapHighlight;
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_d.data = _c.apply(void 0, [_r.sent()]), _d)];
                case 7:
                    e_1 = _r.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/** Fetch active highlights for a specific user, filtered by viewer permissions. */
function fetchUserHighlights(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, body, e_2;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/users/").concat(userId, "/highlights"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _d.sent();
                    return [2 /*return*/, { ok: true, data: ((_c = body.highlights) !== null && _c !== void 0 ? _c : []).map(mapHighlight) }];
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
/**
 * Fetch active highlights visible to the current user.
 * Supports ?userId=, ?city=, ?tripId= filters.
 */
function fetchActiveHighlights(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var token, params, qs, res, _a, _b, body, e_3;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    params = new URLSearchParams();
                    if (opts === null || opts === void 0 ? void 0 : opts.userId)
                        params.set('userId', opts.userId);
                    if (opts === null || opts === void 0 ? void 0 : opts.city)
                        params.set('city', opts.city);
                    if (opts === null || opts === void 0 ? void 0 : opts.tripId)
                        params.set('tripId', opts.tripId);
                    if (opts === null || opts === void 0 ? void 0 : opts.limit)
                        params.set('limit', String(opts.limit));
                    qs = params.toString() ? "?".concat(params.toString()) : '';
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/active").concat(qs), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _d.sent();
                    return [2 /*return*/, { ok: true, data: ((_c = body.highlights) !== null && _c !== void 0 ? _c : []).map(mapHighlight) }];
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
/** Idempotent mark-as-viewed. Best-effort — never blocks the UI. */
function markHighlightViewed(highlightId) {
    return __awaiter(this, void 0, void 0, function () {
        var token;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _a.sent();
                    if (!token)
                        return [2 /*return*/];
                    fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId, "/view"), {
                        method: 'POST',
                        headers: { Authorization: "Bearer ".concat(token) },
                    }).catch(function () { });
                    return [2 /*return*/];
            }
        });
    });
}
function toggleHighlightLike(highlightId, liked) {
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
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId, "/like"), {
                            method: liked ? 'DELETE' : 'POST',
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
                    e_4 = _d.sent();
                    if (isNetworkError(e_4))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function fetchHighlightViewers(highlightId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, body, e_5;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId, "/viewers"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _d.sent();
                    return [2 /*return*/, {
                            ok: true,
                            data: ((_c = body.viewers) !== null && _c !== void 0 ? _c : []).map(function (v) {
                                var _a, _b;
                                return ({
                                    userId: v.user_id,
                                    handle: v.handle,
                                    name: v.name,
                                    avatarUrl: (_a = v.avatar_url) !== null && _a !== void 0 ? _a : null,
                                    viewedAt: v.viewed_at,
                                    likedByMe: (_b = v.liked) !== null && _b !== void 0 ? _b : false,
                                });
                            }),
                        }];
                case 7:
                    e_5 = _d.sent();
                    if (isNetworkError(e_5))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/** Reply to a highlight — creates or returns a Telegraph DM thread. Returns threadId. */
function replyToHighlight(highlightId, message) {
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
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId, "/reply"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify({ message: message }),
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
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function deleteHighlight(highlightId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_7;
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
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId), {
                            method: 'DELETE',
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (res.status === 204)
                        return [2 /*return*/, { ok: true, data: null }];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_c.sent()]))];
                case 5:
                    e_7 = _c.sent();
                    if (isNetworkError(e_7))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function reportHighlight(highlightId, reason) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_8;
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
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/").concat(highlightId, "/report"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify({ reason: reason }),
                        })];
                case 3:
                    res = _c.sent();
                    if (res.status === 204 || res.ok)
                        return [2 /*return*/, { ok: true, data: null }];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_c.sent()]))];
                case 5:
                    e_8 = _c.sent();
                    if (isNetworkError(e_8))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Fetch highlights from users the current user follows, grouped by user.
 * Used by the Explore tab Highlights strip.
 */
function fetchFollowingHighlightsFeed() {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, body, e_9;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: [] }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/highlights/following-feed"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    body = _d.sent();
                    return [2 /*return*/, {
                            ok: true,
                            data: ((_c = body.users) !== null && _c !== void 0 ? _c : []).map(function (u) {
                                var _a, _b, _c, _d;
                                return ({
                                    userId: u.userId,
                                    handle: (_a = u.handle) !== null && _a !== void 0 ? _a : null,
                                    name: (_b = u.name) !== null && _b !== void 0 ? _b : null,
                                    avatarUrl: (_c = u.avatarUrl) !== null && _c !== void 0 ? _c : null,
                                    highlights: ((_d = u.highlights) !== null && _d !== void 0 ? _d : []).map(mapHighlight),
                                });
                            }),
                        }];
                case 7:
                    e_9 = _d.sent();
                    if (isNetworkError(e_9))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_9 instanceof Error ? e_9.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Batch-fetch active-highlight metadata for multiple users.
 * Returns a map: userId → { hasActive: boolean, allViewed: boolean, highlights: Highlight[] }
 * Used by HighlightRing to determine ring state.
 */
function fetchHighlightRingStates(userIds, viewedIds) {
    return __awaiter(this, void 0, void 0, function () {
        var result, uniqueIds, fetches, entries, _i, entries_1, _a, uid, state;
        var _this = this;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    result = new Map();
                    if (userIds.length === 0)
                        return [2 /*return*/, result];
                    uniqueIds = __spreadArray([], new Set(userIds), true);
                    fetches = uniqueIds.map(function (uid) { return __awaiter(_this, void 0, void 0, function () {
                        var r, highlights, hasActive, allViewed;
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, fetchUserHighlights(uid)];
                                case 1:
                                    r = _a.sent();
                                    highlights = r.ok && r.data ? r.data : [];
                                    hasActive = highlights.length > 0;
                                    allViewed = hasActive && highlights.every(function (h) { return viewedIds.has(h.id); });
                                    return [2 /*return*/, [uid, { hasActive: hasActive, allViewed: allViewed, highlights: highlights }]];
                            }
                        });
                    }); });
                    return [4 /*yield*/, Promise.all(fetches)];
                case 1:
                    entries = _b.sent();
                    for (_i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                        _a = entries_1[_i], uid = _a[0], state = _a[1];
                        result.set(uid, state);
                    }
                    return [2 /*return*/, result];
            }
        });
    });
}
