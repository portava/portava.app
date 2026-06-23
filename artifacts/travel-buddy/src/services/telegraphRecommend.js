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
exports.getForYouRecommendations = getForYouRecommendations;
/**
 * Telegraph recommend service — fetches AI place recommendations for the
 * Discovery Hub's "For You" tab.
 */
var supabase_1 = require("../lib/supabase");
var apiBase = function () { var _a; return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''; };
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
function getForYouRecommendations(params) {
    return __awaiter(this, void 0, void 0, function () {
        var base, token, controller, timeoutId, res, data, e_1, isTimeout;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    base = apiBase();
                    if (!base)
                        return [2 /*return*/, { ok: false, error: 'API not configured' }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _e.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, error: 'Not signed in' }];
                    controller = new AbortController();
                    timeoutId = setTimeout(function () { return controller.abort(); }, 10000);
                    _e.label = 2;
                case 2:
                    _e.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, fetch("".concat(base, "/api/telegraph/recommend"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: "Bearer ".concat(token),
                            },
                            body: JSON.stringify({
                                destination: params.destination,
                                interests: (_a = params.interests) !== null && _a !== void 0 ? _a : ['food', 'culture', 'adventure'],
                                travelStyle: (_b = params.travelStyle) !== null && _b !== void 0 ? _b : 'explorer',
                                count: (_c = params.count) !== null && _c !== void 0 ? _c : 8,
                            }),
                            signal: controller.signal,
                        })];
                case 3:
                    res = _e.sent();
                    clearTimeout(timeoutId);
                    if (!res.ok)
                        return [2 /*return*/, { ok: false, error: "HTTP ".concat(res.status) }];
                    return [4 /*yield*/, res.json()];
                case 4:
                    data = (_e.sent());
                    return [2 /*return*/, { ok: true, recommendations: (_d = data.recommendations) !== null && _d !== void 0 ? _d : [] }];
                case 5:
                    e_1 = _e.sent();
                    clearTimeout(timeoutId);
                    isTimeout = e_1 instanceof Error && e_1.name === 'AbortError';
                    return [2 /*return*/, { ok: false, error: isTimeout ? 'Request timed out' : 'Network error' }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
