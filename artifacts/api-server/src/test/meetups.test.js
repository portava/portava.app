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
 * Meetup routes — node:test suite
 *
 * Covers:
 *   POST   /api/meetups                                  — create
 *   GET    /api/meetups/:meetupId                        — detail + access gates
 *   PATCH  /api/meetups/:meetupId                        — update (creator only)
 *   DELETE /api/meetups/:meetupId                        — cancel (creator only)
 *   POST   /api/meetups/:meetupId/invite                 — invite users
 *   POST   /api/meetups/:meetupId/rsvp                   — RSVP
 *   POST   /api/meetups/:meetupId/time-options           — add option (creator)
 *   POST   /api/meetups/:meetupId/time-options/:id/vote  — vote
 *   POST   /api/meetups/:meetupId/time-options/:id/confirm — confirm time
 *   POST   /api/meetups/:meetupId/add-to-trip-plan       — add to trip plan
 *   GET    /api/me/meetup-invites                        — own pending invites
 *
 * Runtime: node:test + fetch() on a real Express server at a random port.
 * Fake Supabase injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/meetups.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var meetups_js_1 = require("../routes/meetups.js");
// ── IDs ───────────────────────────────────────────────────────────────────────
var ALICE_ID = "00000000-0000-0000-0000-0000000000a1";
var BOB_ID = "00000000-0000-0000-0000-0000000000b2";
var MEETUP_ID = "00000000-0000-0000-0000-000000000001";
var TRIP_ID = "00000000-0000-0000-0000-000000000002";
var OPT_ID = "00000000-0000-0000-0000-000000000003";
var CIRCLE_ID = "00000000-0000-0000-0000-000000000004";
var NOW = new Date().toISOString();
// ── Row factories ─────────────────────────────────────────────────────────────
function makeMeetup(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return __assign({ id: MEETUP_ID, creator_id: ALICE_ID, title: "Test meetup", description: null, location_name: "Somewhere", approximate_date: null, time_block: null, starts_at: null, ends_at: null, status: "active", trip_id: null, circle_owner_id: null, visibility: "invitees", chat_thread_id: null, chat_message_id: null, created_at: NOW, updated_at: NOW }, overrides);
}
function makeTimeOption(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return __assign({ id: OPT_ID, meetup_id: MEETUP_ID, proposed_date: "2026-08-01", time_block: "evening", label: null, confirmed: false, created_at: NOW }, overrides);
}
function baseState(overrides) {
    if (overrides === void 0) { overrides = {}; }
    return __assign({ users: {
            "alice-tok": { id: ALICE_ID },
            "bob-tok": { id: BOB_ID },
        }, meetups: [], meetup_invites: [], meetup_time_options: [], meetup_time_votes: [], trip_members: [], circle_memberships: [], trip_plan_items: [], user_friendships: [], profiles: [
            { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
            { id: BOB_ID, handle: "bob", name: "Bob", avatar_url: null },
        ], message_threads: [] }, overrides);
}
// ── Fake Supabase ─────────────────────────────────────────────────────────────
function makeFakeClient(state) {
    var _this = this;
    var insertedRow = null;
    var upsertedRow = null;
    function from(table) {
        var filters = [];
        var _op = "select";
        var _pendingInsert = null;
        var _pendingUpdate = null;
        var _pendingUpsert = null;
        var b = {
            select: function (_sel) { return b; },
            insert: function (row) {
                _op = "insert";
                _pendingInsert = Array.isArray(row) ? row[0] : row;
                return b;
            },
            update: function (patch) { _op = "update"; _pendingUpdate = patch; return b; },
            delete: function () { _op = "delete"; return b; },
            upsert: function (row, _opts) {
                _op = "upsert";
                _pendingUpsert = Array.isArray(row) ? row[0] : row;
                return b;
            },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            neq: function (col, val) { filters.push(function (r) { return r[col] !== val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            is: function () { return b; },
            not: function () { return b; },
            or: function () { return b; },
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
        function matched() { return getSource().filter(function (r) { return filters.every(function (f) { return f(r); }); }); }
        function resolveOne() {
            return __awaiter(this, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                return [2 /*return*/, { data: (_a = matched()[0]) !== null && _a !== void 0 ? _a : null, error: null }];
            }); });
        }
        function resolveSingle() {
            return __awaiter(this, void 0, void 0, function () {
                var row, source, existing;
                var _a;
                return __generator(this, function (_b) {
                    if (_op === "insert" && _pendingInsert) {
                        row = __assign({ id: "gen-".concat(table, "-").concat(Date.now()) }, (_pendingInsert));
                        getSource().push(row);
                        insertedRow = row;
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    if (_op === "upsert" && _pendingUpsert) {
                        source = getSource();
                        existing = source.find(function (r) { return filters.every(function (f) { return f(r); }); });
                        if (existing) {
                            Object.assign(existing, _pendingUpsert);
                            return [2 /*return*/, { data: existing, error: null }];
                        }
                        source.push(_pendingUpsert);
                        return [2 /*return*/, { data: _pendingUpsert, error: null }];
                    }
                    return [2 /*return*/, { data: (_a = matched()[0]) !== null && _a !== void 0 ? _a : null, error: null }];
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
                var _loop_1, _i, _a, row;
                return __generator(this, function (_b) {
                    _loop_1 = function (row) {
                        if (filters.every(function (f) { return f(row); }))
                            Object.assign(row, _pendingUpdate);
                    };
                    for (_i = 0, _a = getSource(); _i < _a.length; _i++) {
                        row = _a[_i];
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
                return __generator(this, function (_a) {
                    if (!_pendingUpsert)
                        return [2 /*return*/, { data: null, error: null }];
                    source = getSource();
                    existing = source.find(function (r) { return filters.every(function (f) { return f(r); }); });
                    if (existing) {
                        Object.assign(existing, _pendingUpsert);
                        return [2 /*return*/, { data: existing, error: null }];
                    }
                    source.push(_pendingUpsert);
                    upsertedRow = _pendingUpsert;
                    return [2 /*return*/, { data: _pendingUpsert, error: null }];
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
            app.use("/api", meetups_js_1.default);
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
function httpPost(port, path, token, body) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": "Bearer ".concat(token) },
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
function httpDelete(port, path, token) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, fetch("http://127.0.0.1:".concat(port).concat(path), {
                        method: "DELETE",
                        headers: { "Authorization": "Bearer ".concat(token) },
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
// ── POST /api/meetups ─────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/meetups", function () {
    (0, node_test_1.it)("rejects unauthenticated requests", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(s.port, "/api/meetups"), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ title: "Test" }),
                        })];
                case 3:
                    res = _a.sent();
                    strict_1.default.equal(res.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects missing title", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups", "alice-tok", { description: "no title" })];
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
    (0, node_test_1.it)("rejects title over 200 chars", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups", "alice-tok", { title: "x".repeat(201) })];
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
    (0, node_test_1.it)("creates a basic invitee-scoped meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup()] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups", "alice-tok", {
                            title: "Rooftop drinks",
                            locationName: "Top floor",
                            visibility: "invitees",
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.ok(r.body.id);
                    strict_1.default.ok(r.body.title);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects trip meetup if not a trip member", function () { return __awaiter(void 0, void 0, void 0, function () {
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
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups", "alice-tok", {
                            title: "Trip meetup",
                            tripId: TRIP_ID,
                            visibility: "trip",
                        })];
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
    (0, node_test_1.it)("creates trip meetup when user is trip owner", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
                        meetups: [makeMeetup({ trip_id: TRIP_ID, visibility: "trip" })],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups", "alice-tok", {
                            title: "Trip meetup",
                            tripId: TRIP_ID,
                            visibility: "trip",
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
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
// ── GET /api/meetups/:meetupId ────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/meetups/:meetupId", function () {
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
                    return [4 /*yield*/, get(s.port, "/api/meetups/".concat(MEETUP_ID))];
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
    (0, node_test_1.it)("returns 404 when meetup not found", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns meetup for creator", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [],
                        meetup_time_options: [],
                        meetup_time_votes: [],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.id, MEETUP_ID);
                    strict_1.default.equal(r.body.isCreator, true);
                    strict_1.default.ok(Array.isArray(r.body.timeOptions));
                    strict_1.default.ok(r.body.counts);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns meetup for direct invitee", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup({ creator_id: BOB_ID })],
                        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
                        meetup_time_options: [],
                        meetup_time_votes: [],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.isCreator, false);
                    strict_1.default.equal(r.body.myRsvp, "pending");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns time options with vote tallies", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r, opt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [],
                        meetup_time_options: [makeTimeOption()],
                        meetup_time_votes: [
                            { option_id: OPT_ID, user_id: ALICE_ID, vote: "yes" },
                            { option_id: OPT_ID, user_id: BOB_ID, vote: "maybe" },
                        ],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.timeOptions.length, 1);
                    opt = r.body.timeOptions[0];
                    strict_1.default.equal(opt.votes.yes, 1);
                    strict_1.default.equal(opt.votes.maybe, 1);
                    strict_1.default.equal(opt.votes.no, 0);
                    strict_1.default.equal(opt.votes.myVote, "yes"); // alice voted yes
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
// ── DELETE /api/meetups/:meetupId ─────────────────────────────────────────────
(0, node_test_1.describe)("DELETE /api/meetups/:meetupId", function () {
    (0, node_test_1.it)("returns 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, fetch("http://127.0.0.1:".concat(s.port, "/api/meetups/").concat(MEETUP_ID), { method: "DELETE" })];
                case 3:
                    res = _a.sent();
                    strict_1.default.equal(res.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 when non-creator tries to cancel", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup({ creator_id: BOB_ID })] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpDelete(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
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
    (0, node_test_1.it)("creator can cancel meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: BOB_ID, status: "pending" }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpDelete(s.port, "/api/meetups/".concat(MEETUP_ID), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "cancelled");
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
// ── POST /api/meetups/:meetupId/rsvp ─────────────────────────────────────────
(0, node_test_1.describe)("POST /api/meetups/:meetupId/rsvp", function () {
    (0, node_test_1.it)("rejects invalid status", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/rsvp"), "alice-tok", { status: "attending" })];
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
    (0, node_test_1.it)("creator can RSVP going", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/rsvp"), "alice-tok", { status: "going" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "going");
                    strict_1.default.ok(r.body.counts);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("invitee can RSVP maybe", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup({ creator_id: BOB_ID })],
                        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/rsvp"), "alice-tok", { status: "maybe" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "maybe");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 404 for unknown meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/rsvp"), "alice-tok", { status: "going" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
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
// ── POST /api/meetups/:meetupId/time-options ──────────────────────────────────
(0, node_test_1.describe)("POST /api/meetups/:meetupId/time-options", function () {
    (0, node_test_1.it)("rejects non-creator", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup({ creator_id: BOB_ID })] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options"), "alice-tok", { proposedDate: "2026-08-01" })];
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
    (0, node_test_1.it)("rejects bad date format", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup()] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options"), "alice-tok", { proposedDate: "not-a-date" })];
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
    (0, node_test_1.it)("rejects missing proposedDate", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup()] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options"), "alice-tok", { timeBlock: "evening" })];
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
    (0, node_test_1.it)("creates time option for creator", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_time_options: [makeTimeOption()],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options"), "alice-tok", {
                            proposedDate: "2026-08-01",
                            timeBlock: "evening",
                        })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.proposedDate, "2026-08-01");
                    strict_1.default.equal(r.body.timeBlock, "evening");
                    strict_1.default.equal(r.body.confirmed, false);
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
// ── POST /api/meetups/:meetupId/time-options/:optionId/vote ───────────────────
(0, node_test_1.describe)("POST /api/meetups/:id/time-options/:optId/vote", function () {
    (0, node_test_1.it)("rejects invalid vote value", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [],
                        meetup_time_options: [makeTimeOption()],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options/").concat(OPT_ID, "/vote"), "alice-tok", { vote: "unsure" })];
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
    (0, node_test_1.it)("creator can vote yes on own meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup()],
                        meetup_invites: [],
                        meetup_time_options: [makeTimeOption()],
                        meetup_time_votes: [{ option_id: OPT_ID, user_id: ALICE_ID, vote: "yes" }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options/").concat(OPT_ID, "/vote"), "alice-tok", { vote: "yes" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.optionId, OPT_ID);
                    strict_1.default.ok("yes" in r.body.votes);
                    strict_1.default.ok("maybe" in r.body.votes);
                    strict_1.default.ok("no" in r.body.votes);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("invitee can vote maybe", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetups: [makeMeetup({ creator_id: BOB_ID })],
                        meetup_invites: [{ id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID, status: "pending" }],
                        meetup_time_options: [makeTimeOption()],
                        meetup_time_votes: [{ option_id: OPT_ID, user_id: ALICE_ID, vote: "maybe" }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/time-options/").concat(OPT_ID, "/vote"), "alice-tok", { vote: "maybe" })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.votes.maybe, 1);
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
// ── POST /api/meetups/:meetupId/add-to-trip-plan ──────────────────────────────
(0, node_test_1.describe)("POST /api/meetups/:meetupId/add-to-trip-plan", function () {
    (0, node_test_1.it)("rejects missing tripId body", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", {})];
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
    (0, node_test_1.it)("rejects non-trip-members", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({ meetups: [makeMeetup()] });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
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
    (0, node_test_1.it)("rejects when meetup is scoped to a different trip", function () { return __awaiter(void 0, void 0, void 0, function () {
        var OTHER_TRIP, state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    OTHER_TRIP = "00000000-0000-0000-0000-000000000099";
                    state = baseState({
                        trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
                        meetups: [makeMeetup({ trip_id: OTHER_TRIP, visibility: "trip" })],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
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
    (0, node_test_1.it)("creates plan item for trip owner", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
                        meetups: [makeMeetup()],
                        trip_plan_items: [],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.tripId, TRIP_ID);
                    strict_1.default.equal(r.body.meetupId, MEETUP_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("idempotent — returns 200 with idempotent flag if already added", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner" }],
                        meetups: [makeMeetup()],
                        trip_plan_items: [{
                                id: "plan-1", trip_id: TRIP_ID, source_type: "meetup", source_id: MEETUP_ID,
                                title: "Test meetup", removed_at: null,
                            }],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, httpPost(s.port, "/api/meetups/".concat(MEETUP_ID, "/add-to-trip-plan"), "alice-tok", { tripId: TRIP_ID })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.idempotent, true);
                    strict_1.default.equal(r.body.message, "already_added");
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
// ── GET /api/me/meetup-invites ────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/meetup-invites", function () {
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
                    return [4 /*yield*/, get(s.port, "/api/me/meetup-invites")];
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
    (0, node_test_1.it)("returns empty list when no invites", function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/meetup-invites", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.invites, []);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, s.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns pending invite with meetup info", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, s, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState({
                        meetup_invites: [{
                                id: "inv-1", meetup_id: MEETUP_ID, user_id: ALICE_ID,
                                status: "pending", invited_at: NOW,
                            }],
                        meetups: [makeMeetup({ creator_id: BOB_ID })],
                    });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    s = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(s.port, "/api/me/meetup-invites", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.invites));
                    strict_1.default.equal(r.body.invites.length, 1);
                    strict_1.default.equal(r.body.invites[0].meetupId, MEETUP_ID);
                    strict_1.default.equal(r.body.invites[0].status, "pending");
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
