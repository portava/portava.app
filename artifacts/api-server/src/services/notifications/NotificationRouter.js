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
exports.NotificationRouter = void 0;
var logger_js_1 = require("../../lib/logger.js");
var push_js_1 = require("../../lib/push.js");
var NotificationPreferenceService_js_1 = require("./NotificationPreferenceService.js");
var logger = logger_js_1.logger.child({ service: "NotificationRouter" });
var NotificationRouter = /** @class */ (function () {
    function NotificationRouter(db) {
        this.db = db;
        this.prefService = new NotificationPreferenceService_js_1.NotificationPreferenceService(db);
    }
    /**
     * Route a notification to all appropriate channels.
     * Assumes the notification row has already been persisted by NotificationService.
     */
    NotificationRouter.prototype.route = function (notification) {
        return __awaiter(this, void 0, void 0, function () {
            var userId, prefs, catPrefs, wantedChannels, activeChannels;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        userId = notification.userId;
                        return [4 /*yield*/, this.prefService.getPreferences(userId)];
                    case 1:
                        prefs = _a.sent();
                        return [4 /*yield*/, this.prefService.getCategoryPreferences(userId)];
                    case 2:
                        catPrefs = (_a.sent())
                            .find(function (c) { return c.category === notification.category; });
                        wantedChannels = ['in_app', 'push'];
                        activeChannels = this.prefService.filterChannels(wantedChannels, prefs, catPrefs, notification.priority);
                        return [4 /*yield*/, Promise.allSettled([
                                // in_app is already persisted — just log
                                this.logAttempt(notification.id, userId, 'in_app', activeChannels.includes('in_app') ? 'sent' : 'suppressed'),
                                // push
                                activeChannels.includes('push')
                                    ? this.sendPush(notification, userId)
                                    : this.logAttempt(notification.id, userId, 'push', 'suppressed'),
                                // telegraph (for telegraph-category notifications)
                                notification.category === 'telegraph'
                                    ? this.sendTelegraphSystemMsg(notification, userId)
                                    : Promise.resolve(),
                                // email stub
                                this.logAttempt(notification.id, userId, 'email', 'suppressed', 'email provider not configured'),
                            ])];
                    case 3:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    NotificationRouter.prototype.sendPush = function (notification, userId) {
        return __awaiter(this, void 0, void 0, function () {
            var devices, profile, tokens, err_1;
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        _d.trys.push([0, 7, , 9]);
                        return [4 /*yield*/, this.db
                                .from('notification_devices')
                                .select('push_token')
                                .eq('user_id', userId)];
                    case 1:
                        devices = (_d.sent()).data;
                        return [4 /*yield*/, this.db
                                .from('profiles')
                                .select('expo_push_token')
                                .eq('id', userId)
                                .maybeSingle()];
                    case 2:
                        profile = (_d.sent()).data;
                        tokens = __spreadArray(__spreadArray([], (devices !== null && devices !== void 0 ? devices : []).map(function (d) { return d.push_token; }), true), [
                            (_a = profile === null || profile === void 0 ? void 0 : profile.expo_push_token) !== null && _a !== void 0 ? _a : null,
                        ], false).filter(Boolean);
                        if (!(tokens.length === 0)) return [3 /*break*/, 4];
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'push', 'suppressed', 'no push tokens')];
                    case 3:
                        _d.sent();
                        return [2 /*return*/];
                    case 4: return [4 /*yield*/, (0, push_js_1.sendPushNotification)(tokens, {
                            title: notification.title,
                            body: notification.body,
                            data: __assign({ notificationId: notification.id, category: notification.category, eventType: notification.eventType, actionUrl: (_b = notification.actionUrl) !== null && _b !== void 0 ? _b : undefined }, ((_c = notification.metadata) !== null && _c !== void 0 ? _c : {})),
                        })];
                    case 5:
                        _d.sent();
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'push', 'sent', undefined, {
                                tokenCount: tokens.length,
                            })];
                    case 6:
                        _d.sent();
                        return [3 /*break*/, 9];
                    case 7:
                        err_1 = _d.sent();
                        logger.warn({ err: err_1, notificationId: notification.id }, 'NotificationRouter: push failed');
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'push', 'failed', String(err_1))];
                    case 8:
                        _d.sent();
                        return [3 /*break*/, 9];
                    case 9: return [2 /*return*/];
                }
            });
        });
    };
    NotificationRouter.prototype.sendTelegraphSystemMsg = function (notification, userId) {
        return __awaiter(this, void 0, void 0, function () {
            var threadId, err_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 5, , 7]);
                        threadId = notification.sourceId;
                        if (!!threadId) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'telegraph', 'suppressed', 'no thread id')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                    case 2: 
                    // Insert a system message into the thread
                    return [4 /*yield*/, this.db.from('messages').insert({
                            thread_id: threadId,
                            sender_id: userId, // system message attributed to recipient
                            body: notification.body,
                            msg_type: 'system',
                            subtype: notification.eventType,
                        })];
                    case 3:
                        // Insert a system message into the thread
                        _a.sent();
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'telegraph', 'sent')];
                    case 4:
                        _a.sent();
                        return [3 /*break*/, 7];
                    case 5:
                        err_2 = _a.sent();
                        logger.warn({ err: err_2, notificationId: notification.id }, 'NotificationRouter: telegraph msg failed');
                        return [4 /*yield*/, this.logAttempt(notification.id, userId, 'telegraph', 'failed', String(err_2))];
                    case 6:
                        _a.sent();
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    NotificationRouter.prototype.logAttempt = function (notificationId_1, userId_1, channel_1, status_1, errorMessage_1) {
        return __awaiter(this, arguments, void 0, function (notificationId, userId, channel, status, errorMessage, metadata) {
            var err_3;
            if (metadata === void 0) { metadata = {}; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.db.from('notification_delivery_attempts').insert({
                                notification_id: notificationId,
                                user_id: userId,
                                channel: channel,
                                status: status,
                                error_message: errorMessage !== null && errorMessage !== void 0 ? errorMessage : null,
                                metadata: metadata,
                            })];
                    case 1:
                        _a.sent();
                        return [3 /*break*/, 3];
                    case 2:
                        err_3 = _a.sent();
                        logger.warn({ err: err_3 }, 'NotificationRouter: failed to log delivery attempt');
                        return [3 /*break*/, 3];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return NotificationRouter;
}());
exports.NotificationRouter = NotificationRouter;
