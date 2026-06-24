"use strict";
/**
 * Realtime stream & typing endpoint tests — HTTP-level.
 *
 * Sections:
 *   A. POST /api/threads/:threadId/typing  (5 tests)
 *   B. Decline message-request emits request.declined — regression  (3 tests)
 *
 * Total: 8
 *
 * Why HTTP-level rather than unit-level:
 *   The in-memory event bus is already unit-tested (telegraphRealtime.test.ts).
 *   These tests exercise the full request path: auth check → membership gate →
 *   fire-and-forget fan-out → event delivered to subscribers.  They would have
 *   caught the decline regression (sender_id missing from select) immediately.
 */
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
var strict_1 = require("node:assert/strict");
var node_test_1 = require("node:test");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var telegraphEvents_js_1 = require("../lib/telegraphEvents.js");
var telegraphStream_js_1 = require("../routes/telegraphStream.js");
var messaging_js_1 = require("../routes/messaging.js");
// ---------------------------------------------------------------------------
// HTTP helper (raw node:http — no supertest, firewall-safe)
// ---------------------------------------------------------------------------
function httpReq(server, method, path, token, body) {
    return new Promise(function (resolve, reject) {
        var addr = server.address();
        var data = body ? JSON.stringify(body) : undefined;
        var options = {
            hostname: "127.0.0.1",
            port: addr.port,
            path: path,
            method: method,
            headers: __assign(__assign({}, (token ? { Authorization: "Bearer ".concat(token) } : {})), (data
                ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
                : {})),
        };
        var r = node_http_1.default.request(options, function (res) {
            var raw = "";
            res.on("data", function (c) { return (raw += c); });
            res.on("end", function () {
                var _a, _b;
                try {
                    resolve({ status: (_a = res.statusCode) !== null && _a !== void 0 ? _a : 0, body: JSON.parse(raw) });
                }
                catch (_c) {
                    resolve({ status: (_b = res.statusCode) !== null && _b !== void 0 ? _b : 0, body: raw });
                }
            });
        });
        r.on("error", reject);
        if (data)
            r.write(data);
        r.end();
    });
}
/** One macrotask — enough for fire-and-forget promise chains to flush. */
var tick = function () { return new Promise(function (r) { return setImmediate(r); }); };
// ---------------------------------------------------------------------------
// Shared test identifiers
// ---------------------------------------------------------------------------
var THREAD_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
var REQUEST_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000002";
var ACTOR = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000001", email: "actor@test.com" };
var OTHER_1 = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000002", email: "other1@test.com" };
var OTHER_2 = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000003", email: "other2@test.com" };
var SENDER = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000004", email: "sender@test.com" };
var TOKEN_ACTOR = "tok_actor";
var TOKEN_OTHER = "tok_other";
/**
 * Project a row to only the columns named in the select() call, exactly as a
 * real DB would.  If the caller passes "*" (or no fields), the full row is
 * returned.  This is what makes the regression test meaningful: if production
 * code omits `sender_id` from `.select(...)`, the projected result won't have
 * the field and `req_.sender_id` will be undefined — matching the original bug.
 */
