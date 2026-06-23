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
exports.useCommunityDiscovery = useCommunityDiscovery;
/**
 * useCommunityDiscovery — fetches traveler-submitted hidden gems and picks
 * from /api/discovery/community for a given city.
 *
 * Returns items in the shapes expected by HiddenGemsSection (DiscoveryItem)
 * and TravelerPicksSection (TravelerPick) from DiscoveryWall2. The submitted_by
 * profile id is a real Supabase UUID so HighlightRing activates correctly.
 */
var react_1 = require("react");
var discovery_1 = require("../services/discovery");
function timeAgo(isoString) {
    var diff = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 60)
        return "".concat(Math.max(1, mins), "m ago");
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return "".concat(hrs, "h ago");
    var days = Math.floor(hrs / 24);
    if (days < 7)
        return "".concat(days, "d ago");
    return "".concat(Math.floor(days / 7), "w ago");
}
function toDiscoveryItem(item) {
    var _a, _b, _c, _d, _e, _f, _g;
    return {
        id: item.id,
        name: item.name,
        category: ((_a = item.category) !== null && _a !== void 0 ? _a : 'hidden_gem'),
        neighborhood: (_b = item.neighborhood) !== null && _b !== void 0 ? _b : '',
        city: item.city,
        blurb: (_c = item.blurb) !== null && _c !== void 0 ? _c : '',
        imageUrl: (_d = item.imageUrl) !== null && _d !== void 0 ? _d : undefined,
        submittedBy: item.submittedBy
            ? {
                id: item.submittedBy.id,
                name: item.submittedBy.name,
                avatarUrl: (_e = item.submittedBy.avatarUrl) !== null && _e !== void 0 ? _e : "https://i.pravatar.cc/120?u=".concat(item.submittedBy.id),
            }
            : undefined,
        savedCount: item.savedCount,
        source: ((_f = item.source) !== null && _f !== void 0 ? _f : 'traveler'),
        status: ((_g = item.status) !== null && _g !== void 0 ? _g : 'provisional'),
        verified: item.verified,
    };
}
function toTravelerPick(item) {
    var _a, _b, _c, _d, _e, _f, _g;
    return {
        id: item.id,
        user: item.submittedBy
            ? {
                id: item.submittedBy.id,
                name: item.submittedBy.name,
                avatarUrl: (_a = item.submittedBy.avatarUrl) !== null && _a !== void 0 ? _a : "https://i.pravatar.cc/120?u=".concat(item.submittedBy.id),
            }
            : { name: 'Traveler', avatarUrl: 'https://i.pravatar.cc/120' },
        place: item.name,
        note: (_b = item.note) !== null && _b !== void 0 ? _b : '',
        city: item.city,
        rating: (_c = item.rating) !== null && _c !== void 0 ? _c : undefined,
        tag: (_e = (_d = item.tag) !== null && _d !== void 0 ? _d : item.category) !== null && _e !== void 0 ? _e : 'Place',
        timeAgo: timeAgo(item.createdAt),
        source: ((_f = item.source) !== null && _f !== void 0 ? _f : 'traveler'),
        status: ((_g = item.status) !== null && _g !== void 0 ? _g : 'provisional'),
        verified: item.verified,
    };
}
var EMPTY = { gems: [], picks: [], loading: false };
function useCommunityDiscovery(city) {
    var _this = this;
    var _a = (0, react_1.useState)(EMPTY), state = _a[0], setState = _a[1];
    var abortRef = (0, react_1.useRef)(null);
    var load = (0, react_1.useCallback)(function (c) { return __awaiter(_this, void 0, void 0, function () {
        var ctrl, result, gems, picks, _i, _a, item, _b;
        var _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    (_c = abortRef.current) === null || _c === void 0 ? void 0 : _c.abort();
                    ctrl = new AbortController();
                    abortRef.current = ctrl;
                    setState(function (prev) { return (__assign(__assign({}, prev), { loading: true })); });
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, (0, discovery_1.getCommunityPlaces)(c, 'all', 20)];
                case 2:
                    result = _d.sent();
                    if (ctrl.signal.aborted)
                        return [2 /*return*/];
                    if (!result.ok) {
                        setState({ gems: [], picks: [], loading: false });
                        return [2 /*return*/];
                    }
                    gems = [];
                    picks = [];
                    for (_i = 0, _a = result.data.items; _i < _a.length; _i++) {
                        item = _a[_i];
                        if (item.placeType === 'traveler_pick') {
                            picks.push(toTravelerPick(item));
                        }
                        else {
                            gems.push(toDiscoveryItem(item));
                        }
                    }
                    setState({ gems: gems, picks: picks, loading: false });
                    return [3 /*break*/, 4];
                case 3:
                    _b = _d.sent();
                    if (!ctrl.signal.aborted) {
                        setState({ gems: [], picks: [], loading: false });
                    }
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); }, []);
    (0, react_1.useEffect)(function () {
        if (!city) {
            setState(EMPTY);
            return;
        }
        load(city);
        return function () { var _a; (_a = abortRef.current) === null || _a === void 0 ? void 0 : _a.abort(); };
    }, [city, load]);
    return state;
}
