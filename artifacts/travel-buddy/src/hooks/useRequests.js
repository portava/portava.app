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
exports.useRequests = useRequests;
exports.useRequestCount = useRequestCount;
/**
 * Request hooks — unified inbox (friend requests, circle invites, trip invites).
 * useRequests splits data into incoming/outgoing for two-tab display.
 * useRequestCount includes an AppState listener so the nav badge stays fresh.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var requests_1 = require("../services/requests");
function useRequests() {
    var _this = this;
    var _a = (0, react_1.useState)([]), incoming = _a[0], setIncoming = _a[1];
    var _b = (0, react_1.useState)([]), outgoing = _b[0], setOutgoing = _b[1];
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)(null), error = _d[0], setError = _d[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, items;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, requests_1.getMyRequests)()];
                case 1:
                    res = _d.sent();
                    if (res.ok) {
                        items = (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.items) !== null && _b !== void 0 ? _b : [];
                        setIncoming(items.filter(function (i) { return i.direction === 'incoming'; }));
                        setOutgoing(items.filter(function (i) { return i.direction === 'outgoing'; }));
                    }
                    else {
                        setError((_c = res.message) !== null && _c !== void 0 ? _c : 'Failed to load requests');
                    }
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () { reload(); }, [reload]);
    return { incoming: incoming, outgoing: outgoing, loading: loading, error: error, reload: reload };
}
function useRequestCount() {
    var _this = this;
    var _a = (0, react_1.useState)(0), count = _a[0], setCount = _a[1];
    var _b = (0, react_1.useState)(false), loading = _b[0], setLoading = _b[1];
    var reload = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    return [4 /*yield*/, (0, requests_1.getRequestCount)()];
                case 1:
                    res = _b.sent();
                    if (res.ok && res.data)
                        setCount((_a = res.data.count) !== null && _a !== void 0 ? _a : 0);
                    setLoading(false);
                    return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        reload();
        var sub = react_native_1.AppState.addEventListener('change', function (state) {
            if (state === 'active')
                reload();
        });
        return function () { return sub.remove(); };
    }, [reload]);
    return { count: count, loading: loading, reload: reload };
}
