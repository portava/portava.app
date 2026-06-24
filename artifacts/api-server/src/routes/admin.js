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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Admin geo controls
 *
 * Role-gated routes (profiles.role = 'admin' required).
 *
 * Geo zones  (geo_zones table — migration 0034):
 *   GET    /admin/geo-zones          — list
 *   POST   /admin/geo-zones          — create
 *   GET    /admin/geo-zones/:id      — single
 *   PATCH  /admin/geo-zones/:id      — update fields
 *   DELETE /admin/geo-zones/:id      — delete
 *
 * Suspicious GPS review  (location_trust_events — migration 0033):
 *   GET  /admin/suspicious-gps           — unreviewed events
 *   POST /admin/suspicious-gps/:id/resolve — mark reviewed
 *
 * Venue moderation  (discovery_places — migration 0029):
 *   GET  /admin/venues/pending        — provisional community places
 *   POST /admin/venues/:id/moderate   — approve (→ verified) or reject (→ blocked)
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var router = (0, express_1.Router)();
// ── Admin guard ───────────────────────────────────────────────────────────────
/**
 * Returns the authenticated user's client (from requireUser / _testClient in tests)
 * plus the service client (for bypassing RLS in production).
 *
 * In tests: `sc` is the fake client injected via _setTestClient.
 * In production: `sc` is the real service-role client from getServiceClient().
 */
function requireAdmin(req, res) {
    return __awaiter(this, void 0, void 0, function () {
        var auth, client, user, _a, data, error, sc;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
                case 1:
                    auth = _c.sent();
                    if (!auth)
                        return [2 /*return*/, null];
                    client = auth.client, user = auth.user;
                    return [4 /*yield*/, client
                            .from("profiles")
                            .select("role")
                            .eq("id", user.id)
                            .maybeSingle()];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data || data.role !== "admin") {
                        res.status(403).json({ error: "forbidden", message: "Admin role required" });
                        return [2 /*return*/, null];
                    }
                    sc = (_b = (0, supabase_1.getServiceClient)()) !== null && _b !== void 0 ? _b : client;
                    return [2 /*return*/, { userId: user.id, client: client, sc: sc }];
            }
        });
    });
}
// ── Geo zone schemas ──────────────────────────────────────────────────────────
// Valid zone_type values from the migration comment
var GEO_ZONE_TYPES = ["city", "neighborhood", "district", "venue_area", "safety_zone"];
// Valid safety_rating values from the migration comment
var SAFETY_RATINGS = ["safe", "moderate", "caution", "avoid"];
var createGeoZoneSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    zoneType: zod_1.z.enum(GEO_ZONE_TYPES),
    centerLat: zod_1.z.number().min(-90).max(90).optional(),
    centerLng: zod_1.z.number().min(-180).max(180).optional(),
    radiusMeters: zod_1.z.number().positive().max(100000).optional(),
    boundsJson: zod_1.z.record(zod_1.z.unknown()).optional(),
    city: zod_1.z.string().max(120).optional(),
    countryCode: zod_1.z.string().max(4).optional(),
    safetyRating: zod_1.z.enum(SAFETY_RATINGS).optional(),
    featured: zod_1.z.boolean().optional().default(false),
    verified: zod_1.z.boolean().optional().default(false),
});
// ── GET /admin/geo-zones ──────────────────────────────────────────────────────
router.get("/admin/geo-zones", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, page, limit, city, query, _a, data, error, count;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _c.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                page = Math.max(1, Number(req.query.page) || 1);
                limit = Math.min(100, Number(req.query.limit) || 50);
                city = ((_b = req.query.city) !== null && _b !== void 0 ? _b : "").trim() || null;
                query = sc
                    .from("geo_zones")
                    .select("id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, " +
                    "safety_rating, featured, verified, created_by, created_at", { count: "exact" })
                    .order("created_at", { ascending: false })
                    .range((page - 1) * limit, page * limit - 1);
                if (city)
                    query = query.ilike("city", "%".concat(city, "%"));
                return [4 /*yield*/, query];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error, count = _a.count;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ zones: data !== null && data !== void 0 ? data : [], total: count !== null && count !== void 0 ? count : 0, page: page });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /admin/geo-zones ─────────────────────────────────────────────────────
