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
exports.AvailabilityProvider = AvailabilityProvider;
exports.useAvailabilityStore = useAvailabilityStore;
var react_1 = require("react");
var events_1 = require("../data/events");
var availability_1 = require("../services/availability");
var SessionContext_1 = require("./SessionContext");
var AvailabilityContext = (0, react_1.createContext)(null);
var EMPTY = { weekly: { days: {} }, trips: [], openToMeet: false };
function AvailabilityProvider(_a) {
    var _this = this;
    var _b;
    var children = _a.children;
    var _c = (0, SessionContext_1.useSession)(), configured = _c.configured, isAuthed = _c.isAuthed;
    var _d = (0, react_1.useState)((_b = events_1.mockAvailability) !== null && _b !== void 0 ? _b : EMPTY), availability = _d[0], setAvailability = _d[1];
    var _e = (0, react_1.useState)(false), saving = _e[0], setSaving = _e[1];
    var _f = (0, react_1.useState)(null), saveError = _f[0], setSaveError = _f[1];
    var _g = (0, react_1.useState)(null), quickStatus = _g[0], setQuickStatusState = _g[1];
    var _h = (0, react_1.useState)(null), quickStatusExpiresAt = _h[0], setQuickStatusExpiresAt = _h[1];
    // Load from backend on mount when authenticated
    (0, react_1.useEffect)(function () {
        if (!configured || !isAuthed)
            return;
        (0, availability_1.getMyAvailability)().then(function (res) {
            if (res.ok && res.data) {
                var d = res.data;
                setAvailability({
                    weekly: { days: d.weeklyDays },
                    trips: [],
                    openToMeet: d.openToMeet,
                });
                if (d.quickStatus) {
                    setQuickStatusState(d.quickStatus.status);
                    setQuickStatusExpiresAt(d.quickStatus.expiresAt);
                }
            }
        });
    }, [configured, isAuthed]);
    var toggleBlock = (0, react_1.useCallback)(function (day, block) {
        setAvailability(function (prev) {
            var _a, _b, _c;
            var days = __assign({}, ((_b = (_a = prev.weekly) === null || _a === void 0 ? void 0 : _a.days) !== null && _b !== void 0 ? _b : {}));
            var cur = new Set((_c = days[day]) !== null && _c !== void 0 ? _c : []);
            if (cur.has(block))
                cur.delete(block);
            else
                cur.add(block);
            days[day] = Array.from(cur);
            return __assign(__assign({}, prev), { weekly: { days: days } });
        });
    }, []);
    var applyWeekly = (0, react_1.useCallback)(function (days) {
        setAvailability(function (prev) { return (__assign(__assign({}, prev), { weekly: { days: days } })); });
    }, []);
    var clearWeekly = (0, react_1.useCallback)(function () {
        setAvailability(function (prev) { return (__assign(__assign({}, prev), { weekly: { days: {} } })); });
    }, []);
    var setOpenToMeet = (0, react_1.useCallback)(function (v) {
        setAvailability(function (prev) { return (__assign(__assign({}, prev), { openToMeet: v })); });
    }, []);
    var addTripWindow = (0, react_1.useCallback)(function (w) {
        setAvailability(function (prev) { return (__assign(__assign({}, prev), { trips: __spreadArray([w], prev.trips.filter(function (t) { return t.id !== w.id; }), true) })); });
    }, []);
    var removeTripWindow = (0, react_1.useCallback)(function (id) {
        setAvailability(function (prev) { return (__assign(__assign({}, prev), { trips: prev.trips.filter(function (t) { return t.id !== id; }) })); });
    }, []);
    var save = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setSaving(true);
                    setSaveError(null);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, (0, availability_1.patchMyAvailability)({
                            weeklyDays: (_a = availability.weekly) === null || _a === void 0 ? void 0 : _a.days,
                            openToMeet: availability.openToMeet,
                        })];
                case 2:
                    res = _c.sent();
                    if (!res.ok)
                        setSaveError((_b = res.message) !== null && _b !== void 0 ? _b : 'Save failed');
                    return [3 /*break*/, 4];
                case 3:
                    setSaving(false);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    }); }, [availability]);
    var setQuickStatus = (0, react_1.useCallback)(function (status) { return __awaiter(_this, void 0, void 0, function () {
        var res;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, availability_1.patchMyQuickStatus)(status)];
                case 1:
                    res = _a.sent();
                    if (res.ok && res.data) {
                        setQuickStatusState(res.data.status);
                        setQuickStatusExpiresAt(res.data.expiresAt);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, []);
    var value = (0, react_1.useMemo)(function () { return ({
        availability: availability,
        toggleBlock: toggleBlock,
        applyWeekly: applyWeekly,
        clearWeekly: clearWeekly,
        setOpenToMeet: setOpenToMeet,
        addTripWindow: addTripWindow,
        removeTripWindow: removeTripWindow,
        save: save,
        saveError: saveError,
        saving: saving,
        quickStatus: quickStatus,
        quickStatusExpiresAt: quickStatusExpiresAt,
        setQuickStatus: setQuickStatus,
    }); }, [availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet,
        addTripWindow, removeTripWindow, save, saveError, saving,
        quickStatus, quickStatusExpiresAt, setQuickStatus]);
    return <AvailabilityContext.Provider value={value}>{children}</AvailabilityContext.Provider>;
}
/** Read + edit availability. Falls back to mock (read-only) if provider missing. */
function useAvailabilityStore() {
    var _this = this;
    var _a;
    var ctx = (0, react_1.useContext)(AvailabilityContext);
    if (!ctx) {
        return {
            availability: (_a = events_1.mockAvailability) !== null && _a !== void 0 ? _a : EMPTY,
            toggleBlock: function () { }, applyWeekly: function () { }, clearWeekly: function () { },
            setOpenToMeet: function () { }, addTripWindow: function () { }, removeTripWindow: function () { },
            save: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/];
            }); }); }, saveError: null, saving: false,
            quickStatus: null, quickStatusExpiresAt: null, setQuickStatus: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                return [2 /*return*/];
            }); }); },
        };
    }
    return ctx;
}