function projectRow(row, selectArg) {
    var fields = selectArg.trim();
    if (!fields || fields === "*")
        return __assign({}, row);
    var cols = fields.split(",").map(function (f) { return f.trim(); }).filter(Boolean);
    var out = {};
    for (var _i = 0, cols_1 = cols; _i < cols_1.length; _i++) {
        var col = cols_1[_i];
        if (Object.prototype.hasOwnProperty.call(row, col)) {
            out[col] = row[col];
        }
    }
    return out;
}
function makeFakeClient(opts) {
    var _a, _b;
    if (opts === void 0) { opts = {}; }
    var tableData = {
        message_thread_members: (_a = opts.threadMembers) !== null && _a !== void 0 ? _a : [],
        message_requests: (_b = opts.messageRequests) !== null && _b !== void 0 ? _b : [],
    };
    function makeQuery(table) {
        var _a;
        var rows = __spreadArray([], ((_a = tableData[table]) !== null && _a !== void 0 ? _a : []), true);
        var selectArg = "*";
        var isUpdate = false;
        var isMaybe = false;
        var q = {
            select: function (fields) {
                if (fields === void 0) { fields = "*"; }
                selectArg = fields;
                return q;
            },
            eq: function (col, val) {
                rows = rows.filter(function (r) { return r[col] === val; });
                return q;
            },
            is: function (col, val) {
                if (val === null)
                    rows = rows.filter(function (r) { return r[col] == null; });
                return q;
            },
            order: function () { return q; },
            limit: function (n) { rows = rows.slice(0, n); return q; },
            maybeSingle: function () { isMaybe = true; return q; },
            single: function () { return q; },
            update: function (_data) { isUpdate = true; return q; },
            insert: function (_data) { return q; },
            then: function (resolve, _reject) {
                var _a;
                if (isUpdate)
                    return resolve({ data: null, error: null });
                var projected = rows.map(function (r) { return projectRow(r, selectArg); });
                if (isMaybe)
                    return resolve({ data: (_a = projected[0]) !== null && _a !== void 0 ? _a : null, error: null });
                return resolve({ data: projected, error: null });
            },
        };
        return q;
    }
    return {
        auth: {
            getUser: function (token) {
                return __awaiter(this, void 0, void 0, function () {
                    var u;
                    var _a;
                    return __generator(this, function (_b) {
                        u = ((_a = opts.users) !== null && _a !== void 0 ? _a : {})[token];
                        if (!u)
                            return [2 /*return*/, { data: { user: null }, error: { message: "bad token" } }];
                        return [2 /*return*/, { data: { user: u }, error: null }];
                    });
                });
            },
        },
        from: function (table) { return makeQuery(table); },
    };
}
// ---------------------------------------------------------------------------
// A. POST /api/threads/:threadId/typing
// ---------------------------------------------------------------------------
var streamServer;
(0, node_test_1.describe)("A. Typing endpoint — auth, membership gate, event fan-out", function () {
    (0, node_test_1.before)(function () {
        var app = (0, express_1.default)();
        app.use(express_1.default.json());
        app.use("/api", telegraphStream_js_1.default);
        streamServer = (0, node_http_1.createServer)(app);
        streamServer.listen(0);
    });
    (0, node_test_1.after)(function () { streamServer === null || streamServer === void 0 ? void 0 : streamServer.close(); });
    (0, node_test_1.afterEach)(function () { (0, http_js_1._clearTestClient)(); });
    (0, node_test_1.it)("A1: 401 without auth token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    (0, http_js_1._setTestClient)(makeFakeClient({ users: {} }), true);
                    return [4 /*yield*/, httpReq(streamServer, "POST", "/api/threads/".concat(THREAD_ID, "/typing"), undefined, { typing: true })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("A2: 400 for malformed thread UUID", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    (0, http_js_1._setTestClient)(makeFakeClient({ users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a) }), true);
                    return [4 /*yield*/, httpReq(streamServer, "POST", "/api/threads/not-a-uuid/typing", TOKEN_ACTOR, { typing: true })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("A3: 403 for non-member of the thread", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    (0, http_js_1._setTestClient)(makeFakeClient({
                        users: (_a = {}, _a[TOKEN_OTHER] = OTHER_1, _a),
                        threadMembers: [],
                    }), true);
                    return [4 /*yield*/, httpReq(streamServer, "POST", "/api/threads/".concat(THREAD_ID, "/typing"), TOKEN_OTHER, { typing: true })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("A4: 200 and relays typing.started to other members only — actor excluded", function () { return __awaiter(void 0, void 0, void 0, function () {
        var actorEvents, other1Events, other2Events, ua, u1, u2, r;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    (0, http_js_1._setTestClient)(makeFakeClient({
                        users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a),
                        threadMembers: [
                            { thread_id: THREAD_ID, user_id: ACTOR.id, left_at: null },
                            { thread_id: THREAD_ID, user_id: OTHER_1.id, left_at: null },
                            { thread_id: THREAD_ID, user_id: OTHER_2.id, left_at: null },
                        ],
                    }), true);
                    actorEvents = [];
                    other1Events = [];
                    other2Events = [];
                    ua = (0, telegraphEvents_js_1.subscribe)(ACTOR.id, function (e) { return actorEvents.push(e); });
                    u1 = (0, telegraphEvents_js_1.subscribe)(OTHER_1.id, function (e) { return other1Events.push(e); });
                    u2 = (0, telegraphEvents_js_1.subscribe)(OTHER_2.id, function (e) { return other2Events.push(e); });
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, , 4, 5]);
                    return [4 /*yield*/, httpReq(streamServer, "POST", "/api/threads/".concat(THREAD_ID, "/typing"), TOKEN_ACTOR, { typing: true })];
                case 2:
                    r = _c.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    strict_1.default.equal(r.body.typing, true);
                    return [4 /*yield*/, tick()];
                case 3:
                    _c.sent();
                    strict_1.default.equal(actorEvents.length, 0, "actor must NOT receive their own typing indicator");
                    strict_1.default.equal(other1Events.length, 1, "other1 must receive typing.started");
                    strict_1.default.equal(other2Events.length, 1, "other2 must receive typing.started");
                    strict_1.default.equal(other1Events[0].type, "typing.started");
                    strict_1.default.equal((_b = other1Events[0].payload) === null || _b === void 0 ? void 0 : _b.userId, ACTOR.id, "payload carries the actor's userId");
                    strict_1.default.equal(other1Events[0].threadId, THREAD_ID, "event is scoped to the correct thread");
                    return [3 /*break*/, 5];
                case 4:
                    ua();
                    u1();
                    u2();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("A5: relays typing.stopped when typing=false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var events, u1, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    (0, http_js_1._setTestClient)(makeFakeClient({
                        users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a),
                        threadMembers: [
                            { thread_id: THREAD_ID, user_id: ACTOR.id, left_at: null },
                            { thread_id: THREAD_ID, user_id: OTHER_1.id, left_at: null },
                        ],
                    }), true);
                    events = [];
                    u1 = (0, telegraphEvents_js_1.subscribe)(OTHER_1.id, function (e) { return events.push(e); });
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, , 4, 5]);
                    return [4 /*yield*/, httpReq(streamServer, "POST", "/api/threads/".concat(THREAD_ID, "/typing"), TOKEN_ACTOR, { typing: false })];
                case 2:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.typing, false);
                    return [4 /*yield*/, tick()];
                case 3:
                    _b.sent();
                    strict_1.default.equal(events.length, 1);
                    strict_1.default.equal(events[0].type, "typing.stopped");
                    return [3 /*break*/, 5];
                case 4:
                    u1();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// B. Decline message-request — request.declined emission regression
//
//   Background: The decline handler originally omitted sender_id from its DB
//   select(), so req_.sender_id was undefined and publishToUsers was never
//   called.  The fix was to include sender_id in the select.  These tests
//   confirm that regression can never silently re-appear.
// ---------------------------------------------------------------------------
var msgServer;
(0, node_test_1.describe)("B. Decline message-request — request.declined realtime regression", function () {
    (0, node_test_1.before)(function () {
        var app = (0, express_1.default)();
        app.use(express_1.default.json());
        app.use("/api", messaging_js_1.default);
        msgServer = (0, node_http_1.createServer)(app);
        msgServer.listen(0);
    });
    (0, node_test_1.after)(function () {
        msgServer === null || msgServer === void 0 ? void 0 : msgServer.close();
        (0, http_js_1._clearTestClient)();
        (0, supabase_js_1._setTestServiceClient)(null);
    });
    (0, node_test_1.afterEach)(function () {
        (0, http_js_1._clearTestClient)();
        (0, supabase_js_1._setTestServiceClient)(null);
    });
    (0, node_test_1.it)("B1: 200 and body { status: 'declined', requestId } for valid decline", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a),
                        messageRequests: [
                            { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: ACTOR.id, status: "pending" },
                        ],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, httpReq(msgServer, "POST", "/api/message-requests/".concat(REQUEST_ID, "/decline"), TOKEN_ACTOR)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.status, "declined");
                    strict_1.default.equal(r.body.requestId, REQUEST_ID);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("B2: 403 when caller is not the recipient", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a),
                        messageRequests: [
                            { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: OTHER_1.id, status: "pending" },
                        ],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    return [4 /*yield*/, httpReq(msgServer, "POST", "/api/message-requests/".concat(REQUEST_ID, "/decline"), TOKEN_ACTOR)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("B3: emits request.declined to the sender — and only the sender", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, senderEvents, actorEvents, us, ua, r;
        var _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_ACTOR] = ACTOR, _a),
                        messageRequests: [
                            { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: ACTOR.id, status: "pending" },
                        ],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    (0, supabase_js_1._setTestServiceClient)(client);
                    senderEvents = [];
                    actorEvents = [];
                    us = (0, telegraphEvents_js_1.subscribe)(SENDER.id, function (e) { return senderEvents.push(e); });
                    ua = (0, telegraphEvents_js_1.subscribe)(ACTOR.id, function (e) { return actorEvents.push(e); });
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, , 4, 5]);
                    return [4 /*yield*/, httpReq(msgServer, "POST", "/api/message-requests/".concat(REQUEST_ID, "/decline"), TOKEN_ACTOR)];
                case 2:
                    r = _c.sent();
                    strict_1.default.equal(r.status, 200);
                    // publishToUsers is fire-and-forget after the response is sent;
                    // wait one macrotask for the synchronous fake-client chain to flush.
                    return [4 /*yield*/, tick()];
                case 3:
                    // publishToUsers is fire-and-forget after the response is sent;
                    // wait one macrotask for the synchronous fake-client chain to flush.
                    _c.sent();
                    strict_1.default.equal(senderEvents.length, 1, "sender must receive request.declined");
                    strict_1.default.equal(senderEvents[0].type, "request.declined");
                    strict_1.default.equal((_b = senderEvents[0].payload) === null || _b === void 0 ? void 0 : _b.requestId, REQUEST_ID, "payload must include the requestId");
                    strict_1.default.equal(actorEvents.length, 0, "the decliner must not receive their own action");
                    return [3 /*break*/, 5];
                case 4:
                    us();
                    ua();
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); });
});
