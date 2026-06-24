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
exports.NotificationPreferenceService = void 0;
var DEFAULTS = {
    pushEnabled: true,
    emailEnabled: false,
    inAppEnabled: true,
    digestsEnabled: false,
    safetyOverride: true,
    quietHoursEnabled: false,
    quietStart: '22:00',
    quietEnd: '08:00',
    messagePreviews: true,
    locationPreviews: false,
};
function rowToPrefs(userId, row) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    if (!row)
        return __assign({ userId: userId }, DEFAULTS);
    return {
        userId: userId,
        pushEnabled: Boolean((_a = row.push_enabled) !== null && _a !== void 0 ? _a : DEFAULTS.pushEnabled),
        emailEnabled: Boolean((_b = row.email_enabled) !== null && _b !== void 0 ? _b : DEFAULTS.emailEnabled),
        inAppEnabled: Boolean((_c = row.in_app_enabled) !== null && _c !== void 0 ? _c : DEFAULTS.inAppEnabled),
        digestsEnabled: Boolean((_d = row.digests_enabled) !== null && _d !== void 0 ? _d : DEFAULTS.digestsEnabled),
        safetyOverride: Boolean((_e = row.safety_override) !== null && _e !== void 0 ? _e : DEFAULTS.safetyOverride),
        quietHoursEnabled: Boolean((_f = row.quiet_hours_enabled) !== null && _f !== void 0 ? _f : DEFAULTS.quietHoursEnabled),
        quietStart: (_g = row.quiet_start) !== null && _g !== void 0 ? _g : DEFAULTS.quietStart,
        quietEnd: (_h = row.quiet_end) !== null && _h !== void 0 ? _h : DEFAULTS.quietEnd,
        messagePreviews: Boolean((_j = row.message_previews) !== null && _j !== void 0 ? _j : DEFAULTS.messagePreviews),
        locationPreviews: Boolean((_k = row.location_previews) !== null && _k !== void 0 ? _k : DEFAULTS.locationPreviews),
    };
}
function prefsToRow(p) {
    var patch = {};
    if (p.pushEnabled !== undefined)
        patch.push_enabled = p.pushEnabled;
    if (p.emailEnabled !== undefined)
        patch.email_enabled = p.emailEnabled;
    if (p.inAppEnabled !== undefined)
        patch.in_app_enabled = p.inAppEnabled;
    if (p.digestsEnabled !== undefined)
        patch.digests_enabled = p.digestsEnabled;
    if (p.safetyOverride !== undefined)
        patch.safety_override = p.safetyOverride;
    if (p.quietHoursEnabled !== undefined)
        patch.quiet_hours_enabled = p.quietHoursEnabled;
    if (p.quietStart !== undefined)
        patch.quiet_start = p.quietStart;
    if (p.quietEnd !== undefined)
        patch.quiet_end = p.quietEnd;
    if (p.messagePreviews !== undefined)
        patch.message_previews = p.messagePreviews;
    if (p.locationPreviews !== undefined)
        patch.location_previews = p.locationPreviews;
    return patch;
}
var NotificationPreferenceService = /** @class */ (function () {
    function NotificationPreferenceService(db) {
        this.db = db;
    }
    NotificationPreferenceService.prototype.getPreferences = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var data;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db
                            .from('notification_preferences')
                            .select('*')
                            .eq('user_id', userId)
                            .maybeSingle()];
                    case 1:
                        data = (_a.sent()).data;
                        return [2 /*return*/, rowToPrefs(userId, data)];
                }
            });
        });
    };
    NotificationPreferenceService.prototype.upsertPreferences = function (userId, patch) {
        return __awaiter(this, void 0, void 0, function () {
            var row, _a, data, error;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        row = __assign(__assign({ user_id: userId }, prefsToRow(patch)), { updated_at: new Date().toISOString() });
                        return [4 /*yield*/, this.db
                                .from('notification_preferences')
                                .upsert(row, { onConflict: 'user_id' })
                                .select('*')
                                .single()];
                    case 1:
                        _a = _b.sent(), data = _a.data, error = _a.error;
                        if (error)
                            throw new Error(error.message);
                        return [2 /*return*/, rowToPrefs(userId, data)];
                }
            });
        });
    };
    NotificationPreferenceService.prototype.getCategoryPreferences = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var data;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.db
                            .from('notification_category_preferences')
                            .select('*')
                            .eq('user_id', userId)];
                    case 1:
                        data = (_a.sent()).data;
                        return [2 /*return*/, (data !== null && data !== void 0 ? data : []).map(function (r) { return ({
                                category: r.category,
                                inAppEnabled: Boolean(r.in_app_enabled),
                                pushEnabled: Boolean(r.push_enabled),
                                emailEnabled: Boolean(r.email_enabled),
                                digestEnabled: Boolean(r.digest_enabled),
                            }); })];
                }
            });
        });
    };
    NotificationPreferenceService.prototype.upsertCategoryPreferences = function (userId, category, patch) {
        return __awaiter(this, void 0, void 0, function () {
            var row;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        row = { user_id: userId, category: category, updated_at: new Date().toISOString() };
                        if (patch.inAppEnabled !== undefined)
                            row.in_app_enabled = patch.inAppEnabled;
                        if (patch.pushEnabled !== undefined)
                            row.push_enabled = patch.pushEnabled;
                        if (patch.emailEnabled !== undefined)
                            row.email_enabled = patch.emailEnabled;
                        if (patch.digestEnabled !== undefined)
                            row.digest_enabled = patch.digestEnabled;
                        return [4 /*yield*/, this.db
                                .from('notification_category_preferences')
                                .upsert(row, { onConflict: 'user_id,category' })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Given a priority and user prefs, decide which channels should be used.
     * Safety override: urgent + admin always go through regardless of push setting.
     */
    NotificationPreferenceService.prototype.filterChannels = function (channels, prefs, catPrefs, priority) {
        var _this = this;
        var isSafetyCritical = priority === 'urgent' || priority === 'important';
        var safetyOverrideApplies = prefs.safetyOverride && isSafetyCritical;
        return channels.filter(function (ch) {
            switch (ch) {
                case 'in_app':
                    if (!prefs.inAppEnabled)
                        return false;
                    if (catPrefs && !catPrefs.inAppEnabled)
                        return false;
                    return true;
                case 'push': {
                    if (!prefs.pushEnabled && !safetyOverrideApplies)
                        return false;
                    if (catPrefs && !catPrefs.pushEnabled && !safetyOverrideApplies)
                        return false;
                    if (prefs.quietHoursEnabled && !safetyOverrideApplies && _this.isQuietHour(prefs))
                        return false;
                    return true;
                }
                case 'email':
                    if (!prefs.emailEnabled)
                        return false;
                    if (catPrefs && !catPrefs.emailEnabled)
                        return false;
                    return true;
                case 'telegraph':
                    return true; // Telegraph system messages always pass through
                default:
                    return false;
            }
        });
    };
    /** Returns true if the current time is inside the quiet window. */
    NotificationPreferenceService.prototype.isQuietHour = function (prefs) {
        if (!prefs.quietHoursEnabled)
            return false;
        var now = new Date();
        var _a = prefs.quietStart.split(':').map(Number), sh = _a[0], sm = _a[1];
        var _b = prefs.quietEnd.split(':').map(Number), eh = _b[0], em = _b[1];
        var nowMins = now.getHours() * 60 + now.getMinutes();
        var startMins = sh * 60 + sm;
        var endMins = eh * 60 + em;
        if (startMins < endMins) {
            // Same-day window (e.g. 09:00–17:00)
            return nowMins >= startMins && nowMins < endMins;
        }
        // Overnight window (e.g. 22:00–08:00)
        return nowMins >= startMins || nowMins < endMins;
    };
    return NotificationPreferenceService;
}());
exports.NotificationPreferenceService = NotificationPreferenceService;
