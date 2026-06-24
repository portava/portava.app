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
/**
 * Admin geo-control contract tests
 *
 * Verifies schema alignment against actual migrations:
 *   0034_geo_zones.sql  — geo_zones columns: zone_type, name, city, country_code,
 *                         bounds_json, center_lat/lng, radius_meters,
 *                         safety_rating, featured, verified, created_by
 *   0033_location_sessions.sql — location_trust_events columns: event_type,
 *                         confidence, details, reviewed_at, reviewed_by
 *   0029_discovery_places.sql  — discovery_places: status = provisional|verified|blocked
 *                         submitted_by references profiles
 *
 * All tests use the fake-client injection pattern from pulseGps.test.ts:
 *   _setTestClient(fakeClient) so no real Supabase connection is needed.
 *
 * Run: node --import tsx/esm --test src/test/adminGeo.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var admin_js_1 = require("../routes/admin.js");
// ── Test server ───────────────────────────────────────────────────────────────
var server;
var base;
// Reusable HTTP helper — always sends a fake bearer token so requireUser passes
var FAKE_TOKEN = "fake.jwt.token";
function req(method, path, body, headers) {
    return new Promise(function (resolve, reject) {
        var url = new URL(path, base);
        var payload = body ? JSON.stringify(body) : undefined;
        var reqHeaders = __assign({ "content-type": "application/json", "authorization": "Bearer ".concat(FAKE_TOKEN) }, headers);
        var r = node_http_1.default.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: method, headers: reqHeaders }, function (res) {
            var raw = "";
            res.on("data", function (c) { return (raw += c); });
            res.on("end", function () {
                var _a;
                var parsed;
                try {
                    parsed = JSON.parse(raw);
                }
                catch (_b) {
                    parsed = raw;
                }
                resolve({ status: (_a = res.statusCode) !== null && _a !== void 0 ? _a : 0, body: parsed });
            });
        });
        r.on("error", reject);
        if (payload)
            r.write(payload);
        r.end();
    });
}
// ── Fake client builder ───────────────────────────────────────────────────────
function makeFakeClient(opts) {
    var _a = opts.role, role = _a === void 0 ? "admin" : _a, _b = opts.geoZones, geoZones = _b === void 0 ? [] : _b, _c = opts.trustEvents, trustEvents = _c === void 0 ? [] : _c, _d = opts.discoveryPlaces, discoveryPlaces = _d === void 0 ? [] : _d;
    // A minimal chainable builder
    function builder(rows, single) {
        if (single === void 0) { single = false; }
        var _rows = __spreadArray([], rows, true);
        var _single = single;
        var b = {
            select: function () { return b; },
            insert: function (data) { _rows = [data]; return b; },
            update: function (data) {
                _rows = _rows.map(function (r) { return (__assign(__assign({}, r), data)); });
                return b;
            },
            delete: function () { _rows = []; return b; },
            eq: function () { return b; },
            is: function () { return b; },
            ilike: function () { return b; },
            not: function () { return b; },
            in: function () { return b; },
            order: function () { return b; },
            limit: function () { return b; },
            range: function () { return b; },
            maybeSingle: function () { var _a; return Promise.resolve({ data: (_a = _rows[0]) !== null && _a !== void 0 ? _a : null, error: null }); },
            single: function () { var _a; return Promise.resolve({ data: (_a = _rows[0]) !== null && _a !== void 0 ? _a : null, error: null }); },
            then: function (resolve) { return Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve); },
        };
        return b;
    }
    return {
        from: function (table) {
            if (table === "profiles")
                return builder([{ id: "uid1", role: role }]);
            if (table === "geo_zones")
                return builder(geoZones);
            if (table === "location_trust_events")
                return builder(trustEvents);
            if (table === "discovery_places")
                return builder(discoveryPlaces);
            return builder([]);
        },
        auth: {
            getUser: function () {
                return Promise.resolve({ data: { user: { id: "uid1" } }, error: null });
            },
        },
    };
}
(0, node_test_1.before)(function () { return __awaiter(void 0, void 0, void 0, function () {
    var app, addr;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                app = (0, express_1.default)();
                app.use(express_1.default.json());
                app.use(admin_js_1.default);
                server = node_http_1.default.createServer(app);
                return [4 /*yield*/, new Promise(function (r) { return server.listen(0, r); })];
            case 1:
                _a.sent();
                addr = server.address();
                base = "http://127.0.0.1:".concat(addr.port);
                return [2 /*return*/];
        }
    });
}); });
(0, node_test_1.after)(function () { return server.close(); });
// ── Helpers to set both client slots ─────────────────────────────────────────
function setClients(opts) {
    var c = makeFakeClient(opts);
    (0, http_js_1._setTestClient)(c, true);
    (0, supabase_js_1._setTestServiceClient)(c);
}
// ── Tests ─────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("admin — geo zones", function () {
    (0, node_test_1.it)("GET /admin/geo-zones returns 200 for admin role", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({ role: "admin", geoZones: [{ id: "gz1", name: "Lahug", zone_type: "neighborhood" }] });
                    return [4 /*yield*/, req("GET", "/admin/geo-zones")];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 200);
                    strict_1.default.ok(Array.isArray(body.zones));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET /admin/geo-zones returns 403 for non-admin", function () { return __awaiter(void 0, void 0, void 0, function () {
        var status;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients({ role: "user" });
                    return [4 /*yield*/, req("GET", "/admin/geo-zones")];
                case 1:
                    status = (_a.sent()).status;
                    strict_1.default.equal(status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/geo-zones uses correct columns (no is_system, no metadata)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var captured, client, origFrom, row;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    captured = [];
                    client = makeFakeClient({ role: "admin" });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "geo_zones") {
                            var origInsert_1 = b.insert.bind(b);
                            b.insert = function (data) {
                                captured.push(data);
                                return origInsert_1(data);
                            };
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("POST", "/admin/geo-zones", {
                            name: "Poblacion",
                            zoneType: "neighborhood",
                            city: "Makati",
                            countryCode: "PH",
                        })];
                case 1:
                    _a.sent();
                    strict_1.default.equal(captured.length, 1);
                    row = captured[0];
                    // Must use correct DB column names
                    strict_1.default.equal(row.zone_type, "neighborhood");
                    strict_1.default.equal(row.city, "Makati");
                    strict_1.default.equal(row.country_code, "PH");
                    // Must NOT include columns absent from the migration
                    strict_1.default.ok(!("is_system" in row), "is_system must not be sent to DB");
                    strict_1.default.ok(!("metadata" in row), "metadata must not be sent to DB (not in geo_zones)");
                    strict_1.default.ok(!("polygon_geojson" in row), "polygon_geojson must not be sent");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/geo-zones rejects unknown zoneType", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({ role: "admin" });
                    return [4 /*yield*/, req("POST", "/admin/geo-zones", {
                            name: "Test",
                            zoneType: "invalid_type",
                        })];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 400);
                    strict_1.default.equal(body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("PATCH /admin/geo-zones/:id only sends defined fields", function () { return __awaiter(void 0, void 0, void 0, function () {
        var captured, client, origFrom;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    captured = [];
                    client = makeFakeClient({ role: "admin", geoZones: [{ id: "gz1", name: "Old Name" }] });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "geo_zones") {
                            var origUpdate_1 = b.update.bind(b);
                            b.update = function (data) { captured.push(data); return origUpdate_1(data); };
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("PATCH", "/admin/geo-zones/gz1", { name: "New Name" })];
                case 1:
                    _a.sent();
                    strict_1.default.equal(captured.length, 1);
                    strict_1.default.equal(captured[0].name, "New Name");
                    strict_1.default.ok(!("zone_type" in captured[0]), "zone_type must not be sent when not patched");
                    strict_1.default.ok(!("is_system" in captured[0]), "is_system must never appear");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("PATCH /admin/geo-zones returns 400 when body is empty", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({ role: "admin", geoZones: [{ id: "gz1" }] });
                    return [4 /*yield*/, req("PATCH", "/admin/geo-zones/gz1", {})];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 400);
                    strict_1.default.equal(body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("DELETE /admin/geo-zones/:id returns 204 for admin", function () { return __awaiter(void 0, void 0, void 0, function () {
        var status;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients({ role: "admin", geoZones: [{ id: "gz1" }] });
                    return [4 /*yield*/, req("DELETE", "/admin/geo-zones/gz1")];
                case 1:
                    status = (_a.sent()).status;
                    strict_1.default.equal(status, 204);
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("admin — suspicious GPS queue", function () {
    (0, node_test_1.it)("GET /admin/suspicious-gps returns unreviewed events", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({
                        role: "admin",
                        trustEvents: [
                            { id: "te1", user_id: "u1", event_type: "impossible_speed", confidence: "high", details: null, created_at: new Date().toISOString() },
                        ],
                    });
                    return [4 /*yield*/, req("GET", "/admin/suspicious-gps")];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 200);
                    strict_1.default.ok(Array.isArray(body.events));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET /admin/suspicious-gps never includes lat/lng", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body, event;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setClients({
                        role: "admin",
                        trustEvents: [{ id: "te1", lat: 10.3, lng: 123.9, event_type: "coordinate_jump", confidence: "medium" }],
                    });
                    return [4 /*yield*/, req("GET", "/admin/suspicious-gps")];
                case 1:
                    _a = _c.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 200);
                    event = (_b = body.events[0]) !== null && _b !== void 0 ? _b : {};
                    strict_1.default.ok(!("lat" in event), "lat must not appear in suspicious GPS response");
                    strict_1.default.ok(!("lng" in event), "lng must not appear in suspicious GPS response");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/suspicious-gps/:id/resolve uses reviewed_at (not resolved_at)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var captured, client, origFrom, status, update;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    captured = [];
                    client = makeFakeClient({ role: "admin", trustEvents: [{ id: "te1" }] });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "location_trust_events") {
                            var origUpdate_2 = b.update.bind(b);
                            b.update = function (data) { captured.push(data); return origUpdate_2(data); };
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("POST", "/admin/suspicious-gps/te1/resolve", { resolution: "cleared" })];
                case 1:
                    status = (_a.sent()).status;
                    strict_1.default.equal(status, 200);
                    strict_1.default.equal(captured.length, 1);
                    update = captured[0];
                    // Must use schema column names
                    strict_1.default.ok("reviewed_at" in update, "must use reviewed_at (migration column)");
                    strict_1.default.ok("reviewed_by" in update, "must use reviewed_by (migration column)");
                    strict_1.default.ok(!("resolved_at" in update), "resolved_at does not exist in migration");
                    strict_1.default.ok(!("resolved_by" in update), "resolved_by does not exist in migration");
                    strict_1.default.ok(!("trust_level" in update), "trust_level does not exist in migration");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/suspicious-gps/:id/resolve rejects invalid resolution", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({ role: "admin", trustEvents: [{ id: "te1" }] });
                    return [4 /*yield*/, req("POST", "/admin/suspicious-gps/te1/resolve", { resolution: "deleted" })];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 400);
                    strict_1.default.equal(body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("admin — venue moderation", function () {
    (0, node_test_1.it)("GET /admin/venues/pending queries discovery_places with status=provisional", function () { return __awaiter(void 0, void 0, void 0, function () {
        var queried, client, origFrom, status;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    queried = [];
                    client = makeFakeClient({ role: "admin" });
                    origFrom = client.from.bind(client);
                    client.from = function (table) { queried.push(table); return origFrom(table); };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("GET", "/admin/venues/pending")];
                case 1:
                    status = (_a.sent()).status;
                    strict_1.default.equal(status, 200);
                    strict_1.default.ok(queried.includes("discovery_places"), "must query discovery_places table");
                    strict_1.default.ok(!queried.includes("place_profiles"), "must NOT query place_profiles (wrong table)");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/venues/:id/moderate approve sets status=verified", function () { return __awaiter(void 0, void 0, void 0, function () {
        var captured, client, origFrom, status;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    captured = [];
                    client = makeFakeClient({
                        role: "admin",
                        discoveryPlaces: [{ id: "dp1", name: "Abaca", status: "provisional" }],
                    });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "discovery_places") {
                            var origUpdate_3 = b.update.bind(b);
                            b.update = function (data) { captured.push(data); return origUpdate_3(data); };
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("POST", "/admin/venues/dp1/moderate", { action: "approve" })];
                case 1:
                    status = (_b.sent()).status;
                    strict_1.default.equal(status, 200);
                    strict_1.default.equal((_a = captured[0]) === null || _a === void 0 ? void 0 : _a.status, "verified", "approve must set status=verified (valid place_profiles enum)");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/venues/:id/moderate reject sets status=blocked", function () { return __awaiter(void 0, void 0, void 0, function () {
        var captured, client, origFrom, status;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    captured = [];
                    client = makeFakeClient({
                        role: "admin",
                        discoveryPlaces: [{ id: "dp1", name: "Bad Spot", status: "provisional" }],
                    });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "discovery_places") {
                            var origUpdate_4 = b.update.bind(b);
                            b.update = function (data) { captured.push(data); return origUpdate_4(data); };
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, req("POST", "/admin/venues/dp1/moderate", { action: "reject" })];
                case 1:
                    status = (_b.sent()).status;
                    strict_1.default.equal(status, 200);
                    strict_1.default.equal((_a = captured[0]) === null || _a === void 0 ? void 0 : _a.status, "blocked", "reject must set status=blocked (not rejected — not a valid enum value)");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST /admin/venues/:id/moderate rejects invalid action", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, status, body;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setClients({ role: "admin", discoveryPlaces: [{ id: "dp1" }] });
                    return [4 /*yield*/, req("POST", "/admin/venues/dp1/moderate", { action: "delete" })];
                case 1:
                    _a = _b.sent(), status = _a.status, body = _a.body;
                    strict_1.default.equal(status, 400);
                    strict_1.default.equal(body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
});
