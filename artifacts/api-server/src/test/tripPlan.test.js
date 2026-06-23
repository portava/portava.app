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
 * Integration tests for Trip Plan Builder routes.
 *
 * Covers all 15 scenarios specified in task-13:
 *   1.  Non-member cannot read plan (403)
 *   2.  Pending invitee cannot read plan (403)
 *   3.  Accepted member can read plan (200)
 *   4.  Owner can read plan (200)
 *   5.  Non-member cannot create plan item (403)
 *   6.  Accepted member can create plan item; creator_id set from token
 *   7.  Owner can create plan item
 *   8.  Member cannot edit another member's item (403)
 *   9.  Member CAN edit their own item (200)
 *  10.  Owner can edit any item
 *  11.  Soft-delete: remove sets removed_at; source fields unchanged
 *  12.  Removed item no longer appears in GET /plan
 *  13.  Duplicate meetup guard: second add returns 409
 *  14.  GPS fields are NOT present in any plan item response
 *  15.  creator_id in response always matches token user, not body
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripPlan.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var trips_js_1 = require("../routes/trips.js");
var plan_js_1 = require("../routes/plan.js");
// ── ID constants (valid UUIDs) ────────────────────────────────────────────────
var ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
var BOB_ID = "bbbbbbbb-0000-0000-0000-000000000002";
var CAROL_ID = "cccccccc-0000-0000-0000-000000000003";
var TRIP_ID = "33333333-0000-0000-0000-000000000001";
var MEETUP_ID = "44444444-0000-0000-0000-000000000002";
var PLACE_ID = "55555555-0000-0000-0000-000000000003";
var ITEM_ID_1 = "66666666-0000-0000-0000-000000000004";
var ITEM_ID_2 = "77777777-0000-0000-0000-000000000005";
function baseState() {
    return {
        users: {
            "alice-tok": { id: ALICE_ID },
            "bob-tok": { id: BOB_ID },
            "carol-tok": { id: CAROL_ID },
        },
        trip_members: [],
        trip_plan_items: [],
        meetups: [
            { id: MEETUP_ID, title: "Beach Meetup", starts_at: "2026-07-10T18:00:00Z", location_name: "Mactan Shore" },
        ],
        places: [
            { id: PLACE_ID, name: "Anzani Restaurant", category: "dining", location_name: "Banilad, Cebu",
                approximate_lat: 10.32, approximate_lng: 123.89 },
        ],
    };
}
// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state) {
    var _this = this;
    function from(table) {
        var filters = [];
        var _op = "select";
        var _insertRow = null;
        var _updatePayload = null;
        var _selectCols = null;
        var b = {
            select: function (cols) { _selectCols = cols !== null && cols !== void 0 ? cols : null; return b; },
            insert: function (row) {
                _op = "insert";
                _insertRow = row;
                return b;
            },
            update: function (patch) { _op = "update"; _updatePayload = patch; return b; },
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
        function getSource() { var _c; return (_c = state[table]) !== null && _c !== void 0 ? _c : []; }
        function matchedRows() { return getSource().filter(function (r) { return filters.every(function (f) { return f(r); }); }); }
        function stripGps(row) {
            var _a = row.approximate_lat, _b = row.approximate_lng, rest = __rest(row, ["approximate_lat", "approximate_lng"]);
            return rest;
        }
        function resolveOne() {
            return __awaiter(this, void 0, void 0, function () {
                var m_1, m;
                var _c;
                return __generator(this, function (_d) {
                    if (_op === "update") {
                        m_1 = matchedRows();
                        return [2 /*return*/, { data: m_1[0] ? __assign(__assign({}, m_1[0]), _updatePayload) : null, error: null }];
                    }
                    m = matchedRows();
                    return [2 /*return*/, { data: (_c = m[0]) !== null && _c !== void 0 ? _c : null, error: null }];
                });
            });
        }
        function resolveInsertOrOne() {
            return __awaiter(this, void 0, void 0, function () {
                var dup, newRow, source, updated, _loop_1, _i, source_1, row, m;
                var _c;
                return __generator(this, function (_d) {
                    if (_op === "insert" && _insertRow) {
                        // check for duplicate (unique index simulation for source items)
                        if (table === "trip_plan_items" && _insertRow.source_id) {
                            dup = getSource().find(function (r) {
                                return r.trip_id === _insertRow.trip_id &&
                                    r.source_type === _insertRow.source_type &&
                                    r.source_id === _insertRow.source_id &&
                                    r.removed_at == null;
                            });
                            if (dup)
                                return [2 /*return*/, { data: null, error: { message: "duplicate key value violates unique constraint" } }];
                        }
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
                    m = matchedRows();
                    return [2 /*return*/, { data: (_c = m[0]) !== null && _c !== void 0 ? _c : null, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_c) {
                    return [2 /*return*/, { data: matchedRows(), error: null }];
                });
            });
        }
        function resolveUpdate() {
            return __awaiter(this, void 0, void 0, function () {
                var _loop_2, _i, _c, row;
                return __generator(this, function (_d) {
                    _loop_2 = function (row) {
                        if (filters.every(function (f) { return f(row); }))
                            Object.assign(row, _updatePayload);
                    };
                    for (_i = 0, _c = getSource(); _i < _c.length; _i++) {
                        row = _c[_i];
                        _loop_2(row);
                    }
                    return [2 /*return*/, { data: null, error: null }];
                });
            });
        }
        function resolveDelete() {
            return __awaiter(this, void 0, void 0, function () {
                return __generator(this, function (_c) {
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
                return __generator(this, function (_c) {
                    u = state.users[token];
                    if (!u)
                        return [2 /*return*/, { data: { user: null }, error: { message: "invalid token" } }];
                    return [2 /*return*/, { data: { user: u }, error: null }];
                });
            }); },
        },
    };
}
// ── Server helpers ─────────────────────────────────────────────────────────────
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
        return __generator(this, function (_c) {
            app = makeApp(state);
            return [2 /*return*/, new Promise(function (resolve, reject) {
                    var srv = (0, node_http_1.createServer)(app);
                    srv.listen(0, "127.0.0.1", function () {
                        var port = srv.address().port;
                        resolve({ port: port, state: state, close: function () { return new Promise(function (res, rej) { return srv.close(function (e) { return e ? rej(e) : res(); }); }); } });
                    });
                    srv.on("error", reject);
                })];
        });
    });
}
function get(port, path, token) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    headers = {};
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), { headers: headers })];
                case 1:
                    res = _d.sent();
                    _c = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_c.body = _d.sent(), _c)];
            }
        });
    });
}
function post(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
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
                    res = _d.sent();
                    _c = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_c.body = _d.sent(), _c)];
            }
        });
    });
}
function patch(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
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
                    res = _d.sent();
                    _c = { status: res.status };
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 2: return [2 /*return*/, (_c.body = _d.sent(), _c)];
            }
        });
    });
}
function del(port, path, token) {
    return __awaiter(this, void 0, void 0, function () {
        var headers, res, text;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    headers = {};
                    if (token)
                        headers["Authorization"] = "Bearer ".concat(token);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), { method: "DELETE", headers: headers })];
                case 1:
                    res = _c.sent();
                    return [4 /*yield*/, res.text()];
                case 2:
                    text = _c.sent();
                    return [2 /*return*/, { status: res.status, body: text ? JSON.parse(text) : null }];
            }
        });
    });
}
// ── Test helpers ──────────────────────────────────────────────────────────────
function stateWithMembers(roles) {
    var s = baseState();
    for (var _i = 0, _c = Object.entries(roles); _i < _c.length; _i++) {
        var _d = _c[_i], userId = _d[0], role = _d[1];
        s.trip_members.push({ trip_id: TRIP_ID, user_id: userId, role: role });
    }
    return s;
}
function stateWithItem(creatorId) {
    var _c;
    var s = stateWithMembers((_c = {}, _c[ALICE_ID] = "owner", _c[BOB_ID] = "member", _c[creatorId] = creatorId === ALICE_ID || creatorId === BOB_ID ? (creatorId === ALICE_ID ? "owner" : "member") : "member", _c));
    s.trip_plan_items.push({
        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: creatorId,
        title: "Test Item", category: "activity", status: "tentative",
        source_type: "manual", source_id: null,
        day_date: null, starts_at: null, ends_at: null,
        location_name: null, notes: null,
        sort_order: 0, visibility: "members", removed_at: null,
        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    return s;
}
// ── Tests ─────────────────────────────────────────────────────────────────────
// ── 1. Non-member cannot read plan ───────────────────────────────────────────
(0, node_test_1.describe)("GET /api/trips/:tripId/plan — membership gate", function () {
    (0, node_test_1.it)("1. non-member gets 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "bob-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("2. pending invitee gets 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "invited", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "bob-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("3. accepted member gets 200 with items array", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "bob-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.items));
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4. owner gets 200 with items array", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.items));
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 5-7. POST /plan/items — create ────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/trips/:tripId/plan/items — create", function () {
    (0, node_test_1.it)("5. non-member gets 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), "bob-tok", { title: "Test" })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("6. member can create; creator_id set from token (not body)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), "bob-tok", {
                            title: "Swimming", category: "activity",
                            // evil: attacker passes wrong creator_id in body — must be ignored
                            creatorId: ALICE_ID,
                        })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.creatorId, BOB_ID, "creatorId must come from token, not body");
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("7. owner can create plan item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), "alice-tok", { title: "Check-in" })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.tripId, TRIP_ID);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 8-10. PATCH /plan/items/:itemId — edit permissions ───────────────────────
(0, node_test_1.describe)("PATCH /api/trips/:tripId/plan/items/:itemId — edit", function () {
    (0, node_test_1.it)("8. member cannot edit another member's item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d[CAROL_ID] = "member", _d));
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
                        title: "Bob item", category: "activity", status: "tentative",
                        source_type: "manual", source_id: null, day_date: null,
                        starts_at: null, ends_at: null, location_name: null, notes: null,
                        sort_order: 0, visibility: "members", removed_at: null,
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "carol-tok", { title: "Modified" })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("9. member can edit their own item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "bob-tok", { title: "Updated Title" })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.title, "Updated Title");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("10. owner can edit any item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "alice-tok", { status: "confirmed" })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "confirmed");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 11-12. Soft-delete ────────────────────────────────────────────────────────
(0, node_test_1.describe)("PATCH /remove — soft-delete", function () {
    (0, node_test_1.it)("11. remove sets removed_at; source_type and source_id unchanged", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r, dbItem;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d));
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
                        title: "Meetup item", category: "meeting_point", status: "tentative",
                        source_type: "meetup", source_id: MEETUP_ID, day_date: null,
                        starts_at: null, ends_at: null, location_name: null, notes: null,
                        sort_order: 0, visibility: "members", removed_at: null,
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/remove"), "bob-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 200);
                    dbItem = s.trip_plan_items.find(function (i) { return i.id === ITEM_ID_1; });
                    strict_1.default.ok(dbItem.removed_at, "removed_at should be set after soft-delete");
                    // source fields untouched
                    strict_1.default.equal(dbItem.source_type, "meetup");
                    strict_1.default.equal(dbItem.source_id, MEETUP_ID);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12. removed item no longer appears in GET /plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: ALICE_ID,
                        title: "Gone item", category: "activity", status: "tentative",
                        source_type: "manual", source_id: null, day_date: null,
                        starts_at: null, ends_at: null, location_name: null, notes: null,
                        sort_order: 0, visibility: "members",
                        removed_at: "2026-06-05T00:00:00Z", // already removed
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-05T00:00:00Z",
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 0, "removed item should not appear");
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 13. Duplicate meetup guard ────────────────────────────────────────────────
(0, node_test_1.describe)("POST /meetups/:id/add-to-trip-plan — duplicate guard", function () {
    (0, node_test_1.it)("13. adding same meetup twice returns 409", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r1, r2;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
                case 2:
                    r1 = _e.sent();
                    strict_1.default.equal(r1.status, 201, "first add should succeed");
                    return [4 /*yield*/, post(port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
                case 3:
                    r2 = _e.sent();
                    strict_1.default.equal(r2.status, 409, "second add should return 409 duplicate");
                    return [4 /*yield*/, close()];
                case 4:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 14. GPS fields not exposed ────────────────────────────────────────────────
(0, node_test_1.describe)("GET /plan — GPS privacy", function () {
    (0, node_test_1.it)("14. plan item responses do not include GPS coordinates", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r, item;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d));
                    // Add a place item manually with GPS fields in the row
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: ALICE_ID,
                        title: "Anzani", category: "dining", status: "tentative",
                        source_type: "place", source_id: PLACE_ID,
                        day_date: null, starts_at: null, ends_at: null,
                        location_name: "Banilad, Cebu", notes: null,
                        sort_order: 0, visibility: "members", removed_at: null,
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
                        // These should NOT appear in the response
                        approximate_lat: 10.32,
                        approximate_lng: 123.89,
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, get(port, "/api/trips/".concat(TRIP_ID, "/plan"), "alice-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 1);
                    item = r.body.items[0];
                    strict_1.default.equal(item.approximate_lat, undefined, "approximate_lat must not be exposed");
                    strict_1.default.equal(item.approximate_lng, undefined, "approximate_lng must not be exposed");
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 15. creator_id always from token ─────────────────────────────────────────
(0, node_test_1.describe)("POST /plan/items — creator_id from token", function () {
    (0, node_test_1.it)("15. creator_id in response matches token even if body sends different value", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), "bob-tok", {
                            title: "My item",
                            creatorId: ALICE_ID, // attacker tries to impersonate alice
                            creator_id: ALICE_ID, // snake_case variant
                        })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.creatorId, BOB_ID, "creator must always be set from JWT, not body");
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── canEditPlanItem — unit tests ──────────────────────────────────────────────
function makeMiniClient(items, members) {
    return {
        from: function (table) {
            var source = table === "trip_plan_items" ? items : members;
            var filters = [];
            var b = {
                select: function () { return b; },
                eq: function (c, v) { filters.push(function (r) { return r[c] === v; }); return b; },
                in: function (c, vs) { filters.push(function (r) { return vs.includes(r[c]); }); return b; },
                is: function (c, v) {
                    filters.push(function (r) { return v === null ? r[c] == null : r[c] === v; });
                    return b;
                },
                maybeSingle: function () {
                    return __awaiter(this, void 0, void 0, function () {
                        var _c;
                        return __generator(this, function (_d) {
                            return [2 /*return*/, { data: (_c = source.filter(function (r) { return filters.every(function (f) { return f(r); }); })[0]) !== null && _c !== void 0 ? _c : null, error: null }];
                        });
                    });
                },
            };
            return b;
        },
    };
}
function planItem(id, tripId, creatorId, removedAt) {
    if (removedAt === void 0) { removedAt = null; }
    return { id: id, trip_id: tripId, creator_id: creatorId, removed_at: removedAt };
}
function membership(tripId, userId, role) {
    return { trip_id: tripId, user_id: userId, role: role };
}
(0, node_test_1.describe)("canEditPlanItem — unit tests", function () {
    (0, node_test_1.it)("A. not_found when item does not exist", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([], [membership(TRIP_ID, ALICE_ID, "owner")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, ALICE_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "not_found");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("B. not_found when item is soft-deleted (removed_at set)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, ALICE_ID, "2026-06-01T00:00:00Z")], [membership(TRIP_ID, ALICE_ID, "owner")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, ALICE_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "not_found");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("C. not_member when user has no accepted membership", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)], []);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, BOB_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "not_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("D. not_member when user is only invited (not accepted)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)], [membership(TRIP_ID, BOB_ID, "invited")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, BOB_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "not_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("E. forbidden when member tries to edit another member's item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)], [membership(TRIP_ID, BOB_ID, "member")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, BOB_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("F. permitted when member edits their own item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, BOB_ID)], [membership(TRIP_ID, BOB_ID, "member")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, BOB_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, true);
                    if (r.permitted) {
                        strict_1.default.equal(r.role, "member");
                        strict_1.default.equal(r.creatorId, BOB_ID);
                    }
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G. permitted when owner edits another member's item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, BOB_ID)], [membership(TRIP_ID, ALICE_ID, "owner")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, ALICE_ID)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, true);
                    if (r.permitted)
                        strict_1.default.equal(r.role, "owner");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("H. ownerOnly=true: forbidden for member even editing their own item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, BOB_ID)], [membership(TRIP_ID, BOB_ID, "member")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, BOB_ID, true)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, false);
                    strict_1.default.equal(r.code, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("I. ownerOnly=true: permitted for trip owner", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeMiniClient([planItem(ITEM_ID_1, TRIP_ID, BOB_ID)], [membership(TRIP_ID, ALICE_ID, "owner")]);
                    return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, TRIP_ID, ITEM_ID_1, ALICE_ID, true)];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.permitted, true);
                    if (r.permitted)
                        strict_1.default.equal(r.role, "owner");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── DELETE /plan/items/:itemId — REST soft-delete permissions ─────────────────
(0, node_test_1.describe)("DELETE /api/trips/:tripId/plan/items/:itemId — permissions", function () {
    (0, node_test_1.it)("16. member cannot delete another member's item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d[CAROL_ID] = "member", _d));
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
                        title: "Bob item", category: "activity", status: "tentative",
                        source_type: "manual", source_id: null, day_date: null,
                        starts_at: null, ends_at: null, location_name: null, notes: null,
                        sort_order: 0, visibility: "members", removed_at: null,
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, del(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "carol-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("17. member can delete their own item (204)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r, dbItem;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, del(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "bob-tok")];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 204);
                    dbItem = s.trip_plan_items.find(function (i) { return i.id === ITEM_ID_1; });
                    strict_1.default.ok(dbItem.removed_at, "removed_at should be set after DELETE");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("18. owner can delete any member's item (204)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, del(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), "alice-tok")];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 204);
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── PATCH /remove — additional permission scenarios ───────────────────────────
(0, node_test_1.describe)("PATCH /remove — additional permission scenarios", function () {
    (0, node_test_1.it)("19. member cannot remove another member's item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[BOB_ID] = "member", _d[CAROL_ID] = "member", _d));
                    s.trip_plan_items.push({
                        id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
                        title: "Bob item", category: "activity", status: "tentative",
                        source_type: "manual", source_id: null, day_date: null,
                        starts_at: null, ends_at: null, location_name: null, notes: null,
                        sort_order: 0, visibility: "members", removed_at: null,
                        created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
                    });
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/remove"), "carol-tok")];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("20. owner can remove any member's item (200)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/remove"), "alice-tok")];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 200);
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /reorder — owner-only enforcement ────────────────────────────────────
(0, node_test_1.describe)("POST /plan/items/:itemId/reorder — owner-only", function () {
    (0, node_test_1.it)("21. member cannot reorder items (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/reorder"), "bob-tok", { sortOrder: 2000 })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 403);
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("22. owner can reorder any item (200)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithItem(BOB_ID);
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/reorder"), "alice-tok", { sortOrder: 5000 })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.sortOrder, 5000);
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 23-27. Invited (pending) member cannot mutate plan ────────────────────────
// The server already enforces this via isAcceptedTripMember / canEditPlanItem
// (both check role IN ('owner','member')), but these tests make it explicit.
(0, node_test_1.describe)("Invited member blocked from plan mutations", function () {
    var INVITED_TOK = "carol-tok";
    function stateWithInvitedAndItem() {
        var _c;
        var s = stateWithMembers((_c = {}, _c[ALICE_ID] = "owner", _c[BOB_ID] = "member", _c[CAROL_ID] = "invited", _c));
        s.trip_plan_items.push({
            id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
            title: "Existing item", category: "activity", status: "tentative",
            source_type: "manual", source_id: null, day_date: null,
            starts_at: null, ends_at: null, location_name: null, notes: null,
            sort_order: 0, visibility: "members", removed_at: null,
            created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
        });
        return s;
    }
    (0, node_test_1.it)("23. invited member cannot POST a new plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        var _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    s = stateWithMembers((_d = {}, _d[ALICE_ID] = "owner", _d[CAROL_ID] = "invited", _d));
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _e.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items"), INVITED_TOK, { title: "Sneak Add" })];
                case 2:
                    r = _e.sent();
                    strict_1.default.equal(r.status, 403, "invited member must not be able to add plan items");
                    return [4 /*yield*/, close()];
                case 3:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("24. invited member cannot PATCH an existing plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithInvitedAndItem();
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), INVITED_TOK, { title: "Hijacked" })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 403, "invited member must not be able to edit plan items");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("25. invited member cannot DELETE a plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithInvitedAndItem();
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, del(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1), INVITED_TOK)];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 403, "invited member must not be able to delete plan items");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("26. invited member cannot soft-remove a plan item (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithInvitedAndItem();
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, patch(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/remove"), INVITED_TOK)];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 403, "invited member must not be able to remove plan items");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("27. invited member cannot reorder plan items (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, _c, port, close, r;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    s = stateWithInvitedAndItem();
                    return [4 /*yield*/, startServer(s)];
                case 1:
                    _c = _d.sent(), port = _c.port, close = _c.close;
                    return [4 /*yield*/, post(port, "/api/trips/".concat(TRIP_ID, "/plan/items/").concat(ITEM_ID_1, "/reorder"), INVITED_TOK, { sortOrder: 999 })];
                case 2:
                    r = _d.sent();
                    strict_1.default.equal(r.status, 403, "invited member must not be able to reorder plan items");
                    return [4 /*yield*/, close()];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
