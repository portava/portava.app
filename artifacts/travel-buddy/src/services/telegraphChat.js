"use strict";
/**
 * Telegraph Chat Suggestions — mobile service layer.
 * Wraps all /api/threads/:threadId/telegraph/* endpoints.
 */
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
exports.getTelegraphSuggestions = getTelegraphSuggestions;
exports.dismissSuggestion = dismissSuggestion;
exports.addSuggestionToPlan = addSuggestionToPlan;
exports.getSuggestionMeetupPrefill = getSuggestionMeetupPrefill;
exports.startTimePoll = startTimePoll;
exports.updateTelegraphChatSettings = updateTelegraphChatSettings;
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
function apiGet(path) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, body, data, e_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, error: 'Not authenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    body = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_a = body.message) !== null && _a !== void 0 ? _a : "HTTP ".concat(res.status) }];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    data = _c.sent();
                    return [2 /*return*/, { ok: true, data: data }];
                case 7:
                    e_1 = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_b = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _b !== void 0 ? _b : 'Network error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiPost(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, b, data, e_2;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, error: 'Not authenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            method: 'POST',
                            headers: {
                                Authorization: "Bearer ".concat(token),
                                'Content-Type': 'application/json',
                            },
                            body: body !== undefined ? JSON.stringify(body) : undefined,
                        })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    b = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_a = b.message) !== null && _a !== void 0 ? _a : "HTTP ".concat(res.status) }];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    data = _c.sent();
                    return [2 /*return*/, { ok: true, data: data }];
                case 7:
                    e_2 = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_b = e_2 === null || e_2 === void 0 ? void 0 : e_2.message) !== null && _b !== void 0 ? _b : 'Network error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiPatch(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, b, data, e_3;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, error: 'Not authenticated' }];
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            method: 'PATCH',
                            headers: {
                                Authorization: "Bearer ".concat(token),
                                'Content-Type': 'application/json',
                            },
                            body: body !== undefined ? JSON.stringify(body) : undefined,
                        })];
                case 3:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4:
                    b = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_a = b.message) !== null && _a !== void 0 ? _a : "HTTP ".concat(res.status) }];
                case 5: return [4 /*yield*/, res.json()];
                case 6:
                    data = _c.sent();
                    return [2 /*return*/, { ok: true, data: data }];
                case 7:
                    e_3 = _c.sent();
                    return [2 /*return*/, { ok: false, error: (_b = e_3 === null || e_3 === void 0 ? void 0 : e_3.message) !== null && _b !== void 0 ? _b : 'Network error' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
// ── API calls ─────────────────────────────────────────────────────────────────
/**
 * Fetch active suggestions for a thread. Optionally pass the last sent
 * message text so the server can run intent detection and generate new cards.
 */
function getTelegraphSuggestions(threadId, lastMessage) {
    return __awaiter(this, void 0, void 0, function () {
        var qs, res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    qs = lastMessage
                        ? "?message=".concat(encodeURIComponent(lastMessage.slice(0, 200)))
                        : '';
                    return [4 /*yield*/, apiGet("/api/threads/".concat(threadId, "/telegraph/suggestions").concat(qs))];
                case 1:
                    res = _c.sent();
                    return [2 /*return*/, (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.suggestions) !== null && _b !== void 0 ? _b : []];
            }
        });
    });
}
function dismissSuggestion(threadId, suggestionId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiPost("/api/threads/".concat(threadId, "/telegraph/suggestions/").concat(suggestionId, "/dismiss"))];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
function addSuggestionToPlan(threadId, suggestionId, tripId, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, apiPost("/api/threads/".concat(threadId, "/telegraph/suggestions/").concat(suggestionId, "/add-to-plan"), __assign({ tripId: tripId }, opts))];
                case 1:
                    res = _c.sent();
                    return [2 /*return*/, { ok: res.ok, planItemId: (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.planItem) === null || _b === void 0 ? void 0 : _b.id, error: res.error }];
            }
        });
    });
}
function getSuggestionMeetupPrefill(threadId, suggestionId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, apiPost("/api/threads/".concat(threadId, "/telegraph/suggestions/").concat(suggestionId, "/create-meetup"))];
                case 1:
                    res = _c.sent();
                    return [2 /*return*/, (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.prefill) !== null && _b !== void 0 ? _b : null];
            }
        });
    });
}
function startTimePoll(threadId, suggestionId, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, apiPost("/api/threads/".concat(threadId, "/telegraph/suggestions/").concat(suggestionId, "/start-poll"), opts)];
                case 1:
                    res = _b.sent();
                    return [2 /*return*/, { ok: res.ok, messageId: (_a = res.data) === null || _a === void 0 ? void 0 : _a.messageId, error: res.error }];
            }
        });
    });
}
function updateTelegraphChatSettings(settings) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, apiPatch('/api/me/telegraph-chat-settings', settings)];
                case 1:
                    res = _a.sent();
                    return [2 /*return*/, res.ok];
            }
        });
    });
}
