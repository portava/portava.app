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
exports.buildCompassContext = buildCompassContext;
var GeoZoneService_1 = require("./GeoZoneService");
/**
 * Build a Compass-safe context for `userId`.
 * All sourced from city-level data only — no exact coords returned.
 */
function buildCompassContext(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var empty, locState, city, district, country, countryCode, approximateArea, verifiedPlaces, _a, trip, _b;
        var _c, _d, _e, _f, _g, _h, _j, _k;
        return __generator(this, function (_l) {
            switch (_l.label) {
                case 0:
                    empty = {
                        currentCity: null,
                        currentDistrict: null,
                        currentCountry: null,
                        approximateArea: null,
                        nearbyVerifiedPlaces: [],
                        upcomingTripCity: null,
                        upcomingTripCountry: null,
                    };
                    _l.label = 1;
                case 1:
                    _l.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db
                            .from("user_location_state")
                            .select("city, district, country, country_code, manual_city, manual_country")
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 2:
                    locState = (_l.sent()).data;
                    city = (_d = (_c = locState === null || locState === void 0 ? void 0 : locState.manual_city) !== null && _c !== void 0 ? _c : locState === null || locState === void 0 ? void 0 : locState.city) !== null && _d !== void 0 ? _d : null;
                    district = (_e = locState === null || locState === void 0 ? void 0 : locState.district) !== null && _e !== void 0 ? _e : null;
                    country = (_g = (_f = locState === null || locState === void 0 ? void 0 : locState.manual_country) !== null && _f !== void 0 ? _f : locState === null || locState === void 0 ? void 0 : locState.country) !== null && _g !== void 0 ? _g : null;
                    countryCode = (_h = locState === null || locState === void 0 ? void 0 : locState.country_code) !== null && _h !== void 0 ? _h : null;
                    approximateArea = [city, country].filter(Boolean).join(", ") || null;
                    if (!city) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, GeoZoneService_1.getVerifiedPlaces)(db, city, 5)];
                case 3:
                    _a = (_l.sent()).map(function (p) { return ({
                        name: p.name,
                        placeType: p.placeType,
                        city: p.city,
                    }); });
                    return [3 /*break*/, 5];
                case 4:
                    _a = [];
                    _l.label = 5;
                case 5:
                    verifiedPlaces = _a;
                    return [4 /*yield*/, db
                            .from("trips")
                            .select("destination_city, destination_country")
                            .eq("owner_id", userId)
                            .in("status", ["planning", "active"])
                            .order("start_date", { ascending: true })
                            .limit(1)
                            .maybeSingle()];
                case 6:
                    trip = (_l.sent()).data;
                    return [2 /*return*/, {
                            currentCity: city,
                            currentDistrict: district,
                            currentCountry: country,
                            approximateArea: approximateArea,
                            nearbyVerifiedPlaces: verifiedPlaces,
                            upcomingTripCity: (_j = trip === null || trip === void 0 ? void 0 : trip.destination_city) !== null && _j !== void 0 ? _j : null,
                            upcomingTripCountry: (_k = trip === null || trip === void 0 ? void 0 : trip.destination_country) !== null && _k !== void 0 ? _k : null,
                        }];
                case 7:
                    _b = _l.sent();
                    return [2 /*return*/, empty];
                case 8: return [2 /*return*/];
            }
        });
    });
}
