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
 * Notifications routes
 *
 * User-facing:
 *   GET    /me/notifications                — list (paginated, filterable)
 *   GET    /me/notifications/unread-count   — badge count
 *   POST   /me/notifications/:id/read       — mark single read
 *   POST   /me/notifications/read-all       — mark all read
 *   POST   /me/notifications/:id/dismiss    — dismiss
 *   GET    /me/notification-preferences     — get prefs
 *   PUT    /me/notification-preferences     — update prefs
 *   POST   /me/devices                      — register push token
 *   DELETE /me/devices/:id                  — unregister push token
 *   GET    /me/notifications/stream         — SSE stream for realtime updates
 *
 * Internal (service-role secret header):
 *   POST   /internal/notifications           — create a notification
 *   POST   /internal/notifications/send      — create + route (push, etc.)
 *   POST   /internal/notifications/digest    — trigger digest for a user
 *   POST   /internal/activity-events         — log an activity event
 *   POST   /internal/notifications/expire    — expire old notifications
 *
 * Admin:
 *   GET    /admin/notification-templates            — list all templates
 *   POST   /admin/notifications/account-notice      — send account notice to a user
 *   GET    /admin/notification-delivery-attempts    — list delivery attempts
 *   PUT    /admin/notification-defaults             — update default prefs
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var NotificationService_js_1 = require("../services/notifications/NotificationService.js");
var NotificationPreferenceService_js_1 = require("../services/notifications/NotificationPreferenceService.js");
var NotificationRouter_js_1 = require("../services/notifications/NotificationRouter.js");
var NotificationDigestService_js_1 = require("../services/notifications/NotificationDigestService.js");
var RealtimeActivityService_js_1 = require("../services/notifications/RealtimeActivityService.js");
var NotificationTemplateService_js_1 = require("../services/notifications/NotificationTemplateService.js");
var router = (0, express_1.Router)();
var NOTIFICATION_CATEGORIES = [
    'plans', 'trips', 'telegraph', 'safe_return', 'location', 'trip_crew',
    'compass', 'pulse', 'passport', 'hidden_gems', 'trust', 'airport', 'admin',
];
// ── Internal secret guard ─────────────────────────────────────────────────────
function requireInternalSecret(req, res) {
    var secret = process.env.INTERNAL_API_SECRET;
    if (!secret)
        return true; // if no secret is configured, allow (dev mode)
    var provided = req.headers['x-internal-secret'];
    if (provided !== secret) {
        res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
        return false;
    }
    return true;
}
// ── Admin guard (re-used from admin.ts pattern) ───────────────────────────────
function requireAdmin(req, res) {
    return __awaiter(this, void 0, void 0, function () {
        var auth, client, user, _a, data, error, sc;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
                case 1:
                    auth = _c.sent();
                    if (!auth)
                        return [2 /*return*/, null];
                    client = auth.client, user = auth.user;
                    return [4 /*yield*/, client
                            .from('profiles')
                            .select('role')
                            .eq('id', user.id)
                            .maybeSingle()];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data || data.role !== 'admin') {
                        res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
                        return [2 /*return*/, null];
                    }
                    sc = (_b = (0, supabase_js_1.getServiceClient)()) !== null && _b !== void 0 ? _b : client;
                    return [2 /*return*/, { userId: user.id, sc: sc }];
            }
        });
    });
}
// ═══════════════════════════════════════════════════════════════════════════════
// USER-FACING ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
/** GET /me/notifications */
router.get('/me/notifications', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, svc, limit, offset, category, priority, unreadOnly, since, result, err_1;
    var _a, _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                svc = new NotificationService_js_1.NotificationService(sc);
                limit = Math.min(Number((_b = req.query.limit) !== null && _b !== void 0 ? _b : 20), 100);
                offset = Number((_c = req.query.offset) !== null && _c !== void 0 ? _c : 0);
                category = req.query.category;
                priority = req.query.priority;
                unreadOnly = req.query.unread === 'true';
                since = req.query.since;
                _d.label = 2;
            case 2:
                _d.trys.push([2, 4, , 5]);
                return [4 /*yield*/, svc.list({ userId: user.id, category: category, priority: priority, unreadOnly: unreadOnly, limit: limit, offset: offset, since: since })];
            case 3:
                result = _d.sent();
                res.json(result);
                return [3 /*break*/, 5];
            case 4:
                err_1 = _d.sent();
                (0, http_js_1.sendError)(res, 'db_error', err_1.message);
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
/** GET /me/notifications/unread-count */
router.get('/me/notifications/unread-count', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, svc, count;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                svc = new NotificationService_js_1.NotificationService(sc);
                return [4 /*yield*/, svc.getUnreadCount(user.id)];
            case 2:
                count = _b.sent();
                res.json({ unreadCount: count });
                return [2 /*return*/];
        }
    });
}); });
/** POST /me/notifications/read-all  (must come before /:id/read) */
router.post('/me/notifications/read-all', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, svc, realtimeSvc, category, count;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                svc = new NotificationService_js_1.NotificationService(sc);
                realtimeSvc = new RealtimeActivityService_js_1.RealtimeActivityService(sc);
                category = (_b = req.body) === null || _b === void 0 ? void 0 : _b.category;
                return [4 /*yield*/, svc.markAllRead(user.id, category)];
            case 2:
                count = _c.sent();
                void realtimeSvc.emitUnreadUpdate(user.id);
                res.json({ marked: count });
                return [2 /*return*/];
        }
    });
}); });
/** POST /me/notifications/:id/read */
router.post('/me/notifications/:id/read', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, svc, realtimeSvc, ok;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                svc = new NotificationService_js_1.NotificationService(sc);
                realtimeSvc = new RealtimeActivityService_js_1.RealtimeActivityService(sc);
                return [4 /*yield*/, svc.markRead(user.id, req.params.id)];
            case 2:
                ok = _b.sent();
                if (!ok) {
                    (0, http_js_1.sendError)(res, 'not_found', 'Notification not found');
                    return [2 /*return*/];
                }
                realtimeSvc.emitRead(user.id, req.params.id);
                res.json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
/** POST /me/notifications/:id/dismiss */
router.post('/me/notifications/:id/dismiss', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, svc, ok;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                svc = new NotificationService_js_1.NotificationService(sc);
                return [4 /*yield*/, svc.dismiss(user.id, req.params.id)];
            case 2:
                ok = _b.sent();
                if (!ok) {
                    (0, http_js_1.sendError)(res, 'not_found', 'Notification not found');
                    return [2 /*return*/];
                }
                res.json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
/** GET /me/notification-preferences */
router.get('/me/notification-preferences', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, prefSvc, _a, prefs, catPrefs;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_b = (0, supabase_js_1.getServiceClient)()) !== null && _b !== void 0 ? _b : client;
                prefSvc = new NotificationPreferenceService_js_1.NotificationPreferenceService(sc);
                return [4 /*yield*/, Promise.all([
                        prefSvc.getPreferences(user.id),
                        prefSvc.getCategoryPreferences(user.id),
                    ])];
            case 2:
                _a = _c.sent(), prefs = _a[0], catPrefs = _a[1];
                res.json({ preferences: prefs, categoryPreferences: catPrefs });
                return [2 /*return*/];
        }
    });
}); });
var UpdatePrefsSchema = zod_1.z.object({
    pushEnabled: zod_1.z.boolean().optional(),
    emailEnabled: zod_1.z.boolean().optional(),
    inAppEnabled: zod_1.z.boolean().optional(),
    digestsEnabled: zod_1.z.boolean().optional(),
    safetyOverride: zod_1.z.boolean().optional(),
    quietHoursEnabled: zod_1.z.boolean().optional(),
    quietStart: zod_1.z.string().regex(/^\d{2}:\d{2}$/).optional(),
    quietEnd: zod_1.z.string().regex(/^\d{2}:\d{2}$/).optional(),
    messagePreviews: zod_1.z.boolean().optional(),
    locationPreviews: zod_1.z.boolean().optional(),
    categoryPreferences: zod_1.z.array(zod_1.z.object({
        category: zod_1.z.enum(NOTIFICATION_CATEGORIES),
        inAppEnabled: zod_1.z.boolean().optional(),
        pushEnabled: zod_1.z.boolean().optional(),
        emailEnabled: zod_1.z.boolean().optional(),
        digestEnabled: zod_1.z.boolean().optional(),
    })).optional(),
});
/** PUT /me/notification-preferences */
router.put('/me/notification-preferences', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, sc, prefSvc, _a, categoryPreferences, globalPatch, prefs;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = UpdatePrefsSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, 'invalid_payload', (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid body');
                    return [2 /*return*/];
                }
                sc = (_d = (0, supabase_js_1.getServiceClient)()) !== null && _d !== void 0 ? _d : client;
                prefSvc = new NotificationPreferenceService_js_1.NotificationPreferenceService(sc);
                _a = parsed.data, categoryPreferences = _a.categoryPreferences, globalPatch = __rest(_a, ["categoryPreferences"]);
                return [4 /*yield*/, prefSvc.upsertPreferences(user.id, globalPatch)];
            case 2:
                prefs = _e.sent();
                if (!(categoryPreferences && categoryPreferences.length > 0)) return [3 /*break*/, 4];
                return [4 /*yield*/, Promise.all(categoryPreferences.map(function (cp) {
                        return prefSvc.upsertCategoryPreferences(user.id, cp.category, cp);
                    }))];
            case 3:
                _e.sent();
                _e.label = 4;
            case 4:
                res.json({ ok: true, preferences: prefs });
                return [2 /*return*/];
        }
    });
}); });
var RegisterDeviceSchema = zod_1.z.object({
    pushToken: zod_1.z.string().min(10),
    platform: zod_1.z.enum(['expo', 'apns', 'fcm']).optional().default('expo'),
    label: zod_1.z.string().max(100).optional(),
});
/** POST /me/devices */
router.post('/me/devices', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, sc, _a, data, error;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = RegisterDeviceSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, 'invalid_payload', (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : 'Invalid body');
                    return [2 /*return*/];
                }
                sc = (_d = (0, supabase_js_1.getServiceClient)()) !== null && _d !== void 0 ? _d : client;
                return [4 /*yield*/, sc
                        .from('notification_devices')
                        .upsert({
                        user_id: user.id,
                        push_token: parsed.data.pushToken,
                        platform: parsed.data.platform,
                        label: (_e = parsed.data.label) !== null && _e !== void 0 ? _e : null,
                        last_used_at: new Date().toISOString(),
                    }, { onConflict: 'user_id,push_token' })
                        .select('id')
                        .single()];
            case 2:
                _a = _f.sent(), data = _a.data, error = _a.error;
                if (error) {
                    (0, http_js_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                if (!(parsed.data.platform === 'expo')) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from('profiles').update({ expo_push_token: parsed.data.pushToken }).eq('id', user.id)];
            case 3:
                _f.sent();
                _f.label = 4;
            case 4:
                res.status(201).json({ ok: true, deviceId: data.id });
                return [2 /*return*/];
        }
    });
}); });
/** DELETE /me/devices/:id */
router.delete('/me/devices/:id', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, error;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, sc
                        .from('notification_devices')
                        .delete()
                        .eq('id', req.params.id)
                        .eq('user_id', user.id)];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
