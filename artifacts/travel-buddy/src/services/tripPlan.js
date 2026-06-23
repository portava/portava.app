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
exports.fetchTripPlan = fetchTripPlan;
exports.fetchTripPlanPermission = fetchTripPlanPermission;
exports.updateTripPlanPermission = updateTripPlanPermission;
exports.fetchTripPlanMap = fetchTripPlanMap;
exports.createPlanItem = createPlanItem;
exports.updatePlanItem = updatePlanItem;
exports.removePlanItem = removePlanItem;
exports.deletePlanItem = deletePlanItem;
exports.reorderPlanItem = reorderPlanItem;
exports.fetchPlanEditableTrips = fetchPlanEditableTrips;
exports.addMeetupToPlan = addMeetupToPlan;
exports.addPlaceToPlan = addPlaceToPlan;
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
function planUrl(tripId) {
    var parts = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        parts[_i - 1] = arguments[_i];
    }
    return "".concat(apiBase(), "/api/trips/").concat(tripId, "/plan").concat(parts.length ? '/' + parts.join('/') : '');
}
function fetchTripPlan(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, json;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, { items: [], canEdit: false }];
                    return [4 /*yield*/, authedFetch(planUrl(tripId))];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error("fetchTripPlan ".concat(res.status));
                    return [4 /*yield*/, res.json()];
                case 2:
                    json = _a.sent();
                    return [2 /*return*/, { items: json.items, canEdit: json.canEdit === true }];
            }
        });
    });
}
function fetchTripPlanPermission(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId, "/plan-permission"))];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error("fetchTripPlanPermission ".concat(res.status));
                    return [2 /*return*/, res.json()];
            }
        });
    });
}
function updateTripPlanPermission(tripId, planEditPermission, planEditors) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/trips/").concat(tripId), {
                        method: 'PATCH',
                        body: JSON.stringify({ planEditPermission: planEditPermission, planEditors: planEditors }),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "updateTripPlanPermission ".concat(res.status));
                case 3: return [2 /*return*/];
            }
        });
    });
}
function fetchTripPlanMap(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, json;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, authedFetch(planUrl(tripId, 'map'))];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error("fetchTripPlanMap ".concat(res.status));
                    return [4 /*yield*/, res.json()];
                case 2:
                    json = _a.sent();
                    return [2 /*return*/, json.items];
            }
        });
    });
}
function createPlanItem(tripId, payload) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch(planUrl(tripId, 'items'), {
                        method: 'POST',
                        body: JSON.stringify(payload),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "createPlanItem ".concat(res.status));
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
function updatePlanItem(tripId, itemId, patch) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch(planUrl(tripId, 'items', itemId), {
                        method: 'PATCH',
                        body: JSON.stringify(patch),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "updatePlanItem ".concat(res.status));
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
function removePlanItem(tripId, itemId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch(planUrl(tripId, 'items', itemId, 'remove'), {
                        method: 'PATCH',
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "removePlanItem ".concat(res.status));
                case 3: return [2 /*return*/];
            }
        });
    });
}
function deletePlanItem(tripId, itemId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch(planUrl(tripId, 'items', itemId), {
                        method: 'DELETE',
                    })];
                case 1:
                    res = _b.sent();
                    if (!(!res.ok && res.status !== 204)) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "deletePlanItem ".concat(res.status));
                case 3: return [2 /*return*/];
            }
        });
    });
}
function reorderPlanItem(tripId, itemId, sortOrder) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch(planUrl(tripId, 'items', itemId, 'reorder'), {
                        method: 'POST',
                        body: JSON.stringify({ sortOrder: sortOrder }),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "reorderPlanItem ".concat(res.status));
                case 3: return [2 /*return*/];
            }
        });
    });
}
function fetchPlanEditableTrips() {
    return __awaiter(this, void 0, void 0, function () {
        var res, json;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/me/plan-editable-trips"))];
                case 1:
                    res = _b.sent();
                    if (!res.ok)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, res.json()];
                case 2:
                    json = _b.sent();
                    return [2 /*return*/, ((_a = json.trips) !== null && _a !== void 0 ? _a : [])];
            }
        });
    });
}
function addMeetupToPlan(meetupId, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var res, err;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/meetups/").concat(meetupId, "/add-to-trip-plan"), {
                        method: 'POST',
                        body: JSON.stringify({ tripId: tripId }),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "addMeetupToPlan ".concat(res.status));
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
function addPlaceToPlan(placeId_1, tripId_1) {
    return __awaiter(this, arguments, void 0, function (placeId, tripId, opts) {
        var res, err;
        var _a;
        if (opts === void 0) { opts = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, authedFetch("".concat(apiBase(), "/api/places/").concat(placeId, "/add-to-trip-plan"), {
                        method: 'POST',
                        body: JSON.stringify(__assign({ tripId: tripId }, opts)),
                    })];
                case 1:
                    res = _b.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.json().catch(function () { return ({}); })];
                case 2:
                    err = _b.sent();
                    throw new Error((_a = err.message) !== null && _a !== void 0 ? _a : "addPlaceToPlan ".concat(res.status));
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
