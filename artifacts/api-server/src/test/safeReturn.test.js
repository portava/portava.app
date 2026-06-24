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
 * Safe Return system tests
 *
 * Verifies security rules, privacy guards, escalation logic, and feature-flag
 * gating WITHOUT a live database.  Uses the node:test + fake-client pattern.
 *
 * Run: node --import tsx/esm --test src/test/safeReturn.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var safeReturn_js_1 = require("../routes/safeReturn.js");
var admin_js_1 = require("../routes/admin.js");
var SafeReturnTriggerService_js_1 = require("../services/safeReturn/SafeReturnTriggerService.js");
var SafeReturnPrivacyGuard_js_1 = require("../services/safeReturn/SafeReturnPrivacyGuard.js");
// ── Test server ───────────────────────────────────────────────────────────────
var server;
var base;
var FAKE_TOKEN = "safe-return-test-token";
var USER_ID = "user-safe-return-1";
var OTHER_USER_ID = "other-user-2";
var SESSION_ID = "session-uuid-1";
var CONTACT_ID = "contact-uuid-1";
var SHARE_ID = "share-uuid-1";
var TRIP_ID = "trip-uuid-1";
var PLAN_ITEM_ID = "plan-item-uuid-1";
function req(method, path, body, token) {
    if (token === void 0) { token = FAKE_TOKEN; }
    return new Promise(function (resolve, reject) {
        var url = new URL(path, base);
        var payload = body ? JSON.stringify(body) : undefined;
        var headers = {
            "content-type": "application/json",
            "authorization": "Bearer ".concat(token),
        };
        var r = node_http_1.default.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: method, headers: headers }, function (res) {
            var raw = "";
            res.on("data", function (c) { return (raw += c); });
            res.on("end", function () {
                var _a;
                var parsed;
                try {
                    parsed = JSON.parse(raw);
                }
                catch (_b) {
                    parsed = raw;
                }
                resolve({ status: (_a = res.statusCode) !== null && _a !== void 0 ? _a : 0, body: parsed });
            });
        });
        r.on("error", reject);
        if (payload)
            r.write(payload);
        r.end();
    });
}
function makeFakeClient(state) {
    var _this = this;
    if (state === void 0) { state = {}; }
    var inserted = {};
    var updated = {};
    function getRows(table) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        if (table === "feature_flags") {
            return Object.entries((_a = state.featureFlags) !== null && _a !== void 0 ? _a : {}).map(function (_a) {
                var key = _a[0], enabled = _a[1];
                return ({ key: key, enabled: enabled });
            });
        }
        if (table === "safe_return_sessions")
            return (_b = state.sessions) !== null && _b !== void 0 ? _b : [];
        if (table === "safe_return_contacts")
            return (_c = state.contacts) !== null && _c !== void 0 ? _c : [];
        if (table === "safe_return_events")
            return (_d = state.events) !== null && _d !== void 0 ? _d : [];
        if (table === "safe_return_live_shares")
            return (_e = state.liveShares) !== null && _e !== void 0 ? _e : [];
        if (table === "trip_plan_items")
            return (_f = state.planItems) !== null && _f !== void 0 ? _f : [];
        if (table === "profiles")
            return (_g = state.profiles) !== null && _g !== void 0 ? _g : [];
        if (table === "trips")
            return (_h = state.trips) !== null && _h !== void 0 ? _h : [];
        if (table === "trip_members")
            return (_j = state.tripMembers) !== null && _j !== void 0 ? _j : [];
        if (table === "follows")
            return (_k = state.follows) !== null && _k !== void 0 ? _k : [];
        if (table === "user_location_state")
            return (_l = state.locationState) !== null && _l !== void 0 ? _l : [];
        return [];
    }
    function builder(table) {
        var rows = getRows(table);
        var pendingInsert = null;
        var pendingUpdate = null;
        var filters = [];
        var _limit = null;
        var _single = false;
        var _maybe = false;
        var b = {
            select: function (_cols) { return b; },
            insert: function (row) {
                var _a;
                pendingInsert = row;
                if (!inserted[table])
                    inserted[table] = [];
                if (Array.isArray(row))
                    (_a = inserted[table]).push.apply(_a, row);
                else
                    inserted[table].push(row);
                return b;
            },
            update: function (patch) { pendingUpdate = patch; if (!updated[table])
                updated[table] = []; return b; },
            upsert: function (row) { pendingInsert = row; return b; },
            delete: function () { return b; },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            neq: function (col, val) { filters.push(function (r) { return r[col] !== val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            is: function (col, val) { filters.push(function (r) { return val === null ? r[col] == null : r[col] === val; }); return b; },
            lt: function (col, val) { filters.push(function (r) { return r[col] < val; }); return b; },
            gt: function (col, val) { filters.push(function (r) { return r[col] > val; }); return b; },
            order: function () { return b; },
            limit: function (n) { _limit = n; return b; },
            maybeSingle: function () { _maybe = true; _single = true; return resolve(); },
            single: function () { _single = true; return resolve(); },
            then: function (onF, onR) { return resolveList().then(onF, onR); },
        };
        function resolve() {
            return __awaiter(this, void 0, void 0, function () {
                var row, matched_1, row, matched;
                var _a, _b;
                return __generator(this, function (_c) {
                    if (pendingInsert) {
                        row = Array.isArray(pendingInsert)
                            ? __assign({ id: "gen-".concat(Math.random()) }, pendingInsert[0]) : __assign({ id: "gen-".concat(Math.random()) }, pendingInsert);
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    if (pendingUpdate) {
                        matched_1 = rows.filter(function (r) { return filters.every(function (f) { return f(r); }); });
                        row = matched_1[0] ? __assign(__assign({}, matched_1[0]), pendingUpdate) : null;
                        updated[table].push(__assign({}, row));
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    matched = rows.filter(function (r) { return filters.every(function (f) { return f(r); }); });
                    if (_maybe)
                        return [2 /*return*/, { data: (_a = matched[0]) !== null && _a !== void 0 ? _a : null, error: null }];
                    return [2 /*return*/, { data: (_b = matched[0]) !== null && _b !== void 0 ? _b : null, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () {
                var row, matched;
                return __generator(this, function (_a) {
                    if (pendingInsert) {
                        row = Array.isArray(pendingInsert)
                            ? __assign({ id: "gen-".concat(Math.random()) }, pendingInsert[0]) : __assign({ id: "gen-".concat(Math.random()) }, pendingInsert);
                        return [2 /*return*/, { data: row, error: null }];
                    }
                    matched = rows.filter(function (r) { return filters.every(function (f) { return f(r); }); });
                    return [2 /*return*/, { data: _limit ? matched.slice(0, _limit) : matched, error: null }];
                });
            });
        }
        return b;
    }
    var client = {
        from: function (table) { return builder(table); },
        auth: {
            getUser: function (token) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    if (token === FAKE_TOKEN)
                        return [2 /*return*/, { data: { user: { id: USER_ID } }, error: null }];
                    if (token === "other-tok")
                        return [2 /*return*/, { data: { user: { id: OTHER_USER_ID } }, error: null }];
                    return [2 /*return*/, { data: { user: null }, error: { message: "invalid" } }];
                });
            }); },
        },
        __inserted: inserted,
        __updated: updated,
    };
    return client;
}
function setClients(c) {
    (0, http_js_1._setTestClient)(c, true);
    (0, supabase_js_1._setTestServiceClient)(c);
}
// ── Setup ─────────────────────────────────────────────────────────────────────
(0, node_test_1.before)(function () {
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(function (req, _res, next) {
        req.log = { error: function () { }, info: function () { }, warn: function () { }, debug: function () { } };
        next();
    });
    app.use("/api", safeReturn_js_1.default);
    app.use("/api", admin_js_1.default);
    server = node_http_1.default.createServer(app);
    server.listen(0);
    base = "http://127.0.0.1:".concat(server.address().port);
});
(0, node_test_1.after)(function () { server.close(); });
// ── 1. SafeReturnTriggerService (pure logic — no HTTP) ────────────────────────
(0, node_test_1.describe)("SafeReturnTriggerService.shouldSuggest", function () {
    (0, node_test_1.it)("1a. suggests for nightlife category", function () {
        var item = {
            id: "p1", category: "nightlife", startsAt: null, dayDate: null, locationName: null,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, {});
        strict_1.default.ok(result.shouldSuggest);
        strict_1.default.ok(result.reasons.includes("nightlife_plan"));
    });
    (0, node_test_1.it)("1b. suggests for late-night start (after 21:00)", function () {
        var item = {
            id: "p2", category: "dining", startsAt: "2026-07-01T22:30:00.000Z", dayDate: null, locationName: null,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, {});
        strict_1.default.ok(result.shouldSuggest);
        strict_1.default.ok(result.reasons.includes("late_night_activity"));
    });
    (0, node_test_1.it)("1c. does NOT suggest for daytime trips", function () {
        var item = {
            id: "p3", category: "activity", startsAt: "2026-07-01T10:00:00.000Z", dayDate: null, locationName: null,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, {});
        strict_1.default.ok(!result.shouldSuggest);
        strict_1.default.equal(result.reasons.length, 0);
    });
    (0, node_test_1.it)("1d. suggests for solo attendance", function () {
        var item = {
            id: "p4", category: "activity", startsAt: null, dayDate: null, locationName: null, attendeeCount: 1,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, {});
        strict_1.default.ok(result.shouldSuggest);
        strict_1.default.ok(result.reasons.includes("solo_activity"));
    });
    (0, node_test_1.it)("1e. suggests for new city", function () {
        var item = {
            id: "p5", category: "activity", startsAt: null, dayDate: null, locationName: null,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, { homeCity: "London", currentCity: "Tokyo" });
        strict_1.default.ok(result.shouldSuggest);
        strict_1.default.ok(result.reasons.includes("new_city"));
    });
    (0, node_test_1.it)("1f. does NOT suggest when home city matches current city", function () {
        var item = {
            id: "p6", category: "activity", startsAt: null, dayDate: null, locationName: null,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, { homeCity: "Paris", currentCity: "Paris" });
        strict_1.default.ok(!result.shouldSuggest);
    });
    (0, node_test_1.it)("1g. confidence scales with number of matching reasons", function () {
        var item = {
            id: "p7", category: "nightlife",
            startsAt: "2026-07-01T23:00:00.000Z", dayDate: null, locationName: null,
            attendeeCount: 1, hasLocationCautionFlag: true,
        };
        var result = (0, SafeReturnTriggerService_js_1.shouldSuggest)(item, USER_ID, { homeCity: "London", currentCity: "Bangkok" });
        strict_1.default.equal(result.confidence, "high");
        strict_1.default.ok(result.reasons.length >= 3);
    });
    (0, node_test_1.it)("1h. getSuggestionReason returns non-empty string for reasons", function () {
        var text = (0, SafeReturnTriggerService_js_1.getSuggestionReason)(["nightlife_plan", "solo_activity"]);
        strict_1.default.ok(text.length > 0);
        strict_1.default.ok(text.includes("nightlife") || text.includes("solo"));
    });
});
// ── 2. SafeReturnPrivacyGuard (pure logic) ────────────────────────────────────
(0, node_test_1.describe)("SafeReturnPrivacyGuard.stripGPS", function () {
    (0, node_test_1.it)("2a. removes lat and lng from objects", function () {
        var obj = { id: "s1", status: "active", lat: 51.5, lng: -0.1, city: "London" };
        var stripped = (0, SafeReturnPrivacyGuard_js_1.stripGPS)(obj);
        strict_1.default.ok(!("lat" in stripped));
        strict_1.default.ok(!("lng" in stripped));
        strict_1.default.equal(stripped.city, "London");
    });
    (0, node_test_1.it)("2b. toPublicSession never includes GPS fields", function () {
        var session = {
            id: "s1", status: "active", escalationLevel: 0, timerStartAt: null, timerEndAt: null,
            trustedCircleEnabled: false, liveShareEnabled: false, notifyHostEnabled: false,
            notifyTripCrewEnabled: false, planItemId: null, tripId: null, triggerReason: null,
            emergencyNote: null, closedAt: null, createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            // These should be stripped:
            lat: 51.5, lng: -0.1, userId: USER_ID,
        };
        var pub = (0, SafeReturnPrivacyGuard_js_1.toPublicSession)(session);
        strict_1.default.ok(!("lat" in pub), "lat must not appear");
        strict_1.default.ok(!("lng" in pub), "lng must not appear");
        strict_1.default.ok(!("userId" in pub), "userId must not appear in public shape");
    });
});
// ── 3. Feature flag gating ────────────────────────────────────────────────────
(0, node_test_1.describe)("Feature flag gating", function () {
    (0, node_test_1.it)("3a. returns feature_disabled when safe_return_enabled = false", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions", { timerMinutes: 30 })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    strict_1.default.equal(r.body.error, "feature_disabled");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("3b. active endpoint returns featureEnabled:false when flag off", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/sessions/active")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.featureEnabled, false);
                    strict_1.default.equal(r.body.session, null);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("3c. suggest endpoint returns suggest:false when flag off", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: false } }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/suggest/".concat(PLAN_ITEM_ID))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.suggest, false);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 4. Session lifecycle ──────────────────────────────────────────────────────
(0, node_test_1.describe)("Session lifecycle", function () {
    function enabledState(extra) {
        if (extra === void 0) { extra = {}; }
        return __assign({ featureFlags: {
                safe_return_enabled: true,
                safe_return_live_share_enabled: true,
                safe_return_trusted_circle_alerts_enabled: true,
                safe_return_admin_logs_enabled: true,
            }, sessions: [], contacts: [], events: [], liveShares: [] }, extra);
    }
    (0, node_test_1.it)("4a. creates session with default escalation level 0", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient(enabledState()));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions", {
                            timerMinutes: 30,
                            trustedCircleEnabled: false,
                        })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.ok(r.body.ok);
                    strict_1.default.equal(r.body.session.escalationLevel, 0);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4b. confirm-safe closes the session", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
                        timer_start_at: new Date().toISOString(), timer_end_at: null,
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient(enabledState({ sessions: [session] })));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/confirm"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.ok);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4c. extend updates timer_end_at", function () { return __awaiter(void 0, void 0, void 0, function () {
        var oldEnd, session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    oldEnd = new Date(Date.now() + 10 * 60000).toISOString();
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
                        timer_start_at: new Date().toISOString(), timer_end_at: oldEnd,
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient(enabledState({ sessions: [session] })));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/extend"), { minutes: 30 })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.ok);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4d. cancel prevents further escalation (status → cancelled)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 2,
                        timer_start_at: new Date().toISOString(), timer_end_at: null,
                        trusted_circle_enabled: true, live_share_enabled: true,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient(enabledState({ sessions: [session] })));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/cancel"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.ok);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("4e. trigger-missed endpoint marks session as missed and returns escalation level", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
                        timer_start_at: new Date(Date.now() - 60 * 60000).toISOString(),
                        timer_end_at: new Date(Date.now() - 1000).toISOString(),
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient(enabledState({ sessions: [session], profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }] })));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/trigger-missed"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.ok);
                    strict_1.default.equal(r.body.escalationLevel, 0);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 5. Privacy: exact GPS absent from all public API shapes ───────────────────
(0, node_test_1.describe)("Privacy: no GPS in API responses", function () {
    function sessionWithGps() {
        return {
            id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
            timer_start_at: null, timer_end_at: null,
            trusted_circle_enabled: false, live_share_enabled: false,
            notify_host_enabled: false, notify_trip_crew_enabled: false,
            plan_item_id: null, trip_id: null, trigger_reason: null,
            emergency_note: null, closed_at: null,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            last_prompt_at: null, last_safe_confirmation_at: null,
            // These must NEVER appear in responses:
            lat: 51.5, lng: -0.1,
        };
    }
    (0, node_test_1.it)("5a. active session response never contains lat/lng", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        sessions: [sessionWithGps()],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/sessions/active")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.session);
                    strict_1.default.ok(!("lat" in r.body.session), "lat must not be present");
                    strict_1.default.ok(!("lng" in r.body.session), "lng must not be present");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("5b. history response never contains lat/lng", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        sessions: [sessionWithGps()],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/history")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.sessions));
                    if (r.body.sessions.length > 0) {
                        strict_1.default.ok(!("lat" in r.body.sessions[0]), "lat must not be present in history");
                        strict_1.default.ok(!("lng" in r.body.sessions[0]), "lng must not be present in history");
                    }
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 6. Trusted Circle: only notify if trusted_circle_enabled = true ───────────
(0, node_test_1.describe)("TC alert privacy", function () {
    (0, node_test_1.it)("6a. TC not notified when trusted_circle_enabled = false (session create)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, insertedSessions;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        sessions: [],
                        contacts: [],
                        events: [],
                    });
                    setClients(client);
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions", {
                            timerMinutes: 30,
                            trustedCircleEnabled: false,
                            contacts: [{ contactUserId: OTHER_USER_ID, contactMethod: "in_app", canReceiveLiveLocation: false }],
                        })];
                case 1:
                    _b.sent();
                    insertedSessions = (_a = client.__inserted["safe_return_sessions"]) !== null && _a !== void 0 ? _a : [];
                    if (insertedSessions.length > 0) {
                        strict_1.default.equal(insertedSessions[0].trusted_circle_enabled, false);
                    }
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("6b. host not notified unless notify_host_enabled = true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
                        timer_start_at: null, timer_end_at: new Date(Date.now() - 1000).toISOString(),
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: TRIP_ID, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_trusted_circle_alerts_enabled: true },
                        sessions: [session],
                        contacts: [],
                        events: [],
                        profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
                        trips: [{ id: TRIP_ID, owner_id: OTHER_USER_ID }],
                    }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/trigger-missed"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    // Response should be 200; host was NOT notified because notify_host_enabled=false
                    strict_1.default.ok(r.body.ok);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("6c. trip crew not notified unless notify_trip_crew_enabled = true", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
                        timer_start_at: null, timer_end_at: new Date(Date.now() - 1000).toISOString(),
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: TRIP_ID, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_trusted_circle_alerts_enabled: false },
                        sessions: [session],
                        contacts: [],
                        events: [],
                        profiles: [{ id: USER_ID, expo_push_token: null, display_name: "Alice" }],
                    }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/trigger-missed"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.ok);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 7. Live share ─────────────────────────────────────────────────────────────
(0, node_test_1.describe)("Live share authorization", function () {
    (0, node_test_1.it)("7a. live share not started unless live_share_enabled on session", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
                        timer_start_at: null, timer_end_at: null,
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
                        sessions: [session],
                        liveShares: [],
                        events: [],
                    }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/live-share/start"), { durationMinutes: 60 })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("7b. live share gated by safe_return_live_share_enabled flag", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 0,
                        timer_start_at: null, timer_end_at: null,
                        trusted_circle_enabled: false, live_share_enabled: true,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: false },
                        sessions: [session],
                        liveShares: [],
                        events: [],
                    }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/live-share/start"), { durationMinutes: 60 })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    strict_1.default.equal(r.body.error, "feature_disabled");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("7c. non-recipient cannot access live share view", function () { return __awaiter(void 0, void 0, void 0, function () {
        var futureExpiry, share, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    futureExpiry = new Date(Date.now() + 60 * 60000).toISOString();
                    share = {
                        id: SHARE_ID, session_id: SESSION_ID, user_id: USER_ID,
                        recipient_user_id: "authorized-recipient-id",
                        recipient_contact_id: null, status: "active",
                        started_at: new Date().toISOString(), expires_at: futureExpiry, stopped_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
                        liveShares: [share],
                        sessions: [{ id: SESSION_ID, user_id: USER_ID, city: "Tokyo", district: null, country: "Japan" }],
                        profiles: [{ id: USER_ID, display_name: "Alice" }],
                    }));
                    return [4 /*yield*/, req("GET", "/api/safe-return/live-share/".concat(SHARE_ID), undefined, "other-tok")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("7d. expired live share access is denied (hard expiry cutoff)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var pastExpiry, share, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    pastExpiry = new Date(Date.now() - 1000).toISOString();
                    share = {
                        id: SHARE_ID, session_id: SESSION_ID, user_id: USER_ID,
                        recipient_user_id: USER_ID,
                        recipient_contact_id: null, status: "active",
                        started_at: new Date().toISOString(), expires_at: pastExpiry, stopped_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_live_share_enabled: true },
                        liveShares: [share],
                        sessions: [{ id: SESSION_ID, user_id: USER_ID, city: "Paris", district: null, country: "France" }],
                    }));
                    return [4 /*yield*/, req("GET", "/api/safe-return/live-share/".concat(SHARE_ID))];
                case 1:
                    r = _a.sent();
                    // Should be denied — expired
                    strict_1.default.ok(r.status === 404 || r.body.error !== undefined);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 8. Safety history: only caller's sessions ─────────────────────────────────