/**
 * GET /me/notifications/stream — SSE realtime stream
 * Client should reconnect on connection drop (standard SSE behaviour).
 */
router.get('/me/notifications/stream', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, realtimeSvc, heartbeat, cleanup;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (_a = (0, supabase_js_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                realtimeSvc = new RealtimeActivityService_js_1.RealtimeActivityService(sc);
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();
                heartbeat = setInterval(function () {
                    try {
                        res.write(': ping\n\n');
                    }
                    catch (_a) { }
                }, 30000);
                cleanup = realtimeSvc.registerSSEStream(user.id, function (data) {
                    res.write(data);
                });
                req.on('close', function () {
                    clearInterval(heartbeat);
                    cleanup();
                });
                return [2 /*return*/];
        }
    });
}); });
// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
var CreateNotificationSchema = zod_1.z.object({
    userId: zod_1.z.string().uuid(),
    eventType: zod_1.z.string().min(1),
    params: zod_1.z.record(zod_1.z.string()).optional(),
    title: zod_1.z.string().optional(),
    body: zod_1.z.string().optional(),
    category: zod_1.z.enum(NOTIFICATION_CATEGORIES).optional(),
    priority: zod_1.z.enum(['urgent', 'important', 'normal', 'low']).optional(),
    channels: zod_1.z.array(zod_1.z.string()).optional(),
    actionUrl: zod_1.z.string().optional(),
    imageUrl: zod_1.z.string().optional(),
    sourceType: zod_1.z.string().optional(),
    sourceId: zod_1.z.string().optional(),
    actorId: zod_1.z.string().uuid().optional(),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
    expiresAt: zod_1.z.string().optional(),
    tripId: zod_1.z.string().uuid().optional(),
    senderId: zod_1.z.string().uuid().optional(),
    isLiveShare: zod_1.z.boolean().optional(),
});
/** POST /internal/notifications — create a notification (store only, no routing) */
router.post('/internal/notifications', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var parsed, sc, svc, notification;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (!requireInternalSecret(req, res))
                    return [2 /*return*/];
                parsed = CreateNotificationSchema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: 'invalid_payload', message: (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message });
                    return [2 /*return*/];
                }
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    res.status(503).json({ error: 'server_not_configured' });
                    return [2 /*return*/];
                }
                svc = new NotificationService_js_1.NotificationService(sc);
                return [4 /*yield*/, svc.create(parsed.data)];
            case 1:
                notification = _b.sent();
                if (!notification) {
                    res.status(200).json({ ok: true, created: false, reason: 'blocked_or_deduped' });
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true, created: true, notification: notification });
                return [2 /*return*/];
        }
    });
}); });
/** POST /internal/notifications/send — create + route (push etc.) */
router.post('/internal/notifications/send', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var parsed, sc, svc, notifRouter, realtimeSvc, notification;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (!requireInternalSecret(req, res))
                    return [2 /*return*/];
                parsed = CreateNotificationSchema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: 'invalid_payload', message: (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message });
                    return [2 /*return*/];
                }
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    res.status(503).json({ error: 'server_not_configured' });
                    return [2 /*return*/];
                }
                svc = new NotificationService_js_1.NotificationService(sc);
                notifRouter = new NotificationRouter_js_1.NotificationRouter(sc);
                realtimeSvc = new RealtimeActivityService_js_1.RealtimeActivityService(sc);
                return [4 /*yield*/, svc.create(parsed.data)];
            case 1:
                notification = _b.sent();
                if (!notification) {
                    res.status(200).json({ ok: true, created: false, reason: 'blocked_or_deduped' });
                    return [2 /*return*/];
                }
                // Route asynchronously (push etc.) — don't block the HTTP response
                void notifRouter.route(notification).catch(function () { });
                realtimeSvc.emitCreated(notification);
                res.status(201).json({ ok: true, created: true, notification: notification });
                return [2 /*return*/];
        }
    });
}); });
/** POST /internal/notifications/digest — trigger daily digest for a user */
router.post('/internal/notifications/digest', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var userId, sc, digestSvc, usersProcessed;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (!requireInternalSecret(req, res))
                    return [2 /*return*/];
                userId = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).userId;
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    res.status(503).json({ error: 'server_not_configured' });
                    return [2 /*return*/];
                }
                digestSvc = new NotificationDigestService_js_1.NotificationDigestService(sc);
                if (!userId) return [3 /*break*/, 2];
                return [4 /*yield*/, digestSvc.sendDailyDigest(userId)];
            case 1:
                _b.sent();
                res.json({ ok: true, mode: 'single', userId: userId });
                return [3 /*break*/, 4];
            case 2: return [4 /*yield*/, digestSvc.runForAllUsers()];
            case 3:
                usersProcessed = (_b.sent()).usersProcessed;
                res.json({ ok: true, mode: 'all', usersProcessed: usersProcessed });
                _b.label = 4;
            case 4: return [2 /*return*/];
        }
    });
}); });
/** POST /internal/activity-events — log a raw activity event */
router.post('/internal/activity-events', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var schema, parsed, sc, error;
    var _a, _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0:
                if (!requireInternalSecret(req, res))
                    return [2 /*return*/];
                schema = zod_1.z.object({
                    userId: zod_1.z.string().uuid(),
                    eventType: zod_1.z.string().min(1),
                    category: zod_1.z.string().min(1),
                    actorId: zod_1.z.string().uuid().optional(),
                    sourceType: zod_1.z.string().optional(),
                    sourceId: zod_1.z.string().optional(),
                    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: 'invalid_payload', message: (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message });
                    return [2 /*return*/];
                }
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    res.status(503).json({ error: 'server_not_configured' });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from('activity_events').insert({
                        user_id: parsed.data.userId,
                        event_type: parsed.data.eventType,
                        category: parsed.data.category,
                        actor_id: (_b = parsed.data.actorId) !== null && _b !== void 0 ? _b : null,
                        source_type: (_c = parsed.data.sourceType) !== null && _c !== void 0 ? _c : null,
                        source_id: (_d = parsed.data.sourceId) !== null && _d !== void 0 ? _d : null,
                        metadata: (_e = parsed.data.metadata) !== null && _e !== void 0 ? _e : {},
                    })];
            case 1:
                error = (_f.sent()).error;
                if (error) {
                    res.status(500).json({ error: 'db_error', message: error.message });
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
/** POST /internal/notifications/expire — hard-delete expired rows */
router.post('/internal/notifications/expire', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var sc, svc, deleted;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                if (!requireInternalSecret(req, res))
                    return [2 /*return*/];
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    res.status(503).json({ error: 'server_not_configured' });
                    return [2 /*return*/];
                }
                svc = new NotificationService_js_1.NotificationService(sc);
                return [4 /*yield*/, svc.expireOldNotifications()];
            case 1:
                deleted = _a.sent();
                res.json({ ok: true, deleted: deleted });
                return [2 /*return*/];
        }
    });
}); });
// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
/** GET /admin/notification-templates */
router.get('/admin/notification-templates', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, templates;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _a.sent();
                if (!admin)
                    return [2 /*return*/];
                templates = NotificationTemplateService_js_1.TEMPLATES.map(function (t) { return ({
                    eventType: t.eventType,
                    category: t.category,
                    defaultPriority: t.defaultPriority,
                    defaultChannels: t.defaultChannels,
                }); });
                res.json({ templates: templates, total: templates.length });
                return [2 /*return*/];
        }
    });
}); });
/** POST /admin/notifications/account-notice */
router.post('/admin/notifications/account-notice', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, schema, parsed, svc, notifRouter, notification;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _c.sent();
                if (!admin)
                    return [2 /*return*/];
                schema = zod_1.z.object({
                    userId: zod_1.z.string().uuid(),
                    subject: zod_1.z.string().min(1).max(200),
                    body: zod_1.z.string().min(1).max(2000),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, 'invalid_payload', (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : 'Invalid body');
                    return [2 /*return*/];
                }
                svc = new NotificationService_js_1.NotificationService(admin.sc);
                notifRouter = new NotificationRouter_js_1.NotificationRouter(admin.sc);
                return [4 /*yield*/, svc.create({
                        userId: parsed.data.userId,
                        eventType: 'admin.account_notice',
                        params: { subject: parsed.data.subject, body: parsed.data.body },
                        priority: 'urgent',
                        metadata: { sentBy: admin.userId },
                        sourceType: 'admin',
                        sourceId: admin.userId,
                    })];
            case 2:
                notification = _c.sent();
                if (!notification) {
                    res.json({ ok: false, reason: 'blocked_or_deduped' });
                    return [2 /*return*/];
                }
                void notifRouter.route(notification).catch(function () { });
                res.status(201).json({ ok: true, notification: notification });
                return [2 /*return*/];
        }
    });
}); });
/** GET /admin/notification-delivery-attempts */
router.get('/admin/notification-delivery-attempts', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, limit, offset, status, channel, query, _a, data, error, count;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _d.sent();
                if (!admin)
                    return [2 /*return*/];
                limit = Math.min(Number((_b = req.query.limit) !== null && _b !== void 0 ? _b : 50), 200);
                offset = Number((_c = req.query.offset) !== null && _c !== void 0 ? _c : 0);
                status = req.query.status;
                channel = req.query.channel;
                query = admin.sc
                    .from('notification_delivery_attempts')
                    .select('*', { count: 'exact' })
                    .order('created_at', { ascending: false })
                    .range(offset, offset + limit - 1);
                if (status)
                    query = query.eq('status', status);
                if (channel)
                    query = query.eq('channel', channel);
                return [4 /*yield*/, query];
            case 2:
                _a = _d.sent(), data = _a.data, error = _a.error, count = _a.count;
                if (error) {
                    (0, http_js_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.json({ attempts: data !== null && data !== void 0 ? data : [], total: count !== null && count !== void 0 ? count : 0 });
                return [2 /*return*/];
        }
    });
}); });
/** PUT /admin/notification-defaults — update default preferences for all new users */
router.put('/admin/notification-defaults', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var admin, schema, parsed, flagMap, updated, _i, _a, _b, key, flagName, val;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, requireAdmin(req, res)];
            case 1:
                admin = _e.sent();
                if (!admin)
                    return [2 /*return*/];
                schema = zod_1.z.object({
                    notificationsEnabled: zod_1.z.boolean().optional(),
                    pushNotificationsEnabled: zod_1.z.boolean().optional(),
                    notificationDigestsEnabled: zod_1.z.boolean().optional(),
                    realtimeActivityEnabled: zod_1.z.boolean().optional(),
                    safetyNotificationsEnabled: zod_1.z.boolean().optional(),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, 'invalid_payload', (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : 'Invalid body');
                    return [2 /*return*/];
                }
                flagMap = {
                    notificationsEnabled: 'notifications_enabled',
                    pushNotificationsEnabled: 'push_notifications_enabled',
                    notificationDigestsEnabled: 'notification_digests_enabled',
                    realtimeActivityEnabled: 'realtime_activity_enabled',
                    safetyNotificationsEnabled: 'safety_notifications_enabled',
                };
                updated = {};
                _i = 0, _a = Object.entries(flagMap);
                _e.label = 2;
            case 2:
                if (!(_i < _a.length)) return [3 /*break*/, 5];
                _b = _a[_i], key = _b[0], flagName = _b[1];
                val = parsed.data[key];
                if (!(val !== undefined)) return [3 /*break*/, 4];
                return [4 /*yield*/, admin.sc.from('feature_flags').update({ enabled: val, updated_at: new Date().toISOString() }).eq('flag', flagName)];
            case 3:
                _e.sent();
                updated[key] = val;
                _e.label = 4;
            case 4:
                _i++;
                return [3 /*break*/, 2];
            case 5:
                res.json({ ok: true, updated: updated });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
