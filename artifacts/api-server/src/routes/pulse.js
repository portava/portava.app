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
/**
 * Pulse feed routes
 *
 * GET /api/pulse  — location-scoped Pulse feed
 *   Auth required. Returns posts + their pulse_geo_tags context.
 *   Exact GPS coordinates are never returned; only safe public labels.
 *
 * Tabs / filters:
 *   tab=city        — any post with city/neighborhood/venue-tagged visibility
 *   tab=nearby      — city_only or better + requester has nearby sharing
 *   tab=neighborhood — neighborhood or venue_tagged only
 *   tab=trip        — trip-attached posts only
 *   tab=crew        — posts from followed users only
 *   tab=all (default) — all non-hidden posts
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var router = (0, express_1.Router)();
var VALID_TABS = ["all", "city", "nearby", "neighborhood", "trip", "crew"];
// Visibility levels that each tab considers visible
var TAB_VISIBILITY = {
    all: null, // no filter
    city: ["city_only", "neighborhood", "venue_tagged"],
    nearby: ["city_only", "neighborhood", "venue_tagged", "exact_hidden"],
    neighborhood: ["neighborhood", "venue_tagged"],
    trip: null, // trip_id IS NOT NULL filter instead
    crew: null, // followed-users filter instead
};
var pulseQuerySchema = zod_1.z.object({
    tab: zod_1.z.enum(VALID_TABS).optional().default("all"),
    limit: zod_1.z.coerce.number().int().min(1).max(50).optional().default(20),
    before: zod_1.z.string().datetime().optional(),
});
// Safe columns — exact GPS is never projected
var POST_SAFE_COLUMNS = "id, author_id, trip_id, content, media_urls, visibility, status, created_at, " +
    "location_name, location_city, location_country, location_source";
var GEO_TAG_COLUMNS = "location_visibility, city, district, country, country_code, venue_name, hotel_blur_applied";
/* ===========================================================================
 * GET /api/pulse
 * =========================================================================*/
router.get("/pulse", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, tab, limit, before, crewIds, followRows, sc, query, _b, data, error, visibilityFilter, rows, posts;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = pulseQuerySchema.safeParse(req.query);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid query");
                    return [2 /*return*/];
                }
                _a = parsed.data, tab = _a.tab, limit = _a.limit, before = _a.before;
                crewIds = null;
                if (!(tab === "crew")) return [3 /*break*/, 3];
                return [4 /*yield*/, client
                        .from("follows")
                        .select("following_id")
                        .eq("follower_id", user.id)];
            case 2:
                followRows = (_g.sent()).data;
                crewIds = ((_e = followRows) !== null && _e !== void 0 ? _e : []).map(function (r) { return r.following_id; });
                if (crewIds.length === 0) {
                    res.json({ posts: [], total: 0, tab: tab });
                    return [2 /*return*/];
                }
                _g.label = 3;
            case 3:
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not available");
                    return [2 /*return*/];
                }
                query = sc
                    .from("posts")
                    .select("".concat(POST_SAFE_COLUMNS, ", pulse_geo_tags(").concat(GEO_TAG_COLUMNS, "), profiles!author_id(id, username, full_name, avatar_url)"))
                    .eq("status", "active")
                    .eq("visibility", "public")
                    .order("created_at", { ascending: false })
                    .limit(limit);
                if (before) {
                    query = query.lt("created_at", before);
                }
                // Tab-specific filters
                if (tab === "trip") {
                    query = query.not("trip_id", "is", null);
                }
                else if (tab === "crew" && crewIds) {
                    query = query.in("author_id", crewIds);
                }
                return [4 /*yield*/, query];
            case 4:
                _b = _g.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "pulse feed query failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                visibilityFilter = TAB_VISIBILITY[tab];
                rows = (_f = data) !== null && _f !== void 0 ? _f : [];
                if (visibilityFilter !== null && tab !== "trip" && tab !== "crew") {
                    rows = rows.filter(function (row) {
                        var geoTag = Array.isArray(row.pulse_geo_tags)
                            ? row.pulse_geo_tags[0]
                            : row.pulse_geo_tags;
                        if (!geoTag)
                            return tab === "all" || tab === "city"; // no tag → include for broad tabs
                        return visibilityFilter.includes(geoTag.location_visibility);
                    });
                }
                posts = rows.map(function (row) {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
                    var geoTag = Array.isArray(row.pulse_geo_tags)
                        ? row.pulse_geo_tags[0]
                        : row.pulse_geo_tags;
                    var profile = Array.isArray(row.profiles)
                        ? row.profiles[0]
                        : row.profiles;
                    return {
                        id: row.id,
                        authorId: row.author_id,
                        tripId: (_a = row.trip_id) !== null && _a !== void 0 ? _a : null,
                        content: row.content,
                        mediaUrls: (_b = row.media_urls) !== null && _b !== void 0 ? _b : [],
                        visibility: row.visibility,
                        createdAt: row.created_at,
                        // location labels — safe, no coords
                        locationName: (_c = row.location_name) !== null && _c !== void 0 ? _c : null,
                        locationCity: (_e = (_d = geoTag === null || geoTag === void 0 ? void 0 : geoTag.city) !== null && _d !== void 0 ? _d : row.location_city) !== null && _e !== void 0 ? _e : null,
                        locationCountry: (_g = (_f = geoTag === null || geoTag === void 0 ? void 0 : geoTag.country) !== null && _f !== void 0 ? _f : row.location_country) !== null && _g !== void 0 ? _g : null,
                        locationDistrict: (_h = geoTag === null || geoTag === void 0 ? void 0 : geoTag.district) !== null && _h !== void 0 ? _h : null,
                        venueName: (_j = geoTag === null || geoTag === void 0 ? void 0 : geoTag.venue_name) !== null && _j !== void 0 ? _j : null,
                        locationVisibility: (_k = geoTag === null || geoTag === void 0 ? void 0 : geoTag.location_visibility) !== null && _k !== void 0 ? _k : "city_only",
                        hotelBlurApplied: (_l = geoTag === null || geoTag === void 0 ? void 0 : geoTag.hotel_blur_applied) !== null && _l !== void 0 ? _l : false,
                        // author (safe public profile)
                        author: profile ? {
                            id: profile.id,
                            username: profile.username,
                            name: (_m = profile.full_name) !== null && _m !== void 0 ? _m : profile.username,
                            avatarUrl: (_o = profile.avatar_url) !== null && _o !== void 0 ? _o : null,
                        } : null,
                    };
                });
                res.json({ posts: posts, total: posts.length, tab: tab });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
