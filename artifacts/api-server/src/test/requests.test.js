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
 * Integration tests for the unified Request Inbox routes.
 *
 * Covers:
 *  - GET  /api/me/requests       — all-status list (friend, circle, trip)
 *  - GET  /api/me/requests/count — incoming-pending badge count
 *  - POST /api/me/requests/friend_request/:id/accept|decline|cancel
 *  - POST /api/me/requests/circle_invite/:id/accept|decline
 *  - POST /api/me/requests/trip_invite/:tripId/accept|decline|cancel
 *  - Count transitions after each action type
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest needed).
 * A real Express server starts on a random port per test; fetch() issues HTTP calls.
 * The fake Supabase client is injected via http.ts's _setTestClient test slot.
 *
 * Run: node --import tsx/esm --test src/test/requests.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var requests_js_1 = require("../routes/requests.js");
function baseState() {
    return {
        users: {
            "alice-tok": { id: ALICE_ID },
            "bob-tok": { id: BOB_ID },
            "carol-tok": { id: CAROL_ID },
        },
        friend_requests: [],
        circle_invites: [],
        trip_members: [],
        trips: [],
        profiles: [
            { id: ALICE_ID, handle: "alice", name: "Alice", avatar_url: null },
            { id: BOB_ID, handle: "bob", name: "Bob", avatar_url: null },
            { id: CAROL_ID, handle: "carol", name: "Carol", avatar_url: null },
        ],
        user_friendships: [],
        circle_memberships: [],
    };
}
// ── Fake Supabase client ──────────────────────────────────────────────────────
// Supports select/update/delete/upsert with mutable in-memory state.
function makeFakeClient(state) {
    var _this = this;
    function from(table) {
        var filters = [];
        var _op = "select";
        var _updatePayload = null;
        var b = {
            select: function (_sel) { return b; },
            update: function (changes) { _op = "update"; _updatePayload = changes; return b; },
            delete: function () { _op = "delete"; return b; },
            upsert: function (row) {
                var source = state[table];
                if (!source) {
                    source = [];
                    state[table] = source;
                }
                source.push(row);
                return Promise.resolve({ data: null, error: null });
            },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            order: function () { return b; },
            limit: function () { return b; },
            maybeSingle: function () { return resolveOne(); },
            single: function () { return resolveOne(); },
            then: function (onF, onR) {
                if (_op === "update")
                    return resolveUpdate().then(onF, onR);
                if (_op === "delete")
                    return resolveDelete().then(onF, onR);
                return resolveList().then(onF, onR);
            },
        };
        function getSource() {
            var _a;
            return (_a = state[table]) !== null && _a !== void 0 ? _a : [];
        }
        function matchedRows() {
            return getSource().filter(function (r) { return filters.every(function (f) { return f(r); }); });
        }
        function resolveOne() {
            return __awaiter(this, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                return [2 /*return*/, { data: (_a = matchedRows()[0]) !== null && _a !== void 0 ? _a : null, error: null }];
            }); });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/, { data: matchedRows(), error: null }];
            }); });
        }
        function resolveUpdate() {
            return __awaiter(this, void 0, void 0, function () {
                var _loop_1, _i, _a, row;
                return __generator(this, function (_b) {
                    _loop_1 = function (row) {
                        if (filters.every(function (f) { return f(row); }))
                            Object.assign(row, _updatePayload);
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
    app.use("/api", requests_js_1.default);
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
var T1 = "2026-06-01T00:00:00Z";
var T2 = "2026-06-02T00:00:00Z"; // newer
// All IDs must be valid UUIDs — isUuid() guards are present in the cancel route
var ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
var BOB_ID = "bbbbbbbb-0000-0000-0000-000000000002";
var CAROL_ID = "cccccccc-0000-0000-0000-000000000003";
var FR_ID = "11111111-0000-0000-0000-000000000001";
var CI_ID = "22222222-0000-0000-0000-000000000002";
var TRIP_ID = "33333333-0000-0000-0000-000000000003";
// ── GET /api/me/requests ──────────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/requests", function () {
    (0, node_test_1.it)("returns 401 without auth token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    strict_1.default.equal(r.body.error, "unauthenticated");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 401 with an invalid token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "bad-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns empty items array when no requests exist", function () { return __awaiter(void 0, void 0, void 0, function () {
        var srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.items));
                    strict_1.default.equal(r.body.items.length, 0);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("surfaces an incoming friend request for the recipient", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, item;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 1);
                    item = r.body.items[0];
                    strict_1.default.equal(item.type, "friend_request");
                    strict_1.default.equal(item.direction, "incoming");
                    strict_1.default.equal(item.id, FR_ID);
                    strict_1.default.equal((_a = item.actor) === null || _a === void 0 ? void 0 : _a.handle, "bob");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("surfaces an outgoing friend request for the requester", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items[0].direction, "outgoing");
                    strict_1.default.equal((_a = r.body.items[0].actor) === null || _a === void 0 ? void 0 : _a.handle, "bob");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns incoming circle invite for the recipient", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items[0].type, "circle_invite");
                    strict_1.default.equal(r.body.items[0].direction, "incoming");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns incoming trip invite with trip name and owner as actor", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, item;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali Adventure" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "owner", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    item = r.body.items[0];
                    strict_1.default.equal(item.type, "trip_invite");
                    strict_1.default.equal(item.direction, "incoming");
                    strict_1.default.equal(item.targetName, "Bali Adventure");
                    strict_1.default.equal((_a = item.actor) === null || _a === void 0 ? void 0 : _a.handle, "bob");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns accepted friend request — all statuses included", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "accepted", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 1);
                    strict_1.default.equal(r.body.items[0].status, "accepted");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns outgoing trip invite for trip owner (actor = invitee)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, item;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Tokyo Run" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", created_at: T1 });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 1);
                    item = r.body.items[0];
                    strict_1.default.equal(item.type, "trip_invite");
                    strict_1.default.equal(item.direction, "outgoing");
                    strict_1.default.equal(item.targetName, "Tokyo Run");
                    strict_1.default.equal((_a = item.actor) === null || _a === void 0 ? void 0 : _a.handle, "bob");
                    strict_1.default.ok(item.id.includes(TRIP_ID), "compound id includes tripId");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _b.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("sorts items globally newest-first", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T2 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.items.length, 2);
                    strict_1.default.equal(r.body.items[0].type, "circle_invite", "newer circle invite comes first");
                    strict_1.default.equal(r.body.items[1].type, "friend_request", "older friend request comes second");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── GET /api/me/requests/count ────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/requests/count", function () {
    (0, node_test_1.it)("returns 401 without auth token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns count 0 when no incoming requests", function () { return __awaiter(void 0, void 0, void 0, function () {
        var srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, startServer(baseState())];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.count, 0);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("counts all incoming pending types", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    state.trips.push({ id: TRIP_ID, title: "Trip" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.count, 3);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("does not count outgoing requests in the badge count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.count, 0);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/friend_request/:id/accept ───────────────────────────────
(0, node_test_1.describe)("POST /me/requests/friend_request/:id/accept", function () {
    (0, node_test_1.it)("recipient accepts → status becomes accepted and friendship is created", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "friends");
                    strict_1.default.equal(state.friend_requests[0].status, "accepted", "status mutated in state");
                    strict_1.default.equal(state.user_friendships.length, 1, "friendship row created");
                    strict_1.default.equal(state.user_friendships[0].accepted_request_id, FR_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("requester cannot accept their own request (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.friend_requests[0].status, "pending", "status unchanged");
                    strict_1.default.equal(state.user_friendships.length, 0, "no friendship created");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("cannot accept an already-accepted request (400)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "accepted", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/friend_request/:id/decline ─────────────────────────────
(0, node_test_1.describe)("POST /me/requests/friend_request/:id/decline", function () {
    (0, node_test_1.it)("recipient declines → status becomes declined", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "declined");
                    strict_1.default.equal(state.friend_requests[0].status, "declined");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("requester cannot decline (only recipient can) → 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.friend_requests[0].status, "pending");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/friend_request/:id/cancel ──────────────────────────────
(0, node_test_1.describe)("POST /me/requests/friend_request/:id/cancel", function () {
    (0, node_test_1.it)("requester cancels → status becomes cancelled", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/cancel"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "cancelled");
                    strict_1.default.equal(state.friend_requests[0].status, "cancelled");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("recipient cannot cancel (only requester can) → 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/cancel"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.friend_requests[0].status, "pending");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/circle_invite/:id/accept ───────────────────────────────
(0, node_test_1.describe)("POST /me/requests/circle_invite/:id/accept", function () {
    (0, node_test_1.it)("recipient accepts → status accepted and circle_membership created", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "accepted");
                    strict_1.default.equal(r.body.ownerId, BOB_ID);
                    strict_1.default.equal(state.circle_invites[0].status, "accepted");
                    strict_1.default.equal(state.circle_memberships.length, 1, "membership created");
                    strict_1.default.equal(state.circle_memberships[0].owner_id, BOB_ID);
                    strict_1.default.equal(state.circle_memberships[0].member_id, ALICE_ID);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-recipient cannot accept (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.circle_memberships.length, 0);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/circle_invite/:id/cancel ───────────────────────────────
(0, node_test_1.describe)("POST /me/requests/circle_invite/:id/cancel", function () {
    (0, node_test_1.it)("owner cancels their outgoing invite → status becomes cancelled", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/cancel"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "cancelled");
                    strict_1.default.equal(state.circle_invites[0].status, "cancelled");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("recipient cannot cancel a circle invite they received (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/cancel"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.circle_invites[0].status, "pending");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/circle_invite/:id/decline ──────────────────────────────
(0, node_test_1.describe)("POST /me/requests/circle_invite/:id/decline", function () {
    (0, node_test_1.it)("recipient declines → status becomes declined", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "declined");
                    strict_1.default.equal(state.circle_invites[0].status, "declined");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("owner cannot decline their own invite (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: ALICE_ID, recipient_id: BOB_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(state.circle_invites[0].status, "pending");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/trip_invite/:tripId/accept ─────────────────────────────
(0, node_test_1.describe)("POST /me/requests/trip_invite/:tripId/accept", function () {
    (0, node_test_1.it)("invitee accepts → role becomes member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, tm;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "owner", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "member");
                    tm = state.trip_members.find(function (m) { return m.trip_id === TRIP_ID && m.user_id === ALICE_ID; });
                    strict_1.default.equal(tm === null || tm === void 0 ? void 0 : tm.role, "member", "role updated in state");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-invitee cannot accept (no row → 404)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    // alice is NOT a trip_member at all — carol is invited
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: CAROL_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/accept"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/trip_invite/:tripId/decline ────────────────────────────
(0, node_test_1.describe)("POST /me/requests/trip_invite/:tripId/decline", function () {
    (0, node_test_1.it)("invitee declines → trip_members row is deleted", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, remaining;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "declined");
                    remaining = state.trip_members.filter(function (m) { return m.trip_id === TRIP_ID && m.user_id === ALICE_ID; });
                    strict_1.default.equal(remaining.length, 0, "invite row deleted");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-invitee cannot decline (no row → 404)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/decline"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── POST /me/requests/trip_invite/:tripId/cancel ─────────────────────────────
(0, node_test_1.describe)("POST /me/requests/trip_invite/:tripId/cancel", function () {
    (0, node_test_1.it)("trip owner cancels invite → invitee row is deleted", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, remaining;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", created_at: T1 });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/cancel"), "alice-tok", { inviteeId: BOB_ID })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "cancelled");
                    remaining = state.trip_members.filter(function (m) { return m.trip_id === TRIP_ID && m.user_id === BOB_ID; });
                    strict_1.default.equal(remaining.length, 0, "invitee row deleted");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("non-owner cannot cancel a trip invite (403)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r, remaining;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    // alice is a member, not owner
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "member", created_at: T1 });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: BOB_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/cancel"), "alice-tok", { inviteeId: BOB_ID })];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    remaining = state.trip_members.filter(function (m) { return m.user_id === BOB_ID; });
                    strict_1.default.equal(remaining.length, 1, "invitee row untouched");
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("missing inviteeId returns 400", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 6]);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/cancel"), "alice-tok")];
                case 3:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, srv.close()];
                case 5:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    }); });
});
// ── Count transitions after actions ──────────────────────────────────────────
(0, node_test_1.describe)("count transitions after actions", function () {
    (0, node_test_1.it)("accepting a friend request removes it from the badge count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, before, after;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.friend_requests.push({ id: FR_ID, requester_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 6, 8]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    before = _a.sent();
                    strict_1.default.equal(before.body.count, 1);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/friend_request/".concat(FR_ID, "/accept"), "alice-tok")];
                case 4:
                    _a.sent();
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 5:
                    after = _a.sent();
                    strict_1.default.equal(after.body.count, 0, "badge drops to 0 after accept");
                    return [3 /*break*/, 8];
                case 6: return [4 /*yield*/, srv.close()];
                case 7:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 8: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("declining a circle invite removes it from the badge count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, before, after;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.circle_invites.push({ id: CI_ID, owner_id: BOB_ID, recipient_id: ALICE_ID, status: "pending", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 6, 8]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    before = _a.sent();
                    strict_1.default.equal(before.body.count, 1);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/circle_invite/".concat(CI_ID, "/decline"), "alice-tok")];
                case 4:
                    _a.sent();
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 5:
                    after = _a.sent();
                    strict_1.default.equal(after.body.count, 0, "badge drops to 0 after decline");
                    return [3 /*break*/, 8];
                case 6: return [4 /*yield*/, srv.close()];
                case 7:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 8: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("declining a trip invite removes it from the badge count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, srv, before, after;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = baseState();
                    state.trips.push({ id: TRIP_ID, title: "Bali" });
                    state.trip_members.push({ trip_id: TRIP_ID, user_id: ALICE_ID, role: "invited", created_at: T1 });
                    return [4 /*yield*/, startServer(state)];
                case 1:
                    srv = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 6, 8]);
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 3:
                    before = _a.sent();
                    strict_1.default.equal(before.body.count, 1);
                    return [4 /*yield*/, post(srv.port, "/api/me/requests/trip_invite/".concat(TRIP_ID, "/decline"), "alice-tok")];
                case 4:
                    _a.sent();
                    return [4 /*yield*/, get(srv.port, "/api/me/requests/count", "alice-tok")];
                case 5:
                    after = _a.sent();
                    strict_1.default.equal(after.body.count, 0, "badge drops to 0 after decline");
                    return [3 /*break*/, 8];
                case 6: return [4 /*yield*/, srv.close()];
                case 7:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 8: return [2 /*return*/];
            }
        });
    }); });
});