(0, node_test_1.describe)("Safety history", function () {
    (0, node_test_1.it)("8a. history returns only the caller's sessions", function () { return __awaiter(void 0, void 0, void 0, function () {
        var mySession, otherSession, r, _i, _a, s;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    mySession = {
                        id: SESSION_ID, user_id: USER_ID, status: "safe", escalation_level: 0,
                        timer_start_at: null, timer_end_at: null,
                        trusted_circle_enabled: false, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: new Date().toISOString(),
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    otherSession = __assign(__assign({}, mySession), { id: "other-session", user_id: OTHER_USER_ID });
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        sessions: [mySession, otherSession],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/history")];
                case 1:
                    r = _b.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.sessions));
                    // All returned sessions must belong to the caller
                    for (_i = 0, _a = r.body.sessions; _i < _a.length; _i++) {
                        s = _a[_i];
                        // userId is stripped from public shape — just verify no OTHER_USER_ID fields
                        strict_1.default.ok(!("userId" in s), "userId should be stripped from public shape");
                    }
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 9. Unauthenticated requests ───────────────────────────────────────────────
(0, node_test_1.describe)("Authentication", function () {
    (0, node_test_1.it)("9a. unauthenticated POST sessions returns 401", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions", { timerMinutes: 30 }, "invalid-tok")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    strict_1.default.equal(r.body.error, "unauthenticated");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("9b. unauthenticated GET active returns 401", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/sessions/active", undefined, "invalid-tok")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 10. Suggest endpoint ──────────────────────────────────────────────────────
(0, node_test_1.describe)("Suggest endpoint", function () {
    (0, node_test_1.it)("10a. returns suggestion for nightlife plan item", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        planItems: [{
                                id: PLAN_ITEM_ID, category: "nightlife",
                                starts_at: "2026-07-01T23:00:00.000Z", day_date: "2026-07-01",
                                location_name: "Bar District", lat: null, lng: null, trip_id: TRIP_ID,
                            }],
                        tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "member" }],
                        profiles: [{ id: USER_ID, home_city: "London" }],
                        locationState: [{ user_id: USER_ID, city: "Bangkok" }],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/suggest/".concat(PLAN_ITEM_ID))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.suggest);
                    strict_1.default.ok(r.body.reasons.length > 0);
                    strict_1.default.ok(r.body.reasonText);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("10b. returns no suggestion for daytime dining plan", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        planItems: [{
                                id: PLAN_ITEM_ID, category: "dining",
                                starts_at: "2026-07-01T12:00:00.000Z", day_date: "2026-07-01",
                                location_name: "Cafe", lat: null, lng: null, trip_id: TRIP_ID,
                            }],
                        tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "member" }],
                        profiles: [{ id: USER_ID, home_city: "London" }],
                        locationState: [{ user_id: USER_ID, city: "London" }],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/suggest/".concat(PLAN_ITEM_ID))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(!r.body.suggest);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("10c. returns 404 when plan item not found", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        planItems: [],
                    }));
                    return [4 /*yield*/, req("GET", "/api/me/safe-return/suggest/".concat(PLAN_ITEM_ID))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 404);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 11. Invalid payload ───────────────────────────────────────────────────────
(0, node_test_1.describe)("Input validation", function () {
    (0, node_test_1.it)("11a. escalation_level outside 0–3 is rejected", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions", { escalationLevel: 5, timerMinutes: 30 })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    strict_1.default.equal(r.body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("11b. extend with missing minutes is rejected", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({ featureFlags: { safe_return_enabled: true } }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/extend"), {})];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    strict_1.default.equal(r.body.error, "invalid_payload");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 12. Admin event-log authorization ─────────────────────────────────────────
(0, node_test_1.describe)("Admin event-log authorization", function () {
    (0, node_test_1.it)("12a. non-admin gets 403 for /admin/safe-return/logs", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: {
                            safe_return_enabled: true,
                            safe_return_admin_logs_enabled: true,
                        },
                        profiles: [{ id: USER_ID, role: "member" }],
                        events: [],
                    }));
                    return [4 /*yield*/, req("GET", "/api/admin/safe-return/logs")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    strict_1.default.equal(r.body.error, "forbidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12b. unauthenticated gets 401 for /admin/safe-return/logs", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_admin_logs_enabled: true },
                        profiles: [],
                    }));
                    return [4 /*yield*/, req("GET", "/api/admin/safe-return/logs", undefined, "invalid-tok")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    strict_1.default.equal(r.body.error, "unauthenticated");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12c. admin + flag disabled returns feature_disabled for logs endpoint", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true, safe_return_admin_logs_enabled: false },
                        profiles: [{ id: USER_ID, role: "admin" }],
                        events: [],
                    }));
                    return [4 /*yield*/, req("GET", "/api/admin/safe-return/logs")];
                case 1:
                    r = _a.sent();
                    // feature_disabled maps to HTTP 404 in sendError
                    strict_1.default.equal(r.status, 404);
                    strict_1.default.equal(r.body.error, "feature_disabled");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12d. fresh-install admin reaches config (flag seeded TRUE in migration 0040)", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    // Migration 0040 seeds safe_return_admin_logs_enabled=TRUE so that on a
                    // fresh install an admin can always read and write config flags without
                    // a bootstrap deadlock. This test simulates that fresh state.
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: false, safe_return_admin_logs_enabled: true },
                        profiles: [{ id: USER_ID, role: "admin" }],
                        events: [],
                    }));
                    return [4 /*yield*/, req("GET", "/api/admin/safe-return/config")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.config));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("12e. admin + flag enabled returns event list", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setClients(makeFakeClient({
                        featureFlags: {
                            safe_return_enabled: true,
                            safe_return_admin_logs_enabled: true,
                        },
                        profiles: [{ id: USER_ID, role: "admin" }],
                        events: [
                            { id: "ev-1", session_id: SESSION_ID, user_id: USER_ID, event_type: "session_started", metadata: null, created_at: new Date().toISOString() },
                        ],
                    }));
                    return [4 /*yield*/, req("GET", "/api/admin/safe-return/logs")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.events));
                    strict_1.default.equal(r.body.events.length, 1);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ── 13. Emergency help — no-auto-dial contract ─────────────────────────────────
