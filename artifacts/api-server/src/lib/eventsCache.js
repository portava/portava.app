"use strict";
/**
 * Events context helper — Ticketmaster Discovery API.
 *
 * Fetches events near a destination during trip dates. Active only when
 * TICKETMASTER_API_KEY is set; skips silently otherwise.
 *
 * Results are cached per destination+date-range with a 12-hour TTL.
 *
 * Privacy: only the destination city name and date range are sent to
 * Ticketmaster. No user identifiers or private data leave this server.
 *
 * Graceful degradation: any error, timeout, or missing key returns null.
 */
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
exports.getEventsNearDestination = getEventsNearDestination;
var TM_BASE = "https://app.ticketmaster.com/discovery/v2/events.json";
var FETCH_TIMEOUT_MS = 5000;
var CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
var cache = new Map();
function cacheKey(destination, startDate, endDate) {
    return "".concat(destination.toLowerCase(), ":").concat(startDate, ":").concat(endDate);
}
function isFresh(entry) {
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}
function fetchWithTimeout(url) {
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
                    return [4 /*yield*/, fetch(url, { signal: ctrl.signal })];
                case 2: return [2 /*return*/, _a.sent()];
                case 3:
                    clearTimeout(t);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function inferCategory(raw) {
    var _a, _b, _c, _d, _e, _f, _g;
    var seg = (_g = (_f = (_e = (_d = (_c = (_b = (_a = raw === null || raw === void 0 ? void 0 : raw._embedded) === null || _a === void 0 ? void 0 : _a.events) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.classifications) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.segment) === null || _f === void 0 ? void 0 : _f.name) !== null && _g !== void 0 ? _g : "";
    return seg || "Event";
}
function parseEvents(data, maxCount) {
    var _a, _b;
    var raw = (_b = (_a = data === null || data === void 0 ? void 0 : data._embedded) === null || _a === void 0 ? void 0 : _a.events) !== null && _b !== void 0 ? _b : [];
    return raw.slice(0, maxCount).map(function (e) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        var seg = (_d = (_c = (_b = (_a = e.classifications) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.segment) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : "Event";
        return {
            id: typeof e.id === "string" ? e.id : String(Math.random()),
            name: typeof e.name === "string" ? e.name : "Event",
            category: seg,
            localDate: (_g = (_f = (_e = e.dates) === null || _e === void 0 ? void 0 : _e.start) === null || _f === void 0 ? void 0 : _f.localDate) !== null && _g !== void 0 ? _g : "",
            venueName: (_l = (_k = (_j = (_h = e._embedded) === null || _h === void 0 ? void 0 : _h.venues) === null || _j === void 0 ? void 0 : _j[0]) === null || _k === void 0 ? void 0 : _k.name) !== null && _l !== void 0 ? _l : null,
            url: typeof e.url === "string" ? e.url : null,
        };
    });
}
function getEventsNearDestination(destination_1, startDate_1, endDate_1) {
    return __awaiter(this, arguments, void 0, function (destination, startDate, endDate, maxCount) {
        var apiKey, today, start, end, key, cached, startDT, endDT, city, url, res, data, events, context, _a;
        if (maxCount === void 0) { maxCount = 5; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    apiKey = process.env.TICKETMASTER_API_KEY;
                    if (!apiKey)
                        return [2 /*return*/, null]; // Integration inactive — skip silently
                    today = new Date().toISOString().slice(0, 10);
                    start = startDate !== null && startDate !== void 0 ? startDate : today;
                    end = endDate && endDate >= start ? endDate : start;
                    key = cacheKey(destination, start, end);
                    cached = cache.get(key);
                    if (cached && isFresh(cached))
                        return [2 /*return*/, cached.context];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    startDT = encodeURIComponent("".concat(start, "T00:00:00Z"));
                    endDT = encodeURIComponent("".concat(end, "T23:59:59Z"));
                    city = encodeURIComponent(destination);
                    url = "".concat(TM_BASE, "?apikey=").concat(apiKey) +
                        "&city=".concat(city) +
                        "&startDateTime=".concat(startDT) +
                        "&endDateTime=".concat(endDT) +
                        "&classificationName=music,arts,sports,family" +
                        "&sort=date,asc" +
                        "&size=".concat(maxCount);
                    return [4 /*yield*/, fetchWithTimeout(url)];
                case 2:
                    res = _b.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _b.sent();
                    events = parseEvents(data, maxCount);
                    context = { destination: destination, events: events };
                    cache.set(key, { context: context, cachedAt: Date.now() });
                    return [2 /*return*/, context];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
