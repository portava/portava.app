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
exports.usePlaceSearch = usePlaceSearch;
/**
 * usePlaceSearch — debounced place search against /api/places/search.
 * Falls back to an empty list if the server is unavailable.
 */
var react_1 = require("react");
function apiBase() {
    var _a;
    return (_a = process.env.EXPO_PUBLIC_API_BASE_URL) !== null && _a !== void 0 ? _a : '';
}
var DEBOUNCE_MS = 350;
function usePlaceSearch(query, opts) {
    var _this = this;
    var _a = (0, react_1.useState)([]), results = _a[0], setResults = _a[1];
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var timerRef = (0, react_1.useRef)(null);
    var abortRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(function () {
        if (timerRef.current)
            clearTimeout(timerRef.current);
        if (!query.trim()) {
            setResults([]);
            setLoading(false);
            setError(null);
            return;
        }
        setLoading(true);
        timerRef.current = setTimeout(function () { return __awaiter(_this, void 0, void 0, function () {
            var ctrl, params, res, body, e_1;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (abortRef.current)
                            abortRef.current.abort();
                        ctrl = new AbortController();
                        abortRef.current = ctrl;
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 4, 5, 6]);
                        params = new URLSearchParams({ q: query.trim() });
                        if (opts === null || opts === void 0 ? void 0 : opts.countryCode)
                            params.set('countryCode', opts.countryCode);
                        if (opts === null || opts === void 0 ? void 0 : opts.type)
                            params.set('type', opts.type);
                        if ((opts === null || opts === void 0 ? void 0 : opts.lat) != null)
                            params.set('lat', String(opts.lat));
                        if ((opts === null || opts === void 0 ? void 0 : opts.lng) != null)
                            params.set('lng', String(opts.lng));
                        return [4 /*yield*/, fetch("".concat(apiBase(), "/api/places/search?").concat(params), {
                                signal: ctrl.signal,
                            })];
                    case 2:
                        res = _b.sent();
                        if (!res.ok)
                            throw new Error("HTTP ".concat(res.status));
                        return [4 /*yield*/, res.json()];
                    case 3:
                        body = _b.sent();
                        setResults((_a = body.places) !== null && _a !== void 0 ? _a : []);
                        setError(null);
                        return [3 /*break*/, 6];
                    case 4:
                        e_1 = _b.sent();
                        if ((e_1 === null || e_1 === void 0 ? void 0 : e_1.name) === 'AbortError')
                            return [2 /*return*/];
                        setError('Location search unavailable.');
                        setResults([]);
                        return [3 /*break*/, 6];
                    case 5:
                        setLoading(false);
                        return [7 /*endfinally*/];
                    case 6: return [2 /*return*/];
                }
            });
        }); }, DEBOUNCE_MS);
        return function () {
            if (timerRef.current)
                clearTimeout(timerRef.current);
            if (abortRef.current)
                abortRef.current.abort();
        };
    }, [query]);
    return { results: results, loading: loading, error: error };
}
