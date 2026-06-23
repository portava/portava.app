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
exports.getCurrentGps = getCurrentGps;
exports.checkLocationPermission = checkLocationPermission;
exports.reverseGeocodeDetailed = reverseGeocodeDetailed;
exports.reverseGeocode = reverseGeocode;
/**
 * Location service — GPS capture + reverse geocode using expo-location.
 *
 * The composer, Pulse, Discovery, and Postcards use this for one-time
 * location reads. Active/persistent tracking lives in useActiveLocation.
 *
 * If permission is denied or GPS fails we return graceful nulls — posting
 * is never blocked and we never fabricate coordinates.
 *
 * The backend decides verification; this only supplies the user's real GPS.
 */
var Location = require("expo-location");
function getCurrentGps() {
    return __awaiter(this, void 0, void 0, function () {
        var status_1, pos, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, Location.requestForegroundPermissionsAsync()];
                case 1:
                    status_1 = (_b.sent()).status;
                    if (status_1 !== 'granted') {
                        return [2 /*return*/, { granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' }];
                    }
                    return [4 /*yield*/, Location.getCurrentPositionAsync({
                            accuracy: Location.Accuracy.Balanced,
                        })];
                case 2:
                    pos = _b.sent();
                    return [2 /*return*/, {
                            granted: true,
                            lat: pos.coords.latitude,
                            lng: pos.coords.longitude,
                            accuracyMeters: (_a = pos.coords.accuracy) !== null && _a !== void 0 ? _a : null,
                        }];
                case 3:
                    e_1 = _b.sent();
                    return [2 /*return*/, {
                            granted: false,
                            lat: null,
                            lng: null,
                            accuracyMeters: null,
                            error: e_1 instanceof Error ? e_1.message : 'gps_failed',
                        }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Check permission without prompting. */
function checkLocationPermission() {
    return __awaiter(this, void 0, void 0, function () {
        var status_2, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, Location.getForegroundPermissionsAsync()];
                case 1:
                    status_2 = (_b.sent()).status;
                    if (status_2 === 'granted')
                        return [2 /*return*/, 'granted'];
                    if (status_2 === 'denied')
                        return [2 /*return*/, 'denied'];
                    return [2 /*return*/, 'prompt'];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, 'unavailable'];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Full reverse geocode with district + countryCode — uses expo's built-in geocoder. */
function reverseGeocodeDetailed(lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var results, r, city, district, country, countryCode, parts, formatted, _a;
        var _b, _c, _d, _e, _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    _j.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, Location.reverseGeocodeAsync({ latitude: lat, longitude: lng })];
                case 1:
                    results = _j.sent();
                    r = results === null || results === void 0 ? void 0 : results[0];
                    if (!r)
                        return [2 /*return*/, nullPlace()];
                    city = (_d = (_c = (_b = r.city) !== null && _b !== void 0 ? _b : r.subregion) !== null && _c !== void 0 ? _c : r.region) !== null && _d !== void 0 ? _d : null;
                    district = ((_e = r.district) !== null && _e !== void 0 ? _e : r.subregion !== city) ? (_f = r.subregion) !== null && _f !== void 0 ? _f : null : null;
                    country = (_g = r.country) !== null && _g !== void 0 ? _g : null;
                    countryCode = (_h = r.isoCountryCode) !== null && _h !== void 0 ? _h : null;
                    parts = [r.name, r.street, city, country].filter(Boolean);
                    formatted = parts.slice(0, 3).join(', ') || null;
                    return [2 /*return*/, { city: city, district: district !== null && district !== void 0 ? district : null, country: country, countryCode: countryCode, formatted: formatted }];
                case 2:
                    _a = _j.sent();
                    return [2 /*return*/, nullPlace()];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Slim reverse geocode — kept for backward compat with the composer. */
function reverseGeocode(lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var results, r, city, country, name_1, _a;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    _f.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, Location.reverseGeocodeAsync({ latitude: lat, longitude: lng })];
                case 1:
                    results = _f.sent();
                    r = results === null || results === void 0 ? void 0 : results[0];
                    if (!r)
                        return [2 /*return*/, { city: null, country: null, name: null }];
                    city = (_d = (_c = (_b = r.city) !== null && _b !== void 0 ? _b : r.subregion) !== null && _c !== void 0 ? _c : r.region) !== null && _d !== void 0 ? _d : null;
                    country = (_e = r.country) !== null && _e !== void 0 ? _e : null;
                    name_1 = [r.name, r.street].filter(Boolean).join(' ') || city || null;
                    return [2 /*return*/, { city: city, country: country, name: name_1 }];
                case 2:
                    _a = _f.sent();
                    return [2 /*return*/, { city: null, country: null, name: null }];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function nullPlace() {
    return { city: null, district: null, country: null, countryCode: null, formatted: null };
}
