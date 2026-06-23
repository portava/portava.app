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
exports.getMyProfile = getMyProfile;
exports.updateMyProfile = updateMyProfile;
exports.listMyTrips = listMyTrips;
exports.getTrip = getTrip;
exports.createTrip = createTrip;
exports.updateTrip = updateTrip;
exports.deleteTrip = deleteTrip;
exports.getPendingTripInvites = getPendingTripInvites;
exports.acceptTripInvite = acceptTripInvite;
exports.declineTripInvite = declineTripInvite;
exports.addMember = addMember;
exports.removeMember = removeMember;
/**
 * Profiles + Trips services — typed wrappers over supabase-js. Map DB rows
 * (snake_case) to the app's types (camelCase). UI calls these, never supabase
 * tables directly.
 */
var supabase_1 = require("../lib/supabase");
function mapProfile(r) {
    var _a;
    return {
        id: r.id, handle: r.handle, name: r.name, avatarUrl: r.avatar_url,
        homeCity: r.home_city, homeCountry: r.home_country, currentCity: r.current_city,
        travelStyle: r.travel_style, interests: (_a = r.interests) !== null && _a !== void 0 ? _a : [], verified: r.verified,
        openToMeet: r.open_to_meet, isPrivate: r.is_private, bio: r.bio,
    };
}
function getMyProfile() {
    return __awaiter(this, void 0, void 0, function () {
        var s, uid, _a, data, error;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    s = (_d.sent()).data;
                    uid = (_c = (_b = s.session) === null || _b === void 0 ? void 0 : _b.user) === null || _c === void 0 ? void 0 : _c.id;
                    if (!uid)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.from('profiles').select('*').eq('id', uid).single()];
                case 2:
                    _a = _d.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapProfile(data)];
            }
        });
    });
}
function updateMyProfile(patch) {
    return __awaiter(this, void 0, void 0, function () {
        var s, uid, row, _a, data, error;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    s = (_d.sent()).data;
                    uid = (_c = (_b = s.session) === null || _b === void 0 ? void 0 : _b.user) === null || _c === void 0 ? void 0 : _c.id;
                    if (!uid)
                        return [2 /*return*/, null];
                    row = {};
                    if (patch.name !== undefined)
                        row.name = patch.name;
                    if (patch.bio !== undefined)
                        row.bio = patch.bio;
                    if (patch.avatarUrl !== undefined)
                        row.avatar_url = patch.avatarUrl;
                    if (patch.currentCity !== undefined)
                        row.current_city = patch.currentCity;
                    if (patch.openToMeet !== undefined)
                        row.open_to_meet = patch.openToMeet;
                    if (patch.isPrivate !== undefined)
                        row.is_private = patch.isPrivate;
                    if (patch.interests !== undefined)
                        row.interests = patch.interests;
                    return [4 /*yield*/, supabase_1.supabase.from('profiles').update(row).eq('id', uid).select('*').single()];
                case 2:
                    _a = _d.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapProfile(data)];
            }
        });
    });
}
function mapTrip(r) {
    var _a, _b;
    return {
        id: r.id, ownerId: r.owner_id, title: r.title, destinationCity: r.destination_city,
        destinationCountry: r.destination_country, neighborhoods: (_a = r.neighborhoods) !== null && _a !== void 0 ? _a : [],
        startDate: r.start_date, endDate: r.end_date, status: r.status, visibility: r.visibility,
        travelStyle: r.travel_style, openToMeet: r.open_to_meet, coverUrl: r.cover_url,
        progress: (_b = r.progress) !== null && _b !== void 0 ? _b : 0,
    };
}
function listMyTrips() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, supabase_1.supabase.from('trips').select('*').order('start_date', { ascending: true })];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapTrip)];
            }
        });
    });
}
function getTrip(id) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.from('trips').select('*').eq('id', id).single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapTrip(data)];
            }
        });
    });
}
function createTrip(input) {
    return __awaiter(this, void 0, void 0, function () {
        var refreshed, session, _a, apiBase, res, err, data;
        var _b, _c, _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.auth.refreshSession()];
                case 1:
                    refreshed = (_h.sent()).data;
                    if (!((_b = refreshed === null || refreshed === void 0 ? void 0 : refreshed.session) !== null && _b !== void 0)) return [3 /*break*/, 2];
                    _a = _b;
                    return [3 /*break*/, 4];
                case 2: return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 3:
                    _a = (_h.sent()).data.session;
                    _h.label = 4;
                case 4:
                    session = _a;
                    if (!((_c = session === null || session === void 0 ? void 0 : session.user) === null || _c === void 0 ? void 0 : _c.id)) {
                        throw new Error('Auth error: No authenticated session');
                    }
                    apiBase = (_d = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _d !== void 0 ? _d : '';
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/trips"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: "Bearer ".concat(session.access_token),
                            },
                            body: JSON.stringify({
                                title: input.title,
                                destinationCity: input.destinationCity,
                                destinationCountry: input.destinationCountry,
                                startDate: input.startDate,
                                endDate: input.endDate,
                                status: (_e = input.status) !== null && _e !== void 0 ? _e : 'planning',
                                visibility: (_f = input.visibility) !== null && _f !== void 0 ? _f : 'private',
                                coverUrl: input.coverUrl,
                            }),
                        })];
                case 5:
                    res = _h.sent();
                    if (!!res.ok) return [3 /*break*/, 7];
                    return [4 /*yield*/, res.json().catch(function () { return ({ error: res.statusText }); })];
                case 6:
                    err = _h.sent();
                    throw new Error("API ".concat(res.status, ": ").concat((_g = err.error) !== null && _g !== void 0 ? _g : res.statusText));
                case 7: return [4 /*yield*/, res.json()];
                case 8:
                    data = _h.sent();
                    return [2 /*return*/, mapTrip(data)];
            }
        });
    });
}
function updateTrip(id, patch) {
    return __awaiter(this, void 0, void 0, function () {
        var row, _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    row = {};
                    if (patch.title !== undefined)
                        row.title = patch.title;
                    if (patch.status !== undefined)
                        row.status = patch.status;
                    if (patch.visibility !== undefined)
                        row.visibility = patch.visibility;
                    if (patch.coverUrl !== undefined)
                        row.cover_url = patch.coverUrl;
                    if (patch.progress !== undefined)
                        row.progress = patch.progress;
                    return [4 /*yield*/, supabase_1.supabase.from('trips').update(row).eq('id', id).select('*').single()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapTrip(data)];
            }
        });
    });
}
function deleteTrip(id) {
    return __awaiter(this, void 0, void 0, function () {
        var error;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, supabase_1.supabase.from('trips').delete().eq('id', id)];
                case 1:
                    error = (_a.sent()).error;
                    return [2 /*return*/, !error];
            }
        });
    });
}
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
function getPendingTripInvites() {
    return __awaiter(this, void 0, void 0, function () {
        var token, apiBase, res, data;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        return [2 /*return*/, []];
                    apiBase = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/me/trip-invites/pending"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 2:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _c.sent();
                    return [2 /*return*/, ((_b = data.invites) !== null && _b !== void 0 ? _b : [])];
            }
        });
    });
}
function acceptTripInvite(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, apiBase, res, err;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        throw new Error('Not authenticated');
                    apiBase = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/trips/").concat(tripId, "/accept-invite"), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                        })];
                case 2:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 4];
                    return [4 /*yield*/, res.json().catch(function () { return ({ message: res.statusText }); })];
                case 3:
                    err = _c.sent();
                    throw new Error((_b = err.message) !== null && _b !== void 0 ? _b : "HTTP ".concat(res.status));
                case 4: return [2 /*return*/];
            }
        });
    });
}
function declineTripInvite(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var token, apiBase, res, err;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, freshToken()];
                case 1:
                    token = _c.sent();
                    if (!token)
                        throw new Error('Not authenticated');
                    apiBase = (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
                    return [4 /*yield*/, fetch("".concat(apiBase, "/api/trips/").concat(tripId, "/decline-invite"), {
                            method: 'POST',
                            headers: { Authorization: "Bearer ".concat(token), 'Content-Type': 'application/json' },
                        })];
                case 2:
                    res = _c.sent();
                    if (!!res.ok) return [3 /*break*/, 4];
                    return [4 /*yield*/, res.json().catch(function () { return ({ message: res.statusText }); })];
                case 3:
                    err = _c.sent();
                    throw new Error((_b = err.message) !== null && _b !== void 0 ? _b : "HTTP ".concat(res.status));
                case 4: return [2 /*return*/];
            }
        });
    });
}
function addMember(tripId_1, userId_1) {
    return __awaiter(this, arguments, void 0, function (tripId, userId, role) {
        var error;
        if (role === void 0) { role = 'member'; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, supabase_1.supabase.from('trip_members').insert({ trip_id: tripId, user_id: userId, role: role })];
                case 1:
                    error = (_a.sent()).error;
                    return [2 /*return*/, !error];
            }
        });
    });
}
function removeMember(tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var error;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, supabase_1.supabase.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', userId)];
                case 1:
                    error = (_a.sent()).error;
                    return [2 /*return*/, !error];
            }
        });
    });
}
