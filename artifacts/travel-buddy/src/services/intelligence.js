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
exports.fetchDailyBrief = fetchDailyBrief;
exports.refreshDailyBrief = refreshDailyBrief;
exports.executeBriefAction = executeBriefAction;
exports.dismissBriefRecommendation = dismissBriefRecommendation;
exports.sendConciergeCommand = sendConciergeCommand;
exports.confirmCommandAction = confirmCommandAction;
exports.declineCommandAction = declineCommandAction;
exports.fetchPreferences = fetchPreferences;
exports.patchPreferences = patchPreferences;
exports.resetLearnedPreferences = resetLearnedPreferences;
exports.sendFeedback = sendFeedback;
/**
 * Telegraph Intelligence Service Layer
 * API calls for: Daily Brief, Concierge Commands, Preferences, Feedback.
 *
 * Uses the same authedFetch / freshToken pattern as tripPlan.ts —
 * the token is fetched internally; callers do not need to pass it.
 */
var react_native_1 = require("react-native");
var supabase_1 = require("../lib/supabase");
var getStorage = function () {
    if (react_native_1.Platform.OS === 'web')
        return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@react-native-async-storage/async-storage').default;
};
var apiBase = function () { var _a; return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''; };
var weatherKey = function (tripId) { return "weather_summary:".concat(tripId); };
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
function authedFetch(path_1) {
    return __awaiter(this, arguments, void 0, function (path, opts) {
        var token;
        var _a;
        if (opts === void 0) { opts = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    return [2 /*return*/, fetch("".concat(apiBase()).concat(path), __assign(__assign({}, opts), { headers: __assign(__assign({ 'Content-Type': 'application/json' }, (token ? { Authorization: "Bearer ".concat(token) } : {})), ((_a = opts.headers) !== null && _a !== void 0 ? _a : {})) }))];
            }
        });
    });
}
/* ── Daily Brief ──────────────────────────────────────────────────────────── */
function fetchDailyBrief(tripId, date) {
    return __awaiter(this, void 0, void 0, function () {
        var qs_1, res, data, cached, e_1;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, error: 'not_configured' }];
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 7, , 8]);
                    qs_1 = date ? "?date=".concat(date) : '';
                    return [4 /*yield*/, authedFetch("/api/trips/".concat(tripId, "/daily-brief").concat(qs_1))];
                case 2:
                    res = _d.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _d.sent();
                    if (!res.ok) return [3 /*break*/, 6];
                    if (!data.weatherSummary) return [3 /*break*/, 4];
                    // Persist the latest summary so it survives Open-Meteo downtime
                    (_a = getStorage()) === null || _a === void 0 ? void 0 : _a.setItem(weatherKey(tripId), data.weatherSummary).catch(function () { });
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, ((_b = getStorage()) === null || _b === void 0 ? void 0 : _b.getItem(weatherKey(tripId)))];
                case 5:
                    cached = _d.sent();
                    if (cached)
                        data.weatherSummary = cached;
                    _d.label = 6;
                case 6: return [2 /*return*/, { ok: res.ok, data: data }];
                case 7:
                    e_1 = _d.sent();
                    return [2 /*return*/, { ok: false, error: (_c = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _c !== void 0 ? _c : 'network_error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function refreshDailyBrief(tripId, date) {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, e_2;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, error: 'not_configured' }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, authedFetch("/api/trips/".concat(tripId, "/daily-brief/refresh"), {
                            method: 'POST',
                            body: JSON.stringify(date ? { date: date } : {}),
                        })];
                case 2:
                    res = _b.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _b.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    e_2 = _b.sent();
                    return [2 /*return*/, { ok: false, error: (_a = e_2 === null || e_2 === void 0 ? void 0 : e_2.message) !== null && _a !== void 0 ? _a : 'network_error' }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function executeBriefAction(tripId, actionId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, authedFetch("/api/trips/".concat(tripId, "/daily-brief/actions/").concat(actionId), { method: 'POST' })];
                case 2:
                    res = _b.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _b.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function dismissBriefRecommendation(tripId, recommendationId, category) {
    return __awaiter(this, void 0, void 0, function () {
        var res, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, authedFetch("/api/trips/".concat(tripId, "/daily-brief/dismiss/").concat(recommendationId), {
                            method: 'POST',
                            body: JSON.stringify({ category: category }),
                        })];
                case 2:
                    res = _b.sent();
                    return [2 /*return*/, { ok: res.ok }];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/* ── Concierge Commands ───────────────────────────────────────────────────── */
function sendConciergeCommand(text, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var body, res, data, e_3;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, error: 'not_configured' }];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 4, , 5]);
                    body = {
                        text: text,
                        tripId: (_a = opts === null || opts === void 0 ? void 0 : opts.tripId) !== null && _a !== void 0 ? _a : null,
                        destination: opts === null || opts === void 0 ? void 0 : opts.destination,
                    };
                    if (opts === null || opts === void 0 ? void 0 : opts.meetupId) {
                        body.meetupId = opts.meetupId;
                        body.meetupTime = opts.meetupTime;
                        body.meetupLocation = opts.meetupLocation;
                    }
                    return [4 /*yield*/, authedFetch('/api/telegraph/commands', {
                            method: 'POST',
                            body: JSON.stringify(body),
                        })];
                case 2:
                    res = _c.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _c.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    e_3 = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_b = e_3 === null || e_3 === void 0 ? void 0 : e_3.message) !== null && _b !== void 0 ? _b : 'network_error' }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function confirmCommandAction(commandId, actionId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, authedFetch("/api/telegraph/commands/".concat(commandId, "/confirm-action"), {
                            method: 'POST',
                            body: JSON.stringify({ actionId: actionId }),
                        })];
                case 2:
                    res = _b.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _b.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function declineCommandAction(commandId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, authedFetch("/api/telegraph/commands/".concat(commandId, "/decline-action"), { method: 'POST' })];
                case 2:
                    res = _b.sent();
                    return [2 /*return*/, { ok: res.ok }];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/* ── Preferences ─────────────────────────────────────────────────────────── */
function fetchPreferences() {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, e_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false, error: 'not_configured' }];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, authedFetch('/api/me/preferences')];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    e_4 = _a.sent();
                    return [2 /*return*/, { ok: false, error: e_4 === null || e_4 === void 0 ? void 0 : e_4.message }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function patchPreferences(patch) {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, authedFetch('/api/me/preferences', {
                            method: 'PATCH',
                            body: JSON.stringify(patch),
                        })];
                case 2:
                    res = _b.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _b.sent();
                    return [2 /*return*/, { ok: res.ok, data: data }];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function resetLearnedPreferences() {
    return __awaiter(this, void 0, void 0, function () {
        var res, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, authedFetch('/api/me/preferences/reset-learned', { method: 'POST' })];
                case 2:
                    res = _b.sent();
                    return [2 /*return*/, { ok: res.ok }];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function sendFeedback(recommendationId, category, signal, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: false }];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, authedFetch("/api/telegraph/recommendations/".concat(recommendationId, "/feedback"), {
                            method: 'POST',
                            body: JSON.stringify({ category: category, signal: signal, tripId: tripId !== null && tripId !== void 0 ? tripId : null }),
                        })];
                case 2:
                    res = _b.sent();
                    return [2 /*return*/, { ok: res.ok }];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, { ok: false }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
