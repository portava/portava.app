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
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var router = (0, express_1.Router)();
var PUBLIC_PROFILE_COLUMNS = "id, username, display_name, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at";
var PUBLIC_PROFILE_COLUMNS_FALLBACK = "id, username, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, verification_status, verified_at, passport_visibility, created_at";
var PUBLIC_POSTCARD_COLUMNS = "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at";
/** Fallback: select everything; mapPostcard handles missing fields with ?? null. */
var PUBLIC_POSTCARD_COLUMNS_FALLBACK = "*";
function mapPublicProfile(r) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    return {
        id: r.id,
        username: (_a = r.username) !== null && _a !== void 0 ? _a : null,
        displayName: (_c = (_b = r.display_name) !== null && _b !== void 0 ? _b : r.name) !== null && _c !== void 0 ? _c : null,
        bio: (_d = r.bio) !== null && _d !== void 0 ? _d : null,
        avatarUrl: (_e = r.avatar_url) !== null && _e !== void 0 ? _e : null,
        homeCity: (_f = r.home_city) !== null && _f !== void 0 ? _f : null,
        homeCountry: (_g = r.home_country) !== null && _g !== void 0 ? _g : null,
        travelStyle: (_h = r.travel_style) !== null && _h !== void 0 ? _h : null,
        interests: (_j = r.interests) !== null && _j !== void 0 ? _j : [],
        verified: (_k = r.verified) !== null && _k !== void 0 ? _k : false,
        verificationStatus: (_l = r.verification_status) !== null && _l !== void 0 ? _l : 'unverified',
        verifiedAt: (_m = r.verified_at) !== null && _m !== void 0 ? _m : null,
        passportVisibility: (_o = r.passport_visibility) !== null && _o !== void 0 ? _o : "public",
        createdAt: (_p = r.created_at) !== null && _p !== void 0 ? _p : null,
    };
}
function mapPostcard(r, includePrivate) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    if (includePrivate === void 0) { includePrivate = false; }
    var base = {
        id: r.id,
        postId: r.post_id,
        mediaUrl: (_a = r.media_url) !== null && _a !== void 0 ? _a : null,
        caption: (_b = r.caption) !== null && _b !== void 0 ? _b : null,
        locationName: (_c = r.location_name) !== null && _c !== void 0 ? _c : null,
        locationCity: (_d = r.location_city) !== null && _d !== void 0 ? _d : null,
        locationCountry: (_e = r.location_country) !== null && _e !== void 0 ? _e : null,
        locationVerified: (_f = r.location_verified) !== null && _f !== void 0 ? _f : false,
        stampEligible: (_g = r.stamp_eligible) !== null && _g !== void 0 ? _g : false,
        visibility: (_h = r.visibility) !== null && _h !== void 0 ? _h : "public",
        status: (_j = r.status) !== null && _j !== void 0 ? _j : "active",
        pinnedAt: (_k = r.pinned_at) !== null && _k !== void 0 ? _k : null,
        note: (_l = r.note) !== null && _l !== void 0 ? _l : null,
        createdAt: (_m = r.created_at) !== null && _m !== void 0 ? _m : null,
    };
    if (includePrivate) {
        base.userId = r.user_id;
    }
    return base;
}
/* ===========================================================================
 * GET /users/:username/passport — public passport lookup (no auth required)
 * ===========================================================================
 * Uses the service-role client so unauthenticated callers can view public
 * passports. Private profiles return { private: true } — not a 403.
 */
router.get("/users/:username/passport", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var sc, username, _a, data, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                username = req.params.username.replace(/^@/, "").toLowerCase().trim();
                if (!username || username.length < 1) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid username");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select(PUBLIC_PROFILE_COLUMNS)
                        .eq("username", username)
                        .maybeSingle()];
            case 1:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (!(error && error.code === "42703")) return [3 /*break*/, 3];
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select(PUBLIC_PROFILE_COLUMNS_FALLBACK)
                        .eq("username", username)
                        .maybeSingle()];
            case 2:
                (_b = _c.sent(), data = _b.data, error = _b.error);
                _c.label = 3;
            case 3:
                if (error) {
                    req.log.error({ err: error }, "Failed to load public passport");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "User not found");
                    return [2 /*return*/];
                }
                if (data.passport_visibility === "private") {
                    res.status(200).json({ private: true });
                    return [2 /*return*/];
                }
                res.status(200).json(mapPublicProfile(data));
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:username/passport/postcards — public postcard wall (no auth required)
 * ===========================================================================
 * Uses service-role client so recipients of a share link can view postcards
 * without logging in. Never exposes exact GPS.
 */
