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
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var messageTranslation_1 = require("../services/messageTranslation");
var router = (0, express_1.Router)();
var AVATAR_BUCKET = "profile-media";
var ALLOWED_AVATAR_MIME = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};
var MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
var SUPPORTED_LANGUAGE_CODES = new Set([
    'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'zh-TW',
    'pt', 'it', 'ru', 'ar', 'th', 'vi', 'id', 'tl',
    'sv', 'nl', 'pl', 'tr', 'hi',
]);
var RESERVED_USERNAMES = new Set([
    "admin", "support", "system", "travelbuddy", "passport", "official",
    "root", "api", "settings", "login", "signup", "help", "me", "user",
    "users", "null", "undefined", "about", "terms", "privacy",
]);
var USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
function validateUsername(u) {
    if (!USERNAME_RE.test(u)) {
        return { valid: false, reason: "Username must be 3-24 chars, lowercase letters/numbers/underscores/periods only" };
    }
    if (RESERVED_USERNAMES.has(u)) {
        return { valid: false, reason: "That username is reserved" };
    }
    return { valid: true };
}
var PROFILE_COLUMNS = "id, handle, name, display_name, username, bio, avatar_url, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, passport_visibility, cover_photo_url, username_updated_at, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style, public_social_links, preferred_language";
/** Fallback: select everything that exists; mapProfile handles every field with ?? null. */
var PROFILE_COLUMNS_FALLBACK = "*";
function mapProfile(r) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8;
    return {
        id: r.id,
        handle: (_a = r.handle) !== null && _a !== void 0 ? _a : null,
        name: (_b = r.name) !== null && _b !== void 0 ? _b : null,
        displayName: (_d = (_c = r.display_name) !== null && _c !== void 0 ? _c : r.name) !== null && _d !== void 0 ? _d : null,
        username: (_e = r.username) !== null && _e !== void 0 ? _e : null,
        bio: (_f = r.bio) !== null && _f !== void 0 ? _f : null,
        avatarUrl: (_g = r.avatar_url) !== null && _g !== void 0 ? _g : null,
        homeCity: (_h = r.home_city) !== null && _h !== void 0 ? _h : null,
        homeCountry: (_j = r.home_country) !== null && _j !== void 0 ? _j : null,
        currentCity: (_k = r.current_city) !== null && _k !== void 0 ? _k : null,
        travelStyle: (_l = r.travel_style) !== null && _l !== void 0 ? _l : null,
        interests: (_m = r.interests) !== null && _m !== void 0 ? _m : [],
        verified: (_o = r.verified) !== null && _o !== void 0 ? _o : false,
        verificationStatus: (_p = r.verification_status) !== null && _p !== void 0 ? _p : 'unverified',
        verifiedAt: (_q = r.verified_at) !== null && _q !== void 0 ? _q : null,
        openToMeet: (_r = r.open_to_meet) !== null && _r !== void 0 ? _r : false,
        isPrivate: (_s = r.is_private) !== null && _s !== void 0 ? _s : false,
        passportVisibility: (_t = r.passport_visibility) !== null && _t !== void 0 ? _t : "public",
        coverPhotoUrl: (_u = r.cover_photo_url) !== null && _u !== void 0 ? _u : null,
        usernameUpdatedAt: (_v = r.username_updated_at) !== null && _v !== void 0 ? _v : null,
        createdAt: (_w = r.created_at) !== null && _w !== void 0 ? _w : null,
        spokenLanguages: (_x = r.spoken_languages) !== null && _x !== void 0 ? _x : [],
        defaultLanguage: (_y = r.default_language) !== null && _y !== void 0 ? _y : null,
        travelStyles: (_z = r.travel_styles) !== null && _z !== void 0 ? _z : [],
        travelPace: (_0 = r.travel_pace) !== null && _0 !== void 0 ? _0 : null,
        budgetStyle: (_1 = r.budget_style) !== null && _1 !== void 0 ? _1 : null,
        travelGroupStyle: (_2 = r.travel_group_style) !== null && _2 !== void 0 ? _2 : [],
        lookingFor: (_3 = r.looking_for) !== null && _3 !== void 0 ? _3 : [],
        comfortLevel: (_4 = r.comfort_level) !== null && _4 !== void 0 ? _4 : null,
        availabilityTags: (_5 = r.availability_tags) !== null && _5 !== void 0 ? _5 : [],
        planningStyle: (_6 = r.planning_style) !== null && _6 !== void 0 ? _6 : null,
        publicSocialLinks: (_7 = r.public_social_links) !== null && _7 !== void 0 ? _7 : {},
        preferredLanguage: (_8 = r.preferred_language) !== null && _8 !== void 0 ? _8 : null,
    };
}
/* ===========================================================================
 * GET /me/profile — full own profile
 * ===========================================================================
 */