router.post("/admin/geo-zones", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, parsed, d, _a, data, error;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    return __generator(this, function (_o) {
        switch (_o.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _o.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                parsed = createGeoZoneSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                d = parsed.data;
                return [4 /*yield*/, sc
                        .from("geo_zones")
                        .insert({
                        name: d.name,
                        zone_type: d.zoneType,
                        center_lat: (_d = d.centerLat) !== null && _d !== void 0 ? _d : null,
                        center_lng: (_e = d.centerLng) !== null && _e !== void 0 ? _e : null,
                        radius_meters: (_f = d.radiusMeters) !== null && _f !== void 0 ? _f : null,
                        bounds_json: (_g = d.boundsJson) !== null && _g !== void 0 ? _g : null,
                        city: (_h = d.city) !== null && _h !== void 0 ? _h : null,
                        country_code: (_j = d.countryCode) !== null && _j !== void 0 ? _j : null,
                        safety_rating: (_k = d.safetyRating) !== null && _k !== void 0 ? _k : null,
                        featured: (_l = d.featured) !== null && _l !== void 0 ? _l : false,
                        verified: (_m = d.verified) !== null && _m !== void 0 ? _m : false,
                        created_by: admin.userId,
                    })
                        .select()
                        .single()];
            case 2:
                _a = _o.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ zone: data });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /admin/geo-zones/:id ──────────────────────────────────────────────────
router.get("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, sc
                        .from("geo_zones")
                        .select()
                        .eq("id", req.params.id)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Geo zone not found");
                    return [2 /*return*/];
                }
                res.json({ zone: data });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /admin/geo-zones/:id ────────────────────────────────────────────────
router.patch("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, parsed, d, patch, _a, data, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _d.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                parsed = createGeoZoneSchema.partial().safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                d = parsed.data;
                patch = {};
                if (d.name !== undefined)
                    patch.name = d.name;
                if (d.zoneType !== undefined)
                    patch.zone_type = d.zoneType;
                if (d.centerLat !== undefined)
                    patch.center_lat = d.centerLat;
                if (d.centerLng !== undefined)
                    patch.center_lng = d.centerLng;
                if (d.radiusMeters !== undefined)
                    patch.radius_meters = d.radiusMeters;
                if (d.boundsJson !== undefined)
                    patch.bounds_json = d.boundsJson;
                if (d.city !== undefined)
                    patch.city = d.city;
                if (d.countryCode !== undefined)
                    patch.country_code = d.countryCode;
                if (d.safetyRating !== undefined)
                    patch.safety_rating = d.safetyRating;
                if (d.featured !== undefined)
                    patch.featured = d.featured;
                if (d.verified !== undefined)
                    patch.verified = d.verified;
                if (Object.keys(patch).length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "No fields to update");
                    return [2 /*return*/];
                }
                patch.updated_at = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from("geo_zones")
                        .update(patch)
                        .eq("id", req.params.id)
                        .select()
                        .single()];
            case 2:
                _a = _d.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Geo zone not found");
                    return [2 /*return*/];
                }
                res.json({ zone: data });
                return [2 /*return*/];
        }
    });
}); });
// ── DELETE /admin/geo-zones/:id ───────────────────────────────────────────────
router.delete("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _a.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, sc.from("geo_zones").delete().eq("id", req.params.id)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).end();
                return [2 /*return*/];
        }
    });
}); });
// ── Suspicious GPS review ─────────────────────────────────────────────────────
// Table: location_trust_events (migration 0033)
// Columns: id, user_id, event_type, confidence (low|medium|high),
//          details (JSONB), reviewed_at, reviewed_by, created_at
// Unreviewed = reviewed_at IS NULL
/** GET /admin/suspicious-gps — unreviewed trust events, oldest first */
router.get("/admin/suspicious-gps", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, limit, _a, data, error, events;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                limit = Math.min(100, Number(req.query.limit) || 50);
                return [4 /*yield*/, sc
                        .from("location_trust_events")
                        .select("id, user_id, event_type, confidence, details, created_at")
                        .is("reviewed_at", null)
                        .order("created_at", { ascending: true })
                        .limit(limit)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                events = (data !== null && data !== void 0 ? data : []).map(function (_a) {
                    var _lat = _a.lat, _lng = _a.lng, rest = __rest(_a, ["lat", "lng"]);
                    return rest;
                });
                res.json({ events: events, total: events.length });
                return [2 /*return*/];
        }
    });
}); });
/** POST /admin/suspicious-gps/:id/resolve — mark a trust event reviewed */
router.post("/admin/suspicious-gps/:id/resolve", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, schema, parsed, _a, data, error;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _e.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                schema = zod_1.z.object({
                    resolution: zod_1.z.enum(["cleared", "flagged", "banned"]),
                    note: zod_1.z.string().max(500).optional(),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("location_trust_events")
                        .update({
                        reviewed_at: new Date().toISOString(),
                        reviewed_by: admin.userId,
                        // Append review outcome to details so the original signal is preserved
                        details: { resolution: parsed.data.resolution, note: (_d = parsed.data.note) !== null && _d !== void 0 ? _d : null },
                    })
                        .eq("id", req.params.id)
                        .is("reviewed_at", null) // idempotency guard
                        .select("id, confidence, reviewed_at")
                        .maybeSingle()];
            case 2:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Trust event not found or already reviewed");
                    return [2 /*return*/];
                }
                res.json({ event: data });
                return [2 /*return*/];
        }
    });
}); });
// ── Venue moderation ──────────────────────────────────────────────────────────
// Table: discovery_places (migration 0029)
// status flow: provisional (default) → verified | blocked
// submitted_by references profiles(id)
/** GET /admin/venues/pending — community places awaiting moderation */
router.get("/admin/venues/pending", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, limit, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                limit = Math.min(100, Number(req.query.limit) || 50);
                return [4 /*yield*/, sc
                        .from("discovery_places")
                        .select("id, name, place_type, category, city, neighborhood, blurb, source, submitted_by, created_at")
                        .eq("status", "provisional")
                        .order("created_at", { ascending: true })
                        .limit(limit)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ venues: data !== null && data !== void 0 ? data : [], total: (data !== null && data !== void 0 ? data : []).length });
                return [2 /*return*/];
        }
    });
}); });
/** POST /admin/venues/:id/moderate — approve or reject a provisional discovery place */
router.post("/admin/venues/:id/moderate", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, schema, parsed, newStatus, _a, data, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _d.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                schema = zod_1.z.object({
                    action: zod_1.z.enum(["approve", "reject"]),
                    reason: zod_1.z.string().max(500).optional(),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                newStatus = parsed.data.action === "approve" ? "verified" : "blocked";
                return [4 /*yield*/, sc
                        .from("discovery_places")
                        .update({ status: newStatus })
                        .eq("id", req.params.id)
                        .eq("status", "provisional") // only moderate provisional items
                        .select("id, name, status")
                        .maybeSingle()];
            case 2:
                _a = _d.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Venue not found or not in provisional status");
                    return [2 /*return*/];
                }
                res.json({ venue: data });
                return [2 /*return*/];
        }
    });
}); });
// ── Geofence admin controls ───────────────────────────────────────────────────
// Table: geofence_admin_settings (migration 0039)
// Single-row config for default/min/max check-in radius and global no-show flag.
/** GET /admin/geofence-settings — read current admin radius config */
router.get("/admin/geofence-settings", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, sc
                        .from("geofence_admin_settings")
                        .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability, updated_at")
                        .eq("id", 1)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({
                    settings: data !== null && data !== void 0 ? data : {
                        default_radius_m: 150,
                        min_radius_m: 50,
                        max_radius_m: 5000,
                        no_show_affects_reliability: false,
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
/** PATCH /admin/geofence-settings — update radius defaults */
var geofenceSettingsSchema = zod_1.z.object({
    defaultRadiusM: zod_1.z.number().int().min(10).max(10000).optional(),
    minRadiusM: zod_1.z.number().int().min(10).max(1000).optional(),
    maxRadiusM: zod_1.z.number().int().min(100).max(50000).optional(),
    noShowAffectsReliability: zod_1.z.boolean().optional(),
});
router.patch("/admin/geofence-settings", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, parsed, patch, _a, data, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _d.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                parsed = geofenceSettingsSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                patch = { updated_at: new Date().toISOString() };
                if (parsed.data.defaultRadiusM !== undefined)
                    patch.default_radius_m = parsed.data.defaultRadiusM;
                if (parsed.data.minRadiusM !== undefined)
                    patch.min_radius_m = parsed.data.minRadiusM;
                if (parsed.data.maxRadiusM !== undefined)
                    patch.max_radius_m = parsed.data.maxRadiusM;
                if (parsed.data.noShowAffectsReliability !== undefined)
                    patch.no_show_affects_reliability = parsed.data.noShowAffectsReliability;
                return [4 /*yield*/, sc
                        .from("geofence_admin_settings")
                        .update(patch)
                        .eq("id", 1)
                        .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability, updated_at")
                        .maybeSingle()];
            case 2:
                _a = _d.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ settings: data });
                return [2 /*return*/];
        }
    });
}); });
/** POST /admin/geofence/:tripId/override-reveal — admin can force-reveal exact location */
router.post("/admin/geofence/:tripId/override-reveal", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, sc
                        .from("plan_geofences")
                        .update({ host_revealed: true, updated_at: new Date().toISOString() })
                        .eq("trip_id", req.params.tripId)
                        .select("id, trip_id, host_revealed")
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "No geofence for this trip");
                    return [2 /*return*/];
                }
                res.json({ geofence: data });
                return [2 /*return*/];
        }
    });
}); });
/** GET /admin/geofence/:tripId/suspicious-checkins — suspicious check-in events for a trip */
router.get("/admin/geofence/:tripId/suspicious-checkins", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, sc
                        .from("plan_attendance_events")
                        .select("id, user_id, event_type, metadata, created_at")
                        .eq("trip_id", req.params.tripId)
                        .eq("event_type", "suspicious_check_in")
                        .order("created_at", { ascending: false })
                        .limit(100)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ events: data !== null && data !== void 0 ? data : [], total: (data !== null && data !== void 0 ? data : []).length });
                return [2 /*return*/];
        }
    });
}); });
// ── Safe Return admin routes ──────────────────────────────────────────────────
// All gated by safe_return_admin_logs_enabled feature flag + requireAdmin.
function isSafeReturnAdminEnabled(sc) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, sc
                            .from("feature_flags")
                            .select("enabled")
                            .eq("key", "safe_return_admin_logs_enabled")
                            .maybeSingle()];
                case 1:
                    data = (_b.sent()).data;
                    return [2 /*return*/, Boolean(data === null || data === void 0 ? void 0 : data.enabled)];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * GET /admin/safe-return/logs
 * Returns recent Safe Return events (all users) — admin only.
 */
