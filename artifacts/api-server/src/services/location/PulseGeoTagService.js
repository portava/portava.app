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
exports.writePulseGeoTag = writePulseGeoTag;
var LocationPermissionService_1 = require("./LocationPermissionService");
var GeoZoneService_1 = require("./GeoZoneService");
// Ordered from least-precise to most-precise.
// Hotel blur caps the stored visibility to `neighborhood` or below.
var VISIBILITY_RANK = {
    no_location: 0,
    city_only: 1,
    neighborhood: 2,
    venue_tagged: 3,
    exact_hidden: 4,
};
function capToNeighborhood(v) {
    return VISIBILITY_RANK[v] > VISIBILITY_RANK["neighborhood"] ? "neighborhood" : v;
}
/**
 * Write a pulse_geo_tags row for `postId`.
 * Best-effort — throws are swallowed; a failure must not corrupt the post.
 */
function writePulseGeoTag(db, input) {
    return __awaiter(this, void 0, void 0, function () {
        var postId, userId, userGpsLat, userGpsLng, locationCity, locationCountry, locationDistrict, locationCountryCode, venueName, prefs, visibility, overrideRank, preferenceRank, hotelBlurApplied, nearStay, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    postId = input.postId, userId = input.userId, userGpsLat = input.userGpsLat, userGpsLng = input.userGpsLng, locationCity = input.locationCity, locationCountry = input.locationCountry, locationDistrict = input.locationDistrict, locationCountryCode = input.locationCountryCode, venueName = input.venueName;
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 8, , 9]);
                    return [4 /*yield*/, (0, LocationPermissionService_1.loadPreferences)(db, userId)];
                case 2:
                    prefs = _d.sent();
                    if (!!(0, LocationPermissionService_1.isSharingActive)(prefs)) return [3 /*break*/, 4];
                    return [4 /*yield*/, db.from("pulse_geo_tags").insert({
                            post_id: postId,
                            user_id: userId,
                            location_visibility: "no_location",
                            hotel_blur_applied: false,
                        })];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
                case 4:
                    visibility = (0, LocationPermissionService_1.effectivePulseVisibility)(prefs);
                    // Per-post override: pick the LESS precise of (pref default, per-post override).
                    // Users can reduce precision at posting time; they cannot exceed their mode default.
                    if (input.locationVisibilityOverride != null) {
                        overrideRank = (_b = VISIBILITY_RANK[input.locationVisibilityOverride]) !== null && _b !== void 0 ? _b : 99;
                        preferenceRank = (_c = VISIBILITY_RANK[visibility]) !== null && _c !== void 0 ? _c : 99;
                        visibility = overrideRank <= preferenceRank
                            ? input.locationVisibilityOverride
                            : visibility;
                    }
                    hotelBlurApplied = false;
                    if (!(prefs.hotelBlurEnabled && userGpsLat != null && userGpsLng != null)) return [3 /*break*/, 6];
                    return [4 /*yield*/, (0, GeoZoneService_1.isNearPrivateStay)(db, userId, userGpsLat, userGpsLng)];
                case 5:
                    nearStay = _d.sent();
                    if (nearStay) {
                        visibility = capToNeighborhood(visibility);
                        hotelBlurApplied = true;
                    }
                    _d.label = 6;
                case 6: 
                // 5. Write the tag — only public text labels, never coordinates.
                return [4 /*yield*/, db.from("pulse_geo_tags").insert({
                        post_id: postId,
                        user_id: userId,
                        location_visibility: visibility,
                        city: locationCity !== null && locationCity !== void 0 ? locationCity : null,
                        district: locationDistrict !== null && locationDistrict !== void 0 ? locationDistrict : null,
                        country: locationCountry !== null && locationCountry !== void 0 ? locationCountry : null,
                        country_code: locationCountryCode !== null && locationCountryCode !== void 0 ? locationCountryCode : null,
                        venue_name: venueName !== null && venueName !== void 0 ? venueName : null,
                        hotel_blur_applied: hotelBlurApplied,
                    })];
                case 7:
                    // 5. Write the tag — only public text labels, never coordinates.
                    _d.sent();
                    return [3 /*break*/, 9];
                case 8:
                    _a = _d.sent();
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/];
            }
        });
    });
}
