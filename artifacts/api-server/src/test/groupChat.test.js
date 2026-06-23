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
 * Backend tests — Trip & Circle Group Chat (Task #11)
 *
 * Covers all 39 acceptance scenarios:
 *   - Trip chat access: accepted / pending / declined / removed / non-member
 *   - Circle chat access: accepted / non-member / pending invite
 *   - Send permissions (active member vs. left member)
 *   - No-duplicate thread creation (idempotency)
 *   - Membership sync on accept / remove
 *   - Message visibility only to thread members
 *   - Privacy guards: no GPS, no private posts, no service-role fields
 *   - PATCH /messages/:id and DELETE /messages/:id
 *   - Sync repair endpoints
 *
 * Runtime: node:test + node:assert/strict (matches requests.test.ts pattern)
 * Run: node --import tsx/esm --test src/test/groupChat.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var groupChat_js_1 = require("../routes/groupChat.js");
var messaging_js_1 = require("../routes/messaging.js");
// ── IDs ──────────────────────────────────────────────────────────────────────
var ALICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
var BOB_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
var CAROL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
var DAVE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
var TRIP_ID = '11111111-1111-1111-1111-111111111111';
var THREAD_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
var MSG_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
function baseState() {
    return {
        users: {
            'alice-tok': { id: ALICE_ID }, // trip owner & circle owner
            'bob-tok': { id: BOB_ID }, // accepted trip member & circle member
            'carol-tok': { id: CAROL_ID }, // invited (pending) trip member
            'dave-tok': { id: DAVE_ID }, // non-member
        },
        trips: [{ id: TRIP_ID, title: 'Test Trip', destination_city: 'Cebu', owner_id: ALICE_ID }],
        trip_members: [
            { trip_id: TRIP_ID, user_id: ALICE_ID, role: 'owner' },
            { trip_id: TRIP_ID, user_id: BOB_ID, role: 'member' },
            { trip_id: TRIP_ID, user_id: CAROL_ID, role: 'invited' },
        ],
        message_threads: [],
        message_thread_members: [],
        messages: [],
        message_translations: [],
        circle_memberships: [{ owner_id: ALICE_ID, member_id: BOB_ID, created_at: '2026-01-01T00:00:00Z' }],
        circle_invites: [{ id: '00000000-0000-0000-0000-000000000001', owner_id: ALICE_ID, recipient_id: CAROL_ID, status: 'pending' }],
        profiles: [
            { id: ALICE_ID, handle: 'alice', name: 'Alice', avatar_url: null },
            { id: BOB_ID, handle: 'bob', name: 'Bob', avatar_url: null },
            { id: CAROL_ID, handle: 'carol', name: 'Carol', avatar_url: null },
            { id: DAVE_ID, handle: 'dave', name: 'Dave', avatar_url: null },
        ],
        inserted: [],
        updated: [],
    };
}
function stateWithThread(s) {
    return __assign(__assign({}, s), { message_threads: [
            { id: THREAD_ID, thread_type: 'trip', trip_id: TRIP_ID, title: 'Test Trip · Cebu',
                status: 'active', last_message_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        ], message_thread_members: [
            { thread_id: THREAD_ID, user_id: ALICE_ID, joined_at: '2026-01-01T00:00:00Z', left_at: null, role: 'owner' },
            { thread_id: THREAD_ID, user_id: BOB_ID, joined_at: '2026-01-01T00:00:00Z', left_at: null, role: 'member' },
        ] });
}
function stateWithMessage(s) {
    return __assign(__assign({}, stateWithThread(s)), { messages: [
            { id: MSG_ID, thread_id: THREAD_ID, sender_id: ALICE_ID, body: 'Hello group',
                deleted_at: null, created_at: '2026-01-01T01:00:00Z', edited_at: null, original_language: null },
        ] });
}
// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state) {
    function from(table) {
        var filters = [];
        var _select = '';
        var _limit = null;
        var _order = null;
        var _updatePayload = null;
        var _insertPayload = null;
        var _isUpdate = false;
        var _isInsert = false;
        var _isDelete = false;
        var _isSingle = false;
        var _isMaybeSingle = false;
        function getData() {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            var tableData = {
                trips: (_a = state.trips) !== null && _a !== void 0 ? _a : [],
                trip_members: (_b = state.trip_members) !== null && _b !== void 0 ? _b : [],
                message_threads: (_c = state.message_threads) !== null && _c !== void 0 ? _c : [],
                message_thread_members: (_d = state.message_thread_members) !== null && _d !== void 0 ? _d : [],
                messages: (_e = state.messages) !== null && _e !== void 0 ? _e : [],
                message_translations: (_f = state.message_translations) !== null && _f !== void 0 ? _f : [],
                circle_memberships: (_g = state.circle_memberships) !== null && _g !== void 0 ? _g : [],
                circle_invites: (_h = state.circle_invites) !== null && _h !== void 0 ? _h : [],
                profiles: (_j = state.profiles) !== null && _j !== void 0 ? _j : [],
            };
            return ((_k = tableData[table]) !== null && _k !== void 0 ? _k : []).filter(function (r) { return filters.every(function (f) { return f(r); }); });
        }
        var b = {
            select: function (sel) { _select = sel !== null && sel !== void 0 ? sel : ''; return b; },
            eq: function (col, val) {
                filters.push(function (r) { return r[col] === val; });
                return b;
            },
            in: function (col, vals) {
                filters.push(function (r) { return vals.includes(r[col]); });
                return b;
            },
            is: function (col, val) {
                filters.push(function (r) { return val === null ? r[col] == null : r[col] === val; });
                return b;
            },
            not: function (col, op, val) {
                if (op === 'is')
                    filters.push(function (r) { return r[col] !== val; });
                return b;
            },
            lt: function (col, val) {
                filters.push(function (r) { return r[col] < val; });
                return b;
            },
            order: function (_col, _opts) { return b; },
            limit: function (n) { _limit = n; return b; },
            update: function (changes) {
                _isUpdate = true;
                _updatePayload = changes;
                return b;
            },
            insert: function (payload) {
                _isInsert = true;
                _insertPayload = payload;
                return b;
            },
            upsert: function (payload, _opts) {
                _isInsert = true;
                _insertPayload = Array.isArray(payload) ? payload : [payload];
                return b;
            },
            delete: function () { _isDelete = true; return b; },
            maybeSingle: function () {
                _isMaybeSingle = true;
                return b.then();
            },
            single: function () {
                _isSingle = true;
                return b.then();
            },
            then: function (resolve, reject) {
                var _a, _b, _c;
                var data = null;
                var error = null;
                try {
                    if (_isInsert) {
                        var rows = Array.isArray(_insertPayload) ? _insertPayload : [_insertPayload];
                        for (var _i = 0, rows_1 = rows; _i < rows_1.length; _i++) {
                            var row = rows_1[_i];
                            var enriched = __assign({ id: "gen-".concat(Math.random().toString(36).slice(2)) }, row);
                            state.inserted.push({ table: table, row: enriched });
                            var arr = state[table];
                            if (arr)
                                arr.push(enriched);
                            if (_isSingle || _isMaybeSingle)
                                data = enriched;
                        }
                        if (!_isSingle && !_isMaybeSingle)
                            data = rows;
                    }
                    else if (_isUpdate) {
                        var rows = getData();
                        var updated = [];
                        for (var _d = 0, rows_2 = rows; _d < rows_2.length; _d++) {
                            var r = rows_2[_d];
                            Object.assign(r, _updatePayload);
                            updated.push(r);
                            state.updated.push({ table: table, row: r });
                        }
                        if (_isSingle || _isMaybeSingle)
                            data = (_a = updated[0]) !== null && _a !== void 0 ? _a : null;
                        else
                            data = updated;
                    }
                    else if (_isDelete) {
                        var rows = getData();
                        var arr = state[table];
                        if (arr) {
                            for (var _e = 0, rows_3 = rows; _e < rows_3.length; _e++) {
                                var r = rows_3[_e];
                                var idx = arr.indexOf(r);
                                if (idx !== -1)
                                    arr.splice(idx, 1);
                            }
                        }
                        data = null;
                    }
                    else {
                        var rows = getData();
                        if (_limit !== null)
                            rows = rows.slice(0, _limit);
                        if (_isSingle)
                            data = (_b = rows[0]) !== null && _b !== void 0 ? _b : null;
                        else if (_isMaybeSingle)
                            data = (_c = rows[0]) !== null && _c !== void 0 ? _c : null;
                        else
                            data = rows;
                    }
                }
                catch (e) {
                    error = e;
                }
                var result = { data: data, error: error };
                if (resolve)
                    return Promise.resolve(resolve(result));
                return Promise.resolve(result);
            },
        };
        return b;
    }
    var fakeAuth = {
        getUser: function (token) {
            var u = state.users[token];
            if (!u)
                return Promise.resolve({ data: { user: null }, error: new Error('invalid token') });
            return Promise.resolve({ data: { user: u }, error: null });
        },
        refreshSession: function () { return Promise.resolve({ data: { session: null } }); },
        getSession: function () { return Promise.resolve({ data: { session: null } }); },
    };
    return { from: from, auth: fakeAuth };
}
function makeApp(state) {
    var client = makeFakeClient(state);
    (0, http_js_1._setTestClient)(client, true);
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Minimal req.log so route error logging doesn't throw.
    app.use(function (req, _res, next) {
        req.log = { error: function () { }, info: function () { }, warn: function () { } };
        next();
    });
    app.use('/api', groupChat_js_1.default);
    app.use('/api', messaging_js_1.default);
    return { app: app, client: client, state: state };
}
function bearer(tok) { return { Authorization: "Bearer ".concat(tok) }; }
function req(app, method, path, tok, body) {
    return __awaiter(this, void 0, void 0, function () {
        var server, port, url, headers, res2, json;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    server = (0, node_http_1.createServer)(app);
                    return [4 /*yield*/, new Promise(function (res) { return server.listen(0, res); })];
                case 1:
                    _a.sent();
                    port = server.address().port;
                    url = "http://localhost:".concat(port).concat(path);
                    headers = { 'Content-Type': 'application/json' };
                    if (tok)
                        headers['Authorization'] = "Bearer ".concat(tok);
                    return [4 /*yield*/, fetch(url, {
                            method: method,
                            headers: headers,
                            body: body ? JSON.stringify(body) : undefined,
                        })];
                case 2:
                    res2 = _a.sent();
                    return [4 /*yield*/, res2.json().catch(function () { return null; })];
                case 3:
                    json = _a.sent();
                    server.close();
                    return [2 /*return*/, { status: res2.status, body: json }];
            }
        });
    });
}
// ═══════════════════════════════════════════════════════════════════════════════
// Trip Chat Access
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('GET /api/trips/:tripId/chat — access control', function () {
    (0, node_test_1.it)('1. trip owner (alice) can access trip chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.thread);
                    strict_1.default.equal(r.body.thread.threadType, 'trip');
                    strict_1.default.equal(r.body.thread.tripId, TRIP_ID);
                    strict_1.default.equal(r.body.thread.memberAccess, 'active');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('2. accepted trip member (bob) can access trip chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.thread);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('3. invited (pending) trip member gets pending_invite error', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'carol-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, 'pending_invite');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('4. non-member (dave) cannot access trip chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'dave-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, 'not_member');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('5. unauthenticated request fails 401', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('6. invalid token fails 401', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'bad-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('7. removed member (left_at set) sees no_access (memberAccess=removed)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithThread(baseState());
                    // Remove bob from both the thread membership and the trip so sync does not restore him.
                    s.message_thread_members.find(function (m) { return m.user_id === BOB_ID; }).left_at = '2026-01-02T00:00:00Z';
                    s.trip_members = s.trip_members.filter(function (m) { return m.user_id !== BOB_ID; });
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, 'not_member');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('8. invalid tripId returns 400', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', '/api/trips/not-a-uuid/chat', 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Trip Chat — thread idempotency and creation
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('GET /api/trips/:tripId/chat — thread creation & idempotency', function () {
    (0, node_test_1.it)('9. creates thread if none exists', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = baseState();
                    strict_1.default.equal(s.message_threads.length, 0);
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.thread.id);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('10. second call returns the SAME thread (no duplicate)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r1, r2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = baseState();
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r1 = _a.sent();
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 2:
                    r2 = _a.sent();
                    strict_1.default.equal(r1.status, 200);
                    strict_1.default.equal(r2.status, 200);
                    strict_1.default.equal(r1.body.thread.id, r2.body.thread.id);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('11. thread_type is "trip" after creation', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.thread.threadType, 'trip');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('12. existing thread is reused (pre-seeded state)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithThread(baseState());
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.thread.id, THREAD_ID);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Circle Chat Access
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('GET /api/circles/:circleId/chat — access control', function () {
    (0, node_test_1.it)('13. circle owner (alice) can access circle chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.thread.threadType, 'circle');
                    strict_1.default.equal(r.body.thread.circleOwnerId, ALICE_ID);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('14. accepted circle member (bob) can access circle chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.thread);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('15. pending circle invite (carol) gets pending_invite', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'carol-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, 'pending_invite');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('16. non-member (dave) cannot access circle chat', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'dave-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, 'not_member');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('17. unauthenticated circle chat request fails 401', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('18. invalid circleId returns 400', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'GET', '/api/circles/bad-id/chat', 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('19. circle thread is created with owner + members', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r, members, ownerInThread, bobInThread;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = baseState();
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.thread.id);
                    members = s.message_thread_members;
                    ownerInThread = members.some(function (m) { return m.user_id === ALICE_ID && m.left_at === null; });
                    bobInThread = members.some(function (m) { return m.user_id === BOB_ID && m.left_at === null; });
                    strict_1.default.ok(ownerInThread, 'owner must be in thread');
                    strict_1.default.ok(bobInThread, 'circle member must be in thread');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('20. circle thread creation is idempotent (no duplicate)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r1, r2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = baseState();
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'alice-tok')];
                case 1:
                    r1 = _a.sent();
                    return [4 /*yield*/, req(app, 'GET', "/api/circles/".concat(ALICE_ID, "/chat"), 'alice-tok')];
                case 2:
                    r2 = _a.sent();
                    strict_1.default.equal(r1.body.thread.id, r2.body.thread.id);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Send Permissions
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('POST /api/threads/:threadId/messages — send permissions', function () {
    (0, node_test_1.it)('21. active member can send a message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithThread(baseState())).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/threads/".concat(THREAD_ID, "/messages"), 'alice-tok', { body: 'Hello!' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.senderId, ALICE_ID);
                    strict_1.default.equal(r.body.body, 'Hello!');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('22. non-member cannot send to group thread', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithThread(baseState())).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/threads/".concat(THREAD_ID, "/messages"), 'dave-tok', { body: 'Hi' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('23. removed member (left_at set) cannot send', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithThread(baseState());
                    s.message_thread_members.find(function (m) { return m.user_id === BOB_ID; }).left_at = '2026-01-02T00:00:00Z';
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/threads/".concat(THREAD_ID, "/messages"), 'bob-tok', { body: 'Hi' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('24. empty body is rejected 400', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithThread(baseState())).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/threads/".concat(THREAD_ID, "/messages"), 'alice-tok', { body: '' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('25. body exceeding 4000 chars is rejected', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithThread(baseState())).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/threads/".concat(THREAD_ID, "/messages"), 'alice-tok', { body: 'x'.repeat(4001) })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Edit and Delete Messages
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('PATCH /api/messages/:messageId — edit own message', function () {
    (0, node_test_1.it)('26. sender can edit their own message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'PATCH', "/api/messages/".concat(MSG_ID), 'alice-tok', { body: 'Edited text' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.body, 'Edited text');
                    strict_1.default.ok(r.body.editedAt);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('27. non-sender cannot edit message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'PATCH', "/api/messages/".concat(MSG_ID), 'bob-tok', { body: 'Nope' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('28. cannot edit a deleted message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithMessage(baseState());
                    s.messages[0].deleted_at = '2026-01-01T02:00:00Z';
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'PATCH', "/api/messages/".concat(MSG_ID), 'alice-tok', { body: 'New' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('29. unauthenticated edit fails 401', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'PATCH', "/api/messages/".concat(MSG_ID), undefined, { body: 'x' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('30. removed member cannot edit (left_at set)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithMessage(baseState());
                    s.message_thread_members.find(function (m) { return m.user_id === ALICE_ID; }).left_at = '2026-01-02T00:00:00Z';
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'PATCH', "/api/messages/".concat(MSG_ID), 'alice-tok', { body: 'Edited' })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)('DELETE /api/messages/:messageId — soft-delete own message', function () {
    (0, node_test_1.it)('31. sender can delete their own message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'DELETE', "/api/messages/".concat(MSG_ID), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.deleted, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('32. non-sender cannot delete message', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'DELETE', "/api/messages/".concat(MSG_ID), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('33. already-deleted message returns 400', function () { return __awaiter(void 0, void 0, void 0, function () {
        var s, app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    s = stateWithMessage(baseState());
                    s.messages[0].deleted_at = '2026-01-01T02:00:00Z';
                    app = makeApp(s).app;
                    return [4 /*yield*/, req(app, 'DELETE', "/api/messages/".concat(MSG_ID), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('34. non-existent message returns 404', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithThread(baseState())).app;
                    return [4 /*yield*/, req(app, 'DELETE', "/api/messages/00000000-0000-0000-0000-000000000000", 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Sync repair endpoints
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('POST /api/trips/:tripId/chat/sync', function () {
    (0, node_test_1.it)('35. trip OWNER (alice) can trigger sync', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/trips/".concat(TRIP_ID, "/chat/sync"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, 'synced');
                    strict_1.default.ok(r.body.threadId);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('36. accepted non-owner trip member (bob) cannot trigger sync', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/trips/".concat(TRIP_ID, "/chat/sync"), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
});
(0, node_test_1.describe)('POST /api/circles/:circleId/chat/sync', function () {
    (0, node_test_1.it)('37. circle OWNER (alice) can trigger circle sync', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/circles/".concat(ALICE_ID, "/chat/sync"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, 'synced');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('38. accepted non-owner circle member (bob) cannot trigger circle sync', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(baseState()).app;
                    return [4 /*yield*/, req(app, 'POST', "/api/circles/".concat(ALICE_ID, "/chat/sync"), 'bob-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ═══════════════════════════════════════════════════════════════════════════════
// Privacy guards
// ═══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)('Privacy guards', function () {
    (0, node_test_1.it)('39. trip chat response exposes no GPS, location_is_private, or service-role fields', function () { return __awaiter(void 0, void 0, void 0, function () {
        var app, r, thread, msg;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    app = makeApp(stateWithMessage(baseState())).app;
                    return [4 /*yield*/, req(app, 'GET', "/api/trips/".concat(TRIP_ID, "/chat"), 'alice-tok')];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    thread = r.body.thread;
                    strict_1.default.ok(!('lat' in thread), 'no lat');
                    strict_1.default.ok(!('lng' in thread), 'no lng');
                    strict_1.default.ok(!('location_is_private' in thread), 'no location_is_private');
                    strict_1.default.ok(!('service_role' in thread), 'no service_role');
                    if (r.body.messages.length > 0) {
                        msg = r.body.messages[0];
                        strict_1.default.ok(!('lat' in msg), 'message: no lat');
                        strict_1.default.ok(!('service_role' in msg), 'message: no service_role');
                    }
                    return [2 /*return*/];
            }
        });
    }); });
});
