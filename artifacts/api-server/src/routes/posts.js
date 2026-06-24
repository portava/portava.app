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
var postSchemas_1 = require("../lib/postSchemas");
var locationVerify_1 = require("../lib/locationVerify");
var stampHelper_1 = require("../lib/stampHelper");
var supabase_1 = require("../lib/supabase");
var PulseGeoTagService_1 = require("../services/location/PulseGeoTagService");
var router = (0, express_1.Router)();
var STORAGE_BUCKET = "post-media";
var ALLOWED_MIME = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
};
/* ===========================================================================
 * POST /media/upload  — authenticated media upload proxied through API server
 * ===========================================================================
 * Client sends raw binary body with Content-Type = MIME type.
 * Server uses service-role key to upload to Supabase Storage, bypassing RLS.
 * Files stored at post-media/{userId}/{timestamp}.{ext}.
 * Returns { url, path }.
 */
router.post("/media/upload", function (req, res, next) {
    var chunks = [];
    req.on("data", function (c) { return chunks.push(c); });
    req.on("end", function () { req.rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
}, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, mimeType, ext, rawBody, path, sc, error, urlData;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                mimeType = ((_a = req.headers["content-type"]) !== null && _a !== void 0 ? _a : "").split(";")[0].trim();
                ext = ALLOWED_MIME[mimeType];
                if (!ext) {
                    (0, http_1.sendError)(res, "invalid_payload", "Unsupported media type: ".concat(mimeType));
                    return [2 /*return*/];
                }
                rawBody = req.rawBody;
                if (!rawBody || rawBody.length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "Empty file body");
                    return [2 /*return*/];
                }
                path = "".concat(user.id, "/").concat(Date.now(), ".").concat(ext);
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Storage not configured");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.storage
                        .from(STORAGE_BUCKET)
                        .upload(path, rawBody, { contentType: mimeType, upsert: false })];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error, path: path }, "Storage upload failed");
                    (0, http_1.sendError)(res, "db_error", "Upload failed: ".concat(error.message));
                    return [2 /*return*/];
                }
                urlData = sc.storage.from(STORAGE_BUCKET).getPublicUrl(path).data;
                res.status(201).json({ url: urlData.publicUrl, path: path });
                return [2 /*return*/];
        }
    });
}); });
// Columns returned to clients (never expose nothing extra; these are all safe).
var POST_COLUMNS = "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at";
/* ===========================================================================
 * POST /posts  — create a standalone or trip-attached post
 * ===========================================================================
 * - requires a valid bearer token (author = verified user; client author_id ignored)
 * - if trip_id present: trip must exist AND user must be owner/accepted member
 * - visibility=trip_only requires trip_id (schema + DB both enforce)
 * - service-role insert; audit fields set server-side
 */
