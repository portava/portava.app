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
exports.useActiveLocation = useActiveLocation;
/**
 * useActiveLocation — app-wide GPS/location state hook.
 *
 * Manages:
 *   - expo-location permission check + request
 *   - One-time GPS capture (getCurrentPositionAsync)
 *   - expo reverse geocode → place object
 *   - Sync to /api/me/location-state (persist across sessions)
 *   - Manual city override
 *   - Permission status tracking
 *   - Freshness tracking (live / recent / stale / unavailable)
 *
 * Does NOT run watchPosition (that belongs to Safe Return / active tracking).
 */
var react_1 = require("react");
var location_1 = require("../services/location");
var supabase_1 = require("../lib/supabase");
// ── Constants ────────────────────────────────────────────────────────────────
var RECENT_THRESHOLD_MS = 15 * 60 * 1000; // 15 min
var STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 min
var EMPTY_PLACE = {
    city: null,
    district: null,
    country: null,
    countryCode: null,
    formatted: null,
};
var INITIAL_STATE = {
    ok: false,
    permissionStatus: 'unknown',
    source: 'none',
    freshness: 'unavailable',
    coords: null,
    place: EMPTY_PLACE,
    lastUpdatedAt: null,
    userMessage: null,
};
// ── Freshness helper ─────────────────────────────────────────────────────────
function computeFreshness(lastUpdatedAt) {
    if (!lastUpdatedAt)
        return 'unavailable';
    var age = Date.now() - new Date(lastUpdatedAt).getTime();
    if (age < RECENT_THRESHOLD_MS)
        return 'live';
    if (age < STALE_THRESHOLD_MS)
        return 'recent';
    return 'stale';
}
// ── API helpers (no import cycle — fetch directly) ───────────────────────────
function apiBase() {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            return [2 /*return*/, (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : ''];
        });
    });
}
function fetchToken() {
    return __awaiter(this, void 0, void 0, function () {
        var supabase, data, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../lib/supabase'); })];
                case 1:
                    supabase = (_d.sent()).supabase;
                    return [4 /*yield*/, supabase.auth.getSession()];
                case 2:
                    data = (_d.sent()).data;
                    return [2 /*return*/, (_c = (_b = data === null || data === void 0 ? void 0 : data.session) === null || _b === void 0 ? void 0 : _b.access_token) !== null && _c !== void 0 ? _c : null];
                case 3:
                    _a = _d.sent();
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function saveLocationToApi(patch) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, base, token, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, Promise.all([apiBase(), fetchToken()])];
                case 2:
                    _a = _c.sent(), base = _a[0], token = _a[1];
                    if (!token)
                        return [2 /*return*/];
                    return [4 /*yield*/, fetch("".concat(base, "/api/me/location-state"), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: "Bearer ".concat(token) },
                            body: JSON.stringify(patch),
                        })];
                case 3:
                    _c.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _b = _c.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function loadLocationFromApi() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, base, token, res, json, d, source, _b;
        var _c, _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    if (!supabase_1.isSupabaseConfigured)
                        return [2 /*return*/, null];
                    _h.label = 1;
                case 1:
                    _h.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, Promise.all([apiBase(), fetchToken()])];
                case 2:
                    _a = _h.sent(), base = _a[0], token = _a[1];
                    if (!token)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, fetch("".concat(base, "/api/me/location-state"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _h.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 4:
                    json = _h.sent();
                    d = json.locationState;
                    if (!d)
                        return [2 /*return*/, null];
                    source = d.manualCity
                        ? 'manual_city'
                        : d.coords
                            ? 'last_known'
                            : 'none';
                    return [2 /*return*/, {
                            ok: !!(d.coords || d.manualCity),
                            permissionStatus: (_c = d.permissionStatus) !== null && _c !== void 0 ? _c : 'unknown',
                            source: source,
                            freshness: computeFreshness(d.updatedAt),
                            coords: (_d = d.coords) !== null && _d !== void 0 ? _d : null,
                            place: d.manualCity
                                ? { city: d.manualCity, district: null, country: (_e = d.manualCountry) !== null && _e !== void 0 ? _e : null, countryCode: null, formatted: d.manualCity }
                                : ((_f = d.place) !== null && _f !== void 0 ? _f : EMPTY_PLACE),
                            lastUpdatedAt: (_g = d.updatedAt) !== null && _g !== void 0 ? _g : null,
                            userMessage: null,
                        }];
                case 5:
                    _b = _h.sent();
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// ── Hook ─────────────────────────────────────────────────────────────────────
function useActiveLocation() {
    var _this = this;
    var _a = (0, react_1.useState)(INITIAL_STATE), locationState = _a[0], setLocationState = _a[1];
    var _b = (0, react_1.useState)(false), isLoading = _b[0], setIsLoading = _b[1];
    var mountedRef = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
    }, []);
    // On mount: check permission + load saved state from API
    (0, react_1.useEffect)(function () {
        var alive = true;
        (function () { return __awaiter(_this, void 0, void 0, function () {
            var _a, permStatus, savedState;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, Promise.all([
                            (0, location_1.checkLocationPermission)(),
                            loadLocationFromApi(),
                        ])];
                    case 1:
                        _a = _b.sent(), permStatus = _a[0], savedState = _a[1];
                        if (!alive)
                            return [2 /*return*/];
                        if (savedState) {
                            setLocationState(function (prev) { return (__assign(__assign({}, savedState), { permissionStatus: permStatus, freshness: computeFreshness(savedState.lastUpdatedAt) })); });
                        }
                        else {
                            setLocationState(function (prev) { return (__assign(__assign({}, prev), { permissionStatus: permStatus })); });
                        }
                        return [2 /*return*/];
                }
            });
        }); })();
        return function () { alive = false; };
    }, []);
    var requestLocation = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var gps, permStatus_1, place, now, next;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (isLoading)
                        return [2 /*return*/];
                    setIsLoading(true);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 7, 8]);
                    return [4 /*yield*/, (0, location_1.getCurrentGps)()];
                case 2:
                    gps = _a.sent();
                    if (!!gps.granted) return [3 /*break*/, 4];
                    permStatus_1 = gps.error === 'permission_denied' ? 'denied' : 'unavailable';
                    if (!mountedRef.current)
                        return [2 /*return*/];
                    setLocationState(function (prev) { return (__assign(__assign({}, prev), { permissionStatus: permStatus_1, userMessage: permStatus_1 === 'denied'
                            ? 'Location is off. You can still use Travel Buddy by choosing a city manually.'
                            : 'GPS timed out. Try again or choose city manually.' })); });
                    return [4 /*yield*/, saveLocationToApi({ permissionStatus: permStatus_1 })];
                case 3:
                    _a.sent();
                    return [2 /*return*/];
                case 4: return [4 /*yield*/, (0, location_1.reverseGeocodeDetailed)(gps.lat, gps.lng)];
                case 5:
                    place = _a.sent();
                    now = new Date().toISOString();
                    next = {
                        ok: true,
                        permissionStatus: 'granted',
                        source: 'gps',
                        freshness: 'live',
                        coords: { lat: gps.lat, lng: gps.lng, accuracyMeters: gps.accuracyMeters },
                        place: place,
                        lastUpdatedAt: now,
                        userMessage: place.city ? null : "We found your location, but couldn't name the city yet.",
                    };
                    if (!mountedRef.current)
                        return [2 /*return*/];
                    setLocationState(next);
                    return [4 /*yield*/, saveLocationToApi({
                            source: 'gps',
                            permissionStatus: 'granted',
                            coords: { lat: gps.lat, lng: gps.lng, accuracyMeters: gps.accuracyMeters },
                            place: place,
                        })];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 7:
                    if (mountedRef.current)
                        setIsLoading(false);
                    return [7 /*endfinally*/];
                case 8: return [2 /*return*/];
            }
        });
    }); }, [isLoading]);
    var refreshLocation = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var perm;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, location_1.checkLocationPermission)()];
                case 1:
                    perm = _a.sent();
                    if (perm !== 'granted') {
                        setLocationState(function (prev) { return (__assign(__assign({}, prev), { permissionStatus: perm })); });
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, requestLocation()];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [requestLocation]);
    var setManualCity = (0, react_1.useCallback)(function (city, country) { return __awaiter(_this, void 0, void 0, function () {
        var trimmedCity, now, next;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    trimmedCity = city.trim();
                    if (!trimmedCity)
                        return [2 /*return*/];
                    now = new Date().toISOString();
                    next = {
                        ok: true,
                        permissionStatus: locationState.permissionStatus,
                        source: 'manual_city',
                        freshness: 'live',
                        coords: locationState.coords,
                        place: { city: trimmedCity, district: null, country: country !== null && country !== void 0 ? country : null, countryCode: null, formatted: trimmedCity },
                        lastUpdatedAt: now,
                        userMessage: null,
                    };
                    setLocationState(next);
                    return [4 /*yield*/, saveLocationToApi({ source: 'manual_city', manualCity: trimmedCity, manualCountry: country !== null && country !== void 0 ? country : null })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); }, [locationState]);
    var clearManualCity = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    setLocationState(function (prev) { return (__assign(__assign({}, prev), { source: prev.coords ? 'last_known' : 'none', place: prev.coords ? prev.place : EMPTY_PLACE })); });
                    return [4 /*yield*/, saveLocationToApi({ manualCity: null, manualCountry: null })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var getLocationForFeature = (0, react_1.useCallback)(function (_feature) { return locationState; }, [locationState]);
    return {
        locationState: locationState,
        isLoading: isLoading,
        requestLocation: requestLocation,
        refreshLocation: refreshLocation,
        setManualCity: setManualCity,
        clearManualCity: clearManualCity,
        getLocationForFeature: getLocationForFeature,
    };
}
