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
exports.getGeofence = getGeofence;
exports.setGeofence = setGeofence;
exports.revealExactLocation = revealExactLocation;
exports.checkIn = checkIn;
exports.getAttendance = getAttendance;
exports.overrideAttendance = overrideAttendance;
/**
 * Plan geofence service — typed wrappers for the geofence API.
 * All coordinates stay server-side; clients receive labels and status text only.
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
function authedFetch(url_1) {
    return __awaiter(this, arguments, void 0, function (url, opts) {
        var token;
        var _a;
        if (opts === void 0) { opts = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _b.sent();
                    return [2 /*return*/, fetch(url, __assign(__assign({}, opts), { headers: __assign(__assign({ 'Content-Type': 'application/json' }, (token ? { Authorization: "Bearer ".concat(token) } : {})), ((_a = opts.headers) !== null && _a !== void 0 ? _a : {})) }))];
            }
        });
    });
}
// ── API calls ─────────────────────────────────────────────────────────────────
/** Load geofence for a trip. Non-members see only public preview info. */
function getGeofence(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence"))];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error('Failed to load geofence');
                    return [2 /*return*/, res.json()];
            }
        });
    });
}
/** Create or update the geofence for a trip (owner only). */
function setGeofence(tripId, payload) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence"), {
                        method: 'POST',
                        body: JSON.stringify(payload),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    body = _b.sent();
                    throw new Error((_a = body === null || body === void 0 ? void 0 : body.message) !== null && _a !== void 0 ? _a : 'Failed to save geofence');
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Host reveals exact location to accepted members. */
function revealExactLocation(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence/reveal"), {
                        method: 'POST',
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    body = _b.sent();
                    throw new Error((_a = body === null || body === void 0 ? void 0 : body.message) !== null && _a !== void 0 ? _a : 'Failed to reveal location');
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Check in using the user's current GPS coordinates. */
function checkIn(tripId, lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence/check-in"), {
                        method: 'POST',
                        body: JSON.stringify({ lat: lat, lng: lng }),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    body = _b.sent();
                    throw new Error((_a = body === null || body === void 0 ? void 0 : body.message) !== null && _a !== void 0 ? _a : 'Check-in failed');
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
/** Load host attendance dashboard (owner only). */
function getAttendance(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence/attendance"))];
                case 1:
                    res = _b.sent();
                    if (!(res.status === 200)) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json()];
                case 2:
                    body = _b.sent();
                    return [2 /*return*/, (_a = body.attendance) !== null && _a !== void 0 ? _a : body];
                case 3: return [2 /*return*/, null];
            }
        });
    });
}
/** Host manually overrides a member's attendance status. */
function overrideAttendance(tripId, userId, status, note) {
    return __awaiter(this, void 0, void 0, function () {
        var res, body;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/geofence/attendance/").concat(userId, "/override"), { method: 'POST', body: JSON.stringify({ status: status, note: note }) })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    body = _b.sent();
                    throw new Error((_a = body === null || body === void 0 ? void 0 : body.message) !== null && _a !== void 0 ? _a : 'Override failed');
                case 3: return [2 /*return*/];
            }
        });
    });
}
