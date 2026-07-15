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
exports.listMapPins = listMapPins;
exports.createMapPin = createMapPin;
exports.getMyLocationPrivacy = getMyLocationPrivacy;
exports.updateMyLocationPrivacy = updateMyLocationPrivacy;
exports.listVisibleCircleLocations = listVisibleCircleLocations;
/**
 * Map + location services. Backend contract for migration 0002. Privacy is enforced
 * by RLS in the DB; these wrappers never bypass it. This pass scaffolds the calls;
 * the Live Map UI does NOT render live locations yet.
 */
var supabase_1 = require("../lib/supabase");
function mapPin(r) {
    return {
        id: r.id, ownerId: r.owner_id, tripId: r.trip_id, title: r.title,
        category: r.category, lat: r.lat, lng: r.lng, city: r.city, isPrivate: r.is_private,
    };
}
/** Pins the viewer is allowed to see (RLS: own pins + non-private pins on visible trips). */
function listMapPins(tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var q, _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    q = supabase_1.supabase.from('map_pins').select('*');
                    if (tripId)
                        q = q.eq('trip_id', tripId);
                    return [4 /*yield*/, q];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapPin)];
            }
        });
    });
}
function createMapPin(input) {
    return __awaiter(this, void 0, void 0, function () {
        var s, uid, _a, data, error;
        var _b, _c, _d, _e, _f, _g, _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    s = (_k.sent()).data;
                    uid = (_c = (_b = s.session) === null || _b === void 0 ? void 0 : _b.user) === null || _c === void 0 ? void 0 : _c.id;
                    if (!uid)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, supabase_1.supabase.from('map_pins').insert({
                            owner_id: uid,
                            trip_id: (_d = input.tripId) !== null && _d !== void 0 ? _d : null,
                            title: input.title,
                            category: (_e = input.category) !== null && _e !== void 0 ? _e : null,
                            lat: (_f = input.lat) !== null && _f !== void 0 ? _f : null,
                            lng: (_g = input.lng) !== null && _g !== void 0 ? _g : null,
                            city: (_h = input.city) !== null && _h !== void 0 ? _h : null,
                            is_private: (_j = input.isPrivate) !== null && _j !== void 0 ? _j : true, // private by default
                        }).select('*').single()];
                case 2:
                    _a = _k.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, mapPin(data)];
            }
        });
    });
}
function getMyLocationPrivacy() {
    return __awaiter(this, void 0, void 0, function () {
        var fallback, s, uid, data;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    fallback = { sharing: 'private', ghostMode: false, staleMinutes: 30 };
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, fallback];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    s = (_c.sent()).data;
                    uid = (_b = (_a = s.session) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                    if (!uid)
                        return [2 /*return*/, fallback];
                    return [4 /*yield*/, supabase_1.supabase.from('user_location_privacy').select('*').eq('user_id', uid).single()];
                case 2:
                    data = (_c.sent()).data;
                    if (!data)
                        return [2 /*return*/, fallback];
                    return [2 /*return*/, { sharing: data.sharing, ghostMode: data.ghost_mode, staleMinutes: data.stale_minutes }];
            }
        });
    });
}
/** PATCH /me/location-privacy. Upserts; defaults stay private until user opts in. */
function updateMyLocationPrivacy(patch) {
    return __awaiter(this, void 0, void 0, function () {
        var s, uid, row, error;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    s = (_c.sent()).data;
                    uid = (_b = (_a = s.session) === null || _a === void 0 ? void 0 : _a.user) === null || _b === void 0 ? void 0 : _b.id;
                    if (!uid)
                        return [2 /*return*/, false];
                    row = { user_id: uid };
                    if (patch.sharing !== undefined)
                        row.sharing = patch.sharing;
                    if (patch.ghostMode !== undefined)
                        row.ghost_mode = patch.ghostMode;
                    if (patch.staleMinutes !== undefined)
                        row.stale_minutes = patch.staleMinutes;
                    return [4 /*yield*/, supabase_1.supabase.from('user_location_privacy').upsert(row, { onConflict: 'user_id' })];
                case 2:
                    error = (_c.sent()).error;
                    return [2 /*return*/, !error];
            }
        });
    });
}
/**
 * Circle members whose location the viewer is allowed to see. RLS does the gating;
 * this returns only rows the DB permits. UI does NOT render these yet (placeholder pass).
 */
function listVisibleCircleLocations() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, supabase_1.supabase.from('user_locations').select('user_id, approx_lat, approx_lng, city')];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    // RLS already filtered to visible rows; map shape.
                    return [2 /*return*/, data
                            .filter(function (r) { return r.approx_lat != null && r.approx_lng != null; })
                            .map(function (r) { return ({ userId: r.user_id, lat: r.approx_lat, lng: r.approx_lng, city: r.city }); })];
            }
        });
    });
}
