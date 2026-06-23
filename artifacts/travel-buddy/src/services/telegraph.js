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
exports.getActivityRecommendations = getActivityRecommendations;
/**
 * Telegraph client service.
 * Fetches AI activity recommendations from POST /api/telegraph/recommend.
 * Falls back to built-in mock recommendations when backend is unavailable.
 */
var supabase_1 = require("../lib/supabase");
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
function freshToken() {
    return __awaiter(this, void 0, void 0, function () {
        var refreshed, session, _a, _b;
        var _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    _e.trys.push([0, 5, , 6]);
                    return [4 /*yield*/, supabase_1.supabase.auth.refreshSession()];
                case 1:
                    refreshed = (_e.sent()).data;
                    if (!((_c = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _c !== void 0)) return [3 /*break*/, 2];
                    _a = _c;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 3:
                    _a = (_e.sent()).data.session;
                    _e.label = 4;
                case 4:
                    session = _a;
                    return [2 /*return*/, (_d = session === null || session === void 0 ? void 0 : session.access_token) !== null && _d !== void 0 ? _d : null];
                case 5:
                    _b = _e.sent();
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function getActivityRecommendations(context) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase()) {
                        return [2 /*return*/, { ok: true, recommendations: buildMockRecommendations(context) }];
                    }
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token) {
                        return [2 /*return*/, { ok: true, recommendations: buildMockRecommendations(context) }];
                    }
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(apiBase(), "/api/telegraph/recommend"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: "Bearer ".concat(token),
                            },
                            body: JSON.stringify(context),
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok) {
                        return [2 /*return*/, { ok: true, recommendations: buildMockRecommendations(context) }];
                    }
                    return [4 /*yield*/, res.json()];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: true, recommendations: (_b = body.recommendations) !== null && _b !== void 0 ? _b : [] }];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, { ok: true, recommendations: buildMockRecommendations(context) }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function buildMockRecommendations(ctx) {
    var _a, _b, _c;
    var dest = (_a = ctx.destination) !== null && _a !== void 0 ? _a : 'Cebu';
    var interests = (_b = ctx.interests) !== null && _b !== void 0 ? _b : [];
    var count = (_c = ctx.count) !== null && _c !== void 0 ? _c : 3;
    var all = [
        {
            id: 'rec_mock_1',
            title: "Island Hopping near ".concat(dest),
            category: 'beach',
            reason: 'Matches your beach and adventure interests. Top-rated by solo travelers.',
            locationContext: '45 min from Mactan Pier',
            estimatedTime: 'Full day',
            priceLevel: '$$',
        },
        {
            id: 'rec_mock_2',
            title: 'Lechón at CNT Lechon',
            category: 'food',
            reason: 'Best-rated lechón in the Visayas — a must for food lovers.',
            locationContext: '1.4 km from downtown Cebu City',
            estimatedTime: '1–2 hours',
            priceLevel: '$',
        },
        {
            id: 'rec_mock_3',
            title: 'IT Park Night Crawl',
            category: 'nightlife',
            reason: 'Great bar-hopping area for solo travelers and nightlife fans.',
            locationContext: 'IT Park, Cebu City',
            estimatedTime: '3–4 hours',
            priceLevel: '$$',
        },
        {
            id: 'rec_mock_4',
            title: 'Kawasan Falls Canyoneering',
            category: 'activity',
            reason: 'Top adventure activity in the region. Book a guide in advance.',
            locationContext: 'Badian, 3 hrs from Cebu City',
            estimatedTime: 'Full day',
            priceLevel: '$$',
        },
        {
            id: 'rec_mock_5',
            title: 'Heritage Walk: Colon Street',
            category: 'activity',
            reason: 'Oldest street in the Philippines — great for culture and photography.',
            locationContext: 'Downtown Cebu City',
            estimatedTime: '2–3 hours',
            priceLevel: 'free',
        },
    ];
    // Prioritize recs that match declared interests
    var sorted = all.sort(function (a, b) {
        var aMatch = interests.some(function (i) { return a.category.includes(i) || a.title.toLowerCase().includes(i); });
        var bMatch = interests.some(function (i) { return b.category.includes(i) || b.title.toLowerCase().includes(i); });
        return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
    });
    return sorted.slice(0, count);
}
