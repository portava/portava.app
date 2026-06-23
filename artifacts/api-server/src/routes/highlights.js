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
var express_1 = require("express");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var highlightPermissions_1 = require("../lib/highlightPermissions");
var messagingPermissions_1 = require("../lib/messagingPermissions");
var zod_1 = require("zod");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
/* ============================================================================
 * Internal helper — resolve whether viewerId can access highlightId.
 * Checks blocks, loads highlight, resolves circle/trip membership, and calls
 * canViewHighlight. Returns null + sends the error response on failure.
 * ============================================================================ */
function resolveViewAccess(sc, viewerId, highlightId, res) {
    return __awaiter(this, void 0, void 0, function () {
        var h, record, ownerId, _a, blockedByMe, blockingMe, viewerFollowsOwner, sharesTrip, _b, circleMember, myTripRows, myTripIds, sharedTrip;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, sc
                        .from("highlights")
                        .select("id, owner_id, visibility, expires_at, deleted_at")
                        .eq("id", highlightId)
                        .maybeSingle()];
                case 1:
                    h = (_c.sent()).data;
                    if (!h) {
                        (0, http_1.sendError)(res, "not_found", "Highlight not found");
                        return [2 /*return*/, null];
                    }
                    record = h;
                    ownerId = record.owner_id;
                    if (!(viewerId !== ownerId)) return [3 /*break*/, 3];
                    return [4 /*yield*/, Promise.all([
                            sc.from("blocks").select("blocked_id").eq("blocker_id", viewerId).eq("blocked_id", ownerId).maybeSingle(),
                            sc.from("blocks").select("blocker_id").eq("blocker_id", ownerId).eq("blocked_id", viewerId).maybeSingle(),
                        ])];
                case 2:
                    _a = _c.sent(), blockedByMe = _a[0], blockingMe = _a[1];
                    if (blockedByMe.data || blockingMe.data) {
                        (0, http_1.sendError)(res, "not_found", "Highlight not found");
                        return [2 /*return*/, null];
                    }
                    _c.label = 3;
                case 3:
                    viewerFollowsOwner = viewerId === ownerId;
                    sharesTrip = viewerId === ownerId;
                    if (!(viewerId !== ownerId && (record.visibility === "circle_only" || record.visibility === "trip_only"))) return [3 /*break*/, 6];
                    return [4 /*yield*/, Promise.all([
                            sc.from("circle_memberships").select("other_id").eq("user_id", ownerId).eq("other_id", viewerId).maybeSingle(),
                            sc.from("trip_members").select("trip_id").eq("user_id", viewerId).in("role", ["owner", "member"]),
                        ])];
                case 4:
                    _b = _c.sent(), circleMember = _b[0], myTripRows = _b[1];
                    viewerFollowsOwner = Boolean(circleMember.data);
                    if (!(myTripRows.data && myTripRows.data.length > 0)) return [3 /*break*/, 6];
                    myTripIds = myTripRows.data.map(function (r) { return r.trip_id; });
                    return [4 /*yield*/, sc
                            .from("trip_members")
                            .select("trip_id")
                            .eq("user_id", ownerId)
                            .in("role", ["owner", "member"])
                            .in("trip_id", myTripIds)
                            .limit(1)
                            .maybeSingle()];
                case 5:
                    sharedTrip = (_c.sent()).data;
                    sharesTrip = Boolean(sharedTrip);
                    _c.label = 6;
                case 6:
                    if (!(0, highlightPermissions_1.canViewHighlight)(viewerId, record, { viewerFollowsOwner: viewerFollowsOwner, sharesTrip: sharesTrip })) {
                        (0, http_1.sendError)(res, "not_found", "Highlight not found");
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, { h: record }];
            }
        });
    });
}
var EXPIRY_HOURS = [3, 6, 12, 24, 48];
var MAX_VIDEO_DURATION_SECONDS = 10;
var KNOWN_FILTER_IDS = [
    'original', 'wanderlust', 'golden_hour', 'deep_ocean', 'mist', 'polaroid',
    'noir', 'safari', 'vivid', 'sunset', 'arctic', 'velvet',
];
var createHighlightSchema = zod_1.z.object({
    mediaUrl: zod_1.z.string().url("media_url must be a URL"),
    mediaType: zod_1.z.string().min(1),
    videoDurationSeconds: zod_1.z.number().nullable().optional(),
    caption: zod_1.z.string().max(500).nullable().optional(),
    locationName: zod_1.z.string().max(200).nullable().optional(),
    locationCity: zod_1.z.string().max(100).nullable().optional(),
    locationCountry: zod_1.z.string().max(100).nullable().optional(),
    visibility: zod_1.z
        .enum(["public", "travelers_nearby", "circle_only", "trip_only", "private"])
        .default("public"),
    expiresInHours: zod_1.z.number().int().refine(function (h) { return EXPIRY_HOURS.includes(h); }, {
        message: "expiresInHours must be one of: ".concat(EXPIRY_HOURS.join(", ")),
    }).default(24),
    filterId: zod_1.z.enum(KNOWN_FILTER_IDS).optional().default('original'),
    filterIntensity: zod_1.z.number().int().min(0).max(100).optional().default(100),
    mediaThumbnailUrl: zod_1.z.string().url().nullable().optional(),
    mediaDurationSeconds: zod_1.z.number().int().min(0).max(10).nullable().optional(),
});
/* ============================================================================
 * POST /highlights — create a highlight
 * ============================================================================ */
