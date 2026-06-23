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
exports.useLocationPreferences = useLocationPreferences;
/**
 * useLocationPreferences — loads the user's location-privacy preferences from
 * the API server and exposes the values consumed across location-aware screens.
 *
 * Returns:
 *   locationMode           — off | city_only | nearby | live_during_activity | trusted_circle_live
 *   sharingPaused          — true when sharing is temporarily paused
 *   effectivePulseVisibility — computed effective visibility (respects sharingPaused)
 *   discoveryVisibility    — discovery-specific visibility level
 *   hotelBlurEnabled       — whether exact hotel location is blurred
 *   isLoading              — true while the first fetch is in flight
 */
var react_1 = require("react");
var SessionContext_1 = require("../context/SessionContext");
var supabase_1 = require("../lib/supabase");
var DEFAULT_PREFS = {
    locationMode: 'city_only',
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    effectivePulseVisibility: 'city_only',
    safeReturnEnabled: true,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
};
var MODE_DEFAULT_VISIBILITY = {
    off: 'no_location',
    city_only: 'city_only',
    nearby: 'neighborhood',
    live_during_activity: 'neighborhood',
    trusted_circle_live: 'venue_tagged',
};
function computeEffectiveVisibility(prefs) {
    var _a;
    if (prefs.locationMode === 'off' || prefs.sharingPaused)
        return 'no_location';
    return (_a = prefs.pulseVisibility) !== null && _a !== void 0 ? _a : MODE_DEFAULT_VISIBILITY[prefs.locationMode];
}
function useLocationPreferences() {
    var _this = this;
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var _a = (0, react_1.useState)(DEFAULT_PREFS), prefs = _a[0], setPrefs = _a[1];
    var _b = (0, react_1.useState)(false), isLoading = _b[0], setIsLoading = _b[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var data, token, base, res, data_1, partial, _a;
        var _b, _c, _d, _e, _f, _g, _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    if (!isAuthed)
                        return [2 /*return*/];
                    return [4 /*yield*/, supabase_1.supabase.auth.getSession()];
                case 1:
                    data = (_k.sent()).data;
                    token = (_b = data === null || data === void 0 ? void 0 : data.session) === null || _b === void 0 ? void 0 : _b.access_token;
                    if (!token)
                        return [2 /*return*/];
                    setIsLoading(true);
                    _k.label = 2;
                case 2:
                    _k.trys.push([2, 5, 6, 7]);
                    base = (_c = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _c !== void 0 ? _c : '';
                    return [4 /*yield*/, fetch("".concat(base, "/api/me/location-preferences"), {
                            headers: { Authorization: "Bearer ".concat(token) },
                        })];
                case 3:
                    res = _k.sent();
                    if (!res.ok)
                        return [2 /*return*/];
                    return [4 /*yield*/, res.json()];
                case 4:
                    data_1 = _k.sent();
                    partial = {
                        locationMode: (_d = data_1.locationMode) !== null && _d !== void 0 ? _d : 'city_only',
                        sharingPaused: (_e = data_1.sharingPaused) !== null && _e !== void 0 ? _e : false,
                        pulseVisibility: (_f = data_1.pulseVisibility) !== null && _f !== void 0 ? _f : null,
                        discoveryVisibility: (_g = data_1.discoveryVisibility) !== null && _g !== void 0 ? _g : null,
                        safeReturnEnabled: (_h = data_1.safeReturnEnabled) !== null && _h !== void 0 ? _h : true,
                        trustedCircleShare: (_j = data_1.trustedCircleShare) !== null && _j !== void 0 ? _j : false,
                        hotelBlurEnabled: data_1.hotelBlurEnabled !== false,
                    };
                    setPrefs(__assign(__assign({}, partial), { effectivePulseVisibility: computeEffectiveVisibility(partial) }));
                    return [3 /*break*/, 7];
                case 5:
                    _a = _k.sent();
                    return [3 /*break*/, 7];
                case 6:
                    setIsLoading(false);
                    return [7 /*endfinally*/];
                case 7: return [2 /*return*/];
            }
        });
    }); }, [isAuthed]);
    (0, react_1.useEffect)(function () {
        load();
    }, [load]);
    return { prefs: prefs, isLoading: isLoading, refresh: load };
}
