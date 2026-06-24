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
exports.TripPlanSection = TripPlanSection;
var react_1 = require("react");
var react_native_1 = require("react-native");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tripPlan_1 = require("../services/tripPlan");
var usePlanSync_1 = require("../hooks/usePlanSync");
var tokens_1 = require("../theme/tokens");
var AddToPlanSheet_1 = require("./AddToPlanSheet");
var TimelineView_1 = require("./itinerary/TimelineView");
var MapView_1 = require("./itinerary/MapView");
var PlanItemSheet_1 = require("./itinerary/PlanItemSheet");
var TripPlanSettingsSheet_1 = require("./TripPlanSettingsSheet");
var SafeReturnSetupSheet_1 = require("./safeReturn/SafeReturnSetupSheet");
var ActiveSafeReturnCard_1 = require("./safeReturn/ActiveSafeReturnCard");
var MissedCheckinPrompt_1 = require("./safeReturn/MissedCheckinPrompt");
var safeReturn_1 = require("../services/safeReturn");
// ── Category filter data ───────────────────────────────────────────────────────
var CAT_CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'accommodation', label: 'Stay' },
    { key: 'activity', label: 'Activity' },
    { key: 'dining', label: 'Dining' },
    { key: 'transport', label: 'Transport' },
    { key: 'meeting_point', label: 'Meetup' },
    { key: 'free_time', label: 'Free time' },
    { key: 'other', label: 'Other' },
];
// ── Helpers ───────────────────────────────────────────────────────────────────
function dayChipLabel(key, tripStartDate) {
    if (key === '__unscheduled__')
        return 'Unscheduled';
    var d = new Date(key + 'T00:00:00');
    if (isNaN(d.getTime()))
        return key;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    var ms = d.getTime();
    if (ms === today.getTime())
        return 'Today';
    if (ms === tomorrow.getTime())
        return 'Tomorrow';
    if (tripStartDate) {
        var start = new Date(tripStartDate + 'T00:00:00');
        if (!isNaN(start.getTime())) {
            var dayNum = Math.round((ms - start.getTime()) / 86400000) + 1;
            if (dayNum >= 1)
                return "Day ".concat(dayNum);
        }
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function buildBuckets(items, tripStartDate, tripEndDate) {
    var _a;
    var byDay = new Map();
    var unscheduled = [];
    for (var _i = 0, items_1 = items; _i < items_1.length; _i++) {
        var item = items_1[_i];
        if (item.dayDate) {
            if (!byDay.has(item.dayDate))
                byDay.set(item.dayDate, []);
            byDay.get(item.dayDate).push(item);
        }
        else {
            unscheduled.push(item);
        }
    }
    var buckets = [];
    if (tripStartDate && tripEndDate) {
        var start = new Date(tripStartDate + 'T00:00:00');
        var end = new Date(tripEndDate + 'T00:00:00');
        var cur = new Date(start);
        while (cur <= end) {
            var key = cur.toISOString().slice(0, 10);
            buckets.push({ key: key, items: (_a = byDay.get(key)) !== null && _a !== void 0 ? _a : [] });
            byDay.delete(key);
            cur.setDate(cur.getDate() + 1);
        }
        for (var _b = 0, byDay_1 = byDay; _b < byDay_1.length; _b++) {
            var _c = byDay_1[_b], key = _c[0], rows = _c[1];
            buckets.push({ key: key, items: rows });
        }
        buckets.sort(function (a, b) { return a.key.localeCompare(b.key); });
    }
    else {
        for (var _d = 0, byDay_2 = byDay; _d < byDay_2.length; _d++) {
            var _e = byDay_2[_d], key = _e[0], rows = _e[1];
            buckets.push({ key: key, items: rows });
        }
        buckets.sort(function (a, b) { return a.key.localeCompare(b.key); });
    }
    if (unscheduled.length > 0 || items.length === 0) {
        buckets.push({ key: '__unscheduled__', items: unscheduled });
    }
    return buckets;
}
// ── Day chip bar ──────────────────────────────────────────────────────────────
function DayChipBar(_a) {
    var buckets = _a.buckets, activeDay = _a.activeDay, onPick = _a.onPick, tripStartDate = _a.tripStartDate;
    if (buckets.length <= 1)
        return null;
    return (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={dc.strip} style={dc.scroll}>
      <react_native_1.Pressable style={[dc.chip, activeDay === 'all' && dc.chipActive]} onPress={function () { return onPick('all'); }}>
        <react_native_1.Text style={[dc.chipText, activeDay === 'all' && dc.chipTextActive]}>All</react_native_1.Text>
      </react_native_1.Pressable>
      {buckets.map(function (b) {
            var on = activeDay === b.key;
            return (<react_native_1.Pressable key={b.key} style={[dc.chip, on && dc.chipActive]} onPress={function () { return onPick(b.key); }}>
            <react_native_1.Text style={[dc.chipText, on && dc.chipTextActive]}>{dayChipLabel(b.key, tripStartDate)}</react_native_1.Text>
            {b.items.length > 0 && <react_native_1.View style={[dc.dot, on && dc.dotActive]}/>}
          </react_native_1.Pressable>);
        })}
    </react_native_1.ScrollView>);
}
// ── Category chip bar ─────────────────────────────────────────────────────────
function CategoryChipBar(_a) {
    var activeCat = _a.activeCat, onPick = _a.onPick;
    return (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cc.strip} style={cc.scroll}>
      {CAT_CHIPS.map(function (c) {
            var on = activeCat === c.key;
            return (<react_native_1.Pressable key={c.key} style={[cc.chip, on && cc.chipActive]} onPress={function () { return onPick(c.key); }}>
            <react_native_1.Text style={[cc.chipText, on && cc.chipTextActive]}>{c.label}</react_native_1.Text>
          </react_native_1.Pressable>);
        })}
    </react_native_1.ScrollView>);
}
// ── Non-member locked view ─────────────────────────────────────────────────────
function PlanLockedView() {
    return (<react_native_1.View style={lk.wrap}>
      <react_native_1.View style={lk.iconWrap}><lucide_react_native_1.Lock size={22} color={tokens_1.color.mute}/></react_native_1.View>
      <react_native_1.Text style={lk.title}>Members-only</react_native_1.Text>
      <react_native_1.Text style={lk.body}>Join this trip to see and collaborate on the day-by-day plan.</react_native_1.Text>
    </react_native_1.View>);
}
// ── Pending-invite view ────────────────────────────────────────────────────────
function PendingInviteView() {
    return (<react_native_1.View style={lk.wrap}>
      <react_native_1.View style={lk.iconWrap}><lucide_react_native_1.Lock size={22} color={tokens_1.color.signal}/></react_native_1.View>
      <react_native_1.Text style={lk.title}>Invite pending</react_native_1.Text>
      <react_native_1.Text style={lk.body}>Accept your trip invite to contribute to the plan.</react_native_1.Text>
    </react_native_1.View>);
}
function ViewToggle(_a) {
    var mode = _a.mode, onChange = _a.onChange;
    return (<react_native_1.View style={vt.wrap}>
      <react_native_1.Pressable style={[vt.btn, mode === 'timeline' && vt.btnActive]} onPress={function () { return onChange('timeline'); }}>
        <lucide_react_native_1.List size={14} color={mode === 'timeline' ? '#fff' : tokens_1.color.mute}/>
        <react_native_1.Text style={[vt.btnText, mode === 'timeline' && vt.btnTextActive]}>Timeline</react_native_1.Text>
      </react_native_1.Pressable>
      <react_native_1.Pressable style={[vt.btn, mode === 'map' && vt.btnActive]} onPress={function () { return onChange('map'); }}>
        <lucide_react_native_1.Map size={14} color={mode === 'map' ? '#fff' : tokens_1.color.mute}/>
        <react_native_1.Text style={[vt.btnText, mode === 'map' && vt.btnTextActive]}>Map</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
// ── Background-sync merge ──────────────────────────────────────────────────────
// Cheap per-item equality: `updatedAt` changes on any server-side field edit,
// `sortOrder` covers reorders, and warnings are advisory and recomputed per fetch.
function planItemEqual(a, b) {
    var _a, _b, _c, _d;
    return (a.id === b.id &&
        a.updatedAt === b.updatedAt &&
        a.sortOrder === b.sortOrder &&
        a.dayDate === b.dayDate &&
        ((_b = (_a = a.warnings) === null || _a === void 0 ? void 0 : _a.join('|')) !== null && _b !== void 0 ? _b : '') === ((_d = (_c = b.warnings) === null || _c === void 0 ? void 0 : _c.join('|')) !== null && _d !== void 0 ? _d : ''));
}
/**
 * Merge a freshly-fetched plan into the current local list. The server response
 * is the source of truth for membership and order. Unchanged items keep their
 * previous object reference so React can skip re-rendering those rows. Returns
 * the same array reference when nothing changed so callers can no-op.
 */
function mergePlanItems(prev, next) {
    var sameLength = prev.length === next.length;
    if (sameLength && prev.every(function (p, i) { return p.id === next[i].id && planItemEqual(p, next[i]); })) {
        return { merged: prev, changed: false };
    }
    var prevById = new Map(prev.map(function (p) { return [p.id, p]; }));
    var merged = next.map(function (n) {
        var existing = prevById.get(n.id);
        return existing && planItemEqual(existing, n) ? existing : n;
    });
    return { merged: merged, changed: true };
}
// ── Main section ──────────────────────────────────────────────────────────────
function TripPlanSection(_a) {
    var _this = this;
    var _b, _c;
    var tripId = _a.tripId, currentUserId = _a.currentUserId, isOwner = _a.isOwner, isPendingInvite = _a.isPendingInvite, tripStartDate = _a.tripStartDate, tripEndDate = _a.tripEndDate, pageScrollRef = _a.pageScrollRef;
    var _d = (0, react_1.useState)([]), items = _d[0], setItems = _d[1];
    var _e = (0, react_1.useState)(false), loading = _e[0], setLoading = _e[1];
    var _f = (0, react_1.useState)(false), canEdit = _f[0], setCanEdit = _f[1];
    var _g = (0, react_1.useState)([]), mapItems = _g[0], setMapItems = _g[1];
    var _h = (0, react_1.useState)(false), mapLoading = _h[0], setMapLoading = _h[1];
    var _j = (0, react_1.useState)(false), addSheetOpen = _j[0], setAddSheetOpen = _j[1];
    var _k = (0, react_1.useState)(false), accessDenied = _k[0], setAccessDenied = _k[1];
    var _l = (0, react_1.useState)(false), settingsOpen = _l[0], setSettingsOpen = _l[1];
    var _m = (0, react_1.useState)('all'), activeDay = _m[0], setActiveDay = _m[1];
    var _o = (0, react_1.useState)('all'), activeCat = _o[0], setActiveCat = _o[1];
    var _p = (0, react_1.useState)('timeline'), viewMode = _p[0], setViewMode = _p[1];
    var _q = (0, react_1.useState)(false), showWarningsOnly = _q[0], setShowWarningsOnly = _q[1];
    var _r = (0, react_1.useState)(null), detailItem = _r[0], setDetailItem = _r[1];
    var _s = (0, react_1.useState)(false), detailStartInEditMode = _s[0], setDetailStartInEditMode = _s[1];
    var _t = (0, react_1.useState)(null), safeReturnSetupItem = _t[0], setSafeReturnSetupItem = _t[1];
    var _u = (0, react_1.useState)(false), safeReturnSetupOpen = _u[0], setSafeReturnSetupOpen = _u[1];
    var _v = (0, react_1.useState)(null), activeSafeReturnSession = _v[0], setActiveSafeReturnSession = _v[1];
    var _w = (0, react_1.useState)(false), showMissedPrompt = _w[0], setShowMissedPrompt = _w[1];
    // Persist view mode per-trip
    (0, react_1.useEffect)(function () {
        async_storage_1.default.getItem("tripPlanMode:".concat(tripId))
            .then(function (v) { if (v === 'timeline' || v === 'map')
            setViewMode(v); })
            .catch(function () { });
    }, [tripId]);
    var loadMap = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setMapLoading(true);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, tripPlan_1.fetchTripPlanMap)(tripId)];
                case 2:
                    data = _b.sent();
                    setMapItems(data);
                    return [3 /*break*/, 5];
                case 3:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 4:
                    setMapLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var result, e_1, msg;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    setLoading(true);
                    setAccessDenied(false);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, (0, tripPlan_1.fetchTripPlan)(tripId)];
                case 2:
                    result = _b.sent();
                    setItems(result.items);
                    setCanEdit(result.canEdit);
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _b.sent();
                    msg = ((_a = e_1.message) !== null && _a !== void 0 ? _a : '').toLowerCase();
                    if (msg.includes('403') || msg.includes('401') || msg.includes('forbidden') || msg.includes('unauthorized')) {
                        setAccessDenied(true);
                    }
                    return [3 /*break*/, 5];
                case 4:
                    setLoading(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { load(); }, [load]));
    // ── Background auto-sync ──────────────────────────────────────────────────────
    // Keep a ref of the latest items so the poll callback merges against current
    // state without needing to be re-created (which would restart the interval).
    var itemsRef = (0, react_1.useRef)(items);
    (0, react_1.useEffect)(function () { itemsRef.current = items; }, [items]);
    // "Plan updated" toast — fades in when a remote change arrives, then auto-hides.
    var updatedAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var updatedHideTimer = (0, react_1.useRef)(null);
    var showUpdatedToast = (0, react_1.useCallback)(function () {
        if (updatedHideTimer.current)
            clearTimeout(updatedHideTimer.current);
        react_native_1.Animated.timing(updatedAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
        updatedHideTimer.current = setTimeout(function () {
            react_native_1.Animated.timing(updatedAnim, { toValue: 0, duration: 240, useNativeDriver: true }).start();
        }, 2200);
    }, [updatedAnim]);
    (0, react_1.useEffect)(function () { return function () { if (updatedHideTimer.current)
        clearTimeout(updatedHideTimer.current); }; }, []);
    var applyServerResult = (0, react_1.useCallback)(function (result) {
        setCanEdit(result.canEdit);
        var _a = mergePlanItems(itemsRef.current, result.items), merged = _a.merged, changed = _a.changed;
        if (!changed)
            return;
        itemsRef.current = merged;
        setItems(merged);
        setMapItems([]); // invalidate map cache so it refetches fresh coords
        showUpdatedToast();
    }, [showUpdatedToast]);
    (0, usePlanSync_1.usePlanSync)(tripId, {
        enabled: !accessDenied,
        intervalMs: 10000,
        onResult: applyServerResult,
    });
    // Auto-load map when entering map mode or when mapItems is cleared by a mutation
    (0, react_1.useEffect)(function () {
        if (viewMode === 'map' && mapItems.length === 0 && !mapLoading) {
            loadMap();
        }
    }, [viewMode, mapItems.length, mapLoading, loadMap]);
    var handleViewModeChange = (0, react_1.useCallback)(function (m) {
        setViewMode(m);
        async_storage_1.default.setItem("tripPlanMode:".concat(tripId), m).catch(function () { });
    }, [tripId]);
    var warnedItemRef = (0, react_1.useRef)(null);
    var warnCount = items.filter(function (i) { return i.warnings && i.warnings.length > 0; }).length;
    var firstWarnedId = (_b = items.find(function (i) { return i.warnings && i.warnings.length > 0; })) === null || _b === void 0 ? void 0 : _b.id;
    // Auto-clear warnings filter if all warnings disappear (e.g. after an item edit or reload)
    (0, react_1.useEffect)(function () {
        if (warnCount === 0 && showWarningsOnly)
            setShowWarningsOnly(false);
    }, [warnCount, showWarningsOnly]);
    var handleNeedsAttention = (0, react_1.useCallback)(function () {
        var _a;
        var first = items.find(function (i) { return i.warnings && i.warnings.length > 0; });
        if (!first)
            return;
        setViewMode('timeline');
        setActiveDay((_a = first.dayDate) !== null && _a !== void 0 ? _a : '__unscheduled__');
        setActiveCat('all');
        // After React re-renders the timeline with filters applied, scroll to the exact item
        setTimeout(function () {
            if (!warnedItemRef.current || !(pageScrollRef === null || pageScrollRef === void 0 ? void 0 : pageScrollRef.current))
                return;
            var nodeHandle = (0, react_native_1.findNodeHandle)(pageScrollRef.current);
            if (nodeHandle == null)
                return;
            warnedItemRef.current.measureLayout(nodeHandle, function (_x, y) { var _a; (_a = pageScrollRef.current) === null || _a === void 0 ? void 0 : _a.scrollTo({ y: Math.max(0, y - 16), animated: true }); }, function () { });
        }, 120);
    }, [items, pageScrollRef]);
    var handleAdded = (0, react_1.useCallback)(function (item) {
        setItems(function (prev) { return __spreadArray(__spreadArray([], prev, true), [item], false); });
        setMapItems([]); // invalidate map cache so it refetches on next map view
        setAddSheetOpen(false);
    }, []);
    var handleItemsChanged = (0, react_1.useCallback)(function (updater) {
        setItems(updater);
        setMapItems([]); // invalidate map cache
    }, []);
    // Poll active Safe Return session every 60 s.
    // Auto-show MissedCheckinPrompt when the backend flags the session as 'missed'.
    (0, react_1.useEffect)(function () {
        var cancelled = false;
        function pollSession() {
            return __awaiter(this, void 0, void 0, function () {
                var r, _a;
                var _b, _c;
                return __generator(this, function (_d) {
                    switch (_d.label) {
                        case 0:
                            _d.trys.push([0, 2, , 3]);
                            return [4 /*yield*/, (0, safeReturn_1.getActiveSession)()];
                        case 1:
                            r = _d.sent();
                            if (cancelled)
                                return [2 /*return*/];
                            setActiveSafeReturnSession((_b = r.session) !== null && _b !== void 0 ? _b : null);
                            if (((_c = r.session) === null || _c === void 0 ? void 0 : _c.status) === 'missed')
                                setShowMissedPrompt(true);
                            return [3 /*break*/, 3];
                        case 2:
                            _a = _d.sent();
                            return [3 /*break*/, 3];
                        case 3: return [2 /*return*/];
                    }
                });
            });
        }
        pollSession();
        var iv = setInterval(pollSession, 60000);
        return function () { cancelled = true; clearInterval(iv); };
    }, []);
    var handleItemPress = (0, react_1.useCallback)(function (item) {
        setDetailStartInEditMode(false);
        setDetailItem(item);
        // Check Safe Return suggestion in the background (best-effort)
        (0, safeReturn_1.getSuggestion)(item.id)
            .then(function (result) {
            if (result === null || result === void 0 ? void 0 : result.suggest) {
                setSafeReturnSetupItem(item);
            }
        })
            .catch(function () { });
    }, []);
    var handleEditPress = (0, react_1.useCallback)(function (item) {
        setDetailStartInEditMode(true);
        setDetailItem(item);
    }, []);
    // Apply day + category + warnings filters to items
    var filteredItems = items.filter(function (item) {
        var dayOk = activeDay === 'all'
            ? true
            : activeDay === '__unscheduled__'
                ? !item.dayDate
                : item.dayDate === activeDay;
        var catOk = activeCat === 'all' || item.category === activeCat;
        var warnOk = !showWarningsOnly || (item.warnings && item.warnings.length > 0);
        return dayOk && catOk && warnOk;
    });
    // Build day buckets from ALL items (for the chip bar) and filtered items (for rendering)
    var allBuckets = buildBuckets(items, tripStartDate, tripEndDate);
    var visibleBuckets = (function () {
        if (activeDay === 'all' && activeCat === 'all' && !showWarningsOnly)
            return allBuckets;
        if (activeDay !== 'all') {
            // Single-day view: return exactly one bucket so no empty date-range days appear
            return [{ key: activeDay, items: filteredItems }];
        }
        // Category-only or warnings-only filter — keep full date range structure
        return buildBuckets(filteredItems, tripStartDate, tripEndDate);
    })();
    var hasContent = items.length > 0;
    return (<react_native_1.View style={ps.wrap}>
      {/* "Plan updated" toast — appears briefly when a teammate's change syncs in */}
      <react_native_1.Animated.View pointerEvents="none" style={[
            ps.updatedToast,
            {
                opacity: updatedAnim,
                transform: [{
                        translateY: updatedAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }),
                    }],
            },
        ]}>
        <lucide_react_native_1.RefreshCw size={11} color={tokens_1.color.onInk}/>
        <react_native_1.Text style={ps.updatedToastText}>Plan updated</react_native_1.Text>
      </react_native_1.Animated.View>

      {/* Header */}
      <react_native_1.View style={ps.head}>
        <react_native_1.Text style={ps.title}>Trip Plan</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        {!accessDenied && hasContent && (<ViewToggle mode={viewMode} onChange={handleViewModeChange}/>)}
        {!accessDenied && (<>
            <react_native_1.Pressable style={ps.refreshBtn} onPress={load} hitSlop={8}>
              <lucide_react_native_1.RotateCcw size={15} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
            {isOwner && (<react_native_1.Pressable style={ps.settingsBtn} onPress={function () { return setSettingsOpen(true); }} hitSlop={8}>
                <lucide_react_native_1.Settings2 size={15} color={tokens_1.color.mute}/>
              </react_native_1.Pressable>)}
            {canEdit && (<react_native_1.Pressable style={ps.addBtn} onPress={function () { return setAddSheetOpen(true); }}>
                <lucide_react_native_1.Plus size={15} color={tokens_1.color.onInk}/>
                <react_native_1.Text style={ps.addBtnText}>Add</react_native_1.Text>
              </react_native_1.Pressable>)}
          </>)}
      </react_native_1.View>

      {/* Read-only notice for members without edit permission */}
      {!loading && !accessDenied && !canEdit && !isOwner && items.length > 0 && (<react_native_1.View style={ps.readOnlyBanner}>
          <lucide_react_native_1.Lock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={ps.readOnlyText}>Only the organizer can edit this plan</react_native_1.Text>
        </react_native_1.View>)}

      {/* Warning summary banner */}
      {!loading && !accessDenied && warnCount > 0 && (<react_native_1.Pressable style={ps.warnBanner} onPress={handleNeedsAttention}>
          <lucide_react_native_1.AlertTriangle size={12} color="#8B5E00"/>
          <react_native_1.Text style={ps.warnBannerText}>
            {warnCount} item{warnCount !== 1 ? 's' : ''} need{warnCount === 1 ? 's' : ''} attention
          </react_native_1.Text>
          <react_native_1.Text style={ps.warnBannerLink}>Jump to first →</react_native_1.Text>
        </react_native_1.Pressable>)}

      {/* Filters — only shown when there's content */}
      {!loading && !accessDenied && hasContent && (<>
          <DayChipBar buckets={allBuckets} activeDay={activeDay} onPick={setActiveDay} tripStartDate={tripStartDate}/>
          <CategoryChipBar activeCat={activeCat} onPick={setActiveCat}/>
          {warnCount > 0 && (<react_native_1.View style={wf.row}>
              <react_native_1.Pressable style={[wf.chip, showWarningsOnly && wf.chipActive]} onPress={function () { return setShowWarningsOnly(function (v) { return !v; }); }}>
                <lucide_react_native_1.AlertTriangle size={11} color={showWarningsOnly ? '#8B5E00' : tokens_1.color.mute}/>
                <react_native_1.Text style={[wf.chipText, showWarningsOnly && wf.chipTextActive]}>
                  Warnings ({warnCount})
                </react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>)}
        </>)}

      {loading && <react_native_1.ActivityIndicator color={tokens_1.color.signal} style={{ marginVertical: tokens_1.space.lg }}/>}

      {!loading && accessDenied && (isPendingInvite ? <PendingInviteView /> : <PlanLockedView />)}

      {!loading && !accessDenied && items.length === 0 && (<react_native_1.View style={ps.empty}>
          <react_native_1.Text style={ps.emptyTitle}>No plans yet.</react_native_1.Text>
          <react_native_1.Text style={ps.emptyBody}>
            {canEdit
                ? 'Add places, meetups, or activities to build your day-by-day itinerary.'
                : 'The organizer hasn\'t added any items yet.'}
          </react_native_1.Text>
          {canEdit && (<react_native_1.Pressable style={ps.emptyBtn} onPress={function () { return setAddSheetOpen(true); }}>
              <react_native_1.Text style={ps.emptyBtnText}>Add your first item</react_native_1.Text>
            </react_native_1.Pressable>)}
        </react_native_1.View>)}

      {!loading && !accessDenied && hasContent && viewMode === 'timeline' && (<TimelineView_1.TimelineView buckets={visibleBuckets} tripStartDate={tripStartDate} tripId={tripId} currentUserId={currentUserId} isOwner={isOwner} canEdit={canEdit} onItemPress={handleItemPress} onEditPress={handleEditPress} onItemsChanged={handleItemsChanged} firstWarnedId={firstWarnedId} warnedItemRef={warnedItemRef}/>)}

      {!loading && !accessDenied && hasContent && viewMode === 'map' && (<MapView_1.ItineraryMapView items={mapItems.length > 0
                ? mapItems.filter(function (item) { return activeCat === 'all' || item.category === activeCat; })
                : filteredItems.filter(function (item) { return item.lat != null && item.lng != null && !item.locationIsPrivate; })} onItemPress={setDetailItem} selectedDay={activeDay} loading={mapLoading}/>)}

      {/* Active Safe Return session card */}
      {activeSafeReturnSession && (<ActiveSafeReturnCard_1.ActiveSafeReturnCard session={activeSafeReturnSession} onSessionEnded={function () { return setActiveSafeReturnSession(null); }} onSessionUpdated={function (s) { return setActiveSafeReturnSession(s); }}/>)}

      {/* Missed check-in prompt — shown automatically when the session
            timer expires and the backend marks the session as 'missed'. */}
      {activeSafeReturnSession && activeSafeReturnSession.status === 'missed' && (<MissedCheckinPrompt_1.MissedCheckinPrompt visible={showMissedPrompt} session={activeSafeReturnSession} onDismiss={function () { return setShowMissedPrompt(false); }} onSafe={function () {
                setShowMissedPrompt(false);
                setActiveSafeReturnSession(null);
            }} onExtended={function (s) {
                setShowMissedPrompt(false);
                setActiveSafeReturnSession(s);
            }}/>)}

      {/* Item detail sheet */}
      <PlanItemSheet_1.PlanItemSheet item={detailItem} tripId={tripId} currentUserId={currentUserId} isOwner={isOwner} canEdit={canEdit} startInEditMode={detailStartInEditMode} onClose={function () {
            setDetailItem(null);
            setDetailStartInEditMode(false);
            // Show Safe Return setup if the API suggested it for this item
            if (safeReturnSetupItem) {
                setSafeReturnSetupOpen(true);
            }
        }} onUpdated={function (updated) {
            setItems(function (prev) { return prev.map(function (i) { return i.id === updated.id ? updated : i; }); });
            setMapItems([]); // invalidate map cache
            setDetailItem(updated);
            setDetailStartInEditMode(false);
        }} onRemoved={function (id) {
            setItems(function (prev) { return prev.filter(function (i) { return i.id !== id; }); });
            setMapItems([]); // invalidate map cache
            setDetailItem(null);
            setDetailStartInEditMode(false);
        }} onSetupSafeReturn={function (item) {
            setSafeReturnSetupItem(item);
            setSafeReturnSetupOpen(true);
        }}/>

      {/* Safe Return setup — shown after plan item sheet closes when suggested */}
      <SafeReturnSetupSheet_1.SafeReturnSetupSheet visible={safeReturnSetupOpen} planItemId={safeReturnSetupItem === null || safeReturnSetupItem === void 0 ? void 0 : safeReturnSetupItem.id} tripId={tripId} planEndsAt={(_c = safeReturnSetupItem === null || safeReturnSetupItem === void 0 ? void 0 : safeReturnSetupItem.endsAt) !== null && _c !== void 0 ? _c : null} onClose={function () { setSafeReturnSetupOpen(false); setSafeReturnSetupItem(null); }} onStarted={function () {
            setSafeReturnSetupOpen(false);
            setSafeReturnSetupItem(null);
            // Refresh active session to show the new card
            (0, safeReturn_1.getActiveSession)()
                .then(function (r) { return setActiveSafeReturnSession(r.session); })
                .catch(function () { });
        }}/>

      <AddToPlanSheet_1.AddToPlanSheet visible={addSheetOpen} tripId={tripId} onClose={function () { return setAddSheetOpen(false); }} onAdded={handleAdded}/>

      {/* Plan settings — owner only */}
      <TripPlanSettingsSheet_1.TripPlanSettingsSheet visible={settingsOpen} tripId={tripId} onClose={function () { return setSettingsOpen(false); }} onSaved={load}/>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var ps = react_native_1.StyleSheet.create({
    wrap: { marginTop: tokens_1.space.lg },
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm, gap: 8 },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    refreshBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: tokens_1.radius.md },
    settingsBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: tokens_1.radius.md },
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, paddingHorizontal: 10, paddingVertical: 6 },
    addBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    readOnlyBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: 8, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md },
    readOnlyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    warnBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm, backgroundColor: '#FFFBEB', borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: '#F5D77B', paddingHorizontal: tokens_1.space.md, paddingVertical: 8 },
    warnBannerText: __assign(__assign({}, tokens_1.type.small), { color: '#8B5E00', fontWeight: '600', flex: 1 }),
    warnBannerLink: __assign(__assign({}, tokens_1.type.small), { color: '#F59E0B', fontWeight: '700' }),
    updatedToast: { position: 'absolute', top: -4, alignSelf: 'center', zIndex: 50, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: tokens_1.color.deep, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
    updatedToastText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
    empty: { padding: tokens_1.space.lg, alignItems: 'center', gap: 8, paddingVertical: 40 },
    emptyTitle: __assign(__assign({}, tokens_1.type.title), { fontSize: 18, color: tokens_1.color.ink }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', maxWidth: 280, lineHeight: 22 }),
    emptyBtn: { marginTop: 8, backgroundColor: tokens_1.color.deep, borderRadius: tokens_1.radius.md, paddingHorizontal: 20, paddingVertical: 10 },
    emptyBtnText: __assign(__assign({}, tokens_1.type.body), { color: '#fff', fontWeight: '700' }),
});
var vt = react_native_1.StyleSheet.create({
    wrap: { flexDirection: 'row', backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 2 },
    btn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
    btnActive: { backgroundColor: tokens_1.color.deep },
    btnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', fontSize: 11 }),
    btnTextActive: { color: '#fff' },
});
var dc = react_native_1.StyleSheet.create({
    scroll: { marginHorizontal: -tokens_1.space.lg, marginBottom: 4 },
    strip: { paddingHorizontal: tokens_1.space.lg, gap: 6, paddingVertical: 4 },
    chip: { borderRadius: 20, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 4 },
    chipActive: { backgroundColor: tokens_1.color.deep, borderColor: tokens_1.color.deep },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    chipTextActive: { color: '#fff' },
    dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: tokens_1.color.signal },
    dotActive: { backgroundColor: '#fff' },
});
var cc = react_native_1.StyleSheet.create({
    scroll: { marginHorizontal: -tokens_1.space.lg, marginBottom: 8 },
    strip: { paddingHorizontal: tokens_1.space.lg, gap: 6, paddingVertical: 2 },
    chip: { borderRadius: 12, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: '#fff', paddingHorizontal: 10, paddingVertical: 3 },
    chipActive: { backgroundColor: '#EEF4FF', borderColor: tokens_1.color.deep },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    chipTextActive: { color: tokens_1.color.deep, fontWeight: '600' },
});
var lk = react_native_1.StyleSheet.create({
    wrap: { padding: tokens_1.space.lg, alignItems: 'center', gap: 8, paddingVertical: 36 },
    iconWrap: { width: 48, height: 48, borderRadius: 24, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.title), { fontSize: 16, color: tokens_1.color.ink }),
    body: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center', maxWidth: 260, lineHeight: 22 }),
});
var wf = react_native_1.StyleSheet.create({
    row: { paddingHorizontal: tokens_1.space.lg, marginBottom: 8, flexDirection: 'row' },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 12, borderWidth: 1, borderColor: '#F5D77B', backgroundColor: '#FFFBEB', paddingHorizontal: 10, paddingVertical: 4 },
    chipActive: { backgroundColor: '#F59E0B', borderColor: '#D97706' },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: '#8B5E00', fontWeight: '600', fontSize: 11 }),
    chipTextActive: { color: '#fff' },
});