router.post("/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, content, mediaUrls, tripId, visibility, _b, mediaType, addToPassport, locationName, locationPlaceId, locationCity, locationCountry, locationLat, locationLng, userGpsLat, userGpsLng, locationSource, locationVisibility, filterId, filterIntensity, mediaThumbnailUrl, mediaDurationSeconds, verdict, _c, data, error, postcard, pc, sc, sc;
    var _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = postSchemas_1.createPostSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_e = (_d = parsed.error.issues[0]) === null || _d === void 0 ? void 0 : _d.message) !== null && _e !== void 0 ? _e : "Invalid payload");
                    return [2 /*return*/];
                }
                _a = parsed.data, content = _a.content, mediaUrls = _a.mediaUrls, tripId = _a.tripId, visibility = _a.visibility;
                _b = parsed.data, mediaType = _b.mediaType, addToPassport = _b.addToPassport, locationName = _b.locationName, locationPlaceId = _b.locationPlaceId, locationCity = _b.locationCity, locationCountry = _b.locationCountry, locationLat = _b.locationLat, locationLng = _b.locationLng, userGpsLat = _b.userGpsLat, userGpsLng = _b.userGpsLng, locationSource = _b.locationSource, locationVisibility = _b.locationVisibility, filterId = _b.filterId, filterIntensity = _b.filterIntensity, mediaThumbnailUrl = _b.mediaThumbnailUrl, mediaDurationSeconds = _b.mediaDurationSeconds;
                if (!tripId) return [3 /*break*/, 4];
                return [4 /*yield*/, (0, http_1.tripExists)(client, tripId)];
            case 2:
                if (!(_f.sent())) {
                    (0, http_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 3:
                if (!(_f.sent())) {
                    // invited-but-not-accepted, declined, removed, or non-member all land here
                    (0, http_1.sendError)(res, "not_member", "You must be an accepted member of this trip to post to it");
                    return [2 /*return*/];
                }
                _f.label = 4;
            case 4:
                verdict = (0, locationVerify_1.verifyLocation)({
                    locationLat: locationLat !== null && locationLat !== void 0 ? locationLat : null,
                    locationLng: locationLng !== null && locationLng !== void 0 ? locationLng : null,
                    userGpsLat: userGpsLat !== null && userGpsLat !== void 0 ? userGpsLat : null,
                    userGpsLng: userGpsLng !== null && userGpsLng !== void 0 ? userGpsLng : null,
                    locationSource: locationSource !== null && locationSource !== void 0 ? locationSource : 'none',
                });
                return [4 /*yield*/, client
                        .from("posts")
                        .insert({
                        author_id: user.id, // verified user only — never from client
                        trip_id: tripId !== null && tripId !== void 0 ? tripId : null,
                        content: content !== null && content !== void 0 ? content : "",
                        media_urls: mediaUrls !== null && mediaUrls !== void 0 ? mediaUrls : [],
                        media_type: mediaType !== null && mediaType !== void 0 ? mediaType : null,
                        visibility: visibility,
                        status: "active",
                        // tagged location
                        location_name: locationName !== null && locationName !== void 0 ? locationName : null,
                        location_place_id: locationPlaceId !== null && locationPlaceId !== void 0 ? locationPlaceId : null,
                        location_city: locationCity !== null && locationCity !== void 0 ? locationCity : null,
                        location_country: locationCountry !== null && locationCountry !== void 0 ? locationCountry : null,
                        location_lat: locationLat !== null && locationLat !== void 0 ? locationLat : null,
                        location_lng: locationLng !== null && locationLng !== void 0 ? locationLng : null,
                        // private GPS (internal only; never in public projections)
                        user_gps_lat: userGpsLat !== null && userGpsLat !== void 0 ? userGpsLat : null,
                        user_gps_lng: userGpsLng !== null && userGpsLng !== void 0 ? userGpsLng : null,
                        location_source: locationSource !== null && locationSource !== void 0 ? locationSource : 'none',
                        // server-decided verification
                        location_verified: verdict.locationVerified,
                        location_verified_at: verdict.locationVerified ? new Date().toISOString() : null,
                        location_distance_meters: verdict.distanceMeters,
                        add_to_passport: addToPassport !== null && addToPassport !== void 0 ? addToPassport : true,
                        created_by: user.id,
                        updated_by: user.id,
                        source: "api_server",
                        // media filters
                        filter_id: filterId !== null && filterId !== void 0 ? filterId : 'original',
                        filter_intensity: filterIntensity !== null && filterIntensity !== void 0 ? filterIntensity : 100,
                        media_thumbnail_url: mediaThumbnailUrl !== null && mediaThumbnailUrl !== void 0 ? mediaThumbnailUrl : null,
                        media_duration_seconds: mediaDurationSeconds !== null && mediaDurationSeconds !== void 0 ? mediaDurationSeconds : null,
                    })
                        .select(POST_COLUMNS)
                        .single()];
            case 5:
                _c = _f.sent(), data = _c.data, error = _c.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to insert post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                postcard = null;
                if (!(0, locationVerify_1.shouldCreatePostcard)({ mediaUrls: mediaUrls !== null && mediaUrls !== void 0 ? mediaUrls : [], addToPassport: addToPassport !== null && addToPassport !== void 0 ? addToPassport : true, status: 'active' })) return [3 /*break*/, 9];
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .insert({
                        post_id: data.id,
                        user_id: user.id,
                        media_url: mediaUrls[0],
                        caption: content !== null && content !== void 0 ? content : null,
                        location_name: locationName !== null && locationName !== void 0 ? locationName : null,
                        location_city: locationCity !== null && locationCity !== void 0 ? locationCity : null,
                        location_country: locationCountry !== null && locationCountry !== void 0 ? locationCountry : null,
                        location_verified: verdict.locationVerified,
                        stamp_eligible: verdict.stampEligible,
                        stamp_reason: verdict.stampReason,
                        verification_method: verdict.verificationMethod,
                        verified_distance_meters: verdict.distanceMeters,
                        verified_at: verdict.locationVerified ? new Date().toISOString() : null,
                        visibility: visibility,
                        status: 'active',
                    })
                        .select("id, post_id, location_verified, stamp_eligible, stamp_reason, verification_method")
                        .single()];
            case 6:
                pc = _f.sent();
                if (!pc.error) return [3 /*break*/, 7];
                // Log but don't fail the post (rollback plan: posting must survive).
                req.log.error({ err: pc.error }, "Postcard auto-create failed (post still created)");
                return [3 /*break*/, 9];
            case 7:
                postcard = pc.data;
                if (!(verdict.stampEligible && locationCity)) return [3 /*break*/, 9];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) return [3 /*break*/, 9];
                return [4 /*yield*/, (0, stampHelper_1.upsertCityStamp)(sc, {
                        userId: user.id,
                        locationCity: locationCity,
                        locationCountry: locationCountry !== null && locationCountry !== void 0 ? locationCountry : null,
                        postcardId: postcard.id,
                    }, req.log)];
            case 8:
                _f.sent();
                _f.label = 9;
            case 9:
                // Pulse GPS tag — write fire-and-forget after the post is committed.
                // Enforces privacy rules: off mode → no_location; hotel blur → neighborhood cap.
                // Never blocks the response; a failure must not corrupt the post.
                {
                    sc = (0, supabase_1.getServiceClient)();
                    if (sc) {
                        (0, PulseGeoTagService_1.writePulseGeoTag)(sc, {
                            postId: data.id,
                            userId: user.id,
                            userGpsLat: userGpsLat !== null && userGpsLat !== void 0 ? userGpsLat : null,
                            userGpsLng: userGpsLng !== null && userGpsLng !== void 0 ? userGpsLng : null,
                            locationCity: locationCity !== null && locationCity !== void 0 ? locationCity : null,
                            locationCountry: locationCountry !== null && locationCountry !== void 0 ? locationCountry : null,
                            venueName: locationName !== null && locationName !== void 0 ? locationName : null,
                            locationVisibilityOverride: (locationVisibility !== null && locationVisibility !== void 0 ? locationVisibility : null),
                        }).catch(function (err) {
                            req.log.warn({ err: err }, "pulse_geo_tag write failed (non-fatal)");
                        });
                    }
                }
                res.status(201).json(__assign(__assign({}, data), { postcard: postcard }));
                return [2 /*return*/];
        }
    });
}); });
// Safe public location labels (no GPS coordinates).
var FOLLOWING_POST_COLUMNS = "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at, " +
    "location_name, location_city, location_country";
