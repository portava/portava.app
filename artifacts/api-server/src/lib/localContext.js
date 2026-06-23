"use strict";
/**
 * Local context helper — fetches top-rated POIs near a destination using
 * Nominatim (OSM geocoding) + Overpass API (OSM POIs).
 * Both are free and require no API key.
 *
 * Results are cached per destination with a 24-hour TTL.
 *
 * Privacy: only the destination name (geocoded to lat/lng) is sent externally.
 * No user identifiers or private data leave this server.
 *
 * Graceful degradation: any error or timeout returns null — callers must
 * treat the result as optional.
 */
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLocalContext = getLocalContext;
var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
var FETCH_TIMEOUT_MS = 5000;
var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
var cache = new Map();
function isFresh(entry) {
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}
function fetchWithTimeout(url, options) {
    return __awaiter(this, void 0, void 0, function () {
        var ctrl, t;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    ctrl = new AbortController();
                    t = setTimeout(function () { return ctrl.abort(); }, FETCH_TIMEOUT_MS);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, fetch(url, __assign(__assign({}, options), { signal: ctrl.signal }))];
                case 2: return [2 /*return*/, _a.sent()];
                case 3:
                    clearTimeout(t);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function geocodeNominatim(destination) {
    return __awaiter(this, void 0, void 0, function () {
        var url, res, data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    url = "".concat(NOMINATIM_URL, "?q=").concat(encodeURIComponent(destination), "&format=json&limit=1");
                    return [4 /*yield*/, fetchWithTimeout(url, {
                            headers: { "User-Agent": "TravelBuddy/1.0 (travel planning app; contact: support@travelbuddy.app)" },
                        })];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    if (!(data === null || data === void 0 ? void 0 : data[0]))
                        return [2 /*return*/, null];
                    return [2 /*return*/, { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }];
            }
        });
    });
}
function inferCategory(tags) {
    if (tags.tourism === "museum")
        return "museum";
    if (tags.tourism === "gallery")
        return "art";
    if (tags.tourism === "attraction" || tags.tourism === "artwork")
        return "attraction";
    if (tags.tourism === "viewpoint")
        return "viewpoint";
    if (tags.tourism)
        return "attraction";
    if (tags.amenity === "restaurant")
        return "restaurant";
    if (tags.amenity === "cafe")
        return "cafe";
    if (tags.amenity === "bar")
        return "bar";
    if (tags.leisure === "park" || tags.leisure === "garden")
        return "park";
    if (tags.historic)
        return "historic";
    if (tags.natural)
        return "nature";
    return "landmark";
}
function getLocalContext(destination) {
    return __awaiter(this, void 0, void 0, function () {
        var key, cached, coords, query, res, data, elements, tips, categories, context, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    key = destination.toLowerCase();
                    cached = cache.get(key);
                    if (cached && isFresh(cached))
                        return [2 /*return*/, cached.context];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, geocodeNominatim(destination)];
                case 2:
                    coords = _c.sent();
                    if (!coords)
                        return [2 /*return*/, null];
                    query = "[out:json][timeout:5];" +
                        "(" +
                        "node[\"tourism\"~\"museum|attraction|gallery|viewpoint\"](around:6000,".concat(coords.lat, ",").concat(coords.lng, ");") +
                        "node[\"amenity\"~\"restaurant|cafe|bar\"](around:3000,".concat(coords.lat, ",").concat(coords.lng, ");") +
                        "node[\"leisure\"~\"park|garden\"](around:6000,".concat(coords.lat, ",").concat(coords.lng, ");") +
                        "node[\"historic\"](around:6000,".concat(coords.lat, ",").concat(coords.lng, ");") +
                        ");" +
                        "out 20;";
                    return [4 /*yield*/, fetchWithTimeout(OVERPASS_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body: "data=".concat(encodeURIComponent(query)),
                        })];
                case 3:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 4:
                    data = _c.sent();
                    elements = (_b = data === null || data === void 0 ? void 0 : data.elements) !== null && _b !== void 0 ? _b : [];
                    tips = elements
                        .filter(function (el) { var _a; return typeof ((_a = el.tags) === null || _a === void 0 ? void 0 : _a.name) === "string" && el.tags.name.length > 0; })
                        .slice(0, 15)
                        .map(function (el) { return ({
                        name: el.tags.name,
                        category: inferCategory(el.tags),
                    }); });
                    categories = __spreadArray([], new Set(tips.map(function (t) { return t.category; })), true);
                    context = { destination: destination, tips: tips, categories: categories };
                    cache.set(key, { context: context, cachedAt: Date.now() });
                    return [2 /*return*/, context];
                case 5:
                    _a = _c.sent();
                    return [2 /*return*/, null];
                case 6: return [2 /*return*/];
            }
        });
    });
}