router.get("/me/profile", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, data, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, client
                        .from("profiles")
                        .select(PROFILE_COLUMNS)
                        .eq("id", user.id)
                        .maybeSingle()];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (!(error && error.code === "42703")) return [3 /*break*/, 4];
                return [4 /*yield*/, client
                        .from("profiles")
                        .select(PROFILE_COLUMNS_FALLBACK)
                        .eq("id", user.id)
                        .maybeSingle()];
            case 3:
                (_b = _c.sent(), data = _b.data, error = _b.error);
                _c.label = 4;
            case 4:
                if (error) {
                    req.log.error({ err: error }, "Failed to load own profile");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Profile not found");
                    return [2 /*return*/];
                }
                res.status(200).json(mapProfile(data));
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /me/profile — update own profile
 * ===========================================================================
 * User identity always from auth token — never from body.
 */
var patchProfileSchema = zod_1.z.object({
    displayName: zod_1.z.string().min(1).max(60).optional(),
    username: zod_1.z.string().optional(),
    bio: zod_1.z.string().max(300).optional(),
    homeCity: zod_1.z.string().max(100).optional(),
    homeCountry: zod_1.z.string().max(100).optional(),
    interests: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    passportVisibility: zod_1.z.enum(["public", "followers_only", "private"]).optional(),
    avatarUrl: zod_1.z.string().url().optional(),
    coverUrl: zod_1.z.string().url().optional(),
    travelStyle: zod_1.z.string().max(50).optional(),
    openToMeet: zod_1.z.boolean().optional(),
    spokenLanguages: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    defaultLanguage: zod_1.z.string().max(50).nullish(),
    travelStyles: zod_1.z.array(zod_1.z.string().max(50)).max(10).optional(),
    travelPace: zod_1.z.enum(["slow", "balanced", "packed"]).nullish(),
    budgetStyle: zod_1.z.enum(["budget", "mid-range", "luxury", "flexible"]).nullish(),
    travelGroupStyle: zod_1.z.array(zod_1.z.string().max(50)).max(5).optional(),
    lookingFor: zod_1.z.array(zod_1.z.string().max(50)).max(10).optional(),
    comfortLevel: zod_1.z.string().max(50).nullish(),
    availabilityTags: zod_1.z.array(zod_1.z.string().max(50)).max(4).optional(),
    planningStyle: zod_1.z.string().max(50).nullish(),
    publicSocialLinks: zod_1.z.record(zod_1.z.string().max(300)).optional(),
    preferredLanguage: zod_1.z.string().max(20).nullish(),
});
router.patch("/me/profile", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, p, row, v, existing, _a, updated, updateError, safeRow, sc;
    var _b;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = patchProfileSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                p = parsed.data;
                row = { updated_by: user.id };
                if (p.displayName !== undefined)
                    row.display_name = p.displayName;
                if (p.bio !== undefined)
                    row.bio = p.bio;
                if (p.homeCity !== undefined)
                    row.home_city = p.homeCity;
                if (p.homeCountry !== undefined)
                    row.home_country = p.homeCountry;
                if (p.interests !== undefined)
                    row.interests = p.interests;
                if (p.passportVisibility !== undefined)
                    row.passport_visibility = p.passportVisibility;
                if (p.avatarUrl !== undefined)
                    row.avatar_url = p.avatarUrl;
                if (p.travelStyle !== undefined)
                    row.travel_style = p.travelStyle;
                if (p.openToMeet !== undefined)
                    row.open_to_meet = p.openToMeet;
                if (p.spokenLanguages !== undefined)
                    row.spoken_languages = p.spokenLanguages;
                if (p.defaultLanguage !== undefined)
                    row.default_language = p.defaultLanguage;
                if (p.travelStyles !== undefined)
                    row.travel_styles = p.travelStyles;
                if (p.travelPace !== undefined)
                    row.travel_pace = p.travelPace;
                if (p.budgetStyle !== undefined)
                    row.budget_style = p.budgetStyle;
                if (p.travelGroupStyle !== undefined)
                    row.travel_group_style = p.travelGroupStyle;
                if (p.lookingFor !== undefined)
                    row.looking_for = p.lookingFor;
                if (p.comfortLevel !== undefined)
                    row.comfort_level = p.comfortLevel;
                if (p.availabilityTags !== undefined)
                    row.availability_tags = p.availabilityTags;
                if (p.planningStyle !== undefined)
                    row.planning_style = p.planningStyle;
                if (p.publicSocialLinks !== undefined)
                    row.public_social_links = p.publicSocialLinks;
                if (p.coverUrl !== undefined)
                    row.cover_photo_url = p.coverUrl;
                if (p.preferredLanguage !== undefined) {
                    if (p.preferredLanguage !== null && !SUPPORTED_LANGUAGE_CODES.has(p.preferredLanguage)) {
                        (0, http_1.sendError)(res, "invalid_payload", "Unsupported language code: \"".concat(p.preferredLanguage, "\". Supported: ").concat(__spreadArray([], SUPPORTED_LANGUAGE_CODES, true).join(", ")));
                        return [2 /*return*/];
                    }
                    row.preferred_language = (_e = p.preferredLanguage) !== null && _e !== void 0 ? _e : null;
                }
                if (!(p.username !== undefined)) return [3 /*break*/, 3];
                v = validateUsername(p.username);
                if (!v.valid) {
                    (0, http_1.sendError)(res, "invalid_payload", (_f = v.reason) !== null && _f !== void 0 ? _f : "Invalid username");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .select("id")
                        .eq("username", p.username)
                        .neq("id", user.id)
                        .maybeSingle()];
            case 2:
                existing = (_g.sent()).data;
                if (existing) {
                    (0, http_1.sendError)(res, "invalid_payload", "Username is already taken");
                    return [2 /*return*/];
                }
                row.username = p.username;
                row.username_updated_at = new Date().toISOString();
                _g.label = 3;
            case 3:
                if (Object.keys(row).length <= 1) {
                    (0, http_1.sendError)(res, "invalid_payload", "At least one field must be provided");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .update(row)
                        .eq("id", user.id)
                        .select(PROFILE_COLUMNS)
                        .single()];
            case 4:
                _a = _g.sent(), updated = _a.data, updateError = _a.error;
                if (!(updateError && updateError.code === "42703")) return [3 /*break*/, 6];
                safeRow = __assign({}, row);
                delete safeRow.display_name;
                delete safeRow.spoken_languages;
                delete safeRow.default_language;
                delete safeRow.travel_styles;
                delete safeRow.travel_pace;
                delete safeRow.budget_style;
                delete safeRow.travel_group_style;
                delete safeRow.looking_for;
                delete safeRow.comfort_level;
                delete safeRow.availability_tags;
                delete safeRow.planning_style;
                delete safeRow.public_social_links;
                return [4 /*yield*/, client
                        .from("profiles")
                        .update(safeRow)
                        .eq("id", user.id)
                        .select(PROFILE_COLUMNS_FALLBACK)
                        .single()];
            case 5:
                (_b = _g.sent(), updated = _b.data, updateError = _b.error);
                _g.label = 6;
            case 6:
                if (updateError) {
                    req.log.error({ err: updateError }, "Failed to update profile");
                    (0, http_1.sendError)(res, "db_error", updateError.message);
                    return [2 /*return*/];
                }
                // Fire-and-forget re-translation sweep when preferred_language changes.
                if (p.preferredLanguage !== undefined && p.preferredLanguage !== null) {
                    sc = (0, supabase_1.getServiceClient)();
                    if (sc) {
                        (0, messageTranslation_1.retranslateForUser)(sc, user.id, p.preferredLanguage, req.log).catch(function () { });
                    }
                }
                res.status(200).json(mapProfile(updated));
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/check-username — check username availability
 * ===========================================================================
 */
router.get("/users/check-username", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, username, v, data;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                username = String((_a = req.query.username) !== null && _a !== void 0 ? _a : "").toLowerCase().trim();
                if (!username) {
                    res.status(200).json({ available: false, reason: "Username is required" });
                    return [2 /*return*/];
                }
                v = validateUsername(username);
                if (!v.valid) {
                    res.status(200).json({ available: false, reason: v.reason });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .select("id")
                        .eq("username", username)
                        .neq("id", user.id)
                        .maybeSingle()];
            case 2:
                data = (_b.sent()).data;
                if (data) {
                    res.status(200).json({ available: false, reason: "Username is already taken" });
                    return [2 /*return*/];
                }
                res.status(200).json({ available: true });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /me/avatar/upload — upload avatar image
 * ===========================================================================
 * Accepts raw binary body, Content-Type = MIME. ≤5 MB. jpeg/png/webp only.
 * Uploads to profile-media bucket at avatars/{userId}/{uuid}.{ext}.
 * Returns { url }. Does NOT update avatar_url on the profile row —
 * caller must follow up with PATCH /me/profile { avatarUrl }.
 */
router.post("/me/avatar/upload", function (req, res, next) {
    var chunks = [];
    req.on("data", function (c) { return chunks.push(c); });
    req.on("end", function () { req.rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
}, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, mimeType, ext, rawBody, randomUUID, uuid, path, error, urlData;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                mimeType = ((_a = req.headers["content-type"]) !== null && _a !== void 0 ? _a : "").split(";")[0].trim();
                ext = ALLOWED_AVATAR_MIME[mimeType];
                if (!ext) {
                    (0, http_1.sendError)(res, "invalid_payload", "Unsupported avatar type: ".concat(mimeType, ". Use jpeg, png, or webp."));
                    return [2 /*return*/];
                }
                rawBody = req.rawBody;
                if (!rawBody || rawBody.length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "Empty file body");
                    return [2 /*return*/];
                }
                if (rawBody.length > MAX_AVATAR_BYTES) {
                    (0, http_1.sendError)(res, "invalid_payload", "Avatar too large (".concat(Math.round(rawBody.length / 1024 / 1024), "MB; max 5MB)"));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.resolve().then(function () { return require("crypto"); })];
            case 2:
                randomUUID = (_b.sent()).randomUUID;
                uuid = randomUUID();
                path = "avatars/".concat(user.id, "/").concat(uuid, ".").concat(ext);
                return [4 /*yield*/, client.storage
                        .from(AVATAR_BUCKET)
                        .upload(path, rawBody, { contentType: mimeType, upsert: true })];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error, path: path }, "Avatar upload failed");
                    (0, http_1.sendError)(res, "db_error", "Upload failed: ".concat(error.message));
                    return [2 /*return*/];
                }
                urlData = client.storage.from(AVATAR_BUCKET).getPublicUrl(path).data;
                res.status(201).json({ url: urlData.publicUrl, path: path });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /me/cover/upload — upload cover photo image
 * ===========================================================================
 * Accepts raw binary body, Content-Type = MIME. ≤10 MB. jpeg/png/webp only.
 * Uploads to profile-media bucket at covers/{userId}/cover.{ext} (fixed path,
 * so each upload replaces the previous one). Returns { url }.
 * Does NOT update cover_photo_url on the profile row —
 * caller must follow up with PATCH /me/profile { coverUrl }.
 */
var MAX_COVER_BYTES = 10 * 1024 * 1024; // 10 MB
router.post("/me/cover/upload", function (req, res, next) {
    var chunks = [];
    req.on("data", function (c) { return chunks.push(c); });
    req.on("end", function () { req.rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
}, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, mimeType, ext, rawBody, path, error, urlData;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                mimeType = ((_a = req.headers["content-type"]) !== null && _a !== void 0 ? _a : "").split(";")[0].trim();
                ext = ALLOWED_AVATAR_MIME[mimeType];
                if (!ext) {
                    (0, http_1.sendError)(res, "invalid_payload", "Unsupported cover type: ".concat(mimeType, ". Use jpeg, png, or webp."));
                    return [2 /*return*/];
                }
                rawBody = req.rawBody;
                if (!rawBody || rawBody.length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "Empty file body");
                    return [2 /*return*/];
                }
                if (rawBody.length > MAX_COVER_BYTES) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cover too large (".concat(Math.round(rawBody.length / 1024 / 1024), "MB; max 10MB)"));
                    return [2 /*return*/];
                }
                path = "covers/".concat(user.id, "/cover.").concat(ext);
                return [4 /*yield*/, client.storage
                        .from(AVATAR_BUCKET)
                        .upload(path, rawBody, { contentType: mimeType, upsert: true })];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error, path: path }, "Cover upload failed");
                    (0, http_1.sendError)(res, "db_error", "Upload failed: ".concat(error.message));
                    return [2 /*return*/];
                }
                urlData = client.storage.from(AVATAR_BUCKET).getPublicUrl(path).data;
                res.status(201).json({ url: urlData.publicUrl, path: path });
                return [2 /*return*/];
        }
    });
}); });
// ── PUT /api/me/push-token ────────────────────────────────────────────────────
// Stores the device's Expo push token so the server can send push notifications.
router.put("/me/push-token", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, token, error;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                ctx = _b.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                token = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).token;
                if (typeof token !== "string" || !token.startsWith("ExponentPushToken[")) {
                    (0, http_1.sendError)(res, "invalid_payload", "token must be a valid ExponentPushToken");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .update({ expo_push_token: token })
                        .eq("id", user.id)];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "push-token: db update failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
