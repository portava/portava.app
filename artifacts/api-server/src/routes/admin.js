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
 * Admin geo controls
 *
 * Role-gated routes (admin role required via X-Admin-Key header or profiles.role='admin').
 *
 * Routes:
 *   GET  /admin/geo-zones          — list geo zones
 *   POST /admin/geo-zones          — create / update a geo zone
 *   GET  /admin/geo-zones/:id      — get single geo zone
 *   PATCH /admin/geo-zones/:id     — update geo zone fields
 *   DELETE /admin/geo-zones/:id    — soft-delete geo zone
 *
 *   GET  /admin/suspicious-gps     — suspicious GPS trust-event review queue
 *   POST /admin/suspicious-gps/:id/resolve — mark trust event reviewed
 *
 *   GET  /admin/venues/pending     — pending venue moderation queue
 *   POST /admin/venues/:id/moderate — approve / reject a venue
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var router = (0, express_1.Router)();
// ── Admin guard middleware ────────────────────────────────────────────────────
function requireAdmin(req, res) {
    return __awaiter(this, void 0, void 0, function () {
        var auth, client, user, _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
                case 1:
                    auth = _b.sent();
                    if (!auth)
                        return [2 /*return*/, null];
                    client = auth.client, user = auth.user;
                    return [4 /*yield*/, client
                            .from("profiles")
                            .select("role")
                            .eq("id", user.id)
                            .maybeSingle()];
                case 2:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data || data.role !== "admin") {
                        res.status(403).json({ error: "forbidden", message: "Admin role required" });
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, { userId: user.id }];
            }
        });
    });
}
// ── Geo zones ─────────────────────────────────────────────────────────────────
var createGeoZoneSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    zoneType: zod_1.z.enum(["city", "neighborhood", "venue", "geofence", "safe_zone", "exclusion_zone"]),
    centerLat: zod_1.z.number().min(-90).max(90).optional(),
    centerLng: zod_1.z.number().min(-180).max(180).optional(),
    radiusMeters: zod_1.z.number().int().min(1).max(100000).optional(),
    city: zod_1.z.string().max(120).optional(),
    countryCode: zod_1.z.string().max(4).optional(),
    isSystem: zod_1.z.boolean().optional().default(false),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
/** GET /admin/geo-zones */
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
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                page = Math.max(1, parseInt(req.query.page) || 1);
                limit = Math.min(100, parseInt(req.query.limit) || 50);
                city = ((_b = req.query.city) === null || _b === void 0 ? void 0 : _b.trim()) || null;
                query = sc
                    .from("geo_zones")
                    .select("id, name, zone_type, center_lat, center_lng, radius_meters, city, country_code, is_system, created_by, created_at", { count: "exact" })
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
/** POST /admin/geo-zones */
router.post("/admin/geo-zones", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, parsed, d, _a, data, error;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return __generator(this, function (_l) {
        switch (_l.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _l.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
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
                        city: (_g = d.city) !== null && _g !== void 0 ? _g : null,
                        country_code: (_h = d.countryCode) !== null && _h !== void 0 ? _h : null,
                        is_system: (_j = d.isSystem) !== null && _j !== void 0 ? _j : false,
                        created_by: admin.userId,
                        metadata: (_k = d.metadata) !== null && _k !== void 0 ? _k : null,
                    })
                        .select()
                        .single()];
            case 2:
                _a = _l.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ zone: data });
                return [2 /*return*/];
        }
    });
}); });
/** GET /admin/geo-zones/:id */
router.get("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
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
/** PATCH /admin/geo-zones/:id */
router.patch("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, patchSchema, parsed, d, patch, _a, data, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _d.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                patchSchema = createGeoZoneSchema.partial();
                parsed = patchSchema.safeParse(req.body);
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
                if (d.city !== undefined)
                    patch.city = d.city;
                if (d.countryCode !== undefined)
                    patch.country_code = d.countryCode;
                if (d.isSystem !== undefined)
                    patch.is_system = d.isSystem;
                if (d.metadata !== undefined)
                    patch.metadata = d.metadata;
                if (Object.keys(patch).length === 0) {
                    (0, http_1.sendError)(res, "invalid_payload", "No fields to update");
                    return [2 /*return*/];
                }
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
/** DELETE /admin/geo-zones/:id */
router.delete("/admin/geo-zones/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _a.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
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
// ── Suspicious GPS review queue ────────────────────────────────────────────────
/** GET /admin/suspicious-gps  — trust events pending review */
router.get("/admin/suspicious-gps", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, limit, status, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                limit = Math.min(100, parseInt(req.query.limit) || 50);
                status = req.query.status || "pending_review";
                return [4 /*yield*/, sc
                        .from("location_trust_events")
                        .select("id, user_id, event_type, trust_level, metadata, created_at, resolved_at, resolved_by")
                        .eq("trust_level", status)
                        .is("resolved_at", null)
                        .order("created_at", { ascending: true })
                        .limit(limit)];
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
/** POST /admin/suspicious-gps/:id/resolve — mark resolved */
router.post("/admin/suspicious-gps/:id/resolve", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, resolutionSchema, parsed, _a, data, error;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _e.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                resolutionSchema = zod_1.z.object({
                    resolution: zod_1.z.enum(["cleared", "flagged", "banned"]),
                    note: zod_1.z.string().max(500).optional(),
                });
                parsed = resolutionSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("location_trust_events")
                        .update({
                        resolved_at: new Date().toISOString(),
                        resolved_by: admin.userId,
                        trust_level: parsed.data.resolution === "cleared" ? "gps_verified" : "suspicious",
                        metadata: { resolution: parsed.data.resolution, note: (_d = parsed.data.note) !== null && _d !== void 0 ? _d : null },
                    })
                        .eq("id", req.params.id)
                        .select("id, trust_level, resolved_at")
                        .single()];
            case 2:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Trust event not found");
                    return [2 /*return*/];
                }
                res.json({ event: data });
                return [2 /*return*/];
        }
    });
}); });
// ── Venue moderation queue ─────────────────────────────────────────────────────
/** GET /admin/venues/pending */
router.get("/admin/venues/pending", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, sc, limit, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _b.sent();
                if (!admin)
                    return [2 /*return*/];
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                limit = Math.min(100, parseInt(req.query.limit) || 50);
                return [4 /*yield*/, sc
                        .from("place_profiles")
                        .select("id, name, place_type, city, country_code, osm_id, submitted_by, status, created_at")
                        .eq("status", "pending")
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
/** POST /admin/venues/:id/moderate */
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
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client unavailable");
                    return [2 /*return*/];
                }
                schema = zod_1.z.object({
                    action: zod_1.z.enum(["approve", "reject"]),
                    reason: zod_1.z.string().max(500).optional(),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                newStatus = parsed.data.action === "approve" ? "verified" : "rejected";
                return [4 /*yield*/, sc
                        .from("place_profiles")
                        .update({ status: newStatus, updated_at: new Date().toISOString() })
                        .eq("id", req.params.id)
                        .select("id, name, status")
                        .single()];
            case 2:
                _a = _d.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    (0, http_1.sendError)(res, "not_found", "Venue not found");
                    return [2 /*return*/];
                }
                res.json({ venue: data });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
