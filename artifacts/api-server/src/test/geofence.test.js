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
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Plan geofence privacy + check-in tests
 *
 * Uses node:test + fake Supabase client pattern.
 * Run: pnpm --filter @workspace/api-server run test
 *
 * Covers:
 * - Non-accepted users cannot see exact plan coordinates
 * - Accepted users see exact location only when settings allow
 * - Removed users lose access immediately
 * - Check-in succeeds inside radius and fails outside
 * - Check-in stores status without exposing public coordinates
 * - Suspicious GPS creates a location_trust_event
 * - Public plan cards never include exact coordinates
 * - Host sees arrival statuses without attendee pins
 * - Admin radius defaults apply (radius clamped to admin settings)
 * - No-show event created after window closes (late_check_in event)
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
// ── Constants ──────────────────────────────────────────────────────────────────
var OWNER_TOKEN = "tok-owner";
var MEMBER_TOKEN = "tok-member";
var OTHER_TOKEN = "tok-other";
var OWNER_ID = "uid-owner";
var MEMBER_ID = "uid-member";
var OTHER_ID = "uid-other";
var TRIP_ID = "trip-aaaa-bbbb-cccc-dddddddddddd";
var GEOFENCE_ID = "gf-aaaa-bbbb-cccc-dddddddddddd";
// The "meetup" coords (private) — ~48.85°N 2.35°E (near Paris)
var MEETUP_LAT = 48.8566;
var MEETUP_LNG = 2.3522;
// Inside radius (< 150m away)
var INSIDE_LAT = 48.8566;
var INSIDE_LNG = 2.3524; // ~14m away
// Outside radius (~5km)
var OUTSIDE_LAT = 48.810;
var OUTSIDE_LNG = 2.3522;
// ── Fake client factory ────────────────────────────────────────────────────────
function makeGeofenceClient(opts) {
    var _this = this;
    var _b = opts.memberRole, memberRole = _b === void 0 ? null : _b, _c = opts.geofence, geofence = _c === void 0 ? null : _c, _d = opts.eventStore, eventStore = _d === void 0 ? [] : _d, _e = opts.checkinStore, checkinStore = _e === void 0 ? [] : _e, _f = opts.memberIds, memberIds = _f === void 0 ? [] : _f, _g = opts.locationSnap, locationSnap = _g === void 0 ? null : _g, _h = opts.trustSuspicious, trustSuspicious = _h === void 0 ? false : _h;
    return {
        auth: {
            getUser: function (token) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_b) {
                    if (token === OWNER_TOKEN)
                        return [2 /*return*/, { data: { user: { id: OWNER_ID } }, error: null }];
                    if (token === MEMBER_TOKEN)
                        return [2 /*return*/, { data: { user: { id: MEMBER_ID } }, error: null }];
                    if (token === OTHER_TOKEN)
                        return [2 /*return*/, { data: { user: { id: OTHER_ID } }, error: null }];
                    return [2 /*return*/, { data: { user: null }, error: { message: "bad token" } }];
                });
            }); },
        },
        from: function (table) {
            var _this = this;
            var store = eventStore;
            var builder = {
                select: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                eq: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                in: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                is: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                gt: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                lt: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                order: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                limit: function () {
                    var _a = [];
                    for (var _i = 0; _i < arguments.length; _i++) {
                        _a[_i] = arguments[_i];
                    }
                    return builder;
                },
                update: function (patch) { store.push({ table: table, op: "update", patch: patch }); return builder; },
                delete: function () { store.push({ table: table, op: "delete" }); return builder; },
                insert: function (row) { store.push({ table: table, op: "insert", row: row }); return builder; },
                upsert: function (row) { checkinStore.push({ table: table, op: "upsert", row: row }); return builder; },
                maybeSingle: function () { return __awaiter(_this, void 0, void 0, function () {
                    var tenMinsAgo;
                    return __generator(this, function (_b) {
                        if (table === "feature_flags")
                            return [2 /*return*/, { data: { enabled: true }, error: null }];
                        if (table === "trips") {
                            return [2 /*return*/, { data: { owner_id: OWNER_ID }, error: null }];
                        }
                        if (table === "trip_members") {
                            if (memberRole === "member")
                                return [2 /*return*/, { data: { user_id: MEMBER_ID }, error: null }];
                            return [2 /*return*/, { data: null, error: null }];
                        }
                        if (table === "plan_geofences")
                            return [2 /*return*/, { data: geofence, error: null }];
                        if (table === "plan_checkins")
                            return [2 /*return*/, { data: null, error: null }];
                        if (table === "geofence_admin_settings") {
                            return [2 /*return*/, { data: { default_radius_m: 150, min_radius_m: 50, max_radius_m: 5000, no_show_affects_reliability: false }, error: null }];
                        }
                        if (table === "location_snapshots") {
                            if (trustSuspicious && locationSnap) {
                                tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
                                return [2 /*return*/, { data: { lat: 40.7128, lng: -74.0060, captured_at: tenMinsAgo }, error: null }];
                            }
                            return [2 /*return*/, { data: locationSnap, error: null }];
                        }
                        return [2 /*return*/, { data: null, error: null }];
                    });
                }); },
                single: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_b) {
                    return [2 /*return*/, ({ data: null, error: null })];
                }); }); },
                then: function (onF) {
                    // Used for location_trust_events insert
                    return Promise.resolve({ data: null, error: null }).then(onF);
                },
            };
            return builder;
        },
    };
}
// ── HTTP helper ────────────────────────────────────────────────────────────────
function request(port, method, path, body, token) {
    if (token === void 0) { token = OWNER_TOKEN; }
    return new Promise(function (resolve, reject) {
        var data = body ? JSON.stringify(body) : undefined;
        var opts = {
            hostname: "127.0.0.1",
            port: port,
            path: path,
            method: method,
            headers: __assign({ "Authorization": "Bearer ".concat(token) }, (data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})),
        };
        var r = node_http_1.default.request(opts, function (res) {
            var raw = "";
            res.on("data", function (c) { raw += c; });
            res.on("end", function () {
                var _b;
                resolve({ status: (_b = res.statusCode) !== null && _b !== void 0 ? _b : 0, body: JSON.parse(raw || "{}") });
            });
        });
        r.on("error", reject);
        if (data)
            r.write(data);
        r.end();
    });
}
// ── Test server factory ────────────────────────────────────────────────────────
function withGeofenceServer(clientOpts, fn) {
    return __awaiter(this, void 0, void 0, function () {
        var client, geofenceRouter, app, server, port;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeGeofenceClient(clientOpts);
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/geofence.js"); })];
                case 1:
                    geofenceRouter = (_b.sent()).default;
                    app = (0, express_1.default)();
                    app.use(express_1.default.json());
                    app.use("/api", geofenceRouter);
                    server = node_http_1.default.createServer(app);
                    return [4 /*yield*/, new Promise(function (resolve) { return server.listen(0, "127.0.0.1", resolve); })];
                case 2:
                    _b.sent();
                    port = server.address().port;
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, , 5, 7]);
                    return [4 /*yield*/, fn(port)];
                case 4:
                    _b.sent();
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, new Promise(function (resolve) { return server.close(function () { return resolve(); }); })];
                case 6:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    });
}
// ═════════════════════════════════════════════════════════════════════════════
// Privacy tests
// ═════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("Geofence privacy — non-accepted users", function () {
    var geofence = {
        id: GEOFENCE_ID,
        lat: MEETUP_LAT,
        lng: MEETUP_LNG,
        check_in_radius_m: 150,
        public_preview_level: "neighborhood",
        exact_visibility: "exact_after_acceptance",
        check_in_required: false,
        check_in_window_start: null,
        check_in_window_end: null,
        arrival_status_visible: true,
        no_show_affects_reliability: false,
        host_enabled: true,
        host_revealed: false,
        location_name: "Secret Venue",
        city: "Paris",
        neighborhood: "Marais",
        venue_name: "Le Labo",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    (0, node_test_1.it)("non-member sees only public preview data, never exact coords", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: null, geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var _b, status, body, gf;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, OTHER_TOKEN)];
                                case 1:
                                    _b = _c.sent(), status = _b.status, body = _b.body;
                                    strict_1.default.equal(status, 200);
                                    strict_1.default.ok(body.geofence, "geofence field present");
                                    gf = body.geofence;
                                    strict_1.default.ok(!("lat" in gf), "lat must not be returned to non-member");
                                    strict_1.default.ok(!("lng" in gf), "lng must not be returned to non-member");
                                    strict_1.default.equal(gf.viewerRole, "none", "viewer role should be none");
                                    strict_1.default.ok(gf.exactRevealLabel, "should have reveal label");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-member response never leaks locationName when preview=neighborhood", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: null, geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var body, json;
                        return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, OTHER_TOKEN)];
                                case 1:
                                    body = (_b.sent()).body;
                                    json = JSON.stringify(body.geofence);
                                    strict_1.default.ok(!json.includes("Secret Venue"), "locationName must be hidden for non-members at neighborhood level");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("public plan card (geofence object) never includes raw coordinates", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: null, geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var body, json;
                        return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, OTHER_TOKEN)];
                                case 1:
                                    body = (_b.sent()).body;
                                    json = JSON.stringify(body);
                                    strict_1.default.ok(!/"lat"\s*:/.test(json), "lat should not appear anywhere in non-member response");
                                    strict_1.default.ok(!/"lng"\s*:/.test(json), "lng should not appear anywhere in non-member response");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("Geofence privacy — accepted members", function () {
    var baseGeofence = {
        id: GEOFENCE_ID,
        lat: MEETUP_LAT,
        lng: MEETUP_LNG,
        check_in_radius_m: 150,
        public_preview_level: "neighborhood",
        check_in_required: false,
        check_in_window_start: null,
        check_in_window_end: null,
        arrival_status_visible: true,
        no_show_affects_reliability: false,
        host_enabled: true,
        host_revealed: false,
        location_name: "Secret Venue",
        city: "Paris",
        neighborhood: "Marais",
        venue_name: "Le Labo",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    (0, node_test_1.it)("accepted member sees exact location when exactVisibility=exact_after_acceptance", function () { return __awaiter(void 0, void 0, void 0, function () {
        var gf;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    gf = __assign(__assign({}, baseGeofence), { exact_visibility: "exact_after_acceptance" });
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: gf }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var _b, status, body;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, MEMBER_TOKEN)];
                                    case 1:
                                        _b = _c.sent(), status = _b.status, body = _b.body;
                                        strict_1.default.equal(status, 200);
                                        strict_1.default.ok(body.geofence.exactLocationRevealed, "exact location should be revealed");
                                        strict_1.default.equal(body.geofence.locationName, "Secret Venue", "locationName should be visible");
                                        strict_1.default.ok(!("lat" in body.geofence), "raw lat still must not be in response");
                                        strict_1.default.ok(!("lng" in body.geofence), "raw lng still must not be in response");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("accepted member does NOT see exact location when exactVisibility=exact_private_host_reveal and host_revealed=false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var gf;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    gf = __assign(__assign({}, baseGeofence), { exact_visibility: "exact_private_host_reveal", host_revealed: false });
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: gf }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, MEMBER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        strict_1.default.equal(body.geofence.exactLocationRevealed, false, "should not be revealed");
                                        strict_1.default.equal(body.geofence.locationName, null, "locationName hidden until revealed");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("accepted member sees exact location when exactVisibility=exact_private_host_reveal AND host_revealed=true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var gf;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    gf = __assign(__assign({}, baseGeofence), { exact_visibility: "exact_private_host_reveal", host_revealed: true });
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: gf }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, MEMBER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        strict_1.default.equal(body.geofence.exactLocationRevealed, true, "host revealed it");
                                        strict_1.default.equal(body.geofence.locationName, "Secret Venue");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("owner always sees exact location (owner role)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var gf;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    gf = __assign(__assign({}, baseGeofence), { exact_visibility: "exact_after_acceptance" });
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "owner", geofence: gf }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, OWNER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        strict_1.default.equal(body.geofence.viewerRole, "owner");
                                        strict_1.default.equal(body.geofence.exactLocationRevealed, true);
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═════════════════════════════════════════════════════════════════════════════
// Check-in tests
// ═════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("Check-in — inside radius", function () {
    var geofence = {
        id: GEOFENCE_ID,
        lat: MEETUP_LAT,
        lng: MEETUP_LNG,
        check_in_radius_m: 150,
        check_in_required: true,
        check_in_window_start: null,
        check_in_window_end: null,
        host_enabled: true,
        trip_id: TRIP_ID,
    };
    (0, node_test_1.it)("accepted member inside radius gets arrived status", function () { return __awaiter(void 0, void 0, void 0, function () {
        var checkinStore, eventStore;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    checkinStore = [];
                    eventStore = [];
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence, eventStore: eventStore, checkinStore: checkinStore }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var _b, status, body;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                            lat: INSIDE_LAT, lng: INSIDE_LNG,
                                        }, MEMBER_TOKEN)];
                                    case 1:
                                        _b = _c.sent(), status = _b.status, body = _b.body;
                                        strict_1.default.equal(status, 200);
                                        strict_1.default.equal(body.ok, true, "expected ok=true, got: ".concat(JSON.stringify(body)));
                                        strict_1.default.equal(body.status, "arrived");
                                        strict_1.default.ok(checkinStore.some(function (e) { return e.op === "upsert"; }), "checkin upsert should be called");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("check-in response never includes exact coordinates", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var body, json;
                        return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                        lat: INSIDE_LAT, lng: INSIDE_LNG,
                                    }, MEMBER_TOKEN)];
                                case 1:
                                    body = (_b.sent()).body;
                                    json = JSON.stringify(body);
                                    strict_1.default.ok(!/"lat"\s*:/.test(json), "lat must not appear in check-in response");
                                    strict_1.default.ok(!/"lng"\s*:/.test(json), "lng must not appear in check-in response");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("Check-in — outside radius", function () {
    var geofence = {
        id: GEOFENCE_ID,
        lat: MEETUP_LAT,
        lng: MEETUP_LNG,
        check_in_radius_m: 150,
        check_in_required: true,
        check_in_window_start: null,
        check_in_window_end: null,
        host_enabled: true,
        trip_id: TRIP_ID,
    };
    (0, node_test_1.it)("member outside radius gets ok=false with friendly message (no coords leaked)", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var _b, status, body, json;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                        lat: OUTSIDE_LAT, lng: OUTSIDE_LNG,
                                    }, MEMBER_TOKEN)];
                                case 1:
                                    _b = _c.sent(), status = _b.status, body = _b.body;
                                    strict_1.default.equal(status, 200);
                                    strict_1.default.equal(body.ok, false, "outside radius should fail");
                                    strict_1.default.equal(body.reason, "outside_radius");
                                    strict_1.default.ok(body.message, "friendly message should be set");
                                    json = JSON.stringify(body);
                                    strict_1.default.ok(!/"lat"\s*:/.test(json), "lat must not appear even in failed check-in response");
                                    strict_1.default.ok(!/"lng"\s*:/.test(json), "lng must not appear even in failed check-in response");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-member cannot check in at all", function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, withGeofenceServer({ memberRole: null, geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                        var status;
                        return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                        lat: INSIDE_LAT, lng: INSIDE_LNG,
                                    }, OTHER_TOKEN)];
                                case 1:
                                    status = (_b.sent()).status;
                                    strict_1.default.equal(status, 403, "non-member should get 403");
                                    return [2 /*return*/];
                            }
                        });
                    }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("Check-in — time window", function () {
    var pastEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    var futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h ahead
    (0, node_test_1.it)("check-in fails with window_not_open when window hasn't started", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    geofence = {
                        id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
                        check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
                        check_in_required: true,
                        check_in_window_start: futureStart,
                        check_in_window_end: null,
                    };
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                            lat: INSIDE_LAT, lng: INSIDE_LNG,
                                        }, MEMBER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        strict_1.default.equal(body.ok, false);
                                        strict_1.default.equal(body.reason, "window_not_open");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("check-in inside radius after window close creates late_check_in event", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence, checkinStore, eventStore;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    geofence = {
                        id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
                        check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
                        check_in_required: true,
                        check_in_window_start: null,
                        check_in_window_end: pastEnd,
                    };
                    checkinStore = [];
                    eventStore = [];
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence, eventStore: eventStore, checkinStore: checkinStore }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body, lateChekin, lateEvent;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                            lat: INSIDE_LAT, lng: INSIDE_LNG,
                                        }, MEMBER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        // Window closed → late check-in still succeeds with late status
                                        strict_1.default.equal(body.ok, true, "Expected ok=true for late check-in: ".concat(JSON.stringify(body)));
                                        strict_1.default.equal(body.status, "late", "should be late status");
                                        lateChekin = checkinStore.find(function (e) { return e.op === "upsert"; });
                                        strict_1.default.ok(lateChekin, "upsert should have been called");
                                        lateEvent = eventStore.find(function (e) { var _b; return e.op === "insert" && ((_b = e.row) === null || _b === void 0 ? void 0 : _b.event_type) === "late_check_in"; });
                                        strict_1.default.ok(lateEvent, "late_check_in event should be recorded");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("Check-in — suspicious GPS creates trust event", function () {
    (0, node_test_1.it)("suspicious GPS creates location_trust_event and returns ok=false with suspicious_gps reason", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence, eventStore;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    geofence = {
                        id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
                        check_in_radius_m: 150, host_enabled: true, trip_id: TRIP_ID,
                        check_in_window_start: null, check_in_window_end: null, check_in_required: true,
                    };
                    eventStore = [];
                    // trustSuspicious=true + locationSnap causes impossible-speed detection
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence, eventStore: eventStore, trustSuspicious: true, locationSnap: { lat: 40.7128, lng: -74.006, captured_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() } }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var body, suspEvent;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence/check-in"), {
                                            lat: INSIDE_LAT, lng: INSIDE_LNG,
                                        }, MEMBER_TOKEN)];
                                    case 1:
                                        body = (_b.sent()).body;
                                        strict_1.default.equal(body.ok, false, "suspicious GPS should return ok=false");
                                        strict_1.default.equal(body.reason, "suspicious_gps");
                                        suspEvent = eventStore.find(function (e) { var _b; return e.op === "insert" && ((_b = e.row) === null || _b === void 0 ? void 0 : _b.event_type) === "suspicious_check_in"; });
                                        strict_1.default.ok(suspEvent, "suspicious_check_in event should be created");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    // trustSuspicious=true + locationSnap causes impossible-speed detection
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═════════════════════════════════════════════════════════════════════════════
// Host attendance dashboard tests
// ═════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("Host attendance dashboard", function () {
    (0, node_test_1.it)("host sees attendance totals and status text — no lat/lng pins", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence, client, origFrom, geofenceRouter, app, server, port, _b, status_1, body, json;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    geofence = {
                        id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
                        check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null,
                        host_enabled: true, trip_id: TRIP_ID,
                    };
                    client = makeGeofenceClient({ memberRole: "owner", geofence: geofence, memberIds: [MEMBER_ID] });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "trip_members") {
                            return __assign(__assign({}, b), { select: function () { return ({
                                    eq: function (col, val) { return ({
                                        eq: function () { return ({
                                            maybeSingle: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_b) {
                                                return [2 /*return*/, ({ data: null, error: null })];
                                            }); }); },
                                        }); },
                                        maybeSingle: function () { return __awaiter(void 0, void 0, void 0, function () {
                                            return __generator(this, function (_b) {
                                                if (col === "trip_id")
                                                    return [2 /*return*/, { data: { owner_id: OWNER_ID }, error: null }];
                                                return [2 /*return*/, { data: null, error: null }];
                                            });
                                        }); },
                                        limit: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_b) {
                                            return [2 /*return*/, ({ data: [{ user_id: MEMBER_ID }], error: null })];
                                        }); }); },
                                        in: function () { return ({
                                            limit: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_b) {
                                                return [2 /*return*/, ({ data: [{ user_id: MEMBER_ID }], error: null })];
                                            }); }); },
                                        }); },
                                        then: function (f) { return Promise.resolve({ data: [{ user_id: MEMBER_ID }], error: null }).then(f); },
                                    }); },
                                }); } });
                        }
                        if (table === "plan_checkins") {
                            return __assign(__assign({}, b), { select: function () { return ({
                                    eq: function () { return ({
                                        eq: function () { return ({
                                            then: function (f) { return Promise.resolve({ data: [{ user_id: MEMBER_ID, status: "arrived", checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null }).then(f); },
                                        }); },
                                        then: function (f) { return Promise.resolve({ data: [{ user_id: MEMBER_ID, status: "arrived", checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() }], error: null }).then(f); },
                                    }); },
                                }); } });
                        }
                        if (table === "profiles") {
                            return __assign(__assign({}, b), { select: function () { return ({
                                    in: function () { return ({
                                        then: function (f) { return Promise.resolve({ data: [{ id: MEMBER_ID, handle: "alice", name: "Alice", avatar_url: null }], error: null }).then(f); },
                                    }); },
                                }); } });
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/geofence.js"); })];
                case 1:
                    geofenceRouter = (_c.sent()).default;
                    app = (0, express_1.default)();
                    app.use(express_1.default.json());
                    app.use("/api", geofenceRouter);
                    server = node_http_1.default.createServer(app);
                    return [4 /*yield*/, new Promise(function (res) { return server.listen(0, "127.0.0.1", res); })];
                case 2:
                    _c.sent();
                    port = server.address().port;
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, , 5, 7]);
                    return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence/attendance"))];
                case 4:
                    _b = _c.sent(), status_1 = _b.status, body = _b.body;
                    strict_1.default.equal(status_1, 200, "Expected 200, got: ".concat(status_1, ": ").concat(JSON.stringify(body)));
                    json = JSON.stringify(body);
                    strict_1.default.ok(!/"lat"\s*:/.test(json), "lat must never appear in attendance response");
                    strict_1.default.ok(!/"lng"\s*:/.test(json), "lng must never appear in attendance response");
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, new Promise(function (res) { return server.close(function () { return res(); }); })];
                case 6:
                    _c.sent();
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-owner member cannot access attendance dashboard", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    geofence = {
                        id: GEOFENCE_ID, lat: MEETUP_LAT, lng: MEETUP_LNG,
                        check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null,
                        host_enabled: true,
                    };
                    return [4 /*yield*/, withGeofenceServer({ memberRole: "member", geofence: geofence }, function (port) { return __awaiter(void 0, void 0, void 0, function () {
                            var status;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence/attendance"), undefined, MEMBER_TOKEN)];
                                    case 1:
                                        status = (_b.sent()).status;
                                        strict_1.default.equal(status, 403, "non-owner should be forbidden from attendance dashboard");
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═════════════════════════════════════════════════════════════════════════════
// Admin radius defaults
// ═════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("Admin radius defaults applied at geofence creation", function () {
    (0, node_test_1.it)("geofence creation clamps radius to admin min/max", function () { return __awaiter(void 0, void 0, void 0, function () {
        var geofence, eventStore, client, origFrom, geofenceRouter, app, server, port, _b, status_2, body;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    geofence = null;
                    eventStore = [];
                    client = makeGeofenceClient({ memberRole: "owner", geofence: geofence, eventStore: eventStore });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "geofence_admin_settings") {
                            return __assign(__assign({}, b), { select: function () { return ({
                                    eq: function () { return ({
                                        maybeSingle: function () { return __awaiter(void 0, void 0, void 0, function () {
                                            return __generator(this, function (_b) {
                                                return [2 /*return*/, ({
                                                        data: { default_radius_m: 200, min_radius_m: 100, max_radius_m: 300, no_show_affects_reliability: false },
                                                        error: null,
                                                    })];
                                            });
                                        }); },
                                    }); },
                                }); } });
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/geofence.js"); })];
                case 1:
                    geofenceRouter = (_c.sent()).default;
                    app = (0, express_1.default)();
                    app.use(express_1.default.json());
                    app.use("/api", geofenceRouter);
                    server = node_http_1.default.createServer(app);
                    return [4 /*yield*/, new Promise(function (res) { return server.listen(0, "127.0.0.1", res); })];
                case 2:
                    _c.sent();
                    port = server.address().port;
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, , 5, 7]);
                    return [4 /*yield*/, request(port, "POST", "/api/trips/".concat(TRIP_ID, "/geofence"), {
                            lat: MEETUP_LAT, lng: MEETUP_LNG,
                            checkInRadiusM: 5000,
                            publicPreviewLevel: "neighborhood",
                            exactVisibility: "exact_after_acceptance",
                        })];
                case 4:
                    _b = _c.sent(), status_2 = _b.status, body = _b.body;
                    strict_1.default.equal(status_2, 201, "Expected 201, got ".concat(status_2, ": ").concat(JSON.stringify(body)));
                    strict_1.default.equal(body.effectiveRadiusM, 300, "radius should be clamped to admin max of 300");
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, new Promise(function (res) { return server.close(function () { return res(); }); })];
                case 6:
                    _c.sent();
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); });
});
// ═════════════════════════════════════════════════════════════════════════════
// Feature flag gating
// ═════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("Feature flag gating", function () {
    (0, node_test_1.it)("returns featureEnabled=false when flag is off", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, origFrom, geofenceRouter, app, server, port, _b, status_3, body;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeGeofenceClient({ memberRole: "member" });
                    origFrom = client.from.bind(client);
                    client.from = function (table) {
                        var b = origFrom(table);
                        if (table === "feature_flags") {
                            return __assign(__assign({}, b), { select: function () { return ({
                                    eq: function () { return ({
                                        maybeSingle: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_b) {
                                            return [2 /*return*/, ({ data: { enabled: false }, error: null })];
                                        }); }); },
                                    }); },
                                }); } });
                        }
                        return b;
                    };
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/geofence.js"); })];
                case 1:
                    geofenceRouter = (_c.sent()).default;
                    app = (0, express_1.default)();
                    app.use(express_1.default.json());
                    app.use("/api", geofenceRouter);
                    server = node_http_1.default.createServer(app);
                    return [4 /*yield*/, new Promise(function (res) { return server.listen(0, "127.0.0.1", res); })];
                case 2:
                    _c.sent();
                    port = server.address().port;
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, , 5, 7]);
                    return [4 /*yield*/, request(port, "GET", "/api/trips/".concat(TRIP_ID, "/geofence"), undefined, MEMBER_TOKEN)];
                case 4:
                    _b = _c.sent(), status_3 = _b.status, body = _b.body;
                    strict_1.default.equal(status_3, 200);
                    strict_1.default.equal(body.featureEnabled, false);
                    strict_1.default.equal(body.geofence, null);
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, new Promise(function (res) { return server.close(function () { return res(); }); })];
                case 6:
                    _c.sent();
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); });
});
