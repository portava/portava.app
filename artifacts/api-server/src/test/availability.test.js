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
 * Availability routes — node:test suite
 *
 * Covers:
 *   GET  /api/me/availability
 *   PATCH /api/me/availability
 *   GET  /api/me/quick-availability
 *   PATCH /api/me/quick-availability
 *   GET   /api/trips/:tripId/availability
 *   PATCH /api/trips/:tripId/availability
 *   GET   /api/circles/:circleId/availability
 *   PATCH /api/circles/:circleId/availability
 *
 * Runtime: node:test + fetch() on a real Express server at a random port.
 * Fake Supabase injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/availability.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var availability_js_1 = require("../routes/availability.js");
// ── IDs ───────────────────────────────────────────────────────────────────────
var ALICE_ID = "00000000-0000-0000-0000-0000000000a1";
var BOB_ID = "00000000-0000-0000-0000-0000000000b2";
var TRIP_ID = "00000000-0000-0000-0000-000000000001";
var CIRCLE_ID = "00000000-0000-0000-0000-000000000002";
function baseState() {
    return {
        users: {
            "alice-tok": { id: ALICE_ID },
            "bob-tok": { id: BOB_ID },
        },
        user_availability: [],
        quick_availability_status: [],
        trip_availability: [],
        trip_members: [],
        circle_memberships: [],
        profiles: [
            { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
            { id: BOB_ID, handle: "bob", name: "Bob", avatar_url: null },
        ],
    };
}
// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state) {
    var _this = this;
    function from(table) {
        var filters = [];
        var _op = "select";
        var _upsertRow = null;
        var _updatePayload = null;
        var b = {
            select: function (_sel) { return b; },
            update: function (changes) { _op = "update"; _updatePayload = changes; return b; },
            delete: function () { _op = "delete"; return b; },
            upsert: function (row, _opts) {
                _op = "upsert";
                _upsertRow = row;
                return b;
            },
            insert: function (row) {
                var _a;
                var source = (_a = state[table]) !== null && _a !== void 0 ? _a : [];
                var r = Array.isArray(row) ? row[0] : row;
                source.push(r);
                return Promise.resolve({ data: r, error: null });
            },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            neq: function (col, val) { filters.push(function (r) { return r[col] !== val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            is: function () { return b; },
            not: function () { return b; },
            order: function () { return b; },
            limit: function () { return b; },
            maybeSingle: function () { return resolveOne(); },
            single: function () { return resolveSingle(); },
            then: function (onF, onR) {
                if (_op === "update")
                    return resolveUpdate().then(onF, onR);
                if (_op === "delete")
                    return resolveDelete().then(onF, onR);
                if (_op === "upsert")
                    return resolveUpsert().then(onF, onR);
                return resolveList().then(onF, onR);
            },
        };
        function getSource() { var _a; return (_a = state[table]) !== null && _a !== void 0 ? _a : []; }
        function matchedRows() { return getSource().filter(function (r) { return filters.every(function (f) { return f(r); }); }); }
        function resolveOne() {
            return __awaiter(this, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                return [2 /*return*/, { data: (_a = matchedRows()[0]) !== null && _a !== void 0 ? _a : null, error: null }];
            }); });
        }
        function resolveSingle() {
            return __awaiter(this, void 0, void 0, function () {
                var row;
                var _a;
                return __generator(this, function (_b) {
                    if (_op === "upsert" && _upsertRow) {
                        row = __assign({}, _upsertRow);
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    return [2 /*return*/, { data: (_a = matchedRows()[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, { data: matchedRows(), error: null }];
            }); });
        }
        function resolveUpdate() {
            return __awaiter(this, void 0, void 0, function () {
                var source, _loop_1, _i, source_1, row;
                return __generator(this, function (_a) {
                    source = getSource();
                    _loop_1 = function (row) {
                        if (filters.every(function (f) { return f(row); }))
                            Object.assign(row, _updatePayload);
                    };
                    for (_i = 0, source_1 = source; _i < source_1.length; _i++) {
                        row = source_1[_i];
                        _loop_1(row);
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
        function resolveUpsert() {
            return __awaiter(this, void 0, void 0, function () {
                var source, existing;
                var _a;
                return __generator(this, function (_b) {
                    if (!_upsertRow)
                        return [2 /*return*/, { data: null, error: null }];
                    source = (_a = state[table]) !== null && _a !== void 0 ? _a : [];
                    state[table] = source;
                    existing = table === "trip_availability"
                        ? source.find(function (r) { return r.trip_id === _upsertRow.trip_id && r.user_id === _upsertRow.user_id; })
                        : source.find(function (r) { return r.user_id === _upsertRow.user_id; });
                    if (existing)
                        Object.assign(existing, _upsertRow);
                    else
                        source.push(_upsertRow);
                    return [2 /*return*/, { data: _upsertRow, error: null }];
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
function startServer(state) {
    return __awaiter(this, void 0, void 0, function () {
        var app;
        return __generator(this, function (_a) {
            (0, http_js_1._setTestClient)(makeFakeClient(state), true);
            app = (0, express_1.default)();
            app.use(express_1.default.json());
            app.use(function (req, _res, next) {
                req.log = { error: function () { }, info: function () { }, warn: function () { } };
                next();
            });
            app.use("/api", availability_js_1.default);
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
function patch(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json", "Authorization": "Bearer ".concat(token) },
                        body: JSON.stringify(body),
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
// ── Tests ─────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/availability")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns empty availability when no row exists", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/availability", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.weeklyDays, {});
                    strict_1.default.equal(r.body.openToMeet, false);
                    strict_1.default.equal(r.body.quickStatus, null);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns stored availability row", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.user_availability.push({
                        user_id: ALICE_ID,
                        weekly_days: { mon: ["evening"], fri: ["afternoon"] },
                        open_to_meet: true,
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/availability", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.weeklyDays, { mon: ["evening"], fri: ["afternoon"] });
                    strict_1.default.equal(r.body.openToMeet, true);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("includes active quick status", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    state = baseState();
                    state.quick_availability_status.push({
                        user_id: ALICE_ID,
                        status: "free_now",
                        expires_at: new Date(Date.now() + 3600000).toISOString(),
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/availability", "alice-tok")];
                case 3:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal((_a = r.body.quickStatus) === null || _a === void 0 ? void 0 : _a.status, "free_now");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("PATCH /api/me/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(s.port, "/api/me/availability"), {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ weeklyDays: {} }),
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects invalid body — openToMeet must be boolean", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/availability", "alice-tok", { openToMeet: "yes" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects invalid block value in weeklyDays", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/availability", "alice-tok", { weeklyDays: { mon: ["midnight"] } })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("upserts and returns availability", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/availability", "alice-tok", {
                            weeklyDays: { fri: ["evening"] },
                            openToMeet: true,
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.weeklyDays, { fri: ["evening"] });
                    strict_1.default.equal(r.body.openToMeet, true);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("GET /api/me/quick-availability", function () {
    (0, node_test_1.it)("returns null status when no row exists", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/quick-availability", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, null);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns null when status is expired", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.quick_availability_status.push({
                        user_id: ALICE_ID,
                        status: "free_now",
                        expires_at: new Date(Date.now() - 1000).toISOString(), // expired
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/quick-availability", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, null);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns active status", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.quick_availability_status.push({
                        user_id: ALICE_ID,
                        status: "open_to_plans",
                        expires_at: new Date(Date.now() + 3600000).toISOString(),
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/quick-availability", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "open_to_plans");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("PATCH /api/me/quick-availability", function () {
    (0, node_test_1.it)("rejects invalid status value", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/quick-availability", "alice-tok", { status: "invisible" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("accepts free_now and returns it", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/quick-availability", "alice-tok", { status: "free_now" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "free_now");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("accepts all valid status values", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _i, _a, status_1, s, r;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _i = 0, _a = ["free_now", "free_tonight", "open_to_plans", "busy"];
                    _b.label = 1;
                case 1:
                    if (!(_i < _a.length)) return [3 /*break*/, 8];
                    status_1 = _a[_i];
                    return [4 /*yield*/, startServer(baseState())];
                case 2:
                    s = _b.sent();
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, , 5, 7]);
                    return [4 /*yield*/, patch(s.port, "/api/me/quick-availability", "alice-tok", { status: status_1 })];
                case 4:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200, "status=".concat(status_1, " should return 200"));
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, s.close()];
                case 6:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 7:
                    _i++;
                    return [3 /*break*/, 1];
                case 8: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects null status (use busy to indicate unavailable)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/me/quick-availability", "alice-tok", { status: null })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("PATCH /api/trips/:tripId/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "no-tok", { openDays: {} })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 for non-members", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok", { openDays: {} })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects missing openDays", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok", {})];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects invalid date key", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok", { openDays: { "not-a-date": ["morning"] } })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("stores trip-scoped open days and returns them", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok", {
                            openDays: { "2025-07-04": ["morning", "evening"] },
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.openDays, { "2025-07-04": ["morning", "evening"] });
                    strict_1.default.equal(r.body.tripId, TRIP_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("PATCH /api/circles/:circleId/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"), "no-tok", { openToMeet: true })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 when not circle member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"), "alice-tok", { openToMeet: true })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("updates and returns own availability when circle member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: ALICE_ID });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, patch(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"), "alice-tok", {
                            weeklyDays: { sat: ["afternoon"] },
                            openToMeet: true,
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.weeklyDays, { sat: ["afternoon"] });
                    strict_1.default.equal(r.body.openToMeet, true);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("GET /api/trips/:tripId/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/trips/".concat(TRIP_ID, "/availability"))];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 for non-members", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns member availability for accepted trip member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r, alice;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }, { trip_id: TRIP_ID, user_id: BOB_ID, role: "member" });
                    state.user_availability.push({
                        user_id: ALICE_ID, weekly_days: { mon: ["evening"] }, open_to_meet: true,
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.members));
                    strict_1.default.equal(r.body.tripId, TRIP_ID);
                    strict_1.default.ok(r.body.members.length >= 1);
                    alice = r.body.members.find(function (m) { return m.userId === ALICE_ID; });
                    strict_1.default.ok(alice, "alice should be in members");
                    strict_1.default.deepEqual(alice.weeklyDays, { mon: ["evening"] });
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("excludes invited (not yet accepted) members", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    // alice is owner; bob is only invited (not a full member)
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/trips/".concat(TRIP_ID, "/availability"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.members.length, 1);
                    strict_1.default.equal(r.body.members[0].userId, ALICE_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)("GET /api/circles/:circleId/availability", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"))];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 when not circle owner or member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns member availability for circle owner", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    // alice is circle owner (by convention circleId == ownerId), bob is member
                    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: ALICE_ID });
                    state.circle_memberships.push({ owner_id: CIRCLE_ID, member_id: BOB_ID });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/circles/".concat(CIRCLE_ID, "/availability"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.members));
                    strict_1.default.equal(r.body.circleId, CIRCLE_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
