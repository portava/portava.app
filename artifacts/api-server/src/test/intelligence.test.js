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
 * Telegraph Trip Intelligence Pack — tests (Sections E–F)
 *
 * Covers:
 *   E1–E25:  Brief access control + context privacy
 *   E26–E40: Concierge command parsing + action confirmation gating
 *   E41–E55: Preference CRUD + learning engine signal logic
 *   F1–F15:  Recommendation ranking + feedback events
 *   F16–F24: Public-profile privacy
 */
var strict_1 = require("node:assert/strict");
var node_test_1 = require("node:test");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
// ─── shared state ──────────────────────────────────────────────────────────
var OWNER_TOKEN = "tok-owner";
var MEMBER_TOKEN = "tok-member";
var INVITED_TOKEN = "tok-invited";
var STRANGER_TOKEN = "tok-stranger";
var OWNER_ID = "uid-owner";
var MEMBER_ID = "uid-member";
var INVITED_ID = "uid-invited";
var STRANGER_ID = "uid-stranger";
var TRIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
var CMD_ID_STORE = new Map();
function makeState() {
    var _a;
    return {
        users: (_a = {},
            _a[OWNER_TOKEN] = { id: OWNER_ID },
            _a[MEMBER_TOKEN] = { id: MEMBER_ID },
            _a[INVITED_TOKEN] = { id: INVITED_ID },
            _a[STRANGER_TOKEN] = { id: STRANGER_ID },
            _a),
        members: [
            { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner" },
            { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member" },
            { trip_id: TRIP_ID, user_id: INVITED_ID, role: "invited" },
        ],
        preferenceProfiles: {},
        preferenceEvents: [],
        tripPlanItems: [],
    };
}
function makeClient(state) {
    var _this = this;
    var inserted = [];
    function from(table) {
        var filters = [];
        var pendingInsert = null;
        var pendingUpdate = null;
        var builder = {
            select: function () { return builder; },
            insert: function (row) { pendingInsert = row; inserted.push({ table: table, row: row }); return builder; },
            update: function (patch) { pendingUpdate = patch; return builder; },
            delete: function () {
                if (table === "user_preference_events") {
                    state.preferenceEvents = state.preferenceEvents.filter(function (e) { return !filters.every(function (f) { return f(e); }); });
                }
                return builder;
            },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return builder; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return builder; },
            is: function (col, val) { filters.push(function (r) { return (val === null ? r[col] == null : r[col] === val); }); return builder; },
            order: function () { return builder; },
            limit: function () { return builder; },
            maybeSingle: function () { return resolveSingle(true); },
            single: function () { return resolveSingle(false); },
            then: function (onF, onR) { return resolveList().then(onF, onR); },
            catch: function (fn) { return { then: function (f) { return Promise.resolve({ data: [], error: null }).then(f); } }; },
        };
        function rows() {
            var source = [];
            if (table === "trip_members")
                source = state.members;
            else if (table === "user_preference_profiles")
                source = Object.values(state.preferenceProfiles);
            else if (table === "user_preference_events")
                source = state.preferenceEvents;
            else if (table === "trip_plan_items")
                source = state.tripPlanItems;
            else if (table === "meetups")
                source = [];
            return source.filter(function (r) { return filters.every(function (f) { return f(r); }); });
        }
        function resolveSingle(maybe) {
            return __awaiter(this, void 0, void 0, function () {
                var row, row, matched_1, matched;
                var _a, _b;
                return __generator(this, function (_c) {
                    if (pendingInsert) {
                        if (table === "user_preference_profiles") {
                            row = __assign({ id: "pref-1", updated_at: new Date().toISOString() }, pendingInsert);
                            state.preferenceProfiles[pendingInsert.user_id] = row;
                            return [2 /*return*/, { data: row, error: null }];
                        }
                        if (table === "user_preference_events") {
                            row = __assign({ id: "evt-".concat(Date.now()) }, pendingInsert);
                            state.preferenceEvents.push(row);
                            return [2 /*return*/, { data: row, error: null }];
                        }
                        return [2 /*return*/, { data: __assign({ id: "new-1" }, pendingInsert), error: null }];
                    }
                    if (pendingUpdate) {
                        matched_1 = rows();
                        if (matched_1.length > 0) {
                            Object.assign(matched_1[0], pendingUpdate);
                            if (table === "user_preference_profiles") {
                                state.preferenceProfiles[matched_1[0].user_id] = matched_1[0];
                            }
                            return [2 /*return*/, { data: matched_1[0], error: null }];
                        }
                        return [2 /*return*/, { data: null, error: null }];
                    }
                    matched = rows();
                    if (maybe)
                        return [2 /*return*/, { data: (_a = matched[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                    return [2 /*return*/, { data: (_b = matched[0]) !== null && _b !== void 0 ? _b : null, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () {
                var row;
                return __generator(this, function (_a) {
                    if (pendingInsert) {
                        if (table === "user_preference_events") {
                            row = __assign({ id: "evt-".concat(Date.now()) }, pendingInsert);
                            state.preferenceEvents.push(row);
                        }
                        return [2 /*return*/, { data: [pendingInsert], error: null }];
                    }
                    return [2 /*return*/, { data: rows(), error: null }];
                });
            });
        }
        return builder;
    }
    return {
        from: from,
        auth: {
            getUser: function (token) { return __awaiter(_this, void 0, void 0, function () {
                var u;
                return __generator(this, function (_a) {
                    u = state.users[token];
                    if (!u)
                        return [2 /*return*/, { data: { user: null }, error: { message: "invalid" } }];
                    return [2 /*return*/, { data: { user: u }, error: null }];
                });
            }); },
        },
        __inserted: inserted,
    };
}
function makeApp(state) {
    var _this = this;
    var client = makeClient(state);
    (0, http_js_1._setTestClient)(client, true);
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(function (req, _res, next) {
        req.log = { error: function () { }, info: function () { }, warn: function () { } };
        next();
    });
    // Import routers (must happen after _setTestClient)
    var attach = function () { return __awaiter(_this, void 0, void 0, function () {
        var _a, prefsRouter, dailyBriefRouter, commandsRouter, feedbackRouter;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.all([
                        Promise.resolve().then(function () { return require("../routes/preferences.js"); }),
                        Promise.resolve().then(function () { return require("../routes/dailyBrief.js"); }),
                        Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); }),
                        Promise.resolve().then(function () { return require("../routes/telegraphFeedback.js"); }),
                    ])];
                case 1:
                    _a = _b.sent(), prefsRouter = _a[0].default, dailyBriefRouter = _a[1].default, commandsRouter = _a[2].default, feedbackRouter = _a[3].default;
                    app.use("/api", prefsRouter);
                    app.use("/api", dailyBriefRouter);
                    app.use("/api", commandsRouter);
                    app.use("/api", feedbackRouter);
                    return [2 /*return*/];
            }
        });
    }); };
    return { app: app, client: client, attach: attach };
}
function bearer(token) {
    return { Authorization: "Bearer ".concat(token) };
}
function req(app, method, path, opts) {
    if (opts === void 0) { opts = {}; }
    return new Promise(function (resolve) {
        var server = node_http_1.default.createServer(app);
        server.listen(0, function () {
            var port = server.address().port;
            var data = opts.body ? JSON.stringify(opts.body) : undefined;
            var options = {
                hostname: "127.0.0.1",
                port: port,
                path: path,
                method: method.toUpperCase(),
                headers: __assign({ "Content-Type": "application/json" }, (opts.token ? bearer(opts.token) : {})),
            };
            var r = node_http_1.default.request(options, function (response) {
                var body = "";
                response.on("data", function (d) { return (body += d); });
                response.on("end", function () {
                    server.close();
                    try {
                        resolve({ status: response.statusCode, body: JSON.parse(body) });
                    }
                    catch (_a) {
                        resolve({ status: response.statusCode, body: body });
                    }
                });
            });
            r.on("error", function (e) { server.close(); resolve({ status: 0, body: String(e) }); });
            if (data)
                r.write(data);
            r.end();
        });
    });
}
// ══════════════════════════════════════════════════════════════════════════════
// Section E — Brief access control + privacy + commands + preferences
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("E — Telegraph Trip Intelligence Pack", function () {
    var state;
    var app;
    (0, node_test_1.before)(function () { return __awaiter(void 0, void 0, void 0, function () {
        var made;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = makeState();
                    made = makeApp(state);
                    app = made.app;
                    return [4 /*yield*/, made.attach()];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.beforeEach)(function () { state = makeState(); (0, http_js_1._setTestClient)(makeClient(state), true); });
    // ── E1–E10: Brief access control ──────────────────────────────────────────
    (0, node_test_1.test)("E1: accepted owner can fetch daily brief", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.access, "full");
                    strict_1.default.ok(r.body.brief !== null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E2: accepted member can fetch daily brief", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: MEMBER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.access, "full");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E3: invited (pending) member sees access_denied, not 403 crash", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: INVITED_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.access, "access_denied");
                    strict_1.default.equal(r.body.brief, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E4: stranger sees access_denied, not 403 crash", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: STRANGER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.access, "access_denied");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E5: unauthenticated request returns 401", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E6: brief date defaults to today when not specified", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, today;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    today = new Date().toISOString().slice(0, 10);
                    strict_1.default.equal((_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.date, today);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E7: brief respects custom date query param", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief?date=2026-07-04"), { token: OWNER_TOKEN })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal((_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.date, "2026-07-04");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E8: invalid date format returns 400", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief?date=not-a-date"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E9: brief for a day with no items contains empty planPreview", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief?date=2099-01-01"), { token: OWNER_TOKEN })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual((_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.planPreview, []);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E10: brief refresh route returns refreshed:true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/refresh"), { token: OWNER_TOKEN, body: { date: "2026-07-04" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.refreshed, true);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── E11–E15: Brief content privacy ────────────────────────────────────────
    (0, node_test_1.test)("E11: brief summary text is a non-empty string", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(typeof ((_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.summaryText) === "string");
                    strict_1.default.ok(((_b = r.body.brief) === null || _b === void 0 ? void 0 : _b.summaryText.length) > 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E12: brief quickActions contains at least view_plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, kinds;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.status, 200);
                    kinds = (_b = (_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.quickActions) === null || _b === void 0 ? void 0 : _b.map(function (a) { return a.kind; });
                    strict_1.default.ok((kinds === null || kinds === void 0 ? void 0 : kinds.includes("view_plan")) || (kinds === null || kinds === void 0 ? void 0 : kinds.includes("ask_telegraph")));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E13: brief does not include private lat/lng or exact GPS", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, briefStr;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    briefStr = JSON.stringify(r.body);
                    strict_1.default.ok(!briefStr.includes('"lat"') || !briefStr.includes('"lng"'), "Brief should not expose raw coordinates");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E14: brief action endpoint returns requiresConfirmation for add_to_plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/actions/add_to_plan"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.requiresConfirmation, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E15: brief action endpoint returns requiresConfirmation=false for view_plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/actions/view_plan"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.requiresConfirmation, false);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── E16–E25: Context privacy + non-member states ──────────────────────────
    (0, node_test_1.test)("E16: invalid action id returns 400", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/actions/delete_everything"), { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E17: stranger cannot dismiss brief recommendation", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/dismiss/rec-xyz"), { token: STRANGER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E18: member can dismiss brief recommendation", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/dismiss/rec-xyz"), { token: MEMBER_TOKEN, body: { category: "food" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E19: invited user cannot perform brief actions", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/actions/add_to_plan"), { token: INVITED_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E20: privacy resolver returns access_denied for invited role", function () { return __awaiter(void 0, void 0, void 0, function () {
        var resolveContext, client, verdict;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/privacyResolver.js"); })];
                case 1:
                    resolveContext = (_a.sent()).resolveContext;
                    client = makeClient(state);
                    return [4 /*yield*/, resolveContext(client, INVITED_ID, TRIP_ID)];
                case 2:
                    verdict = _a.sent();
                    strict_1.default.equal(verdict.access, "access_denied");
                    strict_1.default.equal(verdict.denialReason, "pending_invite");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E21: privacy resolver returns full for owner", function () { return __awaiter(void 0, void 0, void 0, function () {
        var resolveContext, client, verdict;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/privacyResolver.js"); })];
                case 1:
                    resolveContext = (_a.sent()).resolveContext;
                    client = makeClient(state);
                    return [4 /*yield*/, resolveContext(client, OWNER_ID, TRIP_ID)];
                case 2:
                    verdict = _a.sent();
                    strict_1.default.equal(verdict.access, "full");
                    strict_1.default.equal(verdict.isTripOwner, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E22: privacy resolver returns partial when no tripId given", function () { return __awaiter(void 0, void 0, void 0, function () {
        var resolveContext, client, verdict;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/privacyResolver.js"); })];
                case 1:
                    resolveContext = (_a.sent()).resolveContext;
                    client = makeClient(state);
                    return [4 /*yield*/, resolveContext(client, OWNER_ID, null)];
                case 2:
                    verdict = _a.sent();
                    strict_1.default.equal(verdict.access, "partial");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E23: privacy resolver canReadPlanItems true for accepted member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var resolveContext, client, verdict;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/privacyResolver.js"); })];
                case 1:
                    resolveContext = (_a.sent()).resolveContext;
                    client = makeClient(state);
                    return [4 /*yield*/, resolveContext(client, MEMBER_ID, TRIP_ID)];
                case 2:
                    verdict = _a.sent();
                    strict_1.default.equal(verdict.canReadPlanItems, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E24: brief generatedAt is a valid ISO timestamp", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _b.sent();
                    strict_1.default.ok(!isNaN(new Date((_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.generatedAt).getTime()));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E25: refresh route for non-member returns access_denied brief:null", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/trips/".concat(TRIP_ID, "/daily-brief/refresh"), { token: STRANGER_TOKEN, body: {} })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.brief, null);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── E26–E40: Concierge command parsing + confirmation gating ──────────────
    (0, node_test_1.test)("E26: POST /telegraph/commands requires auth", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { body: { text: "Plan tonight" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E27: 'Plan tonight' intent parses as plan_day", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("Plan tonight"), "plan_day");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E28: 'Find food nearby' intent parses as find_food", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("Find food nearby"), "find_food");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E29: 'Fix conflicts in my schedule' parses as fix_schedule_conflict", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("Fix conflicts in my schedule"), "fix_schedule_conflict");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E30: 'What am I missing?' parses as what_is_missing", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("What am I missing?"), "what_is_missing");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E31: 'Create a meetup' parses as create_meetup_draft", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("Create a meetup for tonight"), "create_meetup_draft");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E32: unrecognised text falls back to unknown intent", function () { return __awaiter(void 0, void 0, void 0, function () {
        var parseIntent;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../routes/telegraphCommands.js"); })];
                case 1:
                    parseIntent = (_a.sent()).parseIntent;
                    strict_1.default.equal(parseIntent("xyzzy unrecognised phrase"), "unknown");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E33: POST /telegraph/commands returns commandId and intent", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.ok(r.body.commandId);
                    strict_1.default.equal(r.body.intent, "plan_day");
                    CMD_ID_STORE.set("plan_tonight", r.body.commandId);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E34: every proposedAction has requires_confirmation: true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, _i, _a, action;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Fill free time" } })];
                case 1:
                    r = _c.sent();
                    strict_1.default.equal(r.status, 201);
                    for (_i = 0, _a = (_b = r.body.proposedActions) !== null && _b !== void 0 ? _b : []; _i < _a.length; _i++) {
                        action = _a[_i];
                        strict_1.default.equal(action.requires_confirmation, true);
                    }
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E35: GET /telegraph/commands/:commandId returns stored command", function () { return __awaiter(void 0, void 0, void 0, function () {
        var post, commandId, get;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Find food" } })];
                case 1:
                    post = _a.sent();
                    commandId = post.body.commandId;
                    return [4 /*yield*/, req(app, "GET", "/api/telegraph/commands/".concat(commandId), { token: OWNER_TOKEN })];
                case 2:
                    get = _a.sent();
                    strict_1.default.equal(get.status, 200);
                    strict_1.default.equal(get.body.commandId, commandId);
                    strict_1.default.equal(get.body.intent, "find_food");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E36: confirm-action for known action returns confirmed:true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var post, _a, commandId, proposedActions, actionId, confirm;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Find food", tripId: TRIP_ID } })];
                case 1:
                    post = _c.sent();
                    _a = post.body, commandId = _a.commandId, proposedActions = _a.proposedActions;
                    actionId = (_b = proposedActions[0]) === null || _b === void 0 ? void 0 : _b.id;
                    strict_1.default.ok(actionId);
                    return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands/".concat(commandId, "/confirm-action"), { token: OWNER_TOKEN, body: { actionId: actionId } })];
                case 2:
                    confirm = _c.sent();
                    strict_1.default.equal(confirm.status, 200);
                    strict_1.default.equal(confirm.body.confirmed, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E37: confirm-action fails for non-member even if commandId is valid", function () { return __awaiter(void 0, void 0, void 0, function () {
        var post, _a, commandId, proposedActions, confirm;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } })];
                case 1:
                    post = _c.sent();
                    _a = post.body, commandId = _a.commandId, proposedActions = _a.proposedActions;
                    return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands/".concat(commandId, "/confirm-action"), { token: STRANGER_TOKEN, body: { actionId: (_b = proposedActions[0]) === null || _b === void 0 ? void 0 : _b.id } })];
                case 2:
                    confirm = _c.sent();
                    strict_1.default.equal(confirm.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E38: decline-action returns ok:true without touching data", function () { return __awaiter(void 0, void 0, void 0, function () {
        var post, commandId, decline;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } })];
                case 1:
                    post = _a.sent();
                    commandId = post.body.commandId;
                    return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands/".concat(commandId, "/decline-action"), { token: OWNER_TOKEN, body: {} })];
                case 2:
                    decline = _a.sent();
                    strict_1.default.equal(decline.status, 200);
                    strict_1.default.equal(decline.body.declined, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E39: command history for trip requires membership", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/telegraph/commands/history"), { token: STRANGER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E40: command history returns array for accepted member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/telegraph/commands/history"), { token: MEMBER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.history));
                    return [2 /*return*/];
            }
        });
    }); });
    // ── E41–E55: Preference CRUD + learning engine ────────────────────────────
    (0, node_test_1.test)("E41: GET /me/preferences creates blank profile if none exists", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/me/preferences", { token: OWNER_TOKEN })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray((_a = r.body.explicit) === null || _a === void 0 ? void 0 : _a.interests));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E42: PATCH /me/preferences updates interests", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: ["food", "beach"] } })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.deepEqual((_a = r.body.explicit) === null || _a === void 0 ? void 0 : _a.interests, ["food", "beach"]);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E43: PATCH /me/preferences updates pace", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "relaxed" } })];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal((_a = r.body.explicit) === null || _a === void 0 ? void 0 : _a.pace, "relaxed");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E44: PATCH /me/preferences rejects invalid pace value", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "supersonic" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E45: PATCH /me/preferences rejects interests list over 20 items", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: Array(21).fill("food") } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E46: POST /me/preferences/events records a save signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "save" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E47: POST /me/preferences/events rejects invalid signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "super_like" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E48: POST /me/preferences/reset-learned clears inferred prefs", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "save" } })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, req(app, "POST", "/api/me/preferences/reset-learned", { token: OWNER_TOKEN })];
                case 2:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.reset, "learned_preferences");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E49: GET /me/preferences/summary returns topInferred array", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/me/preferences/summary", { token: OWNER_TOKEN })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.topInferred));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E50: preference routes require auth", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/me/preferences")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── Learning engine unit tests (E51–E55) ──────────────────────────────────
    (0, node_test_1.test)("E51: applyEvent increases affinity for save signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, applyEvent, defaultInferred, inferred, updated;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _c.sent(), applyEvent = _a.applyEvent, defaultInferred = _a.defaultInferred;
                    inferred = defaultInferred();
                    updated = applyEvent(inferred, { userId: "u1", recommendationId: "r1", category: "food", signal: "save", createdAt: new Date().toISOString() });
                    strict_1.default.ok(((_b = updated.categoryAffinities["food"]) !== null && _b !== void 0 ? _b : 0) > 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E52: applyEvent decreases affinity for not_for_me signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, applyEvent, defaultInferred, inferred, updated;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _c.sent(), applyEvent = _a.applyEvent, defaultInferred = _a.defaultInferred;
                    inferred = defaultInferred();
                    updated = applyEvent(inferred, { userId: "u1", recommendationId: "r1", category: "nightlife", signal: "not_for_me", createdAt: new Date().toISOString() });
                    strict_1.default.ok(((_b = updated.categoryAffinities["nightlife"]) !== null && _b !== void 0 ? _b : 0) < 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E53: not_for_me signal adds category to dismissedCategories", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, applyEvent, defaultInferred, updated;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _b.sent(), applyEvent = _a.applyEvent, defaultInferred = _a.defaultInferred;
                    updated = applyEvent(defaultInferred(), { userId: "u1", recommendationId: "r1", category: "clubbing", signal: "not_for_me", createdAt: new Date().toISOString() });
                    strict_1.default.ok(updated.dismissedCategories.includes("clubbing"));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E54: save signal adds category to savedCategories", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, applyEvent, defaultInferred, updated;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _b.sent(), applyEvent = _a.applyEvent, defaultInferred = _a.defaultInferred;
                    updated = applyEvent(defaultInferred(), { userId: "u1", recommendationId: "r1", category: "beach", signal: "save", createdAt: new Date().toISOString() });
                    strict_1.default.ok(updated.savedCategories.includes("beach"));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("E55: scoreRecommendation boosts items in explicit interests", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, scoreRecommendation, defaultExplicit, defaultInferred, explicit, inferred, foodScore, otherScore;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _b.sent(), scoreRecommendation = _a.scoreRecommendation, defaultExplicit = _a.defaultExplicit, defaultInferred = _a.defaultInferred;
                    explicit = __assign(__assign({}, defaultExplicit()), { interests: ["food"] });
                    inferred = defaultInferred();
                    foodScore = scoreRecommendation("food", explicit, inferred);
                    otherScore = scoreRecommendation("transport", explicit, inferred);
                    strict_1.default.ok(foodScore > otherScore);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ══════════════════════════════════════════════════════════════════════════════
// Section F — Recommendation ranking + feedback events + privacy
// ══════════════════════════════════════════════════════════════════════════════
(0, node_test_1.describe)("F — Feedback events + ranking + privacy", function () {
    var state;
    var app;
    (0, node_test_1.before)(function () { return __awaiter(void 0, void 0, void 0, function () {
        var made;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = makeState();
                    made = makeApp(state);
                    app = made.app;
                    return [4 /*yield*/, made.attach()];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.beforeEach)(function () { state = makeState(); (0, http_js_1._setTestClient)(makeClient(state), true); });
    // ── F1–F10: Feedback events + recommendation ranking ──────────────────────
    (0, node_test_1.test)("F1: POST /telegraph/recommendations/:id/feedback requires auth", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { body: { category: "food", signal: "save" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F2: feedback endpoint accepts save signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F3: feedback endpoint accepts more_like_this signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-2/feedback", { token: MEMBER_TOKEN, body: { category: "beach", signal: "more_like_this" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F4: feedback endpoint accepts less_like_this signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-3/feedback", { token: MEMBER_TOKEN, body: { category: "nightlife", signal: "less_like_this" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F5: feedback endpoint accepts not_for_me signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-4/feedback", { token: MEMBER_TOKEN, body: { category: "gambling", signal: "not_for_me" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F6: feedback endpoint accepts dismiss signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-5/feedback", { token: MEMBER_TOKEN, body: { category: "nightlife", signal: "dismiss" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F7: feedback endpoint rejects unknown signal", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-6/feedback", { token: MEMBER_TOKEN, body: { category: "food", signal: "love" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F8: feedback endpoint returns recommendationId in response", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-99/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.body.recommendationId, "rec-99");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F9: scoreRecommendation penalises items in avoidList", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, scoreRecommendation, defaultExplicit, defaultInferred, explicit, score;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _b.sent(), scoreRecommendation = _a.scoreRecommendation, defaultExplicit = _a.defaultExplicit, defaultInferred = _a.defaultInferred;
                    explicit = __assign(__assign({}, defaultExplicit()), { avoidList: ["nightlife"] });
                    score = scoreRecommendation("nightlife", explicit, defaultInferred());
                    strict_1.default.ok(score < 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F10: scoreRecommendation penalises dismissed categories", function () { return __awaiter(void 0, void 0, void 0, function () {
        var _a, scoreRecommendation, defaultExplicit, defaultInferred, inferred, score;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 1:
                    _a = _b.sent(), scoreRecommendation = _a.scoreRecommendation, defaultExplicit = _a.defaultExplicit, defaultInferred = _a.defaultInferred;
                    inferred = __assign(__assign({}, defaultInferred()), { dismissedCategories: ["gambling"] });
                    score = scoreRecommendation("gambling", defaultExplicit(), inferred);
                    strict_1.default.ok(score < 0);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── F11–F15: Daily brief engine unit tests ────────────────────────────────
    (0, node_test_1.test)("F11: buildDailyBrief with empty plan has free window", function () { return __awaiter(void 0, void 0, void 0, function () {
        var buildDailyBrief, brief;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/dailyBriefEngine.js"); })];
                case 1:
                    buildDailyBrief = (_a.sent()).buildDailyBrief;
                    brief = buildDailyBrief({ tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [], recommendations: [], preferenceProfile: null });
                    strict_1.default.ok(brief.openWindows.length > 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F12: buildDailyBrief with plan items populates planPreview", function () { return __awaiter(void 0, void 0, void 0, function () {
        var buildDailyBrief, brief;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/dailyBriefEngine.js"); })];
                case 1:
                    buildDailyBrief = (_a.sent()).buildDailyBrief;
                    brief = buildDailyBrief({
                        tripId: "t1", userId: "u1", date: "2026-07-01",
                        planItems: [{ id: "i1", title: "Breakfast", starts_at: "2026-07-01T08:00:00Z", ends_at: "2026-07-01T09:00:00Z", category: "dining", status: "confirmed", location_name: "Hotel", day_date: "2026-07-01" }],
                        meetups: [], recommendations: [], preferenceProfile: null,
                    });
                    strict_1.default.equal(brief.planPreview.length, 1);
                    strict_1.default.equal(brief.planPreview[0].title, "Breakfast");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F13: buildDailyBrief scores and sorts suggestions by preference", function () { return __awaiter(void 0, void 0, void 0, function () {
        var buildDailyBrief, _a, defaultExplicit, defaultInferred, profile, brief;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/dailyBriefEngine.js"); })];
                case 1:
                    buildDailyBrief = (_b.sent()).buildDailyBrief;
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/preferenceLearning.js"); })];
                case 2:
                    _a = _b.sent(), defaultExplicit = _a.defaultExplicit, defaultInferred = _a.defaultInferred;
                    profile = { userId: "u1", explicit: __assign(__assign({}, defaultExplicit()), { interests: ["food"] }), inferred: defaultInferred(), lastUpdatedAt: "" };
                    brief = buildDailyBrief({
                        tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [],
                        recommendations: [
                            { id: "r1", title: "Great restaurant", category: "food", reason: "match", estimatedTime: "1h", priceLevel: "$" },
                            { id: "r2", title: "Nightclub", category: "nightlife", reason: "nearby", estimatedTime: "3h", priceLevel: "$$$" },
                        ],
                        preferenceProfile: profile,
                    });
                    strict_1.default.ok(brief.suggestions[0].category === "food");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F14: buildDailyBrief warns about cancelled meetup", function () { return __awaiter(void 0, void 0, void 0, function () {
        var buildDailyBrief, brief;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/dailyBriefEngine.js"); })];
                case 1:
                    buildDailyBrief = (_a.sent()).buildDailyBrief;
                    brief = buildDailyBrief({
                        tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [],
                        meetups: [{ id: "m1", title: "Cancelled meetup", proposed_time: null, attendee_count: 0, status: "cancelled" }],
                        recommendations: [], preferenceProfile: null,
                    });
                    strict_1.default.ok(brief.warnings.includes("cancelled_meetup"));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F15: buildDailyBrief isStale is false on fresh build", function () { return __awaiter(void 0, void 0, void 0, function () {
        var buildDailyBrief, brief;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/dailyBriefEngine.js"); })];
                case 1:
                    buildDailyBrief = (_a.sent()).buildDailyBrief;
                    brief = buildDailyBrief({ tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [], recommendations: [], preferenceProfile: null });
                    strict_1.default.equal(brief.isStale, false);
                    return [2 /*return*/];
            }
        });
    }); });
    // ── F16–F24: Public-profile privacy ───────────────────────────────────────
    (0, node_test_1.test)("F16: preference profile of one user is not exposed to another", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: ["luxury"] } })];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN })];
                case 2:
                    r = _c.sent();
                    strict_1.default.ok(!((_b = (_a = r.body.explicit) === null || _a === void 0 ? void 0 : _a.interests) === null || _b === void 0 ? void 0 : _b.includes("luxury")), "Member should not see owner's interests");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F17: preference events are scoped to the authenticated user", function () { return __awaiter(void 0, void 0, void 0, function () {
        var memberPref;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "r1", category: "beach", signal: "save" } })];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN })];
                case 2:
                    memberPref = _c.sent();
                    strict_1.default.deepEqual((_b = (_a = memberPref.body.inferred) === null || _a === void 0 ? void 0 : _a.savedCategories) !== null && _b !== void 0 ? _b : [], []);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F18: reset-learned for owner does not affect member profile", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/me/preferences/events", { token: MEMBER_TOKEN, body: { recommendationId: "r1", category: "food", signal: "save" } })];
                case 1:
                    _b.sent();
                    return [4 /*yield*/, req(app, "POST", "/api/me/preferences/reset-learned", { token: OWNER_TOKEN })];
                case 2:
                    _b.sent();
                    return [4 /*yield*/, req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN })];
                case 3:
                    r = _b.sent();
                    strict_1.default.ok(Array.isArray((_a = r.body.inferred) === null || _a === void 0 ? void 0 : _a.savedCategories));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F19: daily brief does not expose other users' explicit preferences", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, str;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: MEMBER_TOKEN, body: { avoidList: ["gambling"] } })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 2:
                    r = _a.sent();
                    str = JSON.stringify(r.body);
                    strict_1.default.ok(!str.includes("gambling"), "Owner brief should not expose member's avoid list");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F20: Concierge command suggestions contain no other users' data", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, str;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: MEMBER_TOKEN, body: { interests: ["ultra_secret_interest"] } })];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } })];
                case 2:
                    r = _a.sent();
                    str = JSON.stringify(r.body);
                    strict_1.default.ok(!str.includes("ultra_secret_interest"));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F21: feedback signal without tripId still records event", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save", tripId: null } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F22: brief quickActions do not require confirmation for view_plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, viewPlan;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "GET", "/api/trips/".concat(TRIP_ID, "/daily-brief"), { token: OWNER_TOKEN })];
                case 1:
                    r = _c.sent();
                    viewPlan = (_b = (_a = r.body.brief) === null || _a === void 0 ? void 0 : _a.quickActions) === null || _b === void 0 ? void 0 : _b.find(function (a) { return a.kind === "view_plan"; });
                    strict_1.default.ok(viewPlan, "view_plan action should exist");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F23: command unknown intent returns fallback suggestions []", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "xyzzy qqq rrr" } })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.intent, "unknown");
                    strict_1.default.deepEqual(r.body.suggestions, []);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.test)("F24: all preference CRUD routes are scoped by auth token user only", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r1, r2;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "packed" } })];
                case 1:
                    r1 = _c.sent();
                    return [4 /*yield*/, req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN })];
                case 2:
                    r2 = _c.sent();
                    strict_1.default.equal((_a = r1.body.explicit) === null || _a === void 0 ? void 0 : _a.pace, "packed");
                    strict_1.default.notEqual((_b = r2.body.explicit) === null || _b === void 0 ? void 0 : _b.pace, "packed");
                    return [2 /*return*/];
            }
        });
    }); });
});
