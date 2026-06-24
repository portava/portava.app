"use strict";
/**
 * Telegraph Chat Suggestions — backend tests.
 *
 * Sections:
 *   A. Intent detection (8 tests)
 *   B. Privacy resolver (6 tests)
 *   C. API endpoint permission + shape (10 tests)
 *   D. Cooldown / rate-limit logic (4 tests)
 *   E. Settings endpoint (3 tests)
 *   F. Regression (3 tests)
 *   G. Preference event on dismiss + 24h category cooldown (5 tests)
 *
 * Total: 39
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
var telegraphChat_js_1 = require("../routes/telegraphChat.js");
function makeFakeClient(overrides) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    if (overrides === void 0) { overrides = {}; }
    var store = {
        threads: (_a = overrides.threads) !== null && _a !== void 0 ? _a : [],
        threadMembers: (_b = overrides.threadMembers) !== null && _b !== void 0 ? _b : [],
        tripMembers: (_c = overrides.tripMembers) !== null && _c !== void 0 ? _c : [],
        circleMembers: (_d = overrides.circleMembers) !== null && _d !== void 0 ? _d : [],
        profiles: (_e = overrides.profiles) !== null && _e !== void 0 ? _e : [],
        suggestions: (_f = overrides.suggestions) !== null && _f !== void 0 ? _f : [],
        trips: (_g = overrides.trips) !== null && _g !== void 0 ? _g : [],
        messages: (_h = overrides.messages) !== null && _h !== void 0 ? _h : [],
        planItems: (_j = overrides.planItems) !== null && _j !== void 0 ? _j : [],
        preferenceEvents: (_k = overrides.preferenceEvents) !== null && _k !== void 0 ? _k : [],
    };
    var captured = {
        insertedSuggestions: (_l = overrides.insertedSuggestions) !== null && _l !== void 0 ? _l : [],
        insertedMessages: (_m = overrides.insertedMessages) !== null && _m !== void 0 ? _m : [],
        updatedSuggestions: (_o = overrides.updatedSuggestions) !== null && _o !== void 0 ? _o : [],
        updatedProfiles: (_p = overrides.updatedProfiles) !== null && _p !== void 0 ? _p : [],
        insertedPreferenceEvents: (_q = overrides.insertedPreferenceEvents) !== null && _q !== void 0 ? _q : [],
    };
    function makeQuery(tableName, rows) {
        var filtered = __spreadArray([], rows, true);
        var limited = null;
        var isSingle = false;
        var isMaybe = false;
        var isCountOnly = false;
        var selectFields = "*";
        var insertRows = [];
        var updateData = {};
        var isUpdate = false;
        var isInsert = false;
        var q = {
            select: function (fields, opts) {
                var _a;
                selectFields = fields;
                if (opts === null || opts === void 0 ? void 0 : opts.count)
                    isCountOnly = (_a = opts.head) !== null && _a !== void 0 ? _a : false;
                return q;
            },
            eq: function (col, val) {
                filtered = filtered.filter(function (r) { return r[col] === val; });
                return q;
            },
            in: function (col, vals) {
                filtered = filtered.filter(function (r) { return vals.includes(r[col]); });
                return q;
            },
            gt: function (col, val) {
                filtered = filtered.filter(function (r) { return r[col] > val; });
                return q;
            },
            gte: function (col, val) {
                filtered = filtered.filter(function (r) { return r[col] >= val; });
                return q;
            },
            is: function (col, val) {
                if (val === null)
                    filtered = filtered.filter(function (r) { return r[col] == null; });
                return q;
            },
            order: function () {
                return q;
            },
            limit: function (n) {
                limited = filtered.slice(0, n);
                return q;
            },
            maybeSingle: function () {
                isMaybe = true;
                return q;
            },
            single: function () {
                isSingle = true;
                return q;
            },
            insert: function (data) {
                isInsert = true;
                insertRows = Array.isArray(data) ? data : [data];
                return q;
            },
            update: function (data) {
                isUpdate = true;
                updateData = data;
                return q;
            },
            then: function (resolve) {
                var _a, _b, _c;
                var _d, _e;
                if (isInsert) {
                    if (tableName === "telegraph_chat_suggestions") {
                        (_a = captured.insertedSuggestions).push.apply(_a, insertRows);
                        if (isSingle) {
                            return resolve({ data: insertRows[0], error: null });
                        }
                    }
                    if (tableName === "messages") {
                        (_b = captured.insertedMessages).push.apply(_b, insertRows);
                        if (isSingle) {
                            return resolve({
                                data: { id: "msg_" + Math.random().toString(36).slice(2) },
                                error: null,
                            });
                        }
                    }
                    if (tableName === "trip_plan_items") {
                        if (isSingle) {
                            return resolve({
                                data: { id: "plan_" + Math.random().toString(36).slice(2), title: (_d = insertRows[0]) === null || _d === void 0 ? void 0 : _d.title },
                                error: null,
                            });
                        }
                    }
                    if (tableName === "user_preference_events") {
                        (_c = captured.insertedPreferenceEvents).push.apply(_c, insertRows);
                    }
                    return resolve({ data: null, error: null });
                }
                if (isUpdate) {
                    if (tableName === "telegraph_chat_suggestions") {
                        captured.updatedSuggestions.push(updateData);
                    }
                    if (tableName === "profiles") {
                        captured.updatedProfiles.push(updateData);
                    }
                    return resolve({ data: null, error: null });
                }
                if (isCountOnly) {
                    return resolve({ count: filtered.length, error: null });
                }
                var source = limited !== null && limited !== void 0 ? limited : filtered;
                if (isSingle) {
                    if (source.length === 0)
                        return resolve({ data: null, error: { message: "not found" } });
                    return resolve({ data: source[0], error: null });
                }
                if (isMaybe) {
                    return resolve({ data: (_e = source[0]) !== null && _e !== void 0 ? _e : null, error: null });
                }
                return resolve({ data: source, error: null });
            },
        };
        return q;
    }
    var client = {
        auth: {
            getUser: function (token) {
                return __awaiter(this, void 0, void 0, function () {
                    var u;
                    var _a;
                    return __generator(this, function (_b) {
                        u = ((_a = overrides.users) !== null && _a !== void 0 ? _a : {})[token];
                        if (!u)
                            return [2 /*return*/, { data: { user: null }, error: { message: "bad token" } }];
                        return [2 /*return*/, { data: { user: u }, error: null }];
                    });
                });
            },
        },
        from: function (table) {
            var _a;
            var tableMap = {
                message_threads: store.threads,
                message_thread_members: store.threadMembers,
                trip_members: store.tripMembers,
                circle_memberships: store.circleMembers,
                profiles: store.profiles,
                telegraph_chat_suggestions: store.suggestions,
                trips: store.trips,
                messages: store.messages,
                trip_plan_items: store.planItems,
                user_preference_events: store.preferenceEvents,
            };
            return makeQuery(table, (_a = tableMap[table]) !== null && _a !== void 0 ? _a : []);
        },
        _captured: captured,
    };
    return client;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function req(server, method, path, token, body) {
    return new Promise(function (resolve, reject) {
        var addr = server.address();
        var data = body ? JSON.stringify(body) : undefined;
        var options = {
            hostname: "127.0.0.1",
            port: addr.port,
            path: path,
            method: method,
            headers: __assign(__assign({}, (token ? { Authorization: "Bearer ".concat(token) } : {})), (data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})),
        };
        var r = node_http_1.default.request(options, function (res) {
            var raw = "";
            res.on("data", function (chunk) { return (raw += chunk); });
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
// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
var THREAD_ID = "11111111-1111-1111-1111-111111111111";
var TRIP_ID = "22222222-2222-2222-2222-222222222222";
var CIRCLE_OWNER_ID = "33333333-3333-3333-3333-333333333333";
var USER_A = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@test.com" };
var USER_B = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "b@test.com" };
var TOKEN_A = "token_a";
var TOKEN_B = "token_b";
var SUGG_ID = "55555555-5555-5555-5555-555555555555";
function activeMember(userId, threadId) {
    return { thread_id: threadId, user_id: userId, left_at: null };
}
function tripMember(userId, tripId) {
    return { trip_id: tripId, user_id: userId, role: "member" };
}
function tripThread(id, tripId) {
    return {
        id: id,
        thread_type: "trip",
        trip_id: tripId,
        circle_owner_id: null,
    };
}
function directThread(id) {
    return { id: id, thread_type: "direct", trip_id: null, circle_owner_id: null };
}
function circleThread(id, ownerId) {
    return { id: id, thread_type: "circle", trip_id: null, circle_owner_id: ownerId };
}
function suggestion(id, userId, threadId, status, expiresAt) {
    if (status === void 0) { status = "shown"; }
    return {
        id: id,
        user_id: userId,
        thread_id: threadId,
        intent_type: "food",
        title: "Find great food",
        reason: "Detected food planning",
        category: "food",
        action_type: "view_place",
        location_context: null,
        time_context: null,
        status: status,
        created_at: new Date().toISOString(),
        expires_at: expiresAt !== null && expiresAt !== void 0 ? expiresAt : new Date(Date.now() + 3600000).toISOString(),
    };
}
// ---------------------------------------------------------------------------
// Section A: Intent detection (unit-level — just call the module directly)
// ---------------------------------------------------------------------------
var telegraphIntent_js_1 = require("../services/telegraphIntent.js");
var telegraphChatSuggestions_js_1 = require("../services/telegraphChatSuggestions.js");
(0, node_test_1.describe)("A. Intent detection", function () {
    (0, node_test_1.it)("detects food intent from 'where should we eat'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("where should we eat tonight?");
        strict_1.default.ok(r, "expected intent result");
        strict_1.default.equal(r.intent, "food");
    });
    (0, node_test_1.it)("detects create_meetup from 'let's meet up'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("let's meet up this weekend");
        strict_1.default.ok(r);
        strict_1.default.equal(r.intent, "create_meetup");
    });
    (0, node_test_1.it)("detects time_poll from 'what time works for everyone'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("what time works for everyone?");
        strict_1.default.ok(r);
        strict_1.default.equal(r.intent, "time_poll");
    });
    (0, node_test_1.it)("detects nightlife from 'good bars nearby'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("any good bars nearby for tonight?");
        strict_1.default.ok(r);
        strict_1.default.equal(r.intent, "nightlife");
    });
    (0, node_test_1.it)("detects beach from 'island hopping'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("let's go island hopping tomorrow");
        strict_1.default.ok(r);
        strict_1.default.equal(r.intent, "beach");
    });
    (0, node_test_1.it)("detects availability_match from 'are you free this weekend'", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("are you free this weekend?");
        strict_1.default.ok(r);
        strict_1.default.ok(["availability_match", "time_poll"].includes(r.intent));
    });
    (0, node_test_1.it)("returns null for a short/generic message", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("ok");
        strict_1.default.equal(r, null);
    });
    (0, node_test_1.it)("returns null below confidence threshold for unrelated text", function () {
        var r = (0, telegraphIntent_js_1.detectIntent)("wow really cool photos");
        strict_1.default.equal(r, null);
    });
});
// ---------------------------------------------------------------------------
// Section B: Privacy resolver
// ---------------------------------------------------------------------------
var telegraphChatSuggestions_js_2 = require("../services/telegraphChatSuggestions.js");
(0, node_test_1.describe)("B. Privacy resolver", function () {
    (0, node_test_1.it)("trip thread: accepted member gets canUseTripContext = true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({
                        threads: [tripThread(THREAD_ID, TRIP_ID)],
                        tripMembers: [tripMember(USER_A.id, TRIP_ID)],
                        profiles: [{ id: USER_A.id, show_telegraph_trip: true }],
                        trips: [{ id: TRIP_ID, destination_city: "Cebu", destination_country: "Philippines" }],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_A.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.canUseTripContext, true);
                    strict_1.default.equal(v.canShowRecommendation, true);
                    strict_1.default.equal(v.tripDestination, "Cebu");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("trip thread: non-member gets canShowRecommendation = false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({
                        threads: [tripThread(THREAD_ID, TRIP_ID)],
                        tripMembers: [],
                        profiles: [{ id: USER_B.id, show_telegraph_trip: true }],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_B.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.canShowRecommendation, false);
                    strict_1.default.equal(v.reason, "not_trip_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("circle thread: non-member gets canShowRecommendation = false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({
                        threads: [circleThread(THREAD_ID, CIRCLE_OWNER_ID)],
                        circleMembers: [],
                        profiles: [{ id: USER_B.id, show_telegraph_circle: true }],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_B.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.canShowRecommendation, false);
                    strict_1.default.equal(v.reason, "not_circle_member");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("direct thread with telegraph disabled returns canShowRecommendation = false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({
                        threads: [directThread(THREAD_ID)],
                        profiles: [{ id: USER_A.id, show_telegraph_dm: false }],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_A.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.canShowRecommendation, false);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("verdict never exposes exact GPS fields", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({
                        threads: [directThread(THREAD_ID)],
                        profiles: [{ id: USER_A.id, latitude: 10.3, longitude: 123.8, show_telegraph_dm: true }],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_A.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.latitude, undefined);
                    strict_1.default.equal(v.longitude, undefined);
                    strict_1.default.equal(v.exactLocation, undefined);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("unknown thread returns canShowRecommendation = false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, v;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ threads: [] });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_2.resolvePrivacyVerdict)(client, USER_A.id, THREAD_ID)];
                case 1:
                    v = _a.sent();
                    strict_1.default.equal(v.canShowRecommendation, false);
                    strict_1.default.equal(v.reason, "thread_not_found");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Section C: API endpoint permission + shape
// ---------------------------------------------------------------------------
var server;
(0, node_test_1.before)(function () {
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use("/api", telegraphChat_js_1.default);
    server = (0, node_http_1.createServer)(app);
    server.listen(0);
});
(0, node_test_1.after)(function () {
    server === null || server === void 0 ? void 0 : server.close();
});
(0, node_test_1.describe)("C. API endpoint permission + shape", function () {
    (0, node_test_1.it)("GET suggestions — 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ users: {} });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET suggestions — 400 for bad threadId", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({ users: (_a = {}, _a[TOKEN_A] = USER_A, _a) });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/not-a-uuid/telegraph/suggestions", TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET suggestions — 403 when not thread member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET suggestions — 200 with suggestions array for active member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        threads: [directThread(THREAD_ID)],
                        profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.suggestions), "should have suggestions array");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST dismiss — 403 for non-member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_B] = USER_B, _a),
                        threadMembers: [],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/dismiss"), TOKEN_B)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST dismiss — 200 for active member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/dismiss"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST add-to-plan — 403 when user is not trip member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        tripMembers: [],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/add-to-plan"), TOKEN_A, { tripId: TRIP_ID })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST create-meetup — returns prefill data", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        suggestions: [
                            __assign(__assign({}, suggestion(SUGG_ID, USER_A.id, THREAD_ID)), { title: "Dinner in Cebu", location_context: "IT Park", time_context: "Evening", trip_id: TRIP_ID, circle_id: null }),
                        ],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/create-meetup"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    strict_1.default.equal(r.body.prefill.title, "Dinner in Cebu");
                    strict_1.default.equal(r.body.prefill.location, "IT Park");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST start-poll — 200, creates poll message", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/start-poll"), TOKEN_A, { options: ["Morning", "Afternoon", "Evening"] })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    strict_1.default.ok(r.body.messageId);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("GET suggestions — left member (left_at != null) gets 403", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_B] = USER_B, _a),
                        threadMembers: [{ thread_id: THREAD_ID, user_id: USER_B.id, left_at: new Date().toISOString() }],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions"), TOKEN_B)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Section D: Cooldown / rate-limit logic
// ---------------------------------------------------------------------------
var telegraphChatSuggestions_js_3 = require("../services/telegraphChatSuggestions.js");
(0, node_test_1.describe)("D. Cooldown / rate-limit logic", function () {
    (0, node_test_1.it)("checkRateLimit returns true when fewer than 3 suggestions in the last hour", function () { return __awaiter(void 0, void 0, void 0, function () {
        var now, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    now = new Date().toISOString();
                    client = makeFakeClient({
                        suggestions: [
                            { id: "s1", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
                            { id: "s2", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkRateLimit)(client, USER_A.id, THREAD_ID)];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("checkRateLimit returns false when 3 or more suggestions in the last hour", function () { return __awaiter(void 0, void 0, void 0, function () {
        var now, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    now = new Date().toISOString();
                    client = makeFakeClient({
                        suggestions: [
                            { id: "s1", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
                            { id: "s2", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
                            { id: "s3", user_id: USER_A.id, thread_id: THREAD_ID, created_at: now },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkRateLimit)(client, USER_A.id, THREAD_ID)];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, false);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("checkCooldown returns true when no recent same-intent suggestion", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ suggestions: [] });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCooldown)(client, USER_A.id, THREAD_ID, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("checkCooldown returns false when same intent shown recently", function () { return __awaiter(void 0, void 0, void 0, function () {
        var recentTime, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    recentTime = new Date().toISOString();
                    client = makeFakeClient({
                        suggestions: [
                            {
                                id: "s1",
                                user_id: USER_A.id,
                                thread_id: THREAD_ID,
                                intent_type: "food",
                                status: "shown",
                                created_at: recentTime,
                            },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCooldown)(client, USER_A.id, THREAD_ID, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, false);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Section E: Telegraph chat settings endpoint
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("E. Telegraph chat settings", function () {
    (0, node_test_1.it)("PATCH /api/me/telegraph-chat-settings — 401 without token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ users: {} });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "PATCH", "/api/me/telegraph-chat-settings", undefined, {
                            show_telegraph_dm: false,
                        })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("PATCH — 400 for empty body", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({ users: (_a = {}, _a[TOKEN_A] = USER_A, _a) });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "PATCH", "/api/me/telegraph-chat-settings", TOKEN_A, {})];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("PATCH — 200 updates one setting", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "PATCH", "/api/me/telegraph-chat-settings", TOKEN_A, {
                            show_telegraph_dm: false,
                        })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Section F: Regression
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("F. Regression", function () {
    (0, node_test_1.it)("no GPS fields ever appear in a suggestion card", function () {
        var intent = { intent: "food", confidence: 0.9, rawText: "where should we eat?" };
        var verdict = {
            canUseTripContext: true,
            canUseCircleContext: false,
            canUseAvailability: false,
            canShowRecommendation: true,
            reason: "ok",
            tripId: TRIP_ID,
            circleOwnerId: null,
            tripDestination: "Cebu",
            threadType: "trip",
        };
        var cards = (0, telegraphChatSuggestions_js_1.buildSuggestions)(USER_A.id, THREAD_ID, intent, verdict);
        for (var _i = 0, cards_1 = cards; _i < cards_1.length; _i++) {
            var c = cards_1[_i];
            strict_1.default.equal(c.latitude, undefined);
            strict_1.default.equal(c.longitude, undefined);
            strict_1.default.equal(c.liveLocation, undefined);
            strict_1.default.equal(c.exactGps, undefined);
        }
    });
    (0, node_test_1.it)("GET suggestions returns empty array (not 500) when Telegraph API unavailable", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        threads: [directThread(THREAD_ID)],
                        profiles: [{ id: USER_A.id, show_telegraph_dm: true }],
                        suggestions: [],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "GET", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual(r.body.suggestions, []);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("POST dismiss on already-dismissed suggestion returns 200 (idempotent)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID, "dismissed")],
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/dismiss"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Section G: Preference event on dismiss + 24-hour category cooldown
// ---------------------------------------------------------------------------
(0, node_test_1.describe)("G. Preference event on dismiss + 24h category cooldown", function () {
    (0, node_test_1.it)("G1: checkCategoryDeclineCooldown returns true when no recent decline", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({ preferenceEvents: [] });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCategoryDeclineCooldown)(client, USER_A.id, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G2: checkCategoryDeclineCooldown returns false when user declined same category within 24h", function () { return __awaiter(void 0, void 0, void 0, function () {
        var recentTime, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    recentTime = new Date().toISOString();
                    client = makeFakeClient({
                        preferenceEvents: [
                            {
                                user_id: USER_A.id,
                                category: "food",
                                signal: "dismiss",
                                created_at: recentTime,
                            },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCategoryDeclineCooldown)(client, USER_A.id, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, false);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G3: dismiss endpoint writes a preference event to user_preference_events", function () { return __awaiter(void 0, void 0, void 0, function () {
        var capturedEvents, client, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    capturedEvents = [];
                    client = makeFakeClient({
                        users: (_a = {}, _a[TOKEN_A] = USER_A, _a),
                        threadMembers: [activeMember(USER_A.id, THREAD_ID)],
                        suggestions: [suggestion(SUGG_ID, USER_A.id, THREAD_ID)],
                        insertedPreferenceEvents: capturedEvents,
                    });
                    (0, http_js_1._setTestClient)(client, true);
                    return [4 /*yield*/, req(server, "POST", "/api/threads/".concat(THREAD_ID, "/telegraph/suggestions/").concat(SUGG_ID, "/dismiss"), TOKEN_A)];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(capturedEvents.length, 1, "should have inserted one preference event");
                    strict_1.default.equal(capturedEvents[0].user_id, USER_A.id);
                    strict_1.default.equal(capturedEvents[0].signal, "dismiss");
                    strict_1.default.equal(capturedEvents[0].recommendation_id, SUGG_ID);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G4: checkCategoryDeclineCooldown returns true when decline is for a different category", function () { return __awaiter(void 0, void 0, void 0, function () {
        var recentTime, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    recentTime = new Date().toISOString();
                    client = makeFakeClient({
                        preferenceEvents: [
                            {
                                user_id: USER_A.id,
                                category: "nightlife",
                                signal: "dismiss",
                                created_at: recentTime,
                            },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCategoryDeclineCooldown)(client, USER_A.id, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("G5: checkCategoryDeclineCooldown returns false when multiple decline events exist (regression: multi-row must not clear cooldown)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var recentTime, client, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    recentTime = new Date().toISOString();
                    client = makeFakeClient({
                        preferenceEvents: [
                            { user_id: USER_A.id, category: "food", signal: "dismiss", created_at: recentTime },
                            { user_id: USER_A.id, category: "food", signal: "dismiss", created_at: recentTime },
                        ],
                    });
                    return [4 /*yield*/, (0, telegraphChatSuggestions_js_3.checkCategoryDeclineCooldown)(client, USER_A.id, "food")];
                case 1:
                    ok = _a.sent();
                    strict_1.default.equal(ok, false, "multiple decline rows must still suppress the category");
                    return [2 /*return*/];
            }
        });
    }); });
});
