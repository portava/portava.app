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
exports.LOCATION_MODE_DESCRIPTIONS = void 0;
exports.loadPreferences = loadPreferences;
exports.effectivePulseVisibility = effectivePulseVisibility;
exports.canUseNearbyDiscovery = canUseNearbyDiscovery;
exports.isSharingActive = isSharingActive;
var MODE_DEFAULT_PULSE_VISIBILITY = {
    off: "no_location",
    city_only: "city_only",
    nearby: "neighborhood",
    live_during_activity: "neighborhood",
    trusted_circle_live: "venue_tagged",
};
var DEFAULT_PREFS = {
    userId: "",
    locationMode: "city_only",
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    safeReturnEnabled: true,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
};
/** Load preferences from DB; returns defaults if row missing. */
function loadPreferences(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        var _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0: return [4 /*yield*/, db
                        .from("user_location_preferences")
                        .select("*")
                        .eq("user_id", userId)
                        .maybeSingle()];
                case 1:
                    _a = _e.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, __assign(__assign({}, DEFAULT_PREFS), { userId: userId })];
                    return [2 /*return*/, {
                            userId: userId,
                            locationMode: (_b = data.location_mode) !== null && _b !== void 0 ? _b : "city_only",
                            sharingPaused: Boolean(data.sharing_paused),
                            pulseVisibility: (_c = data.pulse_visibility) !== null && _c !== void 0 ? _c : null,
                            discoveryVisibility: (_d = data.discovery_visibility) !== null && _d !== void 0 ? _d : null,
                            safeReturnEnabled: data.safe_return_enabled !== false,
                            trustedCircleShare: Boolean(data.trusted_circle_share),
                            hotelBlurEnabled: data.hotel_blur_enabled !== false,
                        }];
            }
        });
    });
}
/** Effective pulse visibility for a user given their mode + override. */
function effectivePulseVisibility(prefs) {
    if (prefs.sharingPaused)
        return "no_location";
    if (prefs.pulseVisibility)
        return prefs.pulseVisibility;
    return MODE_DEFAULT_PULSE_VISIBILITY[prefs.locationMode];
}
/** Can this user's location be used for nearby discovery? */
function canUseNearbyDiscovery(prefs) {
    if (prefs.sharingPaused)
        return false;
    if (prefs.locationMode === "off")
        return false;
    return true;
}
/** Is sharing location active at all (not paused + not off)? */
function isSharingActive(prefs) {
    return !prefs.sharingPaused && prefs.locationMode !== "off";
}
/** Location mode descriptors for the settings UI. */
exports.LOCATION_MODE_DESCRIPTIONS = {
    off: {
        label: "Off",
        description: "No location data is shared or used. Discovery and Pulse show destination content only.",
    },
    city_only: {
        label: "City only",
        description: "Only your city is used. Great for discovery without sharing your neighborhood.",
    },
    nearby: {
        label: "Nearby",
        description: "Your neighborhood is used for nearby discovery and pulse. No exact location shared.",
    },
    live_during_activity: {
        label: "Live during activity",
        description: "Shares approximate location while plans or meetups are active. Stops after activity ends.",
    },
    trusted_circle_live: {
        label: "Trusted circle live share",
        description: "Shares your approximate location with your trusted circle. You control who sees it.",
    },
};
