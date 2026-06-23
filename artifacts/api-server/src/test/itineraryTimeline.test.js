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
 * Backend tests for Task #14: Trip Itinerary Timeline + Map View
 *
 * 12 scenarios:
 *  1.  Non-member gets 403 on GET /plan
 *  2.  Accepted member gets 200 with items array + warnings field
 *  3.  time_overlap warning when two items on same day start within 30 min
 *  4.  duplicate warning when same source_id in two active items
 *  5.  outside_trip_dates warning when item day_date outside trip start/end
 *  6.  No warnings when no conflicts exist
 *  7.  GET /plan/map returns only items with safe public coordinates
 *  8.  lat/lng absent (null) in /plan response when location_is_private=true
 *  9.  lat/lng present in /plan response when location_is_private=false
 * 10.  Removed item does NOT appear in /plan or /plan/map
 * 11.  Non-member cannot create plan item (403)
 * 12.  Member cannot edit another member's item (403)
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var trips_js_1 = require("../routes/trips.js");
var plan_js_1 = require("../routes/plan.js");
// ── ID constants ──────────────────────────────────────────────────────────────
var ALICE_ID = "aaaaaaaa-1111-0000-0000-000000000001";
var BOB_ID = "bbbbbbbb-1111-0000-0000-000000000002";
var CAROL_ID = "cccccccc-1111-0000-0000-000000000003";
var TRIP_ID = "11110000-1111-0000-0000-000000000001";
var ITEM_ID_A = "aaaaaaaa-2222-0000-0000-000000000001";
var ITEM_ID_B = "bbbbbbbb-2222-0000-0000-000000000002";
var ITEM_ID_C = "cccccccc-2222-0000-0000-000000000003";
var SOURCE_ID = "ssssssss-0000-0000-0000-000000000001";
function baseState() {
    return {
        users: {
            "alice-tok": { id: ALICE_ID },
            "bob-tok": { id: BOB_ID },
            "carol-tok": { id: CAROL_ID },
        },
        trips: [
            { id: TRIP_ID, start_date: "2026-07-01", end_date: "2026-07-15" },
        ],
        trip_members: [],
        trip_plan_items: [],
        meetups: [],
    };
}
function withMembers(roles) {
    var s = baseState();
    for (var _i = 0, _a = Object.entries(roles); _i < _a.length; _i++) {
        var _b = _a[_i], uid = _b[0], role = _b[1];
        s.trip_members.push({ trip_id: TRIP_ID, user_id: uid, role: role });
    }
    return s;
}
// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state) {
    var _this = this;
    function from(table) {
        var filters = [];
        var _op = "select";
        var _insertRow = null;
        var _updatePayload = null;
        var b = {
            select: function (_cols) { return b; },
            insert: function (row) { _op = "insert"; _insertRow = row; return b; },
            update: function (p) { _op = "update"; _updatePayload = p; return b; },
            delete: function () { _op = "delete"; return b; },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            is: function (col, val) {
                filters.push(function (r) { return val === null ? r[col] == null : r[col] === val; });
                return b;
            },
            order: function () { return b; },
            limit: function () { return b; },
            maybeSingle: function () { return resolveOne(); },
            single: function () { return resolveInsertOrOne(); },
            then: function (onF, onR) {
                if (_op === "update")
                    return resolveUpdate().then(onF, onR);
                if (_op === "delete")
                    return resolveDelete().then(onF, onR);
                return resolveList().then(onF, onR);
            },
        };
        function getSource() { var _a; return (_a = state[table]) !== null && _a !== void 0 ? _a : []; }
        function matched() { return getSource().filter(function (r) { return filters.every(function (f) { return f(r); }); }); }
        function resolveOne() {
            return __awaiter(this, void 0, void 0, function () {
                var m_1, m;
                var _a;
                return __generator(this, function (_b) {
                    if (_op === "update") {
                        m_1 = matched();
                        return [2 /*return*/, { data: m_1[0] ? __assign(__assign({}, m_1[0]), _updatePayload) : null, error: null }];
                    }
                    m = matched();
                    return [2 /*return*/, { data: (_a = m[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                });
            });
        }
        function resolveInsertOrOne() {
            return __awaiter(this, void 0, void 0, function () {
                var newRow, source, updated, _loop_1, _i, source_1, row, m;
                var _a;
                return __generator(this, function (_b) {
                    if (_op === "insert" && _insertRow) {
                        newRow = __assign({ id: "new-".concat(Date.now()), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), removed_at: null }, _insertRow);
                        getSource().push(newRow);
                        return [2 /*return*/, { data: newRow, error: null }];
                    }
                    if (_op === "update" && _updatePayload) {
                        source = getSource();
                        updated = null;
                        _loop_1 = function (row) {
                            if (filters.every(function (f) { return f(row); })) {
                                Object.assign(row, _updatePayload);
                                updated = row;
                            }
                        };
                        for (_i = 0, source_1 = source; _i < source_1.length; _i++) {
                            row = source_1[_i];
                            _loop_1(row);
                        }
                        return [2 /*return*/, { data: updated !== null && updated !== void 0 ? updated : null, error: null }];
                    }
                    m = matched();
                    return [2 /*return*/, { data: (_a = m[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, { data: matched(), error: null }];
            }); });
        }
        function resolveUpdate() {
            return __awaiter(this, void 0, void 0, function () {
                var _loop_2, _i, _a, row;
                return __generator(this, function (_b) {
                    _loop_2 = function (row) {
                        if (filters.every(function (f) { return f(row); }))
                            Object.assign(row, _updatePayload);
                    };
                    for (_i = 0, _a = getSource(); _i < _a.length; _i++) {
                        row = _a[_i];
                        _loop_2(row);
                    }
                    return [2 /*return*/, { data: null, error: null }];
                });
            });
        }
        function resolveDelete() {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    state[table] = getSource().filter(function (r) { return !filters.every(function (f) { return f(r); }); });
                    return [2 /*return*/, { data: null, error: null }];
                });
            });
        }
        return b;
    }
    return {
        from: from,
        auth: {
            getUser: function (token) { return __awaiter(_this, void 0, void 0, function () {
                var u;
                return __generator(this, function (_a) {
                    u = state.users[token];
                    if (!u)
                        return [2 /*return*/, { data: { user: null }, error: { message: "invalid token" } }];
                    return [2 /*return*/, { data: { user: u }, error: null }];
                });
            }); },
        },
    };
}
// ── Server helpers ────────────────────────────────────────────────────────────
function makeApp(state) {
    (0, http_js_1._setTestClient)(makeFakeClient(state), true);
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(function (req, _res, next) {
        req.log = { error: function () { }, info: function () { }, warn: function () { } };
        next();
    });
    app.use("/api", trips_js_1.default);
    app.use("/api", plan_js_1.default);
    return app;
}
function startServer(state) {
    return __awaiter(this, void 0, void 0, function () {
        var app;
        return __generator(this, function (_a) {
            app = makeApp(state);
            return [2 /*return*/, new Promise(function (resolve, reject) {
                    var srv = (0, node_http_1.createServer)(app);
                    srv.listen(0, "127.0.0.1", function () {
                        var port = srv.address().port;
                        resolve({ port: port, close: function () { return new Promise(function (res, rej) { return srv.close(function (e) { return e ? rej(e) : res(); }); }); } });
                    });
                    srv.on("error", reject);
                })];
        });
    });
}
function get(port, path, token) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    headers = {};
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), { headers: headers })];
                case 1:
                    res = _b.sent();
                    _a = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_a.body = _b.sent(), _a)];
            }
        });
    });
}
function post(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    headers = { "Content-Type": "application/json" };
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), {
                            method: "POST",
                            headers: headers,
                            body: body !== undefined ? JSON.stringify(body) : undefined,
                        })];
                case 1:
                    res = _b.sent();
                    _a = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_a.body = _b.sent(), _a)];
            }
        });
    });
}
function patchReq(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    headers = { "Content-Type": "application/json" };
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), {
                            method: "PATCH",
                            headers: headers,
                            body: body !== undefined ? JSON.stringify(body) : undefined,
                        })];
                case 1:
                    res = _b.sent();
                    _a = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_a.body = _b.sent(), _a)];
            }
        });
    });
}
function makeItem(overrides) {
    return __assign({ trip_id: TRIP_ID, creator_id: ALICE_ID, title: "Test Item", category: "activity", status: "tentative", source_type: "manual", source_id: null, day_date: null, starts_at: null, ends_at: null, location_name: null, notes: null, sort_order: 0, visibility: "members", removed_at: null, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", lat: null, lng: null, location_is_private: true }, overrides);
}
// ── Tests ─────────────────────────────────────────────────────────────────────
function deleteReq(port, path, token) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    headers = {};
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), { method: "DELETE", headers: headers })];
                case 1:
                    res = _c.sent();
                    _b = { status: res.status };
                    if (!(res.status === 204)) return [3 /*break*/, 2];
                    _a = null;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 3:
                    _a = _c.sent();
                    _c.label = 4;
                case 4: return [2 /*return*/, (_b.body = _a, _b)];
            }
        });
    });
}
(0, node_test_1.describe)("Itinerary timeline + map — 15 scenarios", function () {
    (0, node_test_1.it)("1. Non-member gets 403 on GET /plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    s = withMembers({});
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _b.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "carol-tok")];
                case 2:
                    r = _b.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _b.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("2. Accepted member gets 200 with items array and warnings field", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, item;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Lunch" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.items), "items must be an array");
                    strict_1.default.equal(r.body.items.length, 1);
                    item = r.body.items[0];
                    strict_1.default.ok(Array.isArray(item.warnings), "each item must have a warnings array");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("3. time_overlap warning: two items same day_date starting within 30 min", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, items;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Breakfast", day_date: "2026-07-05", starts_at: "2026-07-05T08:00:00Z" }), makeItem({ id: ITEM_ID_B, title: "Gym", day_date: "2026-07-05", starts_at: "2026-07-05T08:20:00Z" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    strict_1.default.ok(items.every(function (i) { return i.warnings.includes("time_overlap"); }), "both overlapping items must have time_overlap warning");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4. duplicate warning: same source_id in two active plan items", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, items;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, source_type: "meetup", source_id: SOURCE_ID, title: "Meetup 1" }), makeItem({ id: ITEM_ID_B, source_type: "meetup", source_id: SOURCE_ID, title: "Meetup 2" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    strict_1.default.ok(items.every(function (i) { return i.warnings.includes("duplicate"); }), "both items with same source_id must have duplicate warning");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("5. outside_trip_dates warning: item day_date outside trip start/end", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, item;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Pre-trip meal", day_date: "2026-06-20" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    item = r.body.items[0];
                    strict_1.default.ok(item.warnings.includes("outside_trip_dates"), "item with day_date before trip start must have outside_trip_dates warning");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("6. No warnings when items have no conflicts", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, items;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Morning swim", day_date: "2026-07-03", starts_at: "2026-07-03T07:00:00Z" }), makeItem({ id: ITEM_ID_B, title: "Lunch", day_date: "2026-07-03", starts_at: "2026-07-03T12:00:00Z" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    strict_1.default.ok(items.every(function (i) { return i.warnings.length === 0; }), "well-spaced items must have no warnings");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("7. GET /plan/map returns only items with safe public coordinates", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, items;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "No coords", lat: null, lng: null, location_is_private: true }), makeItem({ id: ITEM_ID_B, title: "Private coords", lat: 10.32, lng: 123.89, location_is_private: true }), makeItem({ id: ITEM_ID_C, title: "Public coords", lat: 10.35, lng: 123.91, location_is_private: false }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan/map"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    strict_1.default.equal(items.length, 1, "map endpoint must return only items with public coordinates");
                    strict_1.default.equal(items[0].title, "Public coords");
                    strict_1.default.ok(items[0].lat != null, "lat must be present for public items");
                    strict_1.default.ok(items[0].lng != null, "lng must be present for public items");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("8. lat/lng null in /plan response when location_is_private=true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, item;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Hotel", lat: 10.32, lng: 123.89, location_is_private: true }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    item = r.body.items[0];
                    strict_1.default.equal(item.lat, null, "lat must be null when location_is_private=true");
                    strict_1.default.equal(item.lng, null, "lng must be null when location_is_private=true");
                    strict_1.default.equal(item.locationIsPrivate, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("9. lat/lng present in /plan response when location_is_private=false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, item;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Cafe", lat: 10.32, lng: 123.89, location_is_private: false }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    item = r.body.items[0];
                    strict_1.default.equal(item.lat, 10.32, "lat must be present when location_is_private=false");
                    strict_1.default.equal(item.lng, 123.89, "lng must be present when location_is_private=false");
                    strict_1.default.equal(item.locationIsPrivate, false);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("10. Removed item does not appear in /plan or /plan/map", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, _b, plan, map;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = withMembers((_c = {}, _c[ALICE_ID] = "owner", _c));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Removed", removed_at: "2026-06-10T00:00:00Z",
                        lat: 10.32, lng: 123.89, location_is_private: false }), makeItem({ id: ITEM_ID_B, title: "Active" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _d.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, Promise.all([
                            get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok"),
                            get(port, "/api/trips/".concat(TRIP_ID, "/plan/map"), "alice-tok"),
                        ])];
                case 2:
                    _b = _d.sent(), plan = _b[0], map = _b[1];
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    strict_1.default.equal(plan.body.items.length, 1);
                    strict_1.default.equal(plan.body.items[0].title, "Active");
                    strict_1.default.equal(map.body.items.length, 0, "removed item must not appear in map endpoint");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("11. Non-member cannot create plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), "carol-tok", { title: "Crash" })];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12. Member cannot edit another member's plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b[BOB_ID] = "member", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Alice item", creator_id: ALICE_ID }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, patchReq(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_A), "bob-tok", { title: "Bob hijacks" })];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 403, "member must not be able to edit another member's item");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("13. missing_location warning: item has location_name but no coordinates", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, r, items, noCoord, withCoord;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Eiffel Tower", location_name: "Eiffel Tower, Paris", lat: null, lng: null }), makeItem({ id: ITEM_ID_B, title: "Louvre", location_name: "Louvre Museum", lat: 48.860, lng: 2.337, location_is_private: false }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    noCoord = items.find(function (i) { return i.title === "Eiffel Tower"; });
                    withCoord = items.find(function (i) { return i.title === "Louvre"; });
                    strict_1.default.ok(noCoord.warnings.includes("missing_location"), "item with location_name but no lat/lng must have missing_location warning");
                    strict_1.default.ok(!withCoord.warnings.includes("missing_location"), "item with coordinates must NOT have missing_location warning");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("14. cancelled_source warning: meetup-sourced item from a cancelled meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var MEETUP_ID, s, _a, port, close, r, items, sourced, regular;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    MEETUP_ID = "mmmmmmm0-1111-0000-0000-000000000001";
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.meetups.push({ id: MEETUP_ID, status: "cancelled" });
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Cancelled meetup event",
                        source_type: "meetup", source_id: MEETUP_ID }), makeItem({ id: ITEM_ID_B, title: "Regular item", source_type: "manual" }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _c.sent();
                    return [4 /*yield*/, close()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(r.status, 200);
                    items = r.body.items;
                    sourced = items.find(function (i) { return i.title === "Cancelled meetup event"; });
                    regular = items.find(function (i) { return i.title === "Regular item"; });
                    strict_1.default.ok(sourced.warnings.includes("cancelled_source"), "item sourced from cancelled meetup must have cancelled_source warning");
                    strict_1.default.ok(!regular.warnings.includes("cancelled_source"), "manual item must NOT have cancelled_source warning");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("15. DELETE /plan/items/:itemId removes item (204)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _a, port, close, del, plan;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    s = withMembers((_b = {}, _b[ALICE_ID] = "owner", _b));
                    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "To delete", creator_id: ALICE_ID }));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _a = _c.sent(), port = _a.port, close = _a.close;
                    return [4 /*yield*/, deleteReq(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_A), "alice-tok")];
                case 2:
                    del = _c.sent();
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 3:
                    plan = _c.sent();
                    return [4 /*yield*/, close()];
                case 4:
                    _c.sent();
                    strict_1.default.equal(del.status, 204, "DELETE must return 204");
                    strict_1.default.equal(plan.body.items.length, 0, "deleted item must not appear in plan");
                    return [2 /*return*/];
            }
        });
    }); });
});
