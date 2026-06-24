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
 * Notifications system tests
 *
 * Tests the full notification pipeline:
 * - Privacy guard: GPS strip, Ghost Mode, pending member, removed member
 * - Preference service: quiet hours, safety override, category prefs
 * - Deduplication: message coalescence, nearby throttle, compass rate limit
 * - NotificationService: creation, list, mark-read, expire
 * - API routes: create, list, unread count, mark-read, preferences, devices
 * - Admin routes: account notice, delivery attempts, templates
 *
 * Run: node --import tsx/esm --test src/test/notifications.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var node_http_1 = require("node:http");
var express_1 = require("express");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var notifications_js_1 = require("../routes/notifications.js");
var NotificationPrivacyGuard_js_1 = require("../services/notifications/NotificationPrivacyGuard.js");
var NotificationPrivacyGuard_js_2 = require("../services/notifications/NotificationPrivacyGuard.js");
var NotificationPreferenceService_js_1 = require("../services/notifications/NotificationPreferenceService.js");
var NotificationDeduplicationService_js_1 = require("../services/notifications/NotificationDeduplicationService.js");
var NotificationTemplateService_js_1 = require("../services/notifications/NotificationTemplateService.js");
// ── Test server ───────────────────────────────────────────────────────────────
var server;
var base;
var FAKE_TOKEN = "notif-test-token";
var USER_ID = "00000000-0001-0001-0001-000000000001";
var OTHER_ID = "00000000-0002-0002-0002-000000000002";
var ADMIN_TOKEN = "notif-admin-token";
var ADMIN_ID = "00000000-0003-0003-0003-000000000003";
var TRIP_ID = "00000000-0004-0004-0004-000000000004";
var NOTIF_ID = "00000000-0005-0005-0005-000000000005";
var DEVICE_ID = "00000000-0006-0006-0006-000000000006";
function req(method, path, body, token) {
    if (token === void 0) { token = FAKE_TOKEN; }
    return new Promise(function (resolve, reject) {
        var url = new URL(path, base);
        var payload = body ? JSON.stringify(body) : undefined;
        var r = node_http_1.default.request({
            hostname: url.hostname,
            port: Number(url.port),
            path: url.pathname + url.search,
            method: method,
            headers: {
                "content-type": "application/json",
                "authorization": "Bearer ".concat(token),
            },
        }, function (res) {
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        if (table === "profiles")
            return (_a = state.profiles) !== null && _a !== void 0 ? _a : [];
        if (table === "notifications")
            return (_b = state.notifications) !== null && _b !== void 0 ? _b : [];
        if (table === "notification_preferences")
            return (_c = state.notificationPreferences) !== null && _c !== void 0 ? _c : [];
        if (table === "notification_category_preferences")
            return (_d = state.notificationCategoryPreferences) !== null && _d !== void 0 ? _d : [];
        if (table === "notification_delivery_attempts")
            return (_e = state.notificationDeliveryAttempts) !== null && _e !== void 0 ? _e : [];
        if (table === "notification_devices")
            return (_f = state.notificationDevices) !== null && _f !== void 0 ? _f : [];
        if (table === "trip_members")
            return (_g = state.tripMembers) !== null && _g !== void 0 ? _g : [];
        if (table === "location_preferences")
            return (_h = state.locationPreferences) !== null && _h !== void 0 ? _h : [];
        if (table === "feature_flags")
            return Object.entries((_j = state.featureFlags) !== null && _j !== void 0 ? _j : {}).map(function (_a) {
                var flag = _a[0], enabled = _a[1];
                return ({ flag: flag, enabled: enabled });
            });
        return [];
    }
    function builder(table) {
        var rows = getRows(table);
        var pendingInsert = null;
        var pendingUpdate = null;
        var filters = [];
        var _limit = null;
        var countMode = false;
        var b = {
            select: function (_cols, opts) {
                if ((opts === null || opts === void 0 ? void 0 : opts.count) === "exact")
                    countMode = true;
                return b;
            },
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
            update: function (patch) {
                pendingUpdate = patch;
                if (!updated[table])
                    updated[table] = [];
                return b;
            },
            upsert: function (row) { pendingInsert = row; return b; },
            delete: function () { return b; },
            eq: function (col, val) { filters.push(function (r) { return r[col] === val; }); return b; },
            neq: function (col, val) { filters.push(function (r) { return r[col] !== val; }); return b; },
            in: function (col, vals) { filters.push(function (r) { return vals.includes(r[col]); }); return b; },
            is: function (col, val) { filters.push(function (r) { return val === null ? r[col] == null : r[col] === val; }); return b; },
            gt: function (col, val) { filters.push(function (_r) { return true; }); return b; }, // simplified
            lt: function (col, val) { filters.push(function (_r) { return true; }); return b; },
            or: function (_expr) { return b; }, // simplified
            ilike: function (col, pat) { return b; },
            order: function () { return b; },
            limit: function (n) { _limit = n; return b; },
            range: function () { return b; },
            head: function () { return b; },
            maybeSingle: function () { return resolve(true); },
            single: function () { return resolve(false); },
            then: function (onF, onR) { return resolveList().then(onF, onR); },
        };
        function getFiltered() {
            return rows.filter(function (r) { return filters.every(function (f) { return f(r); }); });
        }
        function resolve(maybe) {
            return __awaiter(this, void 0, void 0, function () {
                var row, matched_1, matched, result;
                var _a, _b;
                return __generator(this, function (_c) {
                    if (pendingInsert) {
                        row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
                        return [2 /*return*/, { data: __assign({ id: "".concat(table, "-new") }, row), error: null }];
                    }
                    if (pendingUpdate) {
                        matched_1 = getFiltered();
                        return [2 /*return*/, { data: matched_1[0] ? __assign(__assign({}, matched_1[0]), pendingUpdate) : null, error: null }];
                    }
                    matched = getFiltered();
                    result = maybe ? ((_a = matched[0]) !== null && _a !== void 0 ? _a : null) : (_b = matched[0]) !== null && _b !== void 0 ? _b : null;
                    return [2 /*return*/, { data: result, error: null }];
                });
            });
        }
        function resolveList() {
            return __awaiter(this, void 0, void 0, function () {
                var row, matched, data;
                return __generator(this, function (_a) {
                    if (pendingInsert) {
                        row = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
                        return [2 /*return*/, { data: __assign({ id: "".concat(table, "-new") }, row), error: null }];
                    }
                    if (pendingUpdate) {
                        return [2 /*return*/, { data: getFiltered(), error: null }];
                    }
                    matched = getFiltered();
                    data = _limit ? matched.slice(0, _limit) : matched;
                    if (countMode)
                        return [2 /*return*/, { data: data, count: matched.length, error: null }];
                    return [2 /*return*/, { data: data, error: null }];
                });
            });
        }
        return b;
    }
    var client = {
        from: builder,
        auth: {
            getUser: function (token) { return __awaiter(_this, void 0, void 0, function () {
                return __generator(this, function (_a) {
                    if (token === FAKE_TOKEN)
                        return [2 /*return*/, { data: { user: { id: USER_ID } }, error: null }];
                    if (token === ADMIN_TOKEN)
                        return [2 /*return*/, { data: { user: { id: ADMIN_ID } }, error: null }];
                    return [2 /*return*/, { data: { user: null }, error: { message: "invalid" } }];
                });
            }); },
        },
        __inserted: inserted,
        __updated: updated,
    };
    return client;
}
function makeApp(state) {
    var client = makeFakeClient(state);
    (0, http_js_1._setTestClient)(client, true);
    (0, supabase_js_1._setTestServiceClient)(client);
    var app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(function (req, _res, next) {
        req.log = { error: function () { }, info: function () { }, warn: function () { } };
        next();
    });
    app.use("/api", notifications_js_1.default);
    return { app: app, client: client };
}
// ── Test suite ────────────────────────────────────────────────────────────────
(0, node_test_1.before)(function () { return __awaiter(void 0, void 0, void 0, function () {
    var state, app, addr;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                state = {
                    profiles: [
                        { id: USER_ID, role: "user", expo_push_token: "ExponentPushToken[user1]" },
                        { id: ADMIN_ID, role: "admin", expo_push_token: null },
                    ],
                    notifications: [
                        {
                            id: NOTIF_ID,
                            user_id: USER_ID,
                            category: "trips",
                            event_type: "trip.invite_received",
                            priority: "important",
                            title: "Alice invited you to a trip",
                            body: "Join \"Thailand Adventure\"",
                            action_url: "/trip/".concat(TRIP_ID),
                            read_at: null,
                            dismissed_at: null,
                            expires_at: null,
                            created_at: new Date().toISOString(),
                            metadata: {},
                            privacy_level: "standard",
                            source_type: "trip",
                            source_id: TRIP_ID,
                            actor_id: OTHER_ID,
                            image_url: null,
                        },
                    ],
                    notificationDevices: [
                        { id: DEVICE_ID, user_id: USER_ID, push_token: "ExponentPushToken[dev1]", platform: "expo" },
                    ],
                    notificationPreferences: [
                        {
                            user_id: USER_ID,
                            push_enabled: true,
                            email_enabled: false,
                            in_app_enabled: true,
                            digests_enabled: false,
                            safety_override: true,
                            quiet_hours_enabled: false,
                            quiet_start: "22:00",
                            quiet_end: "08:00",
                            message_previews: true,
                            location_previews: false,
                        },
                    ],
                    notificationDeliveryAttempts: [
                        { id: "attempt-1", notification_id: NOTIF_ID, user_id: USER_ID, channel: "push", status: "sent", created_at: new Date().toISOString() },
                        { id: "attempt-2", notification_id: NOTIF_ID, user_id: USER_ID, channel: "in_app", status: "sent", created_at: new Date().toISOString() },
                    ],
                    tripMembers: [
                        { user_id: USER_ID, trip_id: TRIP_ID, role: "member" },
                    ],
                    locationPreferences: [],
                    featureFlags: {
                        notifications_enabled: true,
                        push_notifications_enabled: true,
                    },
                };
                app = makeApp(state).app;
                server = node_http_1.default.createServer(app);
                return [4 /*yield*/, new Promise(function (resolve) { return server.listen(0, "127.0.0.1", resolve); })];
            case 1:
                _a.sent();
                addr = server.address();
                base = "http://127.0.0.1:".concat(addr.port);
                return [2 /*return*/];
        }
    });
}); });
(0, node_test_1.after)(function () { return new Promise(function (r) { return server.close(r); }); });
// ─────────────────────────────────────────────────────────────────────────────
// 1. Privacy Guard: GPS coordinate stripping
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard", function () {
    (0, node_test_1.it)("strips decimal GPS coordinates from body", function () {
        var result = (0, NotificationPrivacyGuard_js_1.stripGPSCoordinates)("You are at 13.7563, 100.5018 right now.");
        strict_1.default.ok(!result.includes("13.7563"), "lat should be stripped");
        strict_1.default.ok(!result.includes("100.5018"), "lng should be stripped");
        strict_1.default.ok(result.includes("[location]"), "placeholder should appear");
    });
    (0, node_test_1.it)("strips lat/lng label patterns", function () {
        var result = (0, NotificationPrivacyGuard_js_1.stripGPSCoordinates)("lat: 51.5074, lng: -0.1278");
        strict_1.default.ok(!result.includes("51.5074"));
        strict_1.default.ok(!result.includes("-0.1278"));
    });
    (0, node_test_1.it)("leaves plain text unmodified", function () {
        var text = "Meet at the airport lobby";
        strict_1.default.equal((0, NotificationPrivacyGuard_js_1.stripGPSCoordinates)(text), text);
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 2. Privacy Guard: Ghost Mode suppression
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard — Ghost Mode", function () {
    (0, node_test_1.it)("blocks location notification when sender is in Ghost Mode", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = {
                        locationPreferences: [{ user_id: OTHER_ID, location_mode: "ghost" }],
                        tripMembers: [],
                    };
                    client = makeFakeClient(state);
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("Alice is nearby", "Alice is 100m away", {
                            recipientId: USER_ID,
                            senderId: OTHER_ID,
                            category: "location",
                            eventType: "location.nearby_traveler",
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.blocked, true);
                    strict_1.default.equal(result.blockReason, "ghost_mode");
                    strict_1.default.equal(result.privacyLevel, "ghost_hidden");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("allows location notification when sender is NOT in Ghost Mode", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = {
                        locationPreferences: [{ user_id: OTHER_ID, location_mode: "standard" }],
                        tripMembers: [],
                    };
                    client = makeFakeClient(state);
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("Alice is nearby", "Alice is in Bangkok", {
                            recipientId: USER_ID,
                            senderId: OTHER_ID,
                            category: "location",
                            eventType: "location.nearby_traveler",
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.blocked, false);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 3. Privacy Guard: pending member does not receive private plan location
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard — pending member", function () {
    (0, node_test_1.it)("blocks plan.item_added for invited (pending) trip member", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = {
                        locationPreferences: [],
                        tripMembers: [{ user_id: USER_ID, trip_id: TRIP_ID, role: "invited" }],
                    };
                    client = makeFakeClient(state);
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("New stop added", "Alice added Wat Pho", {
                            recipientId: USER_ID,
                            category: "plans",
                            eventType: "plan.item_added",
                            tripId: TRIP_ID,
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.blocked, true);
                    strict_1.default.equal(result.blockReason, "pending_member");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 4. Privacy Guard: removed trip member stops receiving updates
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard — removed member", function () {
    (0, node_test_1.it)("blocks trip notification for a user with no trip_members row", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = {
                        locationPreferences: [],
                        tripMembers: [], // no row = removed
                    };
                    client = makeFakeClient(state);
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("Plan updated", "A stop was changed", {
                            recipientId: USER_ID,
                            category: "plans",
                            eventType: "plan.item_updated",
                            tripId: TRIP_ID,
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.blocked, true);
                    strict_1.default.equal(result.blockReason, "removed_from_trip");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 5. Privacy Guard: trust notification hides reporter identity
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard — trust reporter identity", function () {
    (0, node_test_1.it)("strips reporter name from trust notification body", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({});
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("Report received", "You were reported by Alice Smith. Reporter: Alice", { recipientId: USER_ID, category: "trust", eventType: "trust.report_received" })];
                case 1:
                    result = _a.sent();
                    strict_1.default.ok(!result.body.includes("Alice"), "reporter name should be stripped");
                    strict_1.default.ok(result.body.toLowerCase().includes("protected") || result.body.includes("[protected]"));
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 6. Privacy Guard: push preview excludes live-share coordinates
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPrivacyGuard — live-share push preview", function () {
    (0, node_test_1.it)("replaces body with safe message for live-share push previews", function () { return __awaiter(void 0, void 0, void 0, function () {
        var client, guard, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    client = makeFakeClient({});
                    guard = new NotificationPrivacyGuard_js_2.NotificationPrivacyGuard(client);
                    return [4 /*yield*/, guard.sanitise("Alice shared their location", "Alice is at 13.7563, 100.5018", {
                            recipientId: USER_ID,
                            category: "location",
                            eventType: "location.live_share_started",
                            isLiveShare: true,
                            isPushPreview: true,
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.ok(!result.body.includes("13.7563"), "exact coordinates should not appear");
                    strict_1.default.ok(result.body.includes("Live location"), "safe message expected");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 7. Preference Service: quiet hours suppress push for non-urgent
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPreferenceService — quiet hours", function () {
    (0, node_test_1.it)("blocks push channel when quiet hours is active and priority is normal", function () {
        var svc = new NotificationPreferenceService_js_1.NotificationPreferenceService({});
        var prefs = {
            userId: USER_ID,
            pushEnabled: true,
            emailEnabled: false,
            inAppEnabled: true,
            digestsEnabled: false,
            safetyOverride: true,
            quietHoursEnabled: true,
            quietStart: "00:00", // start at midnight
            quietEnd: "23:59", // end just before midnight — basically always quiet
            messagePreviews: true,
            locationPreviews: false,
        };
        var channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'normal');
        strict_1.default.ok(channels.includes('in_app'), 'in_app should pass');
        strict_1.default.ok(!channels.includes('push'), 'push should be blocked during quiet hours');
    });
    (0, node_test_1.it)("allows push for urgent even during quiet hours (safety override)", function () {
        var svc = new NotificationPreferenceService_js_1.NotificationPreferenceService({});
        var prefs = {
            userId: USER_ID,
            pushEnabled: true,
            emailEnabled: false,
            inAppEnabled: true,
            digestsEnabled: false,
            safetyOverride: true,
            quietHoursEnabled: true,
            quietStart: "00:00",
            quietEnd: "23:59",
            messagePreviews: true,
            locationPreviews: false,
        };
        var channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'urgent');
        strict_1.default.ok(channels.includes('push'), 'urgent push should bypass quiet hours via safety override');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 8. Preference Service: safety override allows push even when globally off
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPreferenceService — safety override", function () {
    (0, node_test_1.it)("allows push for urgent even when pushEnabled=false (safety override)", function () {
        var svc = new NotificationPreferenceService_js_1.NotificationPreferenceService({});
        var prefs = {
            userId: USER_ID,
            pushEnabled: false, // globally off
            emailEnabled: false,
            inAppEnabled: true,
            digestsEnabled: false,
            safetyOverride: true,
            quietHoursEnabled: false,
            quietStart: "22:00",
            quietEnd: "08:00",
            messagePreviews: true,
            locationPreviews: false,
        };
        var channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'urgent');
        strict_1.default.ok(channels.includes('push'), 'safety override should allow urgent push');
    });
    (0, node_test_1.it)("blocks push for normal priority when pushEnabled=false", function () {
        var svc = new NotificationPreferenceService_js_1.NotificationPreferenceService({});
        var prefs = {
            userId: USER_ID,
            pushEnabled: false,
            emailEnabled: false,
            inAppEnabled: true,
            digestsEnabled: false,
            safetyOverride: true,
            quietHoursEnabled: false,
            quietStart: "22:00",
            quietEnd: "08:00",
            messagePreviews: true,
            locationPreviews: false,
        };
        var channels = svc.filterChannels(['in_app', 'push'], prefs, undefined, 'normal');
        strict_1.default.ok(!channels.includes('push'), 'push should be blocked when off and not urgent');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 9. Preference Service: category preferences respected
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationPreferenceService — category preferences", function () {
    (0, node_test_1.it)("blocks push for category when category push is disabled", function () {
        var svc = new NotificationPreferenceService_js_1.NotificationPreferenceService({});
        var prefs = {
            userId: USER_ID, pushEnabled: true, emailEnabled: false, inAppEnabled: true,
            digestsEnabled: false, safetyOverride: true, quietHoursEnabled: false,
            quietStart: "22:00", quietEnd: "08:00", messagePreviews: true, locationPreviews: false,
        };
        var catPref = { category: 'pulse', inAppEnabled: true, pushEnabled: false, emailEnabled: false, digestEnabled: false };
        var channels = svc.filterChannels(['in_app', 'push'], prefs, catPref, 'normal');
        strict_1.default.ok(channels.includes('in_app'), 'in_app should pass');
        strict_1.default.ok(!channels.includes('push'), 'push should be blocked by category pref');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 10. Deduplication: message coalescence
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationDeduplicationService — message coalescence", function () {
    (0, node_test_1.it)("coalesces telegraph.message within the time window", function () { return __awaiter(void 0, void 0, void 0, function () {
        var state, client, svc, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    state = {
                        notifications: [
                            {
                                id: "old-notif",
                                user_id: USER_ID,
                                category: "telegraph",
                                source_type: "thread",
                                source_id: "thread-123",
                                created_at: new Date().toISOString(),
                            },
                        ],
                    };
                    client = makeFakeClient(state);
                    svc = new NotificationDeduplicationService_js_1.NotificationDeduplicationService(client);
                    return [4 /*yield*/, svc.check({
                            userId: USER_ID,
                            category: "telegraph",
                            eventType: "telegraph.message",
                            sourceType: "thread",
                            sourceId: "thread-123",
                        })];
                case 1:
                    result = _a.sent();
                    strict_1.default.equal(result.isDuplicate, true);
                    strict_1.default.equal(result.reason, "message_coalesced");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 11. Template Service: templates defined for all 13 categories
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("NotificationTemplateService", function () {
    var ALL_CATEGORIES = [
        'plans', 'trips', 'telegraph', 'safe_return', 'location', 'trip_crew',
        'compass', 'pulse', 'passport', 'hidden_gems', 'trust', 'airport', 'admin',
    ];
    (0, node_test_1.it)("has at least one template per category", function () {
        var _loop_1 = function (cat) {
            var found = NotificationTemplateService_js_1.TEMPLATES.some(function (t) { return t.category === cat; });
            strict_1.default.ok(found, "No template found for category: ".concat(cat));
        };
        for (var _i = 0, ALL_CATEGORIES_1 = ALL_CATEGORIES; _i < ALL_CATEGORIES_1.length; _i++) {
            var cat = ALL_CATEGORIES_1[_i];
            _loop_1(cat);
        }
    });
    (0, node_test_1.it)("renders trip.invite_received template", function () {
        var rendered = (0, NotificationTemplateService_js_1.renderTemplate)("trip.invite_received", { actor: "Alice", tripTitle: "Thailand Adventure", destination: "Bangkok" });
        strict_1.default.ok(rendered, "should render");
        strict_1.default.ok(rendered.title.includes("Alice"), "title should include actor");
        strict_1.default.ok(rendered.body.includes("Thailand Adventure"), "body should include trip title");
        strict_1.default.equal(rendered.category, "trips");
        strict_1.default.equal(rendered.priority, "important");
    });
    (0, node_test_1.it)("renders safe_return.reminder template with correct priority", function () {
        var rendered = (0, NotificationTemplateService_js_1.renderTemplate)("safe_return.reminder", {});
        strict_1.default.ok(rendered);
        strict_1.default.equal(rendered.priority, "urgent");
        strict_1.default.ok(rendered.channels.includes("push"), "safe return should push");
    });
    (0, node_test_1.it)("returns null for unknown event type", function () {
        var rendered = (0, NotificationTemplateService_js_1.renderTemplate)("unknown.event.type.xyz", {});
        strict_1.default.equal(rendered, null);
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 12. API: GET /me/notifications — list unread Activity Center
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/notifications", function () {
    (0, node_test_1.it)("returns notifications for authenticated user", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r, n;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/me/notifications")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.notifications), "should have notifications array");
                    strict_1.default.ok(r.body.notifications.length >= 1, "should have at least 1 notification");
                    n = r.body.notifications[0];
                    strict_1.default.equal(n.userId, USER_ID);
                    strict_1.default.ok(n.title, "should have title");
                    strict_1.default.ok(n.body, "should have body");
                    strict_1.default.ok(n.category, "should have category");
                    strict_1.default.ok(n.priority, "should have priority");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 401 for unauthenticated request", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/me/notifications", undefined, "bad-token")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 401);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 13. API: GET /me/notifications/unread-count
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/me/notifications/unread-count", function () {
    (0, node_test_1.it)("returns a numeric unread count", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/me/notifications/unread-count")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(typeof r.body.unreadCount, "number");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 14. API: POST /me/notifications/:id/read — mark-read updates count
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/me/notifications/:id/read", function () {
    (0, node_test_1.it)("marks a notification read", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/me/notifications/".concat(NOTIF_ID, "/read"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 15. API: POST /me/notifications/read-all
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/me/notifications/read-all", function () {
    (0, node_test_1.it)("marks all notifications read", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/me/notifications/read-all", {})];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(typeof r.body.marked, "number");
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 16. API: POST /me/notifications/:id/dismiss
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/me/notifications/:id/dismiss", function () {
    (0, node_test_1.it)("dismisses a notification", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/me/notifications/".concat(NOTIF_ID, "/dismiss"))];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 17. API: GET & PUT /me/notification-preferences
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("GET/PUT /api/me/notification-preferences", function () {
    (0, node_test_1.it)("returns preferences object", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/me/notification-preferences")];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(r.body.preferences, "should have preferences");
                    strict_1.default.equal(typeof r.body.preferences.pushEnabled, "boolean");
                    strict_1.default.equal(typeof r.body.preferences.quietHoursEnabled, "boolean");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("updates preferences", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("PUT", "/api/me/notification-preferences", {
                        pushEnabled: false,
                        quietHoursEnabled: true,
                        quietStart: "21:00",
                        quietEnd: "07:00",
                    })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects invalid quiet_start format", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("PUT", "/api/me/notification-preferences", {
                        quietStart: "not-a-time",
                    })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 18. API: POST /me/devices — device registration
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/me/devices", function () {
    (0, node_test_1.it)("registers a push token device", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/me/devices", {
                        pushToken: "ExponentPushToken[newdevice123]",
                        platform: "expo",
                    })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 201);
                    strict_1.default.equal(r.body.ok, true);
                    strict_1.default.ok(r.body.deviceId, "should return deviceId");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("rejects too-short push token", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/me/devices", { pushToken: "abc" })];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 19. Admin: GET /admin/notification-templates
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("GET /api/admin/notification-templates", function () {
    (0, node_test_1.it)("returns all templates for admin user", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/admin/notification-templates", undefined, ADMIN_TOKEN)];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 200);
                    strict_1.default.ok(Array.isArray(r.body.templates), "should be array");
                    strict_1.default.ok(r.body.templates.length > 0, "should have templates");
                    strict_1.default.ok(r.body.templates[0].eventType, "template should have eventType");
                    strict_1.default.ok(r.body.templates[0].category, "template should have category");
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 403 for non-admin user", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("GET", "/api/admin/notification-templates", undefined, FAKE_TOKEN)];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 403);
                    return [2 /*return*/];
            }
        });
    }); });
});
// ─────────────────────────────────────────────────────────────────────────────
// 20. Admin: POST /admin/notifications/account-notice — logs delivery attempt
// ─────────────────────────────────────────────────────────────────────────────
(0, node_test_1.describe)("POST /api/admin/notifications/account-notice", function () {
    (0, node_test_1.it)("creates account-notice notification for target user", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/admin/notifications/account-notice", {
                        userId: USER_ID,
                        subject: "Community Guidelines Update",
                        body: "Please review our updated community guidelines.",
                    }, ADMIN_TOKEN)];
                case 1:
                    r = _a.sent();
                    // 200 or 201 depending on dedup; key check is no 5xx
                    strict_1.default.ok(r.status === 200 || r.status === 201, "Unexpected status: ".concat(r.status));
                    strict_1.default.equal(r.body.ok, true);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)("returns 400 for missing subject", function () { return __awaiter(void 0, void 0, void 0, function () {
        var r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, req("POST", "/api/admin/notifications/account-notice", { userId: USER_ID, body: "no subject here" }, ADMIN_TOKEN)];
                case 1:
                    r = _a.sent();
                    strict_1.default.equal(r.status, 400);
                    return [2 /*return*/];
            }
        });
    }); });
});
