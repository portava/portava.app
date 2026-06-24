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
exports.listNotifications = listNotifications;
exports.getUnreadNotificationCount = getUnreadNotificationCount;
exports.markNotificationRead = markNotificationRead;
exports.markAllNotificationsRead = markAllNotificationsRead;
exports.dismissNotification = dismissNotification;
exports.getNotificationPreferences = getNotificationPreferences;
exports.updateNotificationPreferences = updateNotificationPreferences;
exports.registerDevice = registerDevice;
exports.unregisterDevice = unregisterDevice;
exports.getRecentNotifications = getRecentNotifications;
/**
 * notifications.ts — typed client over the notifications API.
 *
 * Covers:
 *   - List notifications (paginated, filterable)
 *   - Unread count
 *   - Mark read / dismiss
 *   - Notification preferences (read + update)
 *   - Device registration (push token)
 */
var supabase_1 = require("../lib/supabase");
function apiBase() { var _a; return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''; }
function freshToken() {
    return __awaiter(this, void 0, void 0, function () {
        var refreshed, session, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, supabase_1.supabase.auth.refreshSession()];
                case 1:
                    refreshed = (_d.sent()).data;
                    if (!((_b = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _b !== void 0)) return [3 /*break*/, 2];
                    _a = _b;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 3:
                    _a = (_d.sent()).data.session;
                    _d.label = 4;
                case 4:
                    session = _a;
                    return [2 /*return*/, (_c = session === null || session === void 0 ? void 0 : session.access_token) !== null && _c !== void 0 ? _c : null];
            }
        });
    });
}
function apiFetch(path, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var base, token, res, json, err_1;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    base = apiBase();
                    if (!base)
                        return [2 /*return*/, { ok: false, data: null, message: 'API not configured' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, message: 'Not authenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(base).concat(path), __assign(__assign({}, opts), { headers: __assign({ Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' }, ((_a = opts === null || opts === void 0 ? void 0 : opts.headers) !== null && _a !== void 0 ? _a : {})) }))];
                case 3:
                    res = _d.sent();
                    return [4 /*yield*/, res.json().catch(function () { return null; })];
                case 4:
                    json = _d.sent();
                    if (!res.ok)
                        return [2 /*return*/, { ok: false, data: null, message: (_b = json === null || json === void 0 ? void 0 : json.message) !== null && _b !== void 0 ? _b : "HTTP ".concat(res.status) }];
                    return [2 /*return*/, { ok: true, data: json }];
                case 5:
                    err_1 = _d.sent();
                    return [2 /*return*/, { ok: false, data: null, message: (_c = err_1 === null || err_1 === void 0 ? void 0 : err_1.message) !== null && _c !== void 0 ? _c : 'Network error' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function listNotifications() {
    return __awaiter(this, arguments, void 0, function (params) {
        var qs, q;
        if (params === void 0) { params = {}; }
        return __generator(this, function (_a) {
            qs = new URLSearchParams();
            if (params.category)
                qs.set('category', params.category);
            if (params.priority)
                qs.set('priority', params.priority);
            if (params.unread)
                qs.set('unread', 'true');
            if (params.limit)
                qs.set('limit', String(params.limit));
            if (params.offset)
                qs.set('offset', String(params.offset));
            if (params.since)
                qs.set('since', params.since);
            q = qs.toString();
            return [2 /*return*/, apiFetch("/api/me/notifications".concat(q ? "?".concat(q) : ''))];
        });
    });
}
function getUnreadNotificationCount() {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, apiFetch('/api/me/notifications/unread-count')];
                case 1:
                    res = _c.sent();
                    return [2 /*return*/, res.ok ? ((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.unreadCount) !== null && _b !== void 0 ? _b : 0) : 0];
            }
        });
    });
}
function markNotificationRead(notificationId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/notifications/".concat(notificationId, "/read"), { method: 'POST' })];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
function markAllNotificationsRead(category) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch('/api/me/notifications/read-all', {
                        method: 'POST',
                        body: category ? JSON.stringify({ category: category }) : JSON.stringify({}),
                    })];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
function dismissNotification(notificationId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/notifications/".concat(notificationId, "/dismiss"), { method: 'POST' })];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
function getNotificationPreferences() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch('/api/me/notification-preferences')];
        });
    });
}
function updateNotificationPreferences(prefs) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch('/api/me/notification-preferences', {
                    method: 'PUT',
                    body: JSON.stringify(prefs),
                })];
        });
    });
}
function registerDevice(pushToken_1) {
    return __awaiter(this, arguments, void 0, function (pushToken, platform) {
        var res;
        if (platform === void 0) { platform = 'expo'; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch('/api/me/devices', {
                        method: 'POST',
                        body: JSON.stringify({ pushToken: pushToken, platform: platform }),
                    })];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
function unregisterDevice(deviceId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/devices/".concat(deviceId), { method: 'DELETE' })];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
/** Get up to 5 most recent notifications for the bell popover. */
function getRecentNotifications() {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, listNotifications({ limit: 5 })];
                case 1:
                    res = _c.sent();
                    return [2 /*return*/, res.ok ? ((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.notifications) !== null && _b !== void 0 ? _b : []) : []];
            }
        });
    });
}
