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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSuggestion = getSuggestion;
exports.createSession = createSession;
exports.startSession = startSession;
exports.getActiveSession = getActiveSession;
exports.extendTimer = extendTimer;
exports.confirmSafe = confirmSafe;
exports.cancelSession = cancelSession;
exports.startLiveShare = startLiveShare;
exports.getSessionContacts = getSessionContacts;
exports.stopLiveShare = stopLiveShare;
exports.getHistory = getHistory;
exports.getTrustedContacts = getTrustedContacts;
/**
 * Safe Return mobile service layer.
 * All network calls go through EXPO_PUBLIC_API_BASE_URL (the API server proxy).
 * Auth token comes from supabase.auth.getSession() — same pattern as trips.ts.
 */
var supabase_1 = require("../lib/supabase");
var API_BASE = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
function authHeader() {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    data = (_d.sent()).data;
                    return [2 /*return*/, (_c = (_b = data.session) === null || _b === void 0 ? void 0 : _b.access_token) !== null && _c !== void 0 ? _c : null];
                case 2:
                    _a = _d.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function apiFetch(path_1) {
    return __awaiter(this, arguments, void 0, function (path, opts) {
        var token, headers, res, _a;
        var _b;
        if (opts === void 0) { opts = {}; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, authHeader()];
                case 1:
                    token = _c.sent();
                    headers = __assign({ 'Content-Type': 'application/json' }, ((_b = opts.headers) !== null && _b !== void 0 ? _b : {}));
                    if (token)
                        headers['Authorization'] = "Bearer ".concat(token);
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, fetch("".concat(API_BASE).concat(path), __assign(__assign({}, opts), { headers: headers }))];
                case 3:
                    res = _c.sent();
                    return [2 /*return*/, res.json()];
                case 4:
                    _a = _c.sent();
                    return [2 /*return*/, { error: 'network_error' }];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ── API calls ─────────────────────────────────────────────────────────────────
function getSuggestion(planItemId) {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/safe-return/suggest/".concat(planItemId))];
                case 1:
                    data = _a.sent();
                    if (data === null || data === void 0 ? void 0 : data.error)
                        return [2 /*return*/, null];
                    return [2 /*return*/, data];
            }
        });
    });
}
function createSession(opts) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch('/api/me/safe-return/sessions', {
                    method: 'POST',
                    body: JSON.stringify(opts),
                })];
        });
    });
}
function startSession(sessionId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/start"), { method: 'POST' })];
        });
    });
}
function getActiveSession() {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiFetch('/api/me/safe-return/sessions/active')];
                case 1:
                    data = _b.sent();
                    return [2 /*return*/, { session: (_a = data === null || data === void 0 ? void 0 : data.session) !== null && _a !== void 0 ? _a : null, featureEnabled: data === null || data === void 0 ? void 0 : data.featureEnabled }];
            }
        });
    });
}
function extendTimer(sessionId, minutes) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/extend"), {
                    method: 'POST',
                    body: JSON.stringify({ minutes: minutes }),
                })];
        });
    });
}
function confirmSafe(sessionId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/confirm"), { method: 'POST' })];
        });
    });
}
function cancelSession(sessionId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/cancel"), { method: 'POST' })];
        });
    });
}
function startLiveShare(sessionId, opts) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/live-share/start"), {
                    method: 'POST',
                    body: JSON.stringify(opts),
                })];
        });
    });
}
function getSessionContacts(sessionId) {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/contacts"))];
                case 1:
                    data = _b.sent();
                    return [2 /*return*/, (_a = data === null || data === void 0 ? void 0 : data.contacts) !== null && _a !== void 0 ? _a : []];
            }
        });
    });
}
function stopLiveShare(sessionId, shareId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiFetch("/api/me/safe-return/sessions/".concat(sessionId, "/live-share/stop"), {
                    method: 'POST',
                    body: JSON.stringify({ shareId: shareId }),
                })];
        });
    });
}
function getHistory() {
    return __awaiter(this, arguments, void 0, function (limit) {
        var data;
        var _a;
        if (limit === void 0) { limit = 20; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiFetch("/api/me/safe-return/history?limit=".concat(limit))];
                case 1:
                    data = _b.sent();
                    return [2 /*return*/, { sessions: (_a = data === null || data === void 0 ? void 0 : data.sessions) !== null && _a !== void 0 ? _a : [], featureEnabled: data === null || data === void 0 ? void 0 : data.featureEnabled }];
            }
        });
    });
}
function getTrustedContacts() {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiFetch('/api/me/safe-return/trusted-contacts')];
                case 1:
                    data = _b.sent();
                    return [2 /*return*/, (_a = data === null || data === void 0 ? void 0 : data.contacts) !== null && _a !== void 0 ? _a : []];
            }
        });
    });
}
