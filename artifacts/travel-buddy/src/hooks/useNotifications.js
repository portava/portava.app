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
exports.useNotifications = useNotifications;
exports.useUnreadNotificationCount = useUnreadNotificationCount;
exports.useRecentNotifications = useRecentNotifications;
exports.useNotificationPreferences = useNotificationPreferences;
/**
 * useNotifications — hooks for the Activity Center and notification bell.
 *
 * Polling interval respects app foreground state (same pattern as useMessaging).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var notifications_1 = require("../services/notifications");
var UNREAD_POLL_MS = 15000;
var NOTIF_POLL_MS = 30000;
// ── useNotifications ──────────────────────────────────────────────────────────
function useNotifications(params) {
    var _this = this;
    var _a;
    if (params === void 0) { params = {}; }
    var _b = (0, react_1.useState)([]), notifications = _b[0], setNotifications = _b[1];
    var _c = (0, react_1.useState)(0), total = _c[0], setTotal = _c[1];
    var _d = (0, react_1.useState)(true), loading = _d[0], setLoading = _d[1];
    var _e = (0, react_1.useState)(null), error = _e[0], setError = _e[1];
    var _f = (0, react_1.useState)(false), loadingMore = _f[0], setLoadingMore = _f[1];
    var offsetRef = (0, react_1.useRef)(0);
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var limit = (_a = params.limit) !== null && _a !== void 0 ? _a : 20;
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    offsetRef.current = 0;
                    return [4 /*yield*/, (0, notifications_1.listNotifications)(__assign(__assign({}, params), { limit: limit, offset: 0 }))];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setNotifications(res.data.notifications);
                        setTotal(res.data.total);
                    }
                    else {
                        setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load notifications');
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, [JSON.stringify(params), limit]);
    var loadMore = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var nextOffset, res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (loadingMore)
                        return [2 /*return*/];
                    nextOffset = offsetRef.current + limit;
                    if (nextOffset >= total)
                        return [2 /*return*/];
                    setLoadingMore(true);
                    return [4 /*yield*/, (0, notifications_1.listNotifications)(__assign(__assign({}, params), { limit: limit, offset: nextOffset }))];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data) {
                        setNotifications(function (prev) { return __spreadArray(__spreadArray([], prev, true), res.data.notifications, true); });
                        setTotal(res.data.total);
                        offsetRef.current = nextOffset;
                    }
                    setLoadingMore(false);
                    return [2 /*return*/];
            }
        });
    }); }, [params, limit, total, loadingMore]);
    var silentPoll = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (appStateRef.current !== 'active')
                        return [2 /*return*/];
                    return [4 /*yield*/, (0, notifications_1.listNotifications)(__assign(__assign({}, params), { limit: limit, offset: 0 }))];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data) {
                        setNotifications(res.data.notifications);
                        setTotal(res.data.total);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [JSON.stringify(params), limit]);
    (0, react_1.useEffect)(function () { reload(); }, [reload]);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
            if (next === 'active')
                silentPoll();
        });
        var timer = setInterval(silentPoll, NOTIF_POLL_MS);
        return function () { sub.remove(); clearInterval(timer); };
    }, [silentPoll]);
    var markRead = (0, react_1.useCallback)(function (id) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, notifications_1.markNotificationRead)(id)];
                case 1:
                    _a.sent();
                    setNotifications(function (prev) {
                        return prev.map(function (n) { return n.id === id ? __assign(__assign({}, n), { readAt: new Date().toISOString() }) : n; });
                    });
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var markAllRead = (0, react_1.useCallback)(function (category) { return __awaiter(_this, void 0, void 0, function () {
        var now;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, notifications_1.markAllNotificationsRead)(category)];
                case 1:
                    _a.sent();
                    now = new Date().toISOString();
                    setNotifications(function (prev) {
                        return prev.map(function (n) { return (!n.readAt && (!category || n.category === category)) ? __assign(__assign({}, n), { readAt: now }) : n; });
                    });
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var dismiss = (0, react_1.useCallback)(function (id) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, notifications_1.dismissNotification)(id)];
                case 1:
                    _a.sent();
                    setNotifications(function (prev) { return prev.filter(function (n) { return n.id !== id; }); });
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var unreadCount = notifications.filter(function (n) { return !n.readAt; }).length;
    return { notifications: notifications, total: total, loading: loading, error: error, loadingMore: loadingMore, unreadCount: unreadCount, reload: reload, loadMore: loadMore, markRead: markRead, markAllRead: markAllRead, dismiss: dismiss };
}
// ── useUnreadNotificationCount ────────────────────────────────────────────────
function useUnreadNotificationCount() {
    var _this = this;
    var _a = (0, react_1.useState)(0), count = _a[0], setCount = _a[1];
    var appStateRef = (0, react_1.useRef)(react_native_1.AppState.currentState);
    var refresh = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var c;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, notifications_1.getUnreadNotificationCount)()];
                case 1:
                    c = _a.sent();
                    setCount(c);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () { refresh(); }, [refresh]);
    (0, react_1.useEffect)(function () {
        var sub = react_native_1.AppState.addEventListener('change', function (next) {
            appStateRef.current = next;
            if (next === 'active')
                refresh();
        });
        var timer = setInterval(function () {
            if (appStateRef.current === 'active')
                refresh();
        }, UNREAD_POLL_MS);
        return function () { sub.remove(); clearInterval(timer); };
    }, [refresh]);
    return { count: count, refresh: refresh };
}
// ── useRecentNotifications (for bell popover) ─────────────────────────────────
function useRecentNotifications() {
    var _this = this;
    var _a = (0, react_1.useState)([]), notifications = _a[0], setNotifications = _a[1];
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var items;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, notifications_1.getRecentNotifications)()];
                case 1:
                    items = _a.sent();
                    setNotifications(items);
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    return { notifications: notifications, loading: loading, reload: reload };
}
// ── useNotificationPreferences ────────────────────────────────────────────────
function useNotificationPreferences() {
    var _this = this;
    var _a = (0, react_1.useState)(null), preferences = _a[0], setPreferences = _a[1];
    var _b = (0, react_1.useState)([]), categoryPreferences = _b[0], setCategoryPreferences = _b[1];
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(false), saving = _d[0], setSaving = _d[1];
    var _e = (0, react_1.useState)(null), error = _e[0], setError = _e[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, notifications_1.getNotificationPreferences)()];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setPreferences(res.data.preferences);
                        setCategoryPreferences(res.data.categoryPreferences);
                    }
                    else {
                        setError((_a = res.message) !== null && _a !== void 0 ? _a : 'Failed to load preferences');
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () { reload(); }, [reload]);
    var save = (0, react_1.useCallback)(function (patch) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setSaving(true);
                    return [4 /*yield*/, (0, notifications_1.updateNotificationPreferences)(patch)];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data) {
                        setPreferences((_a = res.data.preferences) !== null && _a !== void 0 ? _a : preferences);
                    }
                    setSaving(false);
                    return [2 /*return*/, res.ok];
            }
        });
    }); }, [preferences]);
    return { preferences: preferences, categoryPreferences: categoryPreferences, loading: loading, saving: saving, error: error, reload: reload, save: save };
}