router.get("/admin/safe-return/logs", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, limit, _a, data, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _c.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, isSafeReturnAdminEnabled(sc)];
            case 2:
                if (!(_c.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return admin logs are not enabled");
                    return [2 /*return*/];
                }
                limit = Math.min(100, parseInt(String((_b = req.query.limit) !== null && _b !== void 0 ? _b : "50"), 10) || 50);
                return [4 /*yield*/, sc
                        .from("safe_return_events")
                        .select("id, session_id, user_id, event_type, metadata, created_at")
                        .order("created_at", { ascending: false })
                        .limit(limit)];
            case 3:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ events: data !== null && data !== void 0 ? data : [], total: (data !== null && data !== void 0 ? data : []).length });
                return [2 /*return*/];
        }
    });
}); });
/**
 * GET /admin/safe-return/config
 * Returns current Safe Return feature flag states.
 * Gated by safe_return_admin_logs_enabled (seeded TRUE in migration 0040
 * so fresh installs can always reach config without a bootstrap deadlock).
 */
router.get("/admin/safe-return/config", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, flags, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, isSafeReturnAdminEnabled(sc)];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return admin is not enabled");
                    return [2 /*return*/];
                }
                flags = [
                    "safe_return_enabled",
                    "safe_return_live_share_enabled",
                    "safe_return_trusted_circle_alerts_enabled",
                    "safe_return_admin_logs_enabled",
                ];
                return [4 /*yield*/, sc
                        .from("feature_flags")
                        .select("key, enabled, description, updated_at")
                        .in("key", flags)];
            case 3:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ config: data !== null && data !== void 0 ? data : [] });
                return [2 /*return*/];
        }
    });
}); });
/**
 * PATCH /admin/safe-return/config
 * Update one or more Safe Return feature flags.
 * Body: { flags: { safe_return_enabled?: boolean, ... } }
 * Gated by safe_return_admin_logs_enabled (seeded true in migration 0037).
 */
