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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationDigestService = void 0;
var logger_js_1 = require("../../lib/logger.js");
var NotificationService_js_1 = require("./NotificationService.js");
var logger = logger_js_1.logger.child({ service: "NotificationDigestService" });
var DIGEST_CATEGORIES = ['trips', 'pulse', 'passport', 'hidden_gems', 'compass'];
var CATEGORY_LABELS = {
    trips: 'Trips',
    pulse: 'City Pulse',
    passport: 'Passport',
    hidden_gems: 'Hidden Gems',
    compass: 'Compass AI',
};
var NotificationDigestService = /** @class */ (function () {
    function NotificationDigestService(db) {
        this.db = db;
        this.notifService = new NotificationService_js_1.NotificationService(db);
    }
    /**
     * Build and send a daily digest for a single user.
     * Should be called once per day per user who has digests_enabled.
     */
    NotificationDigestService.prototype.sendDailyDigest = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var since, _i, DIGEST_CATEGORIES_1, category;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        since = this.getStartOfYesterday();
                        _i = 0, DIGEST_CATEGORIES_1 = DIGEST_CATEGORIES;
                        _a.label = 1;
                    case 1:
                        if (!(_i < DIGEST_CATEGORIES_1.length)) return [3 /*break*/, 4];
                        category = DIGEST_CATEGORIES_1[_i];
                        return [4 /*yield*/, this.sendCategoryDigest(userId, category, since)];
                    case 2:
                        _a.sent();
                        _a.label = 3;
                    case 3:
                        _i++;
                        return [3 /*break*/, 1];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Run digests for all users who have digest preferences enabled.
     * Called by the scheduled cleanup/job infrastructure.
     */
    NotificationDigestService.prototype.runForAllUsers = function () {
        return __awaiter(this, void 0, void 0, function () {
            var prefs, users, err_1;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        return [4 /*yield*/, this.db
                                .from('notification_preferences')
                                .select('user_id')
                                .eq('digests_enabled', true)];
                    case 1:
                        prefs = (_a.sent()).data;
                        users = (prefs !== null && prefs !== void 0 ? prefs : []).map(function (r) { return r.user_id; });
                        logger.info({ count: users.length }, 'DigestService: processing daily digests');
                        return [4 /*yield*/, Promise.allSettled(users.map(function (uid) { return _this.sendDailyDigest(uid); }))];
                    case 2:
                        _a.sent();
                        return [2 /*return*/, { usersProcessed: users.length }];
                    case 3:
                        err_1 = _a.sent();
                        logger.error({ err: err_1 }, 'DigestService.runForAllUsers: failed');
                        return [2 /*return*/, { usersProcessed: 0 }];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    NotificationDigestService.prototype.sendCategoryDigest = function (userId, category, since) {
        return __awaiter(this, void 0, void 0, function () {
            var rows, notifications, label, title, body, input, err_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 3, , 4]);
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .select('id, title, body, priority')
                                .eq('user_id', userId)
                                .eq('category', category)
                                .gt('created_at', since)
                                .is('dismissed_at', null)
                                .in('priority', ['normal', 'low'])];
                    case 1:
                        rows = (_a.sent()).data;
                        notifications = (rows !== null && rows !== void 0 ? rows : []);
                        if (notifications.length === 0)
                            return [2 /*return*/];
                        label = CATEGORY_LABELS[category];
                        title = "Your ".concat(label, " digest");
                        body = notifications.length === 1
                            ? notifications[0].body
                            : "".concat(notifications.length, " updates \u2014 ").concat(notifications.map(function (n) { return n.title; }).slice(0, 3).join(', ')).concat(notifications.length > 3 ? '…' : '');
                        input = {
                            userId: userId,
                            eventType: "digest.".concat(category),
                            title: title,
                            body: body,
                            category: 'compass', // digests go into compass category for display
                            priority: 'low',
                            channels: ['in_app'],
                            sourceType: 'digest',
                            sourceId: "".concat(category, "_").concat(since.slice(0, 10)),
                            metadata: { digestCategory: category, count: notifications.length },
                        };
                        return [4 /*yield*/, this.notifService.create(input)];
                    case 2:
                        _a.sent();
                        logger.info({ userId: userId, category: category, count: notifications.length }, 'DigestService: digest created');
                        return [3 /*break*/, 4];
                    case 3:
                        err_2 = _a.sent();
                        logger.warn({ err: err_2, userId: userId, category: category }, 'DigestService: category digest failed');
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    NotificationDigestService.prototype.getStartOfYesterday = function () {
        var d = new Date();
        d.setDate(d.getDate() - 1);
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
    };
    return NotificationDigestService;
}());
exports.NotificationDigestService = NotificationDigestService;
