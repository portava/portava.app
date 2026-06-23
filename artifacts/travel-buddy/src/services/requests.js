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
exports.getMyRequests = getMyRequests;
exports.getRequestCount = getRequestCount;
exports.acceptRequest = acceptRequest;
exports.declineRequest = declineRequest;
exports.cancelRequest = cancelRequest;
/**
 * Requests service — unified inbox for social requests (friend, circle, trip invites).
 * All reads and writes go through the API server (service-role + JWT verification).
 *
 * Action functions (accept/decline/cancel) replace the fragmented per-domain calls
 * so that notifications.tsx has a single, consistent entry point for all request types.
 */
var supabase_1 = require("../lib/supabase");
// ── Internal helpers ──────────────────────────────────────────────────────────
function apiBase() { var _a; return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''; }
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
function mapApiError(status, body) {
    var _a, _b;
    var code = (_a = body === null || body === void 0 ? void 0 : body.error) !== null && _a !== void 0 ? _a : 'db_error';
    var known = ['unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error'];
    return { ok: false, data: null, errorKind: known.includes(code) ? code : 'db_error', message: (_b = body === null || body === void 0 ? void 0 : body.message) !== null && _b !== void 0 ? _b : "API ".concat(status) };
}
function isNetworkError(e) {
    if (!(e instanceof Error))
        return false;
    return e.message.includes('Network request failed') || e.message.includes('fetch');
}
function apiGet(path) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_1;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: null }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), { headers: { Authorization: "Bearer ".concat(token) } })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_1 = _d.sent();
                    if (isNetworkError(e_1))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_1 instanceof Error ? e_1.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function apiPost(path, body) {
    return __awaiter(this, void 0, void 0, function () {
        var token, res, _a, _b, e_2;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured || !apiBase())
                        return [2 /*return*/, { ok: true, data: null }];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _d.sent();
                    if (!token)
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'unauthenticated' }];
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 7, , 8]);
                    return [4 /*yield*/, fetch("".concat(apiBase()).concat(path), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                            body: body ? JSON.stringify(body) : undefined,
                        })];
                case 3:
                    res = _d.sent();
                    if (!!res.ok) return [3 /*break*/, 5];
                    _a = mapApiError;
                    _b = [res.status];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 4: return [2 /*return*/, _a.apply(void 0, _b.concat([_d.sent()]))];
                case 5:
                    _c = { ok: true };
                    return [4 /*yield*/, res.json()];
                case 6: return [2 /*return*/, (_c.data = _d.sent(), _c)];
                case 7:
                    e_2 = _d.sent();
                    if (isNetworkError(e_2))
                        return [2 /*return*/, { ok: false, data: null, errorKind: 'network_unreachable' }];
                    return [2 /*return*/, { ok: false, data: null, errorKind: 'db_error', message: e_2 instanceof Error ? e_2.message : 'Unknown' }];
                case 8: return [2 /*return*/];
            }
        });
    });
}
// ── Read ──────────────────────────────────────────────────────────────────────
function getMyRequests() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/requests')];
        });
    });
}
function getRequestCount() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiGet('/api/me/requests/count')];
        });
    });
}
// ── Unified actions ───────────────────────────────────────────────────────────
/**
 * Accept an incoming request.
 * - friend_request: id = request UUID
 * - circle_invite:  id = invite UUID
 * - trip_invite:    id = trip UUID (invitee's perspective)
 */
function acceptRequest(type, id) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/me/requests/".concat(type, "/").concat(id, "/accept"))];
        });
    });
}
/**
 * Decline an incoming request.
 * - friend_request: id = request UUID
 * - circle_invite:  id = invite UUID
 * - trip_invite:    id = trip UUID (invitee's perspective)
 */
function declineRequest(type, id) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, apiPost("/api/me/requests/".concat(type, "/").concat(id, "/decline"))];
        });
    });
}
/**
 * Cancel an outgoing request.
 * - friend_request: id = request UUID (requester cancels)
 * - circle_invite:  id = invite UUID (owner cancels their outgoing invite)
 * - trip_invite:    id = trip UUID, requires inviteeId in body (owner cancels a specific invite)
 */
function cancelRequest(type, id, opts) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (type === 'trip_invite') {
                return [2 /*return*/, apiPost("/api/me/requests/trip_invite/".concat(id, "/cancel"), { inviteeId: opts === null || opts === void 0 ? void 0 : opts.inviteeId })];
            }
            return [2 /*return*/, apiPost("/api/me/requests/".concat(type, "/").concat(id, "/cancel"))];
        });
    });
}
