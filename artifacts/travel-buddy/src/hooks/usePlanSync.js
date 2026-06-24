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
exports.usePlanSync = usePlanSync;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var tripPlan_1 = require("../services/tripPlan");
/**
 * Lightweight background sync for a trip plan. While the host screen is focused
 * and the app is in the foreground, it polls `fetchTripPlan(tripId)` on a fixed
 * interval and hands the result to `onResult`. Polling stops when the screen
 * loses focus or the app is backgrounded, and resumes (with an immediate sync)
 * when it returns. Overlapping requests are suppressed.
 */
function usePlanSync(tripId, _a) {
    var _this = this;
    var _b = _a.enabled, enabled = _b === void 0 ? true : _b, _c = _a.intervalMs, intervalMs = _c === void 0 ? 10000 : _c, onResult = _a.onResult, onError = _a.onError;
    var onResultRef = (0, react_1.useRef)(onResult);
    onResultRef.current = onResult;
    var onErrorRef = (0, react_1.useRef)(onError);
    onErrorRef.current = onError;
    var inFlight = (0, react_1.useRef)(false);
    var syncNow = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, error_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!tripId || inFlight.current)
                        return [2 /*return*/];
                    inFlight.current = true;
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, tripPlan_1.fetchTripPlan)(tripId)];
                case 2:
                    result = _b.sent();
                    onResultRef.current(result);
                    return [3 /*break*/, 5];
                case 3:
                    error_1 = _b.sent();
                    (_a = onErrorRef.current) === null || _a === void 0 ? void 0 : _a.call(onErrorRef, error_1);
                    return [3 /*break*/, 5];
                case 4:
                    inFlight.current = false;
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        if (!enabled || !tripId)
            return;
        var timer = null;
        var start = function () {
            if (timer)
                return;
            timer = setInterval(function () {
                if (react_native_1.AppState.currentState === 'active')
                    void syncNow();
            }, intervalMs);
        };
        var stop = function () {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };
        start();
        var sub = react_native_1.AppState.addEventListener('change', function (state) {
            if (state === 'active') {
                void syncNow();
                start();
            }
            else {
                stop();
            }
        });
        return function () {
            stop();
            sub.remove();
        };
    }, [enabled, tripId, intervalMs, syncNow]));
    return { syncNow: syncNow };
}