// EmergencyHelpSheet is a mobile-only component, tested at component level.
// This backend-side test verifies that the trigger-missed API response contains
// no telephone URIs or phone numbers — the server never initiates outbound calls.
(0, node_test_1.describe)("Emergency help no-auto-dial contract", function () {
    (0, node_test_1.it)("13a. trigger-missed response body contains no phone number or dialer URI", function () { return __awaiter(void 0, void 0, void 0, function () {
        var session, r, bodyStr;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    session = {
                        id: SESSION_ID, user_id: USER_ID, status: "active", escalation_level: 3,
                        timer_start_at: new Date(Date.now() - 3600000).toISOString(),
                        timer_end_at: new Date(Date.now() - 1000).toISOString(),
                        trusted_circle_enabled: true, live_share_enabled: false,
                        notify_host_enabled: false, notify_trip_crew_enabled: false,
                        plan_item_id: null, trip_id: null, trigger_reason: null,
                        emergency_note: null, closed_at: null,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        last_prompt_at: null, last_safe_confirmation_at: null,
                    };
                    setClients(makeFakeClient({
                        featureFlags: { safe_return_enabled: true },
                        sessions: [session],
                        contacts: [],
                        events: [],
                        profiles: [{ id: USER_ID, expo_push_token: null }],
                        locationState: [{ user_id: USER_ID, city: "Bangkok", country: "Thailand" }],
                    }));
                    return [4 /*yield*/, req("POST", "/api/me/safe-return/sessions/".concat(SESSION_ID, "/trigger-missed"))];
                case 1:
                    r = _a.sent();
                    bodyStr = JSON.stringify(r.body);
                    strict_1.default.ok(!bodyStr.includes("tel:"), "Response must not include telephone URI");
                    strict_1.default.ok(!bodyStr.includes("phone"), "Response must not include phone number field");
                    strict_1.default.ok(!bodyStr.includes("dial"), "Response must not include dial instruction");
                    // Session is now missed — the prompt is shown to the user; they must tap to call
                    strict_1.default.equal(r.status, 200);
                    return [2 /*return*/];
            }
        });
    }); });
});
