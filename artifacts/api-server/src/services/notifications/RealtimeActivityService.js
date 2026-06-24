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
exports.RealtimeActivityService = exports.activityBus = void 0;
var logger_js_1 = require("../../lib/logger.js");
var logger = logger_js_1.logger.child({ service: "RealtimeActivityService" });
var ActivityBus = /** @class */ (function () {
    function ActivityBus() {
        this.listeners = new Set();
    }
    ActivityBus.prototype.subscribe = function (listener) {
        var _this = this;
        this.listeners.add(listener);
        return function () { return _this.listeners.delete(listener); };
    };
    ActivityBus.prototype.emit = function (event) {
        for (var _i = 0, _a = this.listeners; _i < _a.length; _i++) {
            var listener = _a[_i];
            try {
                listener(event);
            }
            catch (_b) { }
        }
    };
    return ActivityBus;
}());
exports.activityBus = new ActivityBus();
var RealtimeActivityService = /** @class */ (function () {
    function RealtimeActivityService(db) {
        this.db = db;
    }
    /** Emit a new-notification event on the in-process bus. */
    RealtimeActivityService.prototype.emitCreated = function (notification) {
        exports.activityBus.emit({
            type: 'notification.created',
            userId: notification.userId,
            payload: {
                id: notification.id,
                category: notification.category,
                eventType: notification.eventType,
                priority: notification.priority,
                title: notification.title,
                body: notification.body,
                actionUrl: notification.actionUrl,
                createdAt: notification.createdAt,
            },
        });
    };
    /** Emit a read-state change on the in-process bus. */
    RealtimeActivityService.prototype.emitRead = function (userId, notificationId) {
        exports.activityBus.emit({
            type: 'notification.read',
            userId: userId,
            payload: { id: notificationId },
        });
        this.emitUnreadUpdate(userId);
    };
    /** Emit an unread-count update so client badges refresh. */
    RealtimeActivityService.prototype.emitUnreadUpdate = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var now, count, err_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        now = new Date().toISOString();
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .select('id', { count: 'exact', head: true })
                                .eq('user_id', userId)
                                .is('read_at', null)
                                .is('dismissed_at', null)
                                .or("expires_at.is.null,expires_at.gt.".concat(now))];
                    case 1:
                        count = (_a.sent()).count;
                        exports.activityBus.emit({
                            type: 'unread_count.updated',
                            userId: userId,
                            payload: { unreadCount: count !== null && count !== void 0 ? count : 0 },
                        });
                        return [3 /*break*/, 3];
                    case 2:
                        err_1 = _a.sent();
                        logger.warn({ err: err_1, userId: userId }, 'RealtimeActivityService: unread count emit failed');
                        return [3 /*break*/, 3];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Register an SSE response stream for a user.
     * Returns a cleanup function to call when the connection closes.
     */
    RealtimeActivityService.prototype.registerSSEStream = function (userId, write, onClose) {
        var unsub = exports.activityBus.subscribe(function (event) {
            if (event.userId !== userId)
                return;
            try {
                write("data: ".concat(JSON.stringify(__assign({ type: event.type }, event.payload)), "\n\n"));
            }
            catch (_a) {
                // stream closed
            }
        });
        logger.debug({ userId: userId }, 'RealtimeActivityService: SSE stream registered');
        return function () {
            unsub();
            onClose === null || onClose === void 0 ? void 0 : onClose();
            logger.debug({ userId: userId }, 'RealtimeActivityService: SSE stream closed');
        };
    };
    return RealtimeActivityService;
}());
exports.RealtimeActivityService = RealtimeActivityService;
