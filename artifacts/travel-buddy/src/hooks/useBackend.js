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
exports.useSession = useSession;
exports.useMyTrips = useMyTrips;
exports.useTrip = useTrip;
exports.usePendingTripInvites = usePendingTripInvites;
/**
 * Backend hooks. Same {data, loading, error} shape as the existing mock hooks,
 * so screens can swap import source with minimal churn. When Supabase isn't
 * configured these return empty/false so the app still runs on mock screens.
 */
var react_1 = require("react");
var supabase_1 = require("../lib/supabase");
var auth_1 = require("../services/auth");
var trips_1 = require("../services/trips");
function useSession() {
    var _a = (0, react_1.useState)(null), userId = _a[0], setUserId = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    (0, react_1.useEffect)(function () {
        var active = true;
        (0, auth_1.getSessionUserId)().then(function (uid) { if (active) {
            setUserId(uid);
            setLoading(false);
        } });
        var unsub = (0, auth_1.onAuthChange)(function (uid) { if (active)
            setUserId(uid); });
        return function () { active = false; unsub(); };
    }, []);
    return { userId: userId, isAuthed: Boolean(userId), loading: loading, configured: supabase_1.isSupabaseConfigured };
}
function useMyTrips() {
    var _this = this;
    var _a = (0, react_1.useState)([]), data = _a[0], setData = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var _a, e_1;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, 4, 5]);
                    _a = setData;
                    return [4 /*yield*/, (0, trips_1.listMyTrips)()];
                case 2:
                    _a.apply(void 0, [_c.sent()]);
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _c.sent();
                    setError((_b = e_1 === null || e_1 === void 0 ? void 0 : e_1.message) !== null && _b !== void 0 ? _b : 'Failed to load trips');
                    return [3 /*break*/, 5];
                case 4:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () { reload(); }, [reload]);
    return { data: data, loading: loading, error: error, reload: reload };
}
function useTrip(id) {
    var _a = (0, react_1.useState)(null), data = _a[0], setData = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var _c = (0, react_1.useState)(null), error = _c[0], setError = _c[1];
    (0, react_1.useEffect)(function () {
        var active = true;
        if (!id) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        (0, trips_1.getTrip)(id)
            .then(function (t) { if (active)
            setData(t); })
            .catch(function (e) { var _a; if (active)
            setError((_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : 'Failed to load trip'); })
            .finally(function () { if (active)
            setLoading(false); });
        return function () { active = false; };
    }, [id]);
    return { data: data, loading: loading, error: error };
}
function usePendingTripInvites() {
    var _this = this;
    var _a = (0, react_1.useState)([]), invites = _a[0], setInvites = _a[1];
    var _b = (0, react_1.useState)(true), loading = _b[0], setLoading = _b[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setLoading(true);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, 4, 5]);
                    _a = setInvites;
                    return [4 /*yield*/, (0, trips_1.getPendingTripInvites)()];
                case 2:
                    _a.apply(void 0, [_c.sent()]);
                    return [3 /*break*/, 5];
                case 3:
                    _b = _c.sent();
                    setInvites([]);
                    return [3 /*break*/, 5];
                case 4:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () { reload(); }, [reload]);
    return { invites: invites, loading: loading, reload: reload };
}