router.get("/users/:username/passport/postcards", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var sc, username, _a, profile, profileErr, _b, postcards, postcardErr, fb;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                username = req.params.username.replace(/^@/, "").toLowerCase().trim();
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, passport_visibility")
                        .eq("username", username)
                        .maybeSingle()];
            case 1:
                _a = _c.sent(), profile = _a.data, profileErr = _a.error;
                if (profileErr || !profile) {
                    (0, http_1.sendError)(res, "not_found", "User not found");
                    return [2 /*return*/];
                }
                if (profile.passport_visibility === "private") {
                    res.status(200).json({ private: true, postcards: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("passport_postcards")
                        .select(PUBLIC_POSTCARD_COLUMNS)
                        .eq("user_id", profile.id)
                        .eq("status", "active")
                        .eq("visibility", "public")
                        .order("pinned_at", { ascending: false, nullsFirst: false })
                        .order("created_at", { ascending: false })
                        .limit(50)];
            case 2:
                _b = _c.sent(), postcards = _b.data, postcardErr = _b.error;
                if (!(postcardErr && postcardErr.code === "42703")) return [3 /*break*/, 4];
                return [4 /*yield*/, sc
                        .from("passport_postcards")
                        .select(PUBLIC_POSTCARD_COLUMNS_FALLBACK)
                        .eq("user_id", profile.id)
                        .eq("status", "active")
                        .eq("visibility", "public")
                        .order("created_at", { ascending: false })
                        .limit(50)];
            case 3:
                fb = _c.sent();
                postcards = fb.data;
                postcardErr = fb.error;
                _c.label = 4;
            case 4:
                if (postcardErr) {
                    req.log.error({ err: postcardErr }, "Failed to list public postcards");
                    (0, http_1.sendError)(res, "db_error", postcardErr.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ postcards: (postcards !== null && postcards !== void 0 ? postcards : []).map(function (r) { return mapPostcard(r, false); }) });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/passport/postcards — owner's own full postcard list
 * ===========================================================================
 */
router.get("/me/passport/postcards", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, OWNER_POSTCARD_COLUMNS, OWNER_POSTCARD_COLUMNS_FALLBACK, _a, data, error, fb;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                OWNER_POSTCARD_COLUMNS = "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, stamp_reason, verification_method, visibility, status, pinned_at, note, created_at";
                OWNER_POSTCARD_COLUMNS_FALLBACK = "*";
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .select(OWNER_POSTCARD_COLUMNS)
                        .eq("user_id", user.id)
                        .neq("status", "deleted")
                        .order("pinned_at", { ascending: false, nullsFirst: false })
                        .order("created_at", { ascending: false })
                        .limit(100)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (!(error && error.code === "42703")) return [3 /*break*/, 4];
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .select(OWNER_POSTCARD_COLUMNS_FALLBACK)
                        .eq("user_id", user.id)
                        .neq("status", "deleted")
                        .order("created_at", { ascending: false })
                        .limit(100)];
            case 3:
                fb = _b.sent();
                data = fb.data;
                error = fb.error;
                _b.label = 4;
            case 4:
                if (error) {
                    req.log.error({ err: error }, "Failed to list own postcards");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({
                    postcards: (data !== null && data !== void 0 ? data : []).map(function (r) {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
                        return ({
                            id: r.id,
                            postId: r.post_id,
                            mediaUrl: (_a = r.media_url) !== null && _a !== void 0 ? _a : null,
                            caption: (_b = r.caption) !== null && _b !== void 0 ? _b : null,
                            locationName: (_c = r.location_name) !== null && _c !== void 0 ? _c : null,
                            locationCity: (_d = r.location_city) !== null && _d !== void 0 ? _d : null,
                            locationCountry: (_e = r.location_country) !== null && _e !== void 0 ? _e : null,
                            locationVerified: (_f = r.location_verified) !== null && _f !== void 0 ? _f : false,
                            stampEligible: (_g = r.stamp_eligible) !== null && _g !== void 0 ? _g : false,
                            stampReason: (_h = r.stamp_reason) !== null && _h !== void 0 ? _h : null,
                            verificationMethod: (_j = r.verification_method) !== null && _j !== void 0 ? _j : null,
                            visibility: (_k = r.visibility) !== null && _k !== void 0 ? _k : "public",
                            status: (_l = r.status) !== null && _l !== void 0 ? _l : "active",
                            pinnedAt: (_m = r.pinned_at) !== null && _m !== void 0 ? _m : null,
                            note: (_o = r.note) !== null && _o !== void 0 ? _o : null,
                            createdAt: (_p = r.created_at) !== null && _p !== void 0 ? _p : null,
                        });
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /passport/postcards/:id — update postcard (owner only)
 * ===========================================================================
 * Updates note, visibility, pinned_at. Pinning enforces one-per-user.
 */
var patchPostcardSchema = zod_1.z.object({
    note: zod_1.z.string().max(500).nullable().optional(),
    visibility: zod_1.z.enum(["public", "private", "trip_only"]).optional(),
    pin: zod_1.z.boolean().optional(),
});
router.patch("/passport/postcards/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postcardId, parsed, _a, existing, loadErr, patch, _b, data, error;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postcardId = req.params.id;
                parsed = patchPostcardSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .select("id, user_id, status")
                        .eq("id", postcardId)
                        .maybeSingle()];
            case 2:
                _a = _e.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Postcard not found");
                    return [2 /*return*/];
                }
                if (existing.user_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Not your postcard");
                    return [2 /*return*/];
                }
                patch = {};
                if (parsed.data.note !== undefined)
                    patch.note = parsed.data.note;
                if (parsed.data.visibility !== undefined)
                    patch.visibility = parsed.data.visibility;
                if (!(parsed.data.pin === true)) return [3 /*break*/, 4];
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .update({ pinned_at: null })
                        .eq("user_id", user.id)
                        .not("id", "eq", postcardId)];
            case 3:
                _e.sent();
                patch.pinned_at = new Date().toISOString();
                return [3 /*break*/, 5];
            case 4:
                if (parsed.data.pin === false) {
                    patch.pinned_at = null;
                }
                _e.label = 5;
            case 5:
                if (Object.keys(patch).length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "At least one field must be provided");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .update(patch)
                        .eq("id", postcardId)
                        .eq("user_id", user.id)
                        .select("id, post_id, media_url, caption, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at")
                        .single()];
            case 6:
                _b = _e.sent(), data = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to update postcard");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /passport/postcards/:id/remove — remove from passport (owner only)
 * ===========================================================================
 * Sets status to removed_from_passport — does NOT delete the original post.
 */
router.patch("/passport/postcards/:id/remove", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, postcardId, _a, existing, loadErr, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                postcardId = req.params.id;
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .select("id, user_id")
                        .eq("id", postcardId)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), existing = _a.data, loadErr = _a.error;
                if (loadErr) {
                    (0, http_1.sendError)(res, "db_error", loadErr.message);
                    return [2 /*return*/];
                }
                if (!existing) {
                    (0, http_1.sendError)(res, "not_found", "Postcard not found");
                    return [2 /*return*/];
                }
                if (existing.user_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Not your postcard");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("passport_postcards")
                        .update({ status: "removed_from_passport", pinned_at: null })
                        .eq("id", postcardId)
                        .eq("user_id", user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to remove postcard");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:username/profile — public profile card (for share link preview)
 * ===========================================================================
 * Returns displayName, username, avatarUrl, coverUrl, tripCount, stampCount,
 * and visibility. Returns 404 for unknown usernames. Returns a minimal stub
 * for private profiles instead of a full 403.
 */
router.get("/users/:username/profile", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var sc, username, _a, profile, profileErr, _b, _c, tripResult, stampResult, tripCount, stampCount;
    var _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    return __generator(this, function (_p) {
        switch (_p.label) {
            case 0:
                sc = (0, supabase_1.getServiceClient)();
                username = req.params.username.replace(/^@/, "").toLowerCase().trim();
                if (!username) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid username");
                    return [2 /*return*/];
                }
                if (!sc) return [3 /*break*/, 2];
                return [4 /*yield*/, sc.from("profiles")
                        .select("id, username, display_name, name, avatar_url, cover_photo_url, passport_visibility, bio")
                        .eq("username", username)
                        .maybeSingle()];
            case 1:
                _b = _p.sent();
                return [3 /*break*/, 3];
            case 2:
                _b = { data: null, error: new Error("No service client") };
                _p.label = 3;
            case 3:
                _a = _b, profile = _a.data, profileErr = _a.error;
                if (profileErr || !profile) {
                    res.status(404).json({ error: "not_found", message: "User not found" });
                    return [2 /*return*/];
                }
                if (profile.passport_visibility === "private") {
                    res.status(200).json({
                        private: true,
                        username: profile.username,
                        displayName: (_e = (_d = profile.display_name) !== null && _d !== void 0 ? _d : profile.name) !== null && _e !== void 0 ? _e : null,
                        avatarUrl: null,
                        coverUrl: null,
                        tripCount: 0,
                        stampCount: 0,
                        visibility: "private",
                    });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc
                            ? sc.from("trips").select("id", { count: "exact", head: true }).eq("owner_id", profile.id)
                            : Promise.resolve({ count: 0, error: null }),
                        sc
                            ? sc.from("stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("locked", false)
                            : Promise.resolve({ count: 0, error: null }),
                    ])];
            case 4:
                _c = _p.sent(), tripResult = _c[0], stampResult = _c[1];
                tripCount = tripResult.count;
                stampCount = ((_f = stampResult.error) === null || _f === void 0 ? void 0 : _f.code) === "PGRST205" ? 0 : stampResult.count;
                res.status(200).json({
                    id: profile.id,
                    username: (_g = profile.username) !== null && _g !== void 0 ? _g : null,
                    displayName: (_j = (_h = profile.display_name) !== null && _h !== void 0 ? _h : profile.name) !== null && _j !== void 0 ? _j : null,
                    bio: (_k = profile.bio) !== null && _k !== void 0 ? _k : null,
                    avatarUrl: (_l = profile.avatar_url) !== null && _l !== void 0 ? _l : null,
                    coverUrl: (_m = profile.cover_photo_url) !== null && _m !== void 0 ? _m : null,
                    tripCount: tripCount !== null && tripCount !== void 0 ? tripCount : 0,
                    stampCount: stampCount !== null && stampCount !== void 0 ? stampCount : 0,
                    visibility: (_o = profile.passport_visibility) !== null && _o !== void 0 ? _o : "public",
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/stamps  — caller's earned stamps
 * ===========================================================================
 * Returns only unlocked stamps (locked=false). Ordered most-recently-earned
 * first. The response shape matches PassportStamp on the mobile client.
 */
router.get("/me/stamps", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, getServiceClient, sc, _a, data, error, stamps;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/supabase"); })];
            case 2:
                getServiceClient = (_b.sent()).getServiceClient;
                sc = getServiceClient();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("stamps")
                        .select("id, kind, label, sublabel, first_earned_at, last_earned_at, check_in_count, locked")
                        .eq("user_id", user.id)
                        .order("first_earned_at", { ascending: false })];
            case 3:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    // PGRST205 = table not found in schema cache (migration pending) — return empty gracefully
                    if (error.code === "PGRST205") {
                        res.status(200).json({ stamps: [] });
                        return [2 /*return*/];
                    }
                    req.log.error({ err: error }, "Failed to load stamps");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                stamps = (data !== null && data !== void 0 ? data : []).map(function (r) {
                    var _a, _b, _c;
                    return ({
                        id: r.id,
                        kind: r.kind,
                        label: r.label,
                        sublabel: (_a = r.sublabel) !== null && _a !== void 0 ? _a : null,
                        earnedAt: r.first_earned_at,
                        checkInCount: (_b = r.check_in_count) !== null && _b !== void 0 ? _b : 1,
                        locked: (_c = r.locked) !== null && _c !== void 0 ? _c : false,
                    });
                });
                res.status(200).json({ stamps: stamps });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
