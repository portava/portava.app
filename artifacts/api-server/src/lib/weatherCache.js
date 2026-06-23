"use strict";
/**
 * Weather context helper — Open-Meteo (free, no API key required).
 *
 * Geocodes a destination name → lat/lng, then fetches a daily forecast for
 * the requested date range. Results are cached at two layers:
 *   1. In-memory Map (fast, lost on restart)     — 6-hour TTL
 *   2. Supabase weather_cache table (durable)    — 6-hour TTL
 *
 * Read order on cache miss: memory → DB → Open-Meteo.
 * Write order on fresh fetch: memory + DB (best-effort, upsert).
 *
 * Privacy: only the destination name (and derived lat/lng) is sent to
 * external APIs. No user identifiers or private trip data leave this server.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWeatherContext = getWeatherContext;
var supabase_1 = require("./supabase");
var GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
var FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
var FETCH_TIMEOUT_MS = 5000;
var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
var cache = new Map();
function memKey(destination, startDate, endDate) {
    return "".concat(destination.toLowerCase(), ":").concat(startDate, ":").concat(endDate);
}
function dbDateKey(startDate, endDate) {
    return "".concat(startDate, ":").concat(endDate);
}
function isFresh(entry) {
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}
/* ── DB helpers ───────────────────────────────────────────────────────────── */
function dbGet(destination, dateKey) {
    return __awaiter(this, void 0, void 0, function () {
        var client, _a, data, error, cachedAt, context, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    client = (0, supabase_1.getServiceClient)();
                    if (!client)
                        return [2 /*return*/, null];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client
                            .from('weather_cache')
                            .select('brief_summary, forecasts_json, fetched_at')
                            .eq('destination', destination.toLowerCase())
                            .eq('date_key', dateKey)
                            .single()];
                case 2:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    cachedAt = new Date(data.fetched_at).getTime();
                    if (Date.now() - cachedAt >= CACHE_TTL_MS)
                        return [2 /*return*/, null];
                    context = {
                        destination: destination,
                        forecasts: data.forecasts_json,
                        briefSummary: data.brief_summary,
                    };
                    return [2 /*return*/, { context: context, cachedAt: cachedAt }];
                case 3:
                    _b = _c.sent();
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function dbSet(destination, dateKey, entry) {
    return __awaiter(this, void 0, void 0, function () {
        var client, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = (0, supabase_1.getServiceClient)();
                    if (!client)
                        return [2 /*return*/];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client.from('weather_cache').upsert({
                            destination: destination.toLowerCase(),
                            date_key: dateKey,
                            brief_summary: entry.context.briefSummary,
                            forecasts_json: entry.context.forecasts,
                            fetched_at: new Date(entry.cachedAt).toISOString(),
                        }, { onConflict: 'destination,date_key' })];
                case 2:
                    _b.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _b.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/* ── Utility ──────────────────────────────────────────────────────────────── */
function wmoSummary(code) {
    if (code === 0)
        return "Clear sky";
    if (code <= 3)
        return "Partly cloudy";
    if (code <= 48)
        return "Foggy";
    if (code <= 67)
        return "Rain";
    if (code <= 77)
        return "Snow";
    if (code <= 82)
        return "Showers";
    return "Thunderstorms";
}
function buildBriefSummary(forecasts) {
    if (forecasts.length === 0)
        return "";
    var rainy = forecasts.filter(function (f) { return f.precipMm > 2 || f.weatherCode >= 51; });
    var sunny = forecasts.filter(function (f) { return f.weatherCode <= 3; });
    if (rainy.length > 0 && rainy.length < forecasts.length) {
        var labels = rainy.slice(0, 2).map(function (f) {
            return new Date(f.date + "T12:00:00").toLocaleDateString("en", {
                weekday: "short", month: "short", day: "numeric",
            });
        });
        return "Rain forecast on ".concat(labels.join(" and "), " \u2014 indoor alternatives recommended those days.");
    }
    if (rainy.length === forecasts.length) {
        return "Rainy weather expected throughout — pack rain gear and plan indoor activities.";
    }
    if (sunny.length === forecasts.length) {
        var avg = Math.round(forecasts.reduce(function (s, f) { return s + f.maxTempC; }, 0) / forecasts.length);
        return "Sunny skies throughout with highs around ".concat(avg, "\u00B0C \u2014 great conditions for outdoor activities.");
    }
    var f = forecasts[0];
    return "".concat(f.summary, " expected, with temperatures ").concat(f.minTempC, "\u2013").concat(f.maxTempC, "\u00B0C.");
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
function geocode(destination) {
    return __awaiter(this, void 0, void 0, function () {
        var url, res, data, r;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    url = "".concat(GEOCODE_URL, "?name=").concat(encodeURIComponent(destination), "&count=1&language=en&format=json");
                    return [4 /*yield*/, fetchWithTimeout(url)];
                case 1:
                    res = _b.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _b.sent();
                    r = (_a = data === null || data === void 0 ? void 0 : data.results) === null || _a === void 0 ? void 0 : _a[0];
                    if (!r)
                        return [2 /*return*/, null];
                    return [2 /*return*/, { lat: r.latitude, lng: r.longitude }];
            }
        });
    });
}
/* ── Public API ───────────────────────────────────────────────────────────── */
function getWeatherContext(destination, startDate, endDate) {
    return __awaiter(this, void 0, void 0, function () {
        var today, start, end, key, dateKey, memEntry, dbEntry, coords, url, res, data, daily_1, forecasts, context, entry, _a;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    today = new Date().toISOString().slice(0, 10);
                    start = startDate !== null && startDate !== void 0 ? startDate : today;
                    end = endDate && endDate >= start ? endDate : start;
                    key = memKey(destination, start, end);
                    dateKey = dbDateKey(start, end);
                    memEntry = cache.get(key);
                    if (memEntry && isFresh(memEntry))
                        return [2 /*return*/, memEntry.context];
                    return [4 /*yield*/, dbGet(destination, dateKey)];
                case 1:
                    dbEntry = _c.sent();
                    if (dbEntry) {
                        cache.set(key, dbEntry);
                        return [2 /*return*/, dbEntry.context];
                    }
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 6, , 7]);
                    return [4 /*yield*/, geocode(destination)];
                case 3:
                    coords = _c.sent();
                    if (!coords)
                        return [2 /*return*/, null];
                    url = "".concat(FORECAST_URL, "?latitude=").concat(coords.lat, "&longitude=").concat(coords.lng) +
                        "&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum" +
                        "&timezone=auto&start_date=".concat(start, "&end_date=").concat(end);
                    return [4 /*yield*/, fetchWithTimeout(url)];
                case 4:
                    res = _c.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 5:
                    data = _c.sent();
                    daily_1 = data === null || data === void 0 ? void 0 : data.daily;
                    if (!((_b = daily_1 === null || daily_1 === void 0 ? void 0 : daily_1.time) === null || _b === void 0 ? void 0 : _b.length))
                        return [2 /*return*/, null];
                    forecasts = daily_1.time.map(function (date, i) {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
                        return ({
                            date: date,
                            weatherCode: (_b = (_a = daily_1.weathercode) === null || _a === void 0 ? void 0 : _a[i]) !== null && _b !== void 0 ? _b : 0,
                            summary: wmoSummary((_d = (_c = daily_1.weathercode) === null || _c === void 0 ? void 0 : _c[i]) !== null && _d !== void 0 ? _d : 0),
                            maxTempC: Math.round((_f = (_e = daily_1.temperature_2m_max) === null || _e === void 0 ? void 0 : _e[i]) !== null && _f !== void 0 ? _f : 0),
                            minTempC: Math.round((_h = (_g = daily_1.temperature_2m_min) === null || _g === void 0 ? void 0 : _g[i]) !== null && _h !== void 0 ? _h : 0),
                            precipMm: Math.round(((_k = (_j = daily_1.precipitation_sum) === null || _j === void 0 ? void 0 : _j[i]) !== null && _k !== void 0 ? _k : 0) * 10) / 10,
                        });
                    });
                    context = {
                        destination: destination,
                        forecasts: forecasts,
                        briefSummary: buildBriefSummary(forecasts),
                    };
                    entry = { context: context, cachedAt: Date.now() };
                    // Write to both layers (DB is best-effort — don't await to block response)
                    cache.set(key, entry);
                    dbSet(destination, dateKey, entry).catch(function () { });
                    return [2 /*return*/, context];
                case 6:
                    _a = _c.sent();
                    return [2 /*return*/, null];
                case 7: return [2 /*return*/];
            }
        });
    });
}