/* ===========================================================================
 * GET /posts  — global feed OR following feed
 * ===========================================================================
 * feed=global (default): active PUBLIC STANDALONE posts for all users.
 * feed=following: public standalone posts from users the caller follows only.
 *
 * Hard privacy rules enforced at the query level for BOTH modes:
 *   - visibility = "public" only (never trip_only or private)
 *   - trip_id IS NULL (standalone only — no trip content leaks)
 *   - status = "active" (no deleted/hidden/reported posts)
 *   - never returns user_gps_lat/lng (not in any SELECT column list)
 * Auth required for both modes.
 */
router.get("/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, limit, before, feed, sc, _b, followRows, followErr, followingIds, q_1, _c, postRows, postErr, posts, authorIds, profileMap_1, profiles, _i, _d, p, postIds, engMap_1, _e, engData, likedData, likedSet, _f, _g, r, merged, svc, q, _h, data, error, globalPosts, globalPostIds, globalAuthorIds, globalProfileMap, profiles, _j, _k, p, globalEngMap, _l, engData, likedData, likedSet, _m, _o, r, mergedGlobal;
    var _p, _q, _r, _s, _t, _u;
    return __generator(this, function (_v) {
        switch (_v.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _v.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = postSchemas_1.listPostsQuerySchema.safeParse(req.query);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_q = (_p = parsed.error.issues[0]) === null || _p === void 0 ? void 0 : _p.message) !== null && _q !== void 0 ? _q : "Invalid query");
                    return [2 /*return*/];
                }
                _a = parsed.data, limit = _a.limit, before = _a.before, feed = _a.feed;
                if (!(feed === "following")) return [3 /*break*/, 8];
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
                _b = _v.sent(), followRows = _b.data, followErr = _b.error;
                if (followErr) {
                    req.log.error({ err: followErr }, "Failed to load following list for feed");
                    (0, http_1.sendError)(res, "db_error", followErr.message);
                    return [2 /*return*/];
                }
                followingIds = (followRows !== null && followRows !== void 0 ? followRows : []).map(function (r) { return r.following_id; });
                if (followingIds.length === 0) {
                    res.status(200).json({ posts: [], feed: "following" });
                    return [2 /*return*/];
                }
                q_1 = sc
                    .from("posts")
                    .select(FOLLOWING_POST_COLUMNS)
                    .in("author_id", followingIds)
                    .is("trip_id", null)
                    .eq("visibility", "public")
                    .eq("status", "active")
                    .order("created_at", { ascending: false })
                    .limit(limit);
                if (before)
                    q_1 = q_1.lt("created_at", before);
                return [4 /*yield*/, q_1];
            case 3:
                _c = _v.sent(), postRows = _c.data, postErr = _c.error;
                if (postErr) {
                    req.log.error({ err: postErr }, "Failed to load following feed posts");
                    (0, http_1.sendError)(res, "db_error", postErr.message);
                    return [2 /*return*/];
                }
                posts = postRows !== null && postRows !== void 0 ? postRows : [];
                authorIds = __spreadArray([], new Set(posts.map(function (p) { return p.author_id; })), true);
                profileMap_1 = {};
                if (!(authorIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", authorIds)];
            case 4:
                profiles = (_v.sent()).data;
                for (_i = 0, _d = profiles !== null && profiles !== void 0 ? profiles : []; _i < _d.length; _i++) {
                    p = _d[_i];
                    profileMap_1[p.id] = p;
                }
                _v.label = 5;
            case 5:
                postIds = posts.map(function (p) { return p.id; });
                engMap_1 = {};
                if (!(postIds.length > 0)) return [3 /*break*/, 7];
                return [4 /*yield*/, Promise.all([
                        sc.from("posts").select("id, like_count, comment_count").in("id", postIds),
                        sc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", postIds),
                    ])];
            case 6:
                _e = _v.sent(), engData = _e[0].data, likedData = _e[1].data;
                likedSet = new Set((likedData !== null && likedData !== void 0 ? likedData : []).map(function (r) { return r.post_id; }));
                for (_f = 0, _g = engData !== null && engData !== void 0 ? engData : []; _f < _g.length; _f++) {
                    r = _g[_f];
                    engMap_1[r.id] = {
                        likeCount: (_r = r.like_count) !== null && _r !== void 0 ? _r : 0,
                        commentCount: (_s = r.comment_count) !== null && _s !== void 0 ? _s : 0,
                        likedByMe: likedSet.has(r.id),
                    };
                }
                _v.label = 7;
            case 7:
                merged = posts.map(function (p) {
                    var _a, _b;
                    var pr = profileMap_1[p.author_id];
                    var eng = (_a = engMap_1[p.id]) !== null && _a !== void 0 ? _a : { likeCount: 0, commentCount: 0, likedByMe: false };
                    return __assign(__assign({}, p), { author: pr
                            ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: (_b = pr.avatar_url) !== null && _b !== void 0 ? _b : null }
                            : null, likeCount: eng.likeCount, commentCount: eng.commentCount, likedByMe: eng.likedByMe, canLike: true, canComment: true, canShare: true });
                });
                res.status(200).json({ posts: merged, feed: "following" });
                return [2 /*return*/];
            case 8:
                svc = (0, supabase_1.getServiceClient)();
                if (!svc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                q = svc
                    .from("posts")
                    .select(POST_COLUMNS)
                    .is("trip_id", null)
                    .eq("visibility", "public")
                    .eq("status", "active")
                    .order("created_at", { ascending: false })
                    .limit(limit);
                if (before)
                    q = q.lt("created_at", before);
                return [4 /*yield*/, q];
            case 9:
                _h = _v.sent(), data = _h.data, error = _h.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to list posts");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                globalPosts = data !== null && data !== void 0 ? data : [];
                globalPostIds = globalPosts.map(function (p) { return p.id; });
                globalAuthorIds = __spreadArray([], new Set(globalPosts.map(function (p) { return p.author_id; })), true);
                globalProfileMap = {};
                if (!(globalAuthorIds.length > 0)) return [3 /*break*/, 11];
                return [4 /*yield*/, svc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", globalAuthorIds)];
            case 10:
                profiles = (_v.sent()).data;
                for (_j = 0, _k = profiles !== null && profiles !== void 0 ? profiles : []; _j < _k.length; _j++) {
                    p = _k[_j];
                    globalProfileMap[p.id] = p;
                }
                _v.label = 11;
            case 11:
                globalEngMap = {};
                if (!(globalPostIds.length > 0)) return [3 /*break*/, 13];
                return [4 /*yield*/, Promise.all([
                        svc.from("posts").select("id, like_count, comment_count").in("id", globalPostIds),
                        svc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", globalPostIds),
                    ])];
            case 12:
                _l = _v.sent(), engData = _l[0].data, likedData = _l[1].data;
                likedSet = new Set((likedData !== null && likedData !== void 0 ? likedData : []).map(function (r) { return r.post_id; }));
                for (_m = 0, _o = engData !== null && engData !== void 0 ? engData : []; _m < _o.length; _m++) {
                    r = _o[_m];
                    globalEngMap[r.id] = {
                        likeCount: (_t = r.like_count) !== null && _t !== void 0 ? _t : 0,
                        commentCount: (_u = r.comment_count) !== null && _u !== void 0 ? _u : 0,
                        likedByMe: likedSet.has(r.id),
                    };
                }
                _v.label = 13;
            case 13:
                mergedGlobal = globalPosts.map(function (p) {
                    var _a, _b;
                    var pr = globalProfileMap[p.author_id];
                    var eng = (_a = globalEngMap[p.id]) !== null && _a !== void 0 ? _a : { likeCount: 0, commentCount: 0, likedByMe: false };
                    return __assign(__assign({}, p), { author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: (_b = pr.avatar_url) !== null && _b !== void 0 ? _b : null } : null, likeCount: eng.likeCount, commentCount: eng.commentCount, likedByMe: eng.likedByMe, canLike: true, canComment: true, canShare: true });
                });
                res.status(200).json({ posts: mergedGlobal, feed: "global" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/posts  — a trip's feed
 * ===========================================================================
 * - requires accepted membership to view trip_only content
 * - returns active posts attached to that trip that the user may see:
 *     public (anyone who can load the trip) + trip_only (accepted members)
 *   excludes other users' private posts.
 */
router.get("/trips/:tripId/posts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, accepted, q, _a, data, error, tripPosts, tripPostIds, tripAuthorIds, tripSvc, tripProfileMap, profiles, _i, _b, p, tripEngMap, _c, engData, likedData, likedSet, _d, _e, r, mergedTrip;
    var _f, _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _h.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.tripExists)(client, tripId)];
            case 2:
                if (!(_h.sent())) {
                    (0, http_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 3:
                accepted = _h.sent();
                q = client
                    .from("posts")
                    .select(POST_COLUMNS)
                    .eq("trip_id", tripId)
                    .eq("status", "active")
                    .order("created_at", { ascending: false })
                    .limit(100);
                if (accepted) {
                    // public + trip_only, plus own private
                    q = q.or("visibility.eq.public,visibility.eq.trip_only,and(visibility.eq.private,author_id.eq.".concat(user.id, ")"));
                }
                else {
                    // public only, plus own private
                    q = q.or("visibility.eq.public,and(visibility.eq.private,author_id.eq.".concat(user.id, ")"));
                }
                return [4 /*yield*/, q];
            case 4:
                _a = _h.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to list trip posts");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                tripPosts = data !== null && data !== void 0 ? data : [];
                tripPostIds = tripPosts.map(function (p) { return p.id; });
                tripAuthorIds = __spreadArray([], new Set(tripPosts.map(function (p) { return p.author_id; })), true);
                tripSvc = (0, supabase_1.getServiceClient)();
                tripProfileMap = {};
                if (!(tripSvc && tripAuthorIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, tripSvc
                        .from("profiles").select("id, handle, name, avatar_url").in("id", tripAuthorIds)];
            case 5:
                profiles = (_h.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    tripProfileMap[p.id] = p;
                }
                _h.label = 6;
            case 6:
                tripEngMap = {};
                if (!(tripSvc && tripPostIds.length > 0)) return [3 /*break*/, 8];
                return [4 /*yield*/, Promise.all([
                        tripSvc.from("posts").select("id, like_count, comment_count").in("id", tripPostIds),
                        tripSvc.from("posts_likes").select("post_id").eq("user_id", user.id).in("post_id", tripPostIds),
                    ])];
            case 7:
                _c = _h.sent(), engData = _c[0].data, likedData = _c[1].data;
                likedSet = new Set((likedData !== null && likedData !== void 0 ? likedData : []).map(function (r) { return r.post_id; }));
                for (_d = 0, _e = engData !== null && engData !== void 0 ? engData : []; _d < _e.length; _d++) {
                    r = _e[_d];
                    tripEngMap[r.id] = { likeCount: (_f = r.like_count) !== null && _f !== void 0 ? _f : 0, commentCount: (_g = r.comment_count) !== null && _g !== void 0 ? _g : 0, likedByMe: likedSet.has(r.id) };
                }
                _h.label = 8;
            case 8:
                mergedTrip = tripPosts.map(function (p) {
                    var _a, _b;
                    var pr = tripProfileMap[p.author_id];
                    var eng = (_a = tripEngMap[p.id]) !== null && _a !== void 0 ? _a : { likeCount: 0, commentCount: 0, likedByMe: false };
                    // public: any authenticated user; trip_only: accepted members only; private: no public engagement
                    var canEngage = p.visibility === "public" || (p.visibility === "trip_only" && accepted);
                    return __assign(__assign({}, p), { author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: (_b = pr.avatar_url) !== null && _b !== void 0 ? _b : null } : null, likeCount: eng.likeCount, commentCount: eng.commentCount, likedByMe: eng.likedByMe, canLike: canEngage, canComment: canEngage, canShare: canEngage });
                });
                res.status(200).json({ posts: mergedTrip, isMember: accepted });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /posts/:postId  — author-only edit
 * ===========================================================================
 */
router.patch("/posts/:postId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postId, parsed, _a, existing, loadErr, nextVisibility, patch, _b, data, error;
    var _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postId = req.params.postId;
                parsed = postSchemas_1.updatePostSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("posts")
                        .select("id, author_id, trip_id, visibility")
                        .eq("id", postId)
                        .maybeSingle()];
            case 2:
                _a = _f.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    req.log.error({ err: loadErr }, "Failed to load post for update");
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                if (existing.author_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the author can edit this post");
                    return [2 /*return*/];
                }
                nextVisibility = (_e = parsed.data.visibility) !== null && _e !== void 0 ? _e : existing.visibility;
                if (nextVisibility === "trip_only" && !existing.trip_id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot set trip_only on a standalone post");
                    return [2 /*return*/];
                }
                patch = { updated_by: user.id };
                if (parsed.data.content !== undefined)
                    patch.content = parsed.data.content;
                if (parsed.data.mediaUrls !== undefined)
                    patch.media_urls = parsed.data.mediaUrls;
                if (parsed.data.visibility !== undefined)
                    patch.visibility = parsed.data.visibility;
                if (parsed.data.status !== undefined)
                    patch.status = parsed.data.status;
                return [4 /*yield*/, client
                        .from("posts")
                        .update(patch)
                        .eq("id", postId)
                        .eq("author_id", user.id) // belt-and-suspenders ownership guard
                        .select(POST_COLUMNS)
                        .single()];
            case 3:
                _b = _f.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to update post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * DELETE /posts/:postId  — author-only soft delete
 * ===========================================================================
 * Soft delete (status=deleted, deleted_at=now) so feeds hide it but the row is
 * retained for moderation/audit. Author only.
 */
router.delete("/posts/:postId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postId, _a, existing, loadErr, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postId = req.params.postId;
                return [4 /*yield*/, client
                        .from("posts")
                        .select("id, author_id")
                        .eq("id", postId)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                if (existing.author_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the author can delete this post");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("posts")
                        .update({ status: "deleted", deleted_at: new Date().toISOString(), updated_by: user.id })
                        .eq("id", postId)
                        .eq("author_id", user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to delete post");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * POST /posts/:postId/like  — like a post (idempotent)
 * DELETE /posts/:postId/like — unlike a post (idempotent)
 * ============================================================================
 */
function isValidUuid(s) {
    return /^[0-9a-f-]{36}$/i.test(s);
}
/** Returns true if the caller may engage with a post; sends 403 and returns false otherwise. */
function checkEngagePermission(res, post, userId, userClient) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (post.visibility === "private") {
                        (0, http_1.sendError)(res, "forbidden", "Cannot engage with a private post");
                        return [2 /*return*/, false];
                    }
                    if (!(post.visibility === "trip_only")) return [3 /*break*/, 3];
                    _a = !post.trip_id;
                    if (_a) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(userClient, post.trip_id, userId)];
                case 1:
                    _a = !(_b.sent());
                    _b.label = 2;
                case 2:
                    if (_a) {
                        (0, http_1.sendError)(res, "forbidden", "Only accepted trip members can engage with this post");
                        return [2 /*return*/, false];
                    }
                    _b.label = 3;
                case 3: return [2 /*return*/, true];
            }
        });
    });
}
router.post("/posts/:postId/like", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, client, postId, sc, _a, post, postErr, upsertErr, count;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user, client = auth.client;
                postId = req.params.postId;
                if (!isValidUuid(postId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid post id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle()];
            case 2:
                _a = _b.sent(), post = _a.data, postErr = _a.error;
                if (postErr) {
                    (0, http_1.sendError)(res, "db_error", postErr.message);
                    return [2 /*return*/];
                }
                if (!post) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, checkEngagePermission(res, post, user.id, client)];
            case 3:
                if (!(_b.sent()))
                    return [2 /*return*/];
                return [4 /*yield*/, sc
                        .from("posts_likes")
                        .upsert({ post_id: postId, user_id: user.id }, { onConflict: "post_id,user_id", ignoreDuplicates: true })];
            case 4:
                upsertErr = (_b.sent()).error;
                if (upsertErr) {
                    (0, http_1.sendError)(res, "db_error", upsertErr.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts_likes").select("id", { count: "exact", head: true }).eq("post_id", postId)];
            case 5:
                count = (_b.sent()).count;
                return [4 /*yield*/, sc.from("posts").update({ like_count: count !== null && count !== void 0 ? count : 0 }).eq("id", postId)];
            case 6:
                _b.sent();
                res.status(200).json({ likedByMe: true, likeCount: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
router.delete("/posts/:postId/like", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, client, postId, sc, post, _a, delErr, count;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user, client = auth.client;
                postId = req.params.postId;
                if (!isValidUuid(postId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid post id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("posts").select("id, visibility, trip_id").eq("id", postId).maybeSingle()];
            case 2:
                post = (_b.sent()).data;
                _a = post;
                if (!_a) return [3 /*break*/, 4];
                return [4 /*yield*/, checkEngagePermission(res, post, user.id, client)];
            case 3:
                _a = !(_b.sent());
                _b.label = 4;
            case 4:
                if (_a)
                    return [2 /*return*/];
                return [4 /*yield*/, sc
                        .from("posts_likes").delete().eq("post_id", postId).eq("user_id", user.id)];
            case 5:
                delErr = (_b.sent()).error;
                if (delErr) {
                    (0, http_1.sendError)(res, "db_error", delErr.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts_likes").select("id", { count: "exact", head: true }).eq("post_id", postId)];
            case 6:
                count = (_b.sent()).count;
                return [4 /*yield*/, sc.from("posts").update({ like_count: count !== null && count !== void 0 ? count : 0 }).eq("id", postId)];
            case 7:
                _b.sent();
                res.status(200).json({ likedByMe: false, likeCount: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
/* ============================================================================
 * GET /posts/:postId/comments  — list visible comments
 * POST /posts/:postId/comments — add a comment
 * DELETE /posts/:postId/comments/:commentId — soft-delete own comment
 * ============================================================================
 */
router.get("/posts/:postId/comments", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, client, postId, sc, post, _a, rows, listErr, commentRows, authorIds, profileMap, profiles, _i, _b, p, comments;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user, client = auth.client;
                postId = req.params.postId;
                if (!isValidUuid(postId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid post id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle()];
            case 2:
                post = (_c.sent()).data;
                if (!post) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, checkEngagePermission(res, post, user.id, client)];
            case 3:
                if (!(_c.sent()))
                    return [2 /*return*/];
                return [4 /*yield*/, sc
                        .from("posts_comments")
                        .select("id, post_id, user_id, body, created_at, updated_at")
                        .eq("post_id", postId)
                        .is("deleted_at", null)
                        .order("created_at", { ascending: true })];
            case 4:
                _a = _c.sent(), rows = _a.data, listErr = _a.error;
                if (listErr) {
                    (0, http_1.sendError)(res, "db_error", listErr.message);
                    return [2 /*return*/];
                }
                commentRows = rows !== null && rows !== void 0 ? rows : [];
                authorIds = __spreadArray([], new Set(commentRows.map(function (c) { return c.user_id; })), true);
                profileMap = {};
                if (!(authorIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, sc.from("profiles").select("id, handle, name, avatar_url").in("id", authorIds)];
            case 5:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 6;
            case 6:
                comments = commentRows.map(function (c) {
                    var _a, _b;
                    var pr = profileMap[c.user_id];
                    return {
                        id: c.id,
                        body: c.body,
                        createdAt: c.created_at,
                        updatedAt: (_a = c.updated_at) !== null && _a !== void 0 ? _a : null,
                        canDelete: c.user_id === user.id,
                        author: pr
                            ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: (_b = pr.avatar_url) !== null && _b !== void 0 ? _b : null }
                            : { id: c.user_id, handle: "traveler", name: "Traveler", avatarUrl: null },
                    };
                });
                res.status(200).json({ ok: true, comments: comments });
                return [2 /*return*/];
        }
    });
}); });
router.post("/posts/:postId/comments", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, client, postId, body, sc, post, _a, comment, insertErr, count, profile;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user, client = auth.client;
                postId = req.params.postId;
                if (!isValidUuid(postId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid post id");
                    return [2 /*return*/];
                }
                body = String((_c = (_b = req.body) === null || _b === void 0 ? void 0 : _b.body) !== null && _c !== void 0 ? _c : "").trim();
                if (!body) {
                    (0, http_1.sendError)(res, "invalid_payload", "Comment body is required");
                    return [2 /*return*/];
                }
                if (body.length > 1000) {
                    (0, http_1.sendError)(res, "invalid_payload", "Comment must be 1000 characters or fewer");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle()];
            case 2:
                post = (_e.sent()).data;
                if (!post) {
                    (0, http_1.sendError)(res, "not_found", "Post not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, checkEngagePermission(res, post, user.id, client)];
            case 3:
                if (!(_e.sent()))
                    return [2 /*return*/];
                return [4 /*yield*/, sc
                        .from("posts_comments")
                        .insert({ post_id: postId, user_id: user.id, body: body })
                        .select("id, post_id, user_id, body, created_at, updated_at")
                        .single()];
            case 4:
                _a = _e.sent(), comment = _a.data, insertErr = _a.error;
                if (insertErr) {
                    (0, http_1.sendError)(res, "db_error", insertErr.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts_comments").select("id", { count: "exact", head: true })
                        .eq("post_id", postId).is("deleted_at", null)];
            case 5:
                count = (_e.sent()).count;
                return [4 /*yield*/, sc.from("posts").update({ comment_count: count !== null && count !== void 0 ? count : 0 }).eq("id", postId)];
            case 6:
                _e.sent();
                return [4 /*yield*/, sc.from("profiles").select("id, handle, name, avatar_url").eq("id", user.id).single()];
            case 7:
                profile = (_e.sent()).data;
                res.status(201).json({
                    ok: true,
                    comment: {
                        id: comment.id,
                        body: comment.body,
                        createdAt: comment.created_at,
                        updatedAt: null,
                        canDelete: true,
                        author: profile
                            ? { id: profile.id, handle: profile.handle, name: profile.name, avatarUrl: (_d = profile.avatar_url) !== null && _d !== void 0 ? _d : null }
                            : { id: user.id, handle: "traveler", name: "Traveler", avatarUrl: null },
                    },
                    commentCount: count !== null && count !== void 0 ? count : 0,
                });
                return [2 /*return*/];
        }
    });
}); });
router.delete("/posts/:postId/comments/:commentId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, client, _a, postId, commentId, sc, existing, count;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user, client = auth.client;
                _a = req.params, postId = _a.postId, commentId = _a.commentId;
                if (!isValidUuid(postId) || !isValidUuid(commentId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("posts_comments").select("id, user_id")
                        .eq("id", commentId).eq("post_id", postId).is("deleted_at", null).maybeSingle()];
            case 2:
                existing = (_b.sent()).data;
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Comment not found");
                    return [2 /*return*/];
                }
                if (existing.user_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Cannot delete someone else's comment");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("posts_comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId)];
            case 3:
                _b.sent();
                return [4 /*yield*/, sc.from("posts_comments").select("id", { count: "exact", head: true })
                        .eq("post_id", postId).is("deleted_at", null)];
            case 4:
                count = (_b.sent()).count;
                return [4 /*yield*/, sc.from("posts").update({ comment_count: count !== null && count !== void 0 ? count : 0 }).eq("id", postId)];
            case 5:
                _b.sent();
                res.status(200).json({ ok: true, commentCount: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