router.post("/highlights", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, d, expiresAt, _a, data, error;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    return __generator(this, function (_o) {
        switch (_o.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _o.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = createHighlightSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                d = parsed.data;
                // Reject video highlights longer than 10 seconds, or with missing duration
                if (d.mediaType.startsWith("video/")) {
                    if (d.videoDurationSeconds == null) {
                        (0, http_1.sendError)(res, "invalid_payload", "videoDurationSeconds is required for video highlights.");
                        return [2 /*return*/];
                    }
                    if (d.videoDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
                        (0, http_1.sendError)(res, "invalid_payload", "Highlights and video Postcards can be up to ".concat(MAX_VIDEO_DURATION_SECONDS, " seconds."));
                        return [2 /*return*/];
                    }
                }
                expiresAt = new Date(Date.now() + d.expiresInHours * 60 * 60 * 1000).toISOString();
                return [4 /*yield*/, client
                        .from("highlights")
                        .insert({
                        owner_id: user.id,
                        media_url: d.mediaUrl,
                        media_type: d.mediaType,
                        video_duration_seconds: (_d = d.videoDurationSeconds) !== null && _d !== void 0 ? _d : null,
                        caption: (_e = d.caption) !== null && _e !== void 0 ? _e : null,
                        location_name: (_f = d.locationName) !== null && _f !== void 0 ? _f : null,
                        location_city: (_g = d.locationCity) !== null && _g !== void 0 ? _g : null,
                        location_country: (_h = d.locationCountry) !== null && _h !== void 0 ? _h : null,
                        visibility: d.visibility,
                        expires_at: expiresAt,
                        filter_id: (_j = d.filterId) !== null && _j !== void 0 ? _j : 'original',
                        filter_intensity: (_k = d.filterIntensity) !== null && _k !== void 0 ? _k : 100,
                        media_thumbnail_url: (_l = d.mediaThumbnailUrl) !== null && _l !== void 0 ? _l : null,
                        media_duration_seconds: (_m = d.mediaDurationSeconds) !== null && _m !== void 0 ? _m : null,
                    })
                        .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at, filter_id, filter_intensity, media_thumbnail_url, media_duration_seconds")
                        .single()];
            case 2:
                _a = _o.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to create highlight");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json(__assign(__assign({}, data), { viewCount: 0, likeCount: 0, viewedByMe: false, likedByMe: false }));
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * GET /users/:userId/highlights — active highlights for a user
 * Filtered by viewer permissions + blocks.
 * ============================================================================ */
router.get("/users/:userId/highlights", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, targetId, _a, blocker, blocked, isOwnProfile, _b, rows, error, highlights, viewerFollowsOwner, sharesTrip, sc_1, _c, circleMember, tripRows, myTripIds, sharedTrip, visible, highlightIds, _d, viewRows, likeRows, viewedRows, likedRows, viewCountMap, likeCountMap, _i, _e, r, _f, _g, r, viewedSet, likedSet, sc, author, p, result;
    var _h, _j, _k, _l, _m, _o, _p;
    return __generator(this, function (_q) {
        switch (_q.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _q.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                targetId = req.params.userId;
                if (!UUID.test(targetId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        client.from("blocks").select("blocked_id").eq("blocker_id", user.id).eq("blocked_id", targetId).maybeSingle(),
                        client.from("blocks").select("blocked_id").eq("blocker_id", targetId).eq("blocked_id", user.id).maybeSingle(),
                    ])];
            case 2:
                _a = _q.sent(), blocker = _a[0], blocked = _a[1];
                if (blocker.data || blocked.data) {
                    res.status(200).json({ highlights: [] });
                    return [2 /*return*/];
                }
                isOwnProfile = user.id === targetId;
                return [4 /*yield*/, client
                        .from("highlights")
                        .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
                        .eq("owner_id", targetId)
                        .is("deleted_at", null)
                        .gt("expires_at", new Date().toISOString())
                        .order("created_at", { ascending: true })];
            case 3:
                _b = _q.sent(), rows = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to load user highlights");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                highlights = (rows !== null && rows !== void 0 ? rows : []);
                viewerFollowsOwner = false;
                sharesTrip = false;
                if (!(!isOwnProfile && highlights.some(function (h) { return ["circle_only", "trip_only"].includes(h.visibility); }))) return [3 /*break*/, 6];
                sc_1 = (0, supabase_1.getServiceClient)();
                if (!sc_1) return [3 /*break*/, 6];
                return [4 /*yield*/, Promise.all([
                        sc_1.from("circle_memberships").select("other_id").eq("user_id", targetId).eq("other_id", user.id).maybeSingle(),
                        sc_1.from("trip_members").select("trip_id").eq("user_id", user.id).in("role", ["owner", "member"]),
                    ])];
            case 4:
                _c = _q.sent(), circleMember = _c[0], tripRows = _c[1];
                viewerFollowsOwner = Boolean(circleMember.data);
                if (!(tripRows.data && tripRows.data.length > 0)) return [3 /*break*/, 6];
                myTripIds = tripRows.data.map(function (r) { return r.trip_id; });
                return [4 /*yield*/, sc_1
                        .from("trip_members")
                        .select("trip_id")
                        .eq("user_id", targetId)
                        .in("role", ["owner", "member"])
                        .in("trip_id", myTripIds)
                        .limit(1)
                        .maybeSingle()];
            case 5:
                sharedTrip = (_q.sent()).data;
                sharesTrip = Boolean(sharedTrip);
                _q.label = 6;
            case 6:
                if (isOwnProfile) {
                    viewerFollowsOwner = true;
                    sharesTrip = true;
                }
                visible = highlights.filter(function (h) {
                    return (0, highlightPermissions_1.canViewHighlight)(user.id, h, { viewerFollowsOwner: viewerFollowsOwner, sharesTrip: sharesTrip });
                });
                if (visible.length === 0) {
                    res.status(200).json({ highlights: [] });
                    return [2 /*return*/];
                }
                highlightIds = visible.map(function (h) { return h.id; });
                return [4 /*yield*/, Promise.all([
                        client.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
                        client.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
                        client.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
                        client.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
                    ])];
            case 7:
                _d = _q.sent(), viewRows = _d[0], likeRows = _d[1], viewedRows = _d[2], likedRows = _d[3];
                viewCountMap = {};
                likeCountMap = {};
                for (_i = 0, _e = (_h = viewRows.data) !== null && _h !== void 0 ? _h : []; _i < _e.length; _i++) {
                    r = _e[_i];
                    viewCountMap[r.highlight_id] = ((_j = viewCountMap[r.highlight_id]) !== null && _j !== void 0 ? _j : 0) + 1;
                }
                for (_f = 0, _g = (_k = likeRows.data) !== null && _k !== void 0 ? _k : []; _f < _g.length; _f++) {
                    r = _g[_f];
                    likeCountMap[r.highlight_id] = ((_l = likeCountMap[r.highlight_id]) !== null && _l !== void 0 ? _l : 0) + 1;
                }
                viewedSet = new Set(((_m = viewedRows.data) !== null && _m !== void 0 ? _m : []).map(function (r) { return r.highlight_id; }));
                likedSet = new Set(((_o = likedRows.data) !== null && _o !== void 0 ? _o : []).map(function (r) { return r.highlight_id; }));
                sc = (0, supabase_1.getServiceClient)();
                author = null;
                if (!sc) return [3 /*break*/, 9];
                return [4 /*yield*/, sc.from("profiles").select("id, handle, name, avatar_url").eq("id", targetId).maybeSingle()];
            case 8:
                p = (_q.sent()).data;
                if (p)
                    author = { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_p = p.avatar_url) !== null && _p !== void 0 ? _p : null };
                _q.label = 9;
            case 9:
                result = visible.map(function (h) {
                    var _a, _b;
                    return (__assign(__assign({}, h), { author: author, viewCount: (_a = viewCountMap[h.id]) !== null && _a !== void 0 ? _a : 0, likeCount: (_b = likeCountMap[h.id]) !== null && _b !== void 0 ? _b : 0, viewedByMe: viewedSet.has(h.id), likedByMe: likedSet.has(h.id) }));
                });
                res.status(200).json({ highlights: result });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * GET /highlights/active — all active highlights visible to current user
 * Supports ?userId=, ?city=, ?tripId=, ?limit=
 * ============================================================================ */
router.get("/highlights/active", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, limit, filterUserId, filterCity, filterTripId, sc, tripMemberIds, viewerTripIds, memberRows, ids, viewerTripRows, _a, blockedByMe, blockingMe, blockedIds, q, _b, rows, error, unblocked, circleOwnerIds, followingSet, circleRows, _i, _c, r, tripOnlyOwnerIds, sharesTripSet, sharedRows, _d, _e, r, visible, highlightIds, ownerIds, _f, viewRows, likeRows, viewedRows, likedRows, profileRows, viewCountMap, likeCountMap, _g, _h, r, _j, _k, r, viewedSet, likedSet, profileMap, _l, _m, p, result;
    var _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
    return __generator(this, function (_z) {
        switch (_z.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _z.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                limit = Math.min(Number((_o = req.query.limit) !== null && _o !== void 0 ? _o : 50), 100);
                filterUserId = typeof req.query.userId === "string" && UUID.test(req.query.userId) ? req.query.userId : null;
                filterCity = typeof req.query.city === "string" ? req.query.city : null;
                filterTripId = typeof req.query.tripId === "string" && UUID.test(req.query.tripId) ? req.query.tripId : null;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                tripMemberIds = null;
                viewerTripIds = [];
                if (!filterTripId) return [3 /*break*/, 3];
                return [4 /*yield*/, sc
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", filterTripId)
                        .in("role", ["owner", "member"])];
            case 2:
                memberRows = (_z.sent()).data;
                ids = (memberRows !== null && memberRows !== void 0 ? memberRows : []).map(function (r) { return r.user_id; });
                // Ensure the viewer is actually in the trip (or it's public — we still filter below)
                tripMemberIds = new Set(ids);
                _z.label = 3;
            case 3: return [4 /*yield*/, sc
                    .from("trip_members")
                    .select("trip_id")
                    .eq("user_id", user.id)
                    .in("role", ["owner", "member"])];
            case 4:
                viewerTripRows = (_z.sent()).data;
                viewerTripIds = (viewerTripRows !== null && viewerTripRows !== void 0 ? viewerTripRows : []).map(function (r) { return r.trip_id; });
                return [4 /*yield*/, Promise.all([
                        sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
                        sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
                    ])];
            case 5:
                _a = _z.sent(), blockedByMe = _a[0], blockingMe = _a[1];
                blockedIds = new Set(__spreadArray(__spreadArray([], (((_p = blockedByMe.data) !== null && _p !== void 0 ? _p : []).map(function (r) { return r.blocked_id; })), true), (((_q = blockingMe.data) !== null && _q !== void 0 ? _q : []).map(function (r) { return r.blocker_id; })), true));
                q = sc
                    .from("highlights")
                    .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at")
                    .is("deleted_at", null)
                    .gt("expires_at", new Date().toISOString())
                    .in("visibility", ["public", "travelers_nearby", "circle_only", "trip_only"])
                    .order("created_at", { ascending: false })
                    .limit(limit * 5);
                if (filterUserId) {
                    q = q.eq("owner_id", filterUserId);
                }
                if (filterCity) {
                    q = q.ilike("location_city", "%".concat(filterCity, "%"));
                }
                if (tripMemberIds && tripMemberIds.size > 0) {
                    q = q.in("owner_id", __spreadArray([], tripMemberIds, true));
                }
                return [4 /*yield*/, q];
            case 6:
                _b = _z.sent(), rows = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to load active highlights");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                unblocked = (rows !== null && rows !== void 0 ? rows : []).filter(function (h) { return !blockedIds.has(h.owner_id); });
                circleOwnerIds = __spreadArray([], new Set(unblocked.filter(function (h) { return h.visibility === "circle_only"; }).map(function (h) { return h.owner_id; })), true);
                followingSet = new Set();
                if (!(circleOwnerIds.length > 0)) return [3 /*break*/, 8];
                return [4 /*yield*/, sc
                        .from("circle_memberships")
                        .select("user_id")
                        .eq("other_id", user.id)
                        .in("user_id", circleOwnerIds)];
            case 7:
                circleRows = (_z.sent()).data;
                for (_i = 0, _c = circleRows !== null && circleRows !== void 0 ? circleRows : []; _i < _c.length; _i++) {
                    r = _c[_i];
                    followingSet.add(r.user_id);
                }
                _z.label = 8;
            case 8:
                tripOnlyOwnerIds = __spreadArray([], new Set(unblocked.filter(function (h) { return h.visibility === "trip_only"; }).map(function (h) { return h.owner_id; })), true);
                sharesTripSet = new Set();
                if (!(tripOnlyOwnerIds.length > 0 && viewerTripIds.length > 0)) return [3 /*break*/, 10];
                return [4 /*yield*/, sc
                        .from("trip_members")
                        .select("user_id")
                        .in("user_id", tripOnlyOwnerIds)
                        .in("trip_id", viewerTripIds)
                        .in("role", ["owner", "member"])];
            case 9:
                sharedRows = (_z.sent()).data;
                for (_d = 0, _e = sharedRows !== null && sharedRows !== void 0 ? sharedRows : []; _d < _e.length; _d++) {
                    r = _e[_d];
                    sharesTripSet.add(r.user_id);
                }
                _z.label = 10;
            case 10:
                visible = unblocked.filter(function (h) {
                    if (h.owner_id === user.id)
                        return true;
                    if (h.visibility === "public" || h.visibility === "travelers_nearby")
                        return true;
                    if (h.visibility === "circle_only")
                        return followingSet.has(h.owner_id);
                    if (h.visibility === "trip_only")
                        return sharesTripSet.has(h.owner_id);
                    return false;
                }).slice(0, limit);
                if (visible.length === 0) {
                    res.status(200).json({ highlights: [] });
                    return [2 /*return*/];
                }
                highlightIds = visible.map(function (h) { return h.id; });
                ownerIds = __spreadArray([], new Set(visible.map(function (h) { return h.owner_id; })), true);
                return [4 /*yield*/, Promise.all([
                        sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
                        sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
                        sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
                        sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
                        sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
                    ])];
            case 11:
                _f = _z.sent(), viewRows = _f[0], likeRows = _f[1], viewedRows = _f[2], likedRows = _f[3], profileRows = _f[4];
                viewCountMap = {};
                likeCountMap = {};
                for (_g = 0, _h = (_r = viewRows.data) !== null && _r !== void 0 ? _r : []; _g < _h.length; _g++) {
                    r = _h[_g];
                    viewCountMap[r.highlight_id] = ((_s = viewCountMap[r.highlight_id]) !== null && _s !== void 0 ? _s : 0) + 1;
                }
                for (_j = 0, _k = (_t = likeRows.data) !== null && _t !== void 0 ? _t : []; _j < _k.length; _j++) {
                    r = _k[_j];
                    likeCountMap[r.highlight_id] = ((_u = likeCountMap[r.highlight_id]) !== null && _u !== void 0 ? _u : 0) + 1;
                }
                viewedSet = new Set(((_v = viewedRows.data) !== null && _v !== void 0 ? _v : []).map(function (r) { return r.highlight_id; }));
                likedSet = new Set(((_w = likedRows.data) !== null && _w !== void 0 ? _w : []).map(function (r) { return r.highlight_id; }));
                profileMap = {};
                for (_l = 0, _m = (_x = profileRows.data) !== null && _x !== void 0 ? _x : []; _l < _m.length; _l++) {
                    p = _m[_l];
                    profileMap[p.id] = { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_y = p.avatar_url) !== null && _y !== void 0 ? _y : null };
                }
                result = visible.map(function (h) {
                    var _a, _b, _c;
                    return (__assign(__assign({}, h), { author: (_a = profileMap[h.owner_id]) !== null && _a !== void 0 ? _a : null, viewCount: (_b = viewCountMap[h.id]) !== null && _b !== void 0 ? _b : 0, likeCount: (_c = likeCountMap[h.id]) !== null && _c !== void 0 ? _c : 0, viewedByMe: viewedSet.has(h.id), likedByMe: likedSet.has(h.id) }));
                });
                res.status(200).json({ highlights: result });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * DELETE /highlights/:id — owner soft-delete
 * ============================================================================ */
router.delete("/highlights/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, id, existing, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("highlights")
                        .select("id, owner_id")
                        .eq("id", id)
                        .is("deleted_at", null)
                        .maybeSingle()];
            case 2:
                existing = (_a.sent()).data;
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Highlight not found");
                    return [2 /*return*/];
                }
                if (existing.owner_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the owner can delete this highlight");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("highlights")
                        .update({ deleted_at: new Date().toISOString() })
                        .eq("id", id)
                        .eq("owner_id", user.id)];
            case 3:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to delete highlight");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * POST /highlights/:id/view — idempotent view upsert
 * ============================================================================ */
router.post("/highlights/:id/view", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, id, sc, access, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, resolveViewAccess(sc, user.id, id, res)];
            case 2:
                access = _a.sent();
                if (!access)
                    return [2 /*return*/];
                return [4 /*yield*/, sc
                        .from("highlight_views")
                        .upsert({ highlight_id: id, viewer_id: user.id, viewed_at: new Date().toISOString() }, { onConflict: "highlight_id,viewer_id" })];
            case 3:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to record highlight view");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ viewed: true });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * POST /highlights/:id/like — like a highlight
 * ============================================================================ */
router.post("/highlights/:id/like", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, id, sc, access, count;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, resolveViewAccess(sc, user.id, id, res)];
            case 2:
                access = _a.sent();
                if (!access)
                    return [2 /*return*/];
                if (access.h.owner_id === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot like your own highlight");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("highlight_likes")
                        .upsert({ highlight_id: id, user_id: user.id }, { onConflict: "highlight_id,user_id", ignoreDuplicates: true })];
            case 3:
                _a.sent();
                return [4 /*yield*/, sc
                        .from("highlight_likes")
                        .select("*", { count: "exact", head: true })
                        .eq("highlight_id", id)];
            case 4:
                count = (_a.sent()).count;
                res.status(200).json({ likedByMe: true, likeCount: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * DELETE /highlights/:id/like — unlike a highlight
 * ============================================================================ */
router.delete("/highlights/:id/like", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, id, sc, access, count;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, resolveViewAccess(sc, user.id, id, res)];
            case 2:
                access = _a.sent();
                if (!access)
                    return [2 /*return*/];
                return [4 /*yield*/, sc.from("highlight_likes").delete().eq("highlight_id", id).eq("user_id", user.id)];
            case 3:
                _a.sent();
                return [4 /*yield*/, sc
                        .from("highlight_likes")
                        .select("*", { count: "exact", head: true })
                        .eq("highlight_id", id)];
            case 4:
                count = (_a.sent()).count;
                res.status(200).json({ likedByMe: false, likeCount: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * GET /highlights/:id/viewers — owner-only list of viewers
 * ============================================================================ */
router.get("/highlights/:id/viewers", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, id, h, sc, _a, viewRows, error, viewerIds, _b, profileRows, likeRows, profileMap, _i, _c, p, likedSet, viewers;
    var _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("highlights")
                        .select("id, owner_id")
                        .eq("id", id)
                        .maybeSingle()];
            case 2:
                h = (_f.sent()).data;
                if (!h) {
                    (0, http_1.sendError)(res, "not_found", "Highlight not found");
                    return [2 /*return*/];
                }
                if (h.owner_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the owner can see viewers");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("highlight_views")
                        .select("viewer_id, viewed_at")
                        .eq("highlight_id", id)
                        .order("viewed_at", { ascending: false })];
            case 3:
                _a = _f.sent(), viewRows = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to load highlight viewers");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                viewerIds = (viewRows !== null && viewRows !== void 0 ? viewRows : []).map(function (r) { return r.viewer_id; });
                if (viewerIds.length === 0) {
                    res.status(200).json({ viewers: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc.from("profiles").select("id, handle, name, avatar_url").in("id", viewerIds),
                        sc.from("highlight_likes").select("user_id").eq("highlight_id", id).in("user_id", viewerIds),
                    ])];
            case 4:
                _b = _f.sent(), profileRows = _b[0], likeRows = _b[1];
                profileMap = {};
                for (_i = 0, _c = (_d = profileRows.data) !== null && _d !== void 0 ? _d : []; _i < _c.length; _i++) {
                    p = _c[_i];
                    profileMap[p.id] = p;
                }
                likedSet = new Set(((_e = likeRows.data) !== null && _e !== void 0 ? _e : []).map(function (r) { return r.user_id; }));
                viewers = (viewRows !== null && viewRows !== void 0 ? viewRows : []).map(function (r) {
                    var _a, _b, _c, _d;
                    var p = (_a = profileMap[r.viewer_id]) !== null && _a !== void 0 ? _a : {};
                    return {
                        user_id: r.viewer_id,
                        handle: (_b = p.handle) !== null && _b !== void 0 ? _b : null,
                        name: (_c = p.name) !== null && _c !== void 0 ? _c : null,
                        avatar_url: (_d = p.avatar_url) !== null && _d !== void 0 ? _d : null,
                        viewed_at: r.viewed_at,
                        liked: likedSet.has(r.viewer_id),
                    };
                });
                res.status(200).json({ viewers: viewers });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * POST /highlights/:id/reply — create a Telegraph DM thread for a highlight reply
 * ============================================================================ */
router.post("/highlights/:id/reply", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, id, message, sc, access, ownerId, msgVerdict, myMemberships, myThreadIds, threadId, allMembers, membersByThread, _i, _a, m, _b, _c, _d, tid, members, now, _e, newThread, threadErr, now2, _f;
    var _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _h.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                message = typeof ((_g = req.body) === null || _g === void 0 ? void 0 : _g.message) === "string" ? req.body.message.trim() : "";
                if (!message) {
                    (0, http_1.sendError)(res, "invalid_payload", "message is required");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, resolveViewAccess(sc, user.id, id, res)];
            case 2:
                access = _h.sent();
                if (!access)
                    return [2 /*return*/];
                ownerId = access.h.owner_id;
                if (ownerId === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot reply to your own highlight");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, user.id, ownerId)];
            case 3:
                msgVerdict = _h.sent();
                if (!msgVerdict.allowed) {
                    if (msgVerdict.verdict === "requires_request") {
                        (0, http_1.sendError)(res, "forbidden", "You must send a message request before replying to this highlight");
                    }
                    else {
                        (0, http_1.sendError)(res, "forbidden", "You cannot send messages to this user");
                    }
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("message_thread_members")
                        .select("thread_id")
                        .eq("user_id", user.id)];
            case 4:
                myMemberships = (_h.sent()).data;
                myThreadIds = (myMemberships !== null && myMemberships !== void 0 ? myMemberships : []).map(function (m) { return m.thread_id; });
                threadId = null;
                if (!(myThreadIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, sc
                        .from("message_thread_members")
                        .select("thread_id, user_id")
                        .in("thread_id", myThreadIds)];
            case 5:
                allMembers = (_h.sent()).data;
                membersByThread = {};
                for (_i = 0, _a = (allMembers !== null && allMembers !== void 0 ? allMembers : []); _i < _a.length; _i++) {
                    m = _a[_i];
                    if (!membersByThread[m.thread_id])
                        membersByThread[m.thread_id] = new Set();
                    membersByThread[m.thread_id].add(m.user_id);
                }
                for (_b = 0, _c = Object.entries(membersByThread); _b < _c.length; _b++) {
                    _d = _c[_b], tid = _d[0], members = _d[1];
                    if (members.size === 2 && members.has(user.id) && members.has(ownerId)) {
                        threadId = tid;
                        break;
                    }
                }
                _h.label = 6;
            case 6:
                if (!!threadId) return [3 /*break*/, 9];
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from("message_threads")
                        .insert({ created_at: now, updated_at: now })
                        .select("id")
                        .single()];
            case 7:
                _e = _h.sent(), newThread = _e.data, threadErr = _e.error;
                if (threadErr || !newThread) {
                    req.log.error({ err: threadErr }, "Failed to create DM thread for highlight reply");
                    (0, http_1.sendError)(res, "db_error", "Could not create message thread");
                    return [2 /*return*/];
                }
                threadId = newThread.id;
                now2 = new Date().toISOString();
                return [4 /*yield*/, sc.from("message_thread_members").insert([
                        { thread_id: threadId, user_id: user.id, joined_at: now2 },
                        { thread_id: threadId, user_id: ownerId, joined_at: now2 },
                    ])];
            case 8:
                _h.sent();
                _h.label = 9;
            case 9: 
            // Send a system context message linking to the highlight
            return [4 /*yield*/, sc.from("messages").insert({
                    thread_id: threadId,
                    sender_id: user.id,
                    body: "\u21A9 Replied to your highlight",
                    msg_type: "highlight_reply",
                    subtype: id,
                })];
            case 10:
                // Send a system context message linking to the highlight
                _h.sent();
                // Send the actual reply message
                return [4 /*yield*/, sc.from("messages").insert({
                        thread_id: threadId,
                        sender_id: user.id,
                        body: message,
                        msg_type: "text",
                    })];
            case 11:
                // Send the actual reply message
                _h.sent();
                _h.label = 12;
            case 12:
                _h.trys.push([12, 14, , 15]);
                return [4 /*yield*/, sc
                        .from("highlight_replies")
                        .insert({ highlight_id: id, replier_id: user.id, thread_id: threadId })];
            case 13:
                _h.sent();
                return [3 /*break*/, 15];
            case 14:
                _f = _h.sent();
                return [3 /*break*/, 15];
            case 15:
                res.status(200).json({ threadId: threadId });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * POST /highlights/:id/report
 * ============================================================================ */
router.post("/highlights/:id/report", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, id, reason, sc, access;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                id = req.params.id;
                if (!UUID.test(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid highlight id");
                    return [2 /*return*/];
                }
                reason = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.reason) === "string" ? req.body.reason.trim() : "inappropriate";
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, resolveViewAccess(sc, user.id, id, res)];
            case 2:
                access = _b.sent();
                if (!access)
                    return [2 /*return*/];
                if (access.h.owner_id === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot report your own highlight");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("highlight_reports")
                        .upsert({ highlight_id: id, reporter_id: user.id, reason: reason }, { onConflict: "highlight_id,reporter_id" })];
            case 3:
                _b.sent();
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * GET /highlights/following-feed
 * Returns users the current user follows who have active highlights,
 * grouped per user with their full highlight objects.
 * ============================================================================ */
router.get("/highlights/following-feed", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, followRows, followingIds, _a, blockedByMe, blockingMe, blockedIds, eligibleIds, _b, rows, error, allHighlights, circleOwnerIds, tripOnlyOwnerIds, circleApprovedSet, sharesTripSet, visible, highlightIds, ownerIds, _c, viewRows2, likeRows2, viewedRows2, likedRows2, profileRows, viewCountMap, likeCountMap, _i, _d, r, _e, _f, r, viewedSet, likedSet, profileMap, _g, _h, p, grouped, _j, visible_1, h, ownerId, author, users;
    var _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z;
    return __generator(this, function (_0) {
        switch (_0.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _0.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("user_follows")
                        .select("following_id")
                        .eq("follower_id", user.id)];
            case 2:
                followRows = (_0.sent()).data;
                followingIds = (followRows !== null && followRows !== void 0 ? followRows : []).map(function (r) { return r.following_id; });
                if (followingIds.length === 0) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc.from("blocks").select("blocked_id").eq("blocker_id", user.id),
                        sc.from("blocks").select("blocker_id").eq("blocked_id", user.id),
                    ])];
            case 3:
                _a = _0.sent(), blockedByMe = _a[0], blockingMe = _a[1];
                blockedIds = new Set(__spreadArray(__spreadArray([], (((_k = blockedByMe.data) !== null && _k !== void 0 ? _k : []).map(function (r) { return r.blocked_id; })), true), (((_l = blockingMe.data) !== null && _l !== void 0 ? _l : []).map(function (r) { return r.blocker_id; })), true));
                eligibleIds = followingIds.filter(function (id) { return !blockedIds.has(id); });
                if (eligibleIds.length === 0) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("highlights")
                        .select("id, owner_id, media_url, media_type, video_duration_seconds, caption, location_name, location_city, location_country, visibility, expires_at, created_at, deleted_at, filter_id, filter_intensity, media_thumbnail_url, media_duration_seconds")
                        .in("owner_id", eligibleIds)
                        .is("deleted_at", null)
                        .gt("expires_at", new Date().toISOString())
                        .neq("visibility", "private")
                        .order("created_at", { ascending: true })];
            case 4:
                _b = _0.sent(), rows = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to load following highlights feed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                allHighlights = (rows !== null && rows !== void 0 ? rows : []);
                if (allHighlights.length === 0) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                circleOwnerIds = __spreadArray([], new Set(allHighlights.filter(function (h) { return h.visibility === "circle_only"; }).map(function (h) { return h.owner_id; })), true);
                tripOnlyOwnerIds = __spreadArray([], new Set(allHighlights.filter(function (h) { return h.visibility === "trip_only"; }).map(function (h) { return h.owner_id; })), true);
                circleApprovedSet = new Set();
                sharesTripSet = new Set();
                return [4 /*yield*/, Promise.all([
                        circleOwnerIds.length > 0
                            ? sc
                                .from("circle_memberships")
                                .select("user_id")
                                .eq("other_id", user.id)
                                .in("user_id", circleOwnerIds)
                                .then(function (_a) {
                                var data = _a.data;
                                for (var _i = 0, _b = data !== null && data !== void 0 ? data : []; _i < _b.length; _i++) {
                                    var r = _b[_i];
                                    circleApprovedSet.add(r.user_id);
                                }
                            })
                            : Promise.resolve(),
                        tripOnlyOwnerIds.length > 0
                            ? sc
                                .from("trip_members")
                                .select("trip_id")
                                .eq("user_id", user.id)
                                .in("role", ["owner", "member"])
                                .then(function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
                                var vtIds, shared, _i, _c, r;
                                var viewerTrips = _b.data;
                                return __generator(this, function (_d) {
                                    switch (_d.label) {
                                        case 0:
                                            vtIds = (viewerTrips !== null && viewerTrips !== void 0 ? viewerTrips : []).map(function (r) { return r.trip_id; });
                                            if (vtIds.length === 0)
                                                return [2 /*return*/];
                                            return [4 /*yield*/, sc
                                                    .from("trip_members")
                                                    .select("user_id")
                                                    .in("user_id", tripOnlyOwnerIds)
                                                    .in("trip_id", vtIds)
                                                    .in("role", ["owner", "member"])];
                                        case 1:
                                            shared = (_d.sent()).data;
                                            for (_i = 0, _c = shared !== null && shared !== void 0 ? shared : []; _i < _c.length; _i++) {
                                                r = _c[_i];
                                                sharesTripSet.add(r.user_id);
                                            }
                                            return [2 /*return*/];
                                    }
                                });
                            }); })
                            : Promise.resolve(),
                    ])];
            case 5:
                _0.sent();
                visible = allHighlights.filter(function (h) {
                    if (h.visibility === "public" || h.visibility === "travelers_nearby")
                        return true;
                    if (h.visibility === "circle_only")
                        return circleApprovedSet.has(h.owner_id);
                    if (h.visibility === "trip_only")
                        return sharesTripSet.has(h.owner_id);
                    return false;
                });
                if (visible.length === 0) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                highlightIds = visible.map(function (h) { return h.id; });
                ownerIds = __spreadArray([], new Set(visible.map(function (h) { return h.owner_id; })), true);
                return [4 /*yield*/, Promise.all([
                        sc.from("highlight_views").select("highlight_id").in("highlight_id", highlightIds),
                        sc.from("highlight_likes").select("highlight_id").in("highlight_id", highlightIds),
                        sc.from("highlight_views").select("highlight_id").eq("viewer_id", user.id).in("highlight_id", highlightIds),
                        sc.from("highlight_likes").select("highlight_id").eq("user_id", user.id).in("highlight_id", highlightIds),
                        sc.from("profiles").select("id, handle, name, avatar_url").in("id", ownerIds),
                    ])];
            case 6:
                _c = _0.sent(), viewRows2 = _c[0], likeRows2 = _c[1], viewedRows2 = _c[2], likedRows2 = _c[3], profileRows = _c[4];
                viewCountMap = {};
                likeCountMap = {};
                for (_i = 0, _d = (_m = viewRows2.data) !== null && _m !== void 0 ? _m : []; _i < _d.length; _i++) {
                    r = _d[_i];
                    viewCountMap[r.highlight_id] = ((_o = viewCountMap[r.highlight_id]) !== null && _o !== void 0 ? _o : 0) + 1;
                }
                for (_e = 0, _f = (_p = likeRows2.data) !== null && _p !== void 0 ? _p : []; _e < _f.length; _e++) {
                    r = _f[_e];
                    likeCountMap[r.highlight_id] = ((_q = likeCountMap[r.highlight_id]) !== null && _q !== void 0 ? _q : 0) + 1;
                }
                viewedSet = new Set(((_r = viewedRows2.data) !== null && _r !== void 0 ? _r : []).map(function (r) { return r.highlight_id; }));
                likedSet = new Set(((_s = likedRows2.data) !== null && _s !== void 0 ? _s : []).map(function (r) { return r.highlight_id; }));
                profileMap = {};
                for (_g = 0, _h = (_t = profileRows.data) !== null && _t !== void 0 ? _t : []; _g < _h.length; _g++) {
                    p = _h[_g];
                    profileMap[p.id] = {
                        userId: p.id,
                        handle: (_u = p.handle) !== null && _u !== void 0 ? _u : null,
                        name: (_v = p.name) !== null && _v !== void 0 ? _v : null,
                        avatarUrl: (_w = p.avatar_url) !== null && _w !== void 0 ? _w : null,
                    };
                }
                grouped = new Map();
                for (_j = 0, visible_1 = visible; _j < visible_1.length; _j++) {
                    h = visible_1[_j];
                    ownerId = h.owner_id;
                    if (!grouped.has(ownerId)) {
                        grouped.set(ownerId, { profile: (_x = profileMap[ownerId]) !== null && _x !== void 0 ? _x : null, highlights: [] });
                    }
                    author = profileMap[ownerId]
                        ? { id: profileMap[ownerId].userId, handle: profileMap[ownerId].handle, name: profileMap[ownerId].name, avatarUrl: profileMap[ownerId].avatarUrl }
                        : null;
                    grouped.get(ownerId).highlights.push(__assign(__assign({}, h), { author: author, viewCount: (_y = viewCountMap[h.id]) !== null && _y !== void 0 ? _y : 0, likeCount: (_z = likeCountMap[h.id]) !== null && _z !== void 0 ? _z : 0, viewedByMe: viewedSet.has(h.id), likedByMe: likedSet.has(h.id) }));
                }
                users = __spreadArray([], grouped.values(), true).filter(function (g) { return g.profile !== null; })
                    .map(function (g) { return ({
                    userId: g.profile.userId,
                    handle: g.profile.handle,
                    name: g.profile.name,
                    avatarUrl: g.profile.avatarUrl,
                    highlights: g.highlights,
                }); });
                res.status(200).json({ users: users });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
