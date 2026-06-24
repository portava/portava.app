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
exports.NotificationService = void 0;
var logger_js_1 = require("../../lib/logger.js");
var NotificationPrivacyGuard_js_1 = require("./NotificationPrivacyGuard.js");
var NotificationPreferenceService_js_1 = require("./NotificationPreferenceService.js");
var NotificationDeduplicationService_js_1 = require("./NotificationDeduplicationService.js");
var NotificationTemplateService_js_1 = require("./NotificationTemplateService.js");
var logger = logger_js_1.logger.child({ service: "NotificationService" });
function rowToDto(r) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return {
        id: r.id,
        userId: r.user_id,
        category: r.category,
        eventType: r.event_type,
        priority: r.priority,
        title: r.title,
        body: r.body,
        actionUrl: (_a = r.action_url) !== null && _a !== void 0 ? _a : null,
        imageUrl: (_b = r.image_url) !== null && _b !== void 0 ? _b : null,
        sourceType: (_c = r.source_type) !== null && _c !== void 0 ? _c : null,
        sourceId: (_d = r.source_id) !== null && _d !== void 0 ? _d : null,
        actorId: (_e = r.actor_id) !== null && _e !== void 0 ? _e : null,
        metadata: (_f = r.metadata) !== null && _f !== void 0 ? _f : {},
        privacyLevel: (_g = r.privacy_level) !== null && _g !== void 0 ? _g : 'standard',
        readAt: (_h = r.read_at) !== null && _h !== void 0 ? _h : null,
        dismissedAt: (_j = r.dismissed_at) !== null && _j !== void 0 ? _j : null,
        expiresAt: (_k = r.expires_at) !== null && _k !== void 0 ? _k : null,
        createdAt: r.created_at,
    };
}
var NotificationService = /** @class */ (function () {
    function NotificationService(db) {
        this.db = db;
        this.guard = new NotificationPrivacyGuard_js_1.NotificationPrivacyGuard(db);
        this.prefService = new NotificationPreferenceService_js_1.NotificationPreferenceService(db);
        this.dedup = new NotificationDeduplicationService_js_1.NotificationDeduplicationService(db);
    }
    /**
     * Create a notification through the full pipeline:
     * template render → privacy guard → dedup → preference check → persist.
     * Returns the created row or null if blocked/deduped.
     */
    NotificationService.prototype.create = function (input) {
        return __awaiter(this, void 0, void 0, function () {
            var title, body, category, priority, channels, actionUrl, rendered, dedupResult, privacyCtx, sanitised, row, _a, data, error;
            var _b, _c, _d, _e, _f, _g, _h, _j, _k;
            return __generator(this, function (_l) {
                switch (_l.label) {
                    case 0:
                        title = (_b = input.title) !== null && _b !== void 0 ? _b : '';
                        body = (_c = input.body) !== null && _c !== void 0 ? _c : '';
                        category = input.category;
                        priority = input.priority;
                        channels = input.channels;
                        actionUrl = input.actionUrl;
                        if (input.eventType) {
                            rendered = (0, NotificationTemplateService_js_1.renderTemplate)(input.eventType, (_d = input.params) !== null && _d !== void 0 ? _d : {});
                            if (rendered) {
                                if (!title)
                                    title = rendered.title;
                                if (!body)
                                    body = rendered.body;
                                if (!category)
                                    category = rendered.category;
                                if (!priority)
                                    priority = rendered.priority;
                                if (!channels)
                                    channels = rendered.channels;
                                if (!actionUrl)
                                    actionUrl = rendered.actionUrl;
                            }
                        }
                        if (!title || !body || !category) {
                            logger.warn({ eventType: input.eventType }, 'NotificationService.create: missing title/body/category');
                            return [2 /*return*/, null];
                        }
                        return [4 /*yield*/, this.dedup.check({
                                userId: input.userId,
                                category: category,
                                eventType: input.eventType,
                                sourceType: input.sourceType,
                                sourceId: input.sourceId,
                            })];
                    case 1:
                        dedupResult = _l.sent();
                        if (dedupResult.isDuplicate) {
                            logger.debug({ userId: input.userId, eventType: input.eventType, reason: dedupResult.reason }, 'NotificationService: deduped');
                            return [2 /*return*/, null];
                        }
                        privacyCtx = {
                            recipientId: input.userId,
                            senderId: input.senderId,
                            category: category,
                            eventType: input.eventType,
                            tripId: input.tripId,
                            isLiveShare: input.isLiveShare,
                            isPushPreview: channels === null || channels === void 0 ? void 0 : channels.includes('push'),
                        };
                        return [4 /*yield*/, this.guard.sanitise(title, body, privacyCtx)];
                    case 2:
                        sanitised = _l.sent();
                        if (sanitised.blocked) {
                            logger.info({ userId: input.userId, reason: sanitised.blockReason }, 'NotificationService: blocked by privacy guard');
                            return [2 /*return*/, null];
                        }
                        row = {
                            user_id: input.userId,
                            category: category,
                            event_type: input.eventType,
                            priority: priority !== null && priority !== void 0 ? priority : 'normal',
                            title: sanitised.title,
                            body: sanitised.body,
                            action_url: actionUrl !== null && actionUrl !== void 0 ? actionUrl : null,
                            image_url: (_e = input.imageUrl) !== null && _e !== void 0 ? _e : null,
                            source_type: (_f = input.sourceType) !== null && _f !== void 0 ? _f : null,
                            source_id: (_g = input.sourceId) !== null && _g !== void 0 ? _g : null,
                            actor_id: (_h = input.actorId) !== null && _h !== void 0 ? _h : null,
                            metadata: (_j = input.metadata) !== null && _j !== void 0 ? _j : {},
                            privacy_level: sanitised.privacyLevel,
                            expires_at: (_k = input.expiresAt) !== null && _k !== void 0 ? _k : null,
                        };
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .insert(row)
                                .select('*')
                                .single()];
                    case 3:
                        _a = _l.sent(), data = _a.data, error = _a.error;
                        if (error) {
                            logger.error({ err: error }, 'NotificationService.create: DB insert failed');
                            return [2 /*return*/, null];
                        }
                        logger.info({ id: data.id, userId: input.userId, eventType: input.eventType }, 'NotificationService: created');
                        return [2 /*return*/, rowToDto(data)];
                }
            });
        });
    };
    NotificationService.prototype.list = function (opts) {
        return __awaiter(this, void 0, void 0, function () {
            var limit, offset, query, now, _a, data, error, count;
            var _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        limit = Math.min((_b = opts.limit) !== null && _b !== void 0 ? _b : 20, 100);
                        offset = (_c = opts.offset) !== null && _c !== void 0 ? _c : 0;
                        query = this.db
                            .from('notifications')
                            .select('*', { count: 'exact' })
                            .eq('user_id', opts.userId)
                            .is('dismissed_at', null)
                            .order('created_at', { ascending: false })
                            .range(offset, offset + limit - 1);
                        if (opts.category)
                            query = query.eq('category', opts.category);
                        if (opts.priority)
                            query = query.eq('priority', opts.priority);
                        if (opts.unreadOnly)
                            query = query.is('read_at', null);
                        if (opts.since)
                            query = query.gt('created_at', opts.since);
                        now = new Date().toISOString();
                        query = query.or("expires_at.is.null,expires_at.gt.".concat(now));
                        return [4 /*yield*/, query];
                    case 1:
                        _a = _d.sent(), data = _a.data, error = _a.error, count = _a.count;
                        if (error)
                            throw new Error(error.message);
                        return [2 /*return*/, {
                                notifications: (data !== null && data !== void 0 ? data : []).map(rowToDto),
                                total: count !== null && count !== void 0 ? count : 0,
                            }];
                }
            });
        });
    };
    NotificationService.prototype.getUnreadCount = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var now, _a, count, error;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        now = new Date().toISOString();
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .select('id', { count: 'exact', head: true })
                                .eq('user_id', userId)
                                .is('read_at', null)
                                .is('dismissed_at', null)
                                .or("expires_at.is.null,expires_at.gt.".concat(now))];
                    case 1:
                        _a = _b.sent(), count = _a.count, error = _a.error;
                        if (error)
                            return [2 /*return*/, 0];
                        return [2 /*return*/, count !== null && count !== void 0 ? count : 0];
                }
            });
        });
    };
    NotificationService.prototype.markRead = function (userId, notificationId) {
        return __awaiter(this, void 0, void 0, function () {
            var error;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db
                            .from('notifications')
                            .update({ read_at: new Date().toISOString() })
                            .eq('id', notificationId)
                            .eq('user_id', userId)
                            .is('read_at', null)];
                    case 1:
                        error = (_a.sent()).error;
                        return [2 /*return*/, !error];
                }
            });
        });
    };
    NotificationService.prototype.markAllRead = function (userId, category) {
        return __awaiter(this, void 0, void 0, function () {
            var query, _a, count, error;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        query = this.db
                            .from('notifications')
                            .update({ read_at: new Date().toISOString() })
                            .eq('user_id', userId)
                            .is('read_at', null)
                            .is('dismissed_at', null);
                        if (category)
                            query = query.eq('category', category);
                        return [4 /*yield*/, query.select('id', { count: 'exact' })];
                    case 1:
                        _a = _b.sent(), count = _a.count, error = _a.error;
                        if (error)
                            return [2 /*return*/, 0];
                        return [2 /*return*/, count !== null && count !== void 0 ? count : 0];
                }
            });
        });
    };
    NotificationService.prototype.dismiss = function (userId, notificationId) {
        return __awaiter(this, void 0, void 0, function () {
            var error;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db
                            .from('notifications')
                            .update({ dismissed_at: new Date().toISOString() })
                            .eq('id', notificationId)
                            .eq('user_id', userId)];
                    case 1:
                        error = (_a.sent()).error;
                        return [2 /*return*/, !error];
                }
            });
        });
    };
    /** Hard-delete rows that have passed their expiry. Called by cleanup job. */
    NotificationService.prototype.expireOldNotifications = function () {
        return __awaiter(this, void 0, void 0, function () {
            var now, _a, count, error, deleted;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        now = new Date().toISOString();
                        return [4 /*yield*/, this.db
                                .from('notifications')
                                .delete()
                                .lt('expires_at', now).select('id', { count: 'exact' })];
                    case 1:
                        _a = _b.sent(), count = _a.count, error = _a.error;
                        if (error) {
                            logger.error({ err: error }, 'NotificationService.expireOldNotifications: failed');
                            return [2 /*return*/, 0];
                        }
                        deleted = count !== null && count !== void 0 ? count : 0;
                        logger.info({ deleted: deleted }, 'NotificationService: expired old notifications');
                        return [2 /*return*/, deleted];
                }
            });
        });
    };
    return NotificationService;
}());
exports.NotificationService = NotificationService;