router.patch("/admin/safe-return/config", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, allowedFlags, flags, updates, results;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = admin.sc;
                return [4 /*yield*/, isSafeReturnAdminEnabled(sc)];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return admin is not enabled");
                    return [2 /*return*/];
                }
                allowedFlags = new Set([
                    "safe_return_enabled",
                    "safe_return_live_share_enabled",
                    "safe_return_trusted_circle_alerts_enabled",
                    "safe_return_admin_logs_enabled",
                ]);
                flags = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).flags;
                if (!flags || typeof flags !== "object") {
                    (0, http_1.sendError)(res, "invalid_payload", "Body must have { flags: { flagKey: boolean } }");
                    return [2 /*return*/];
                }
                updates = Object.entries(flags).filter(function (_a) {
                    var key = _a[0], val = _a[1];
                    return allowedFlags.has(key) && typeof val === "boolean";
                });
                if (updates.length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "No valid flag keys provided");
                    return [2 /*return*/];
                }
                results = {};
                return [4 /*yield*/, Promise.all(updates.map(function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
                        var error;
                        var key = _b[0], enabled = _b[1];
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0: return [4 /*yield*/, sc
                                        .from("feature_flags")
                                        .update({ enabled: enabled, updated_at: new Date().toISOString() })
                                        .eq("key", key)];
                                case 1:
                                    error = (_c.sent()).error;
                                    if (!error)
                                        results[key] = enabled;
                                    return [2 /*return*/];
                            }
                        });
                    }); }))];
            case 3:
                _b.sent();
                res.json({ ok: true, updated: results });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
