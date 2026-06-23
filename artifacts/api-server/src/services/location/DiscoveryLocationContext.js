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
exports.buildDiscoveryContext = buildDiscoveryContext;
var GeoZoneService_1 = require("./GeoZoneService");
var DEFAULT_WEIGHTS = {
    distance: 0,
    cityMatch: 1,
    tripMatch: 0,
    trustScore: 0.2,
    safetyScore: 0.1,
    vibeMatch: 0.5,
    trending: 0.3,
    verifiedPlaces: 0.2,
};
function buildDiscoveryContext(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var db, prefs, mode, currentCity, currentCountry, sharingOff, _a, verified, _b, tripCity, city, verified, _c, verified, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    db = opts.db, prefs = opts.prefs, mode = opts.mode, currentCity = opts.currentCity, currentCountry = opts.currentCountry;
                    sharingOff = !currentCity || prefs.locationMode === "off" || prefs.sharingPaused;
                    _a = mode;
                    switch (_a) {
                        case "near_me": return [3 /*break*/, 1];
                        case "in_city": return [3 /*break*/, 5];
                        case "going_soon": return [3 /*break*/, 6];
                        case "around_crew": return [3 /*break*/, 11];
                        case "safe_nearby": return [3 /*break*/, 12];
                    }
                    return [3 /*break*/, 16];
                case 1:
                    if (sharingOff || prefs.locationMode === "city_only") {
                        // Degrade to in_city when location is city-only or off
                        return [2 /*return*/, buildCityContext(currentCity, currentCountry, "near_me", db)];
                    }
                    if (!currentCity) return [3 /*break*/, 3];
                    return [4 /*yield*/, (0, GeoZoneService_1.getVerifiedPlaces)(db, currentCity)];
                case 2:
                    _b = (_e.sent()).map(function (p) { return p.osmId; }).filter(function (id) { return Boolean(id); });
                    return [3 /*break*/, 4];
                case 3:
                    _b = [];
                    _e.label = 4;
                case 4:
                    verified = _b;
                    return [2 /*return*/, {
                            mode: mode,
                            targetCity: currentCity,
                            targetCountry: currentCountry,
                            radiusKm: prefs.locationMode === "nearby" ? 5 : 10,
                            weights: __assign(__assign({}, DEFAULT_WEIGHTS), { distance: 0.8, cityMatch: 0.6, verifiedPlaces: 0.3 }),
                            verifiedPlaceIds: verified,
                            label: "Near me",
                            nearbyEnabled: true,
                        }];
                case 5:
                    {
                        return [2 /*return*/, buildCityContext(currentCity, currentCountry, mode, db)];
                    }
                    _e.label = 6;
                case 6: return [4 /*yield*/, getNextTripCity(db, opts.userId)];
                case 7:
                    tripCity = _e.sent();
                    city = tripCity !== null && tripCity !== void 0 ? tripCity : currentCity;
                    if (!city) return [3 /*break*/, 9];
                    return [4 /*yield*/, (0, GeoZoneService_1.getVerifiedPlaces)(db, city)];
                case 8:
                    _c = (_e.sent()).map(function (p) { return p.osmId; }).filter(function (id) { return Boolean(id); });
                    return [3 /*break*/, 10];
                case 9:
                    _c = [];
                    _e.label = 10;
                case 10:
                    verified = _c;
                    return [2 /*return*/, {
                            mode: mode,
                            targetCity: city,
                            targetCountry: currentCountry,
                            radiusKm: 15,
                            weights: __assign(__assign({}, DEFAULT_WEIGHTS), { tripMatch: 0.9, vibeMatch: 0.4, verifiedPlaces: 0.3 }),
                            verifiedPlaceIds: verified,
                            label: city ? "Going to ".concat(city) : "Going soon",
                            nearbyEnabled: false,
                        }];
                case 11:
                    {
                        return [2 /*return*/, buildCityContext(currentCity, currentCountry, mode, db, {
                                weights: __assign(__assign({}, DEFAULT_WEIGHTS), { cityMatch: 0.7, trustScore: 0.6, vibeMatch: 0.5 }),
                                label: "Around my crew",
                            })];
                    }
                    _e.label = 12;
                case 12:
                    if (!currentCity) return [3 /*break*/, 14];
                    return [4 /*yield*/, (0, GeoZoneService_1.getVerifiedPlaces)(db, currentCity)];
                case 13:
                    _d = (_e.sent()).map(function (p) { return p.osmId; }).filter(function (id) { return Boolean(id); });
                    return [3 /*break*/, 15];
                case 14:
                    _d = [];
                    _e.label = 15;
                case 15:
                    verified = _d;
                    return [2 /*return*/, {
                            mode: mode,
                            targetCity: currentCity,
                            targetCountry: currentCountry,
                            radiusKm: 3,
                            weights: __assign(__assign({}, DEFAULT_WEIGHTS), { safetyScore: 0.9, trustScore: 0.7, verifiedPlaces: 0.8, distance: 0.5 }),
                            verifiedPlaceIds: verified,
                            label: "Safe nearby",
                            nearbyEnabled: !sharingOff,
                        }];
                case 16: return [2 /*return*/];
            }
        });
    });
}
function buildCityContext(city, country, mode, db, overrides) {
    return __awaiter(this, void 0, void 0, function () {
        var verified, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!city) return [3 /*break*/, 2];
                    return [4 /*yield*/, (0, GeoZoneService_1.getVerifiedPlaces)(db, city)];
                case 1:
                    _a = (_b.sent()).map(function (p) { return p.osmId; }).filter(function (id) { return Boolean(id); });
                    return [3 /*break*/, 3];
                case 2:
                    _a = [];
                    _b.label = 3;
                case 3:
                    verified = _a;
                    return [2 /*return*/, __assign({ mode: mode, targetCity: city, targetCountry: country, radiusKm: 10, weights: __assign(__assign({}, DEFAULT_WEIGHTS), { cityMatch: 0.9, vibeMatch: 0.4 }), verifiedPlaceIds: verified, label: city ? "In ".concat(city) : "In this city", nearbyEnabled: false }, overrides)];
            }
        });
    });
}
function getNextTripCity(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("trips")
                            .select("destination_city")
                            .eq("owner_id", userId)
                            .in("status", ["planning", "active"])
                            .order("start_date", { ascending: true })
                            .limit(1)
                            .maybeSingle()];
                case 1:
                    data = (_c.sent()).data;
                    return [2 /*return*/, (_b = data === null || data === void 0 ? void 0 : data.destination_city) !== null && _b !== void 0 ? _b : null];
                case 2:
                    _a = _c.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
