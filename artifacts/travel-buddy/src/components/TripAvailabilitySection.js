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
exports.TripAvailabilitySection = TripAvailabilitySection;
/**
 * TripAvailabilitySection — day-level availability grid for a trip's members.
 *
 * Columns = trip dates (startDate → endDate, max 30, from today onwards).
 * Rows    = accepted trip members.
 * Cells   = green (free) / grey (not set) / dim (no data).
 *
 * Above the grid: BestDaysBanner showing up to 3 days where ≥2 members overlap.
 * Tapping a column header or banner chip opens a day-summary modal.
 * "Plan meetup this day" fires onPlanMeetup(date) so the parent
 * can open MeetupCreationSheet pre-filled.
 *
 * Own-row cells are tappable — opens an inline toggle sheet (free/busy/clear).
 * Optimistic update is applied immediately; reverted on API error.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var availability_1 = require("../services/availability");
var AvailabilityGrid_1 = require("./AvailabilityGrid");
var BestDaysBanner_1 = require("./BestDaysBanner");
var tokens_1 = require("../theme/tokens");
// ── Helpers ───────────────────────────────────────────────────────────────────
var ALL_BLOCKS = ['morning', 'afternoon', 'evening', 'late'];
function generateTripDays(startDate, endDate) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var tripStart = startDate ? new Date(startDate + 'T00:00:00') : today;
    var start = tripStart >= today ? tripStart : today;
    var tripEnd = endDate
        ? new Date(endDate + 'T00:00:00')
        : new Date(start.getTime() + 13 * 86400000);
    var maxEnd = new Date(start.getTime() + 29 * 86400000);
    var end = tripEnd < maxEnd ? tripEnd : maxEnd;
    var days = [];
    var cur = new Date(start);
    while (cur <= end) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}
function formatShortDate(date) {
    return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
    });
}
var COLLAPSE_THRESHOLD = 7;
function CellEditSheet(_a) {
    var date = _a.date, currentStatus = _a.currentStatus, onChoose = _a.onChoose, onClose = _a.onClose;
    if (!date)
        return null;
    var options = [
        { key: 'free', label: '🟢  Mark as Free', active: currentStatus === 'free' },
        { key: 'busy', label: '⚫  Mark as Busy', active: currentStatus === 'unknown' },
        { key: 'clear', label: '✕  Clear', active: currentStatus === 'nodata' },
    ];
    return (<react_native_1.Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={ts.overlay} onPress={onClose}>
        <react_native_1.Pressable style={ts.sheet} onPress={function () { }}>
          <react_native_1.View style={ts.handle}/>
          <react_native_1.Pressable style={ts.closeBtn} onPress={onClose} hitSlop={8}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>

          <react_native_1.Text style={ts.sheetTitle}>{formatShortDate(date)}</react_native_1.Text>
          <react_native_1.Text style={ts.sheetSub}>Update your availability for this day</react_native_1.Text>

          {options.map(function (opt) { return (<react_native_1.Pressable key={opt.key} style={[ts.optionRow, opt.active && ts.optionRowActive]} onPress={function () { onChoose(opt.key); onClose(); }}>
              <react_native_1.Text style={[ts.optionLabel, opt.active && ts.optionLabelActive]}>
                {opt.label}
              </react_native_1.Text>
              {opt.active && <react_native_1.Text style={ts.checkmark}>✓</react_native_1.Text>}
            </react_native_1.Pressable>); })}
        </react_native_1.Pressable>
      </react_native_1.Pressable>
    </react_native_1.Modal>);
}
function TripAvailabilitySection(_a) {
    var _this = this;
    var _b, _c;
    var tripId = _a.tripId, currentUserId = _a.currentUserId, startDate = _a.startDate, endDate = _a.endDate, onPlanMeetup = _a.onPlanMeetup;
    var _d = (0, react_1.useState)([]), members = _d[0], setMembers = _d[1];
    var _e = (0, react_1.useState)([]), bestDays = _e[0], setBestDays = _e[1];
    var _f = (0, react_1.useState)(true), loading = _f[0], setLoading = _f[1];
    var _g = (0, react_1.useState)(null), error = _g[0], setError = _g[1];
    var _h = (0, react_1.useState)(false), collapsed = _h[0], setCollapsed = _h[1];
    var _j = (0, react_1.useState)(null), selectedDay = _j[0], setSelectedDay = _j[1];
    var _k = (0, react_1.useState)(null), editSheet = _k[0], setEditSheet = _k[1];
    var load = (0, react_1.useCallback)(function () { return __awaiter(_this, void 0, void 0, function () {
        var res, ms;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    setLoading(true);
                    setError(null);
                    return [4 /*yield*/, (0, availability_1.getTripAvailability)(tripId)];
                case 1:
                    res = _c.sent();
                    setLoading(false);
                    if (res.ok && res.data) {
                        ms = res.data.members;
                        setMembers(ms);
                        setBestDays((_a = res.data.bestDays) !== null && _a !== void 0 ? _a : []);
                        if (ms.length > COLLAPSE_THRESHOLD)
                            setCollapsed(true);
                    }
                    else {
                        setError((_b = res.message) !== null && _b !== void 0 ? _b : null);
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [tripId]);
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () { load(); }, [load]));
    // ── Own-cell tap handler ────────────────────────────────────────────────────
    var handleOwnCellPress = (0, react_1.useCallback)(function (date, status) {
        setEditSheet({ date: date, status: status });
    }, []);
    // ── Toggle choice → optimistic update → API ─────────────────────────────────
    var handleToggle = (0, react_1.useCallback)(function (choice) { return __awaiter(_this, void 0, void 0, function () {
        var me, prevOpenDays, date, newOpenDays, result;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    me = members.find(function (m) { return m.userId === currentUserId; });
                    if (!me)
                        return [2 /*return*/];
                    prevOpenDays = (_a = me.openDays) !== null && _a !== void 0 ? _a : {};
                    date = editSheet === null || editSheet === void 0 ? void 0 : editSheet.date;
                    if (!date)
                        return [2 /*return*/];
                    newOpenDays = __assign({}, prevOpenDays);
                    if (choice === 'free')
                        newOpenDays[date] = ALL_BLOCKS;
                    else if (choice === 'busy')
                        newOpenDays[date] = [];
                    else
                        delete newOpenDays[date];
                    setMembers(function (prev) {
                        return prev.map(function (m) { return m.userId === currentUserId ? __assign(__assign({}, m), { openDays: newOpenDays }) : m; });
                    });
                    return [4 /*yield*/, (0, availability_1.patchTripOpenDays)(tripId, newOpenDays)];
                case 1:
                    result = _c.sent();
                    if (!result.ok) {
                        setMembers(function (prev) {
                            return prev.map(function (m) { return m.userId === currentUserId ? __assign(__assign({}, m), { openDays: prevOpenDays }) : m; });
                        });
                        react_native_1.Alert.alert('Could not update', (_b = result.message) !== null && _b !== void 0 ? _b : 'Please try again.');
                    }
                    return [2 /*return*/];
            }
        });
    }); }, [members, currentUserId, editSheet, tripId]);
    var days = generateTripDays(startDate, endDate);
    var freeNow = members.filter(function (m) { var _a; return ((_a = m.quickStatus) === null || _a === void 0 ? void 0 : _a.status) === 'free_now'; }).length;
    var canToggle = members.length > COLLAPSE_THRESHOLD;
    if (loading) {
        return (<react_native_1.View style={s.wrap}>
        <react_native_1.View style={s.headRow}>
          <lucide_react_native_1.CalendarClock size={15} color={tokens_1.color.deep}/>
          <react_native_1.Text style={s.heading}>Member Availability</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={s.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>
      </react_native_1.View>);
    }
    if (error || members.length === 0)
        return null;
    return (<react_native_1.View style={s.wrap}>
      {/* Header — tappable to collapse if large group */}
      <react_native_1.Pressable style={s.headRow} onPress={canToggle ? function () { return setCollapsed(function (v) { return !v; }); } : undefined} hitSlop={4}>
        <lucide_react_native_1.CalendarClock size={15} color={tokens_1.color.deep}/>
        <react_native_1.Text style={s.heading}>Member Availability</react_native_1.Text>

        {freeNow > 0 && (<react_native_1.View style={s.badge}>
            <lucide_react_native_1.Zap size={10} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>
            <react_native_1.Text style={s.badgeText}>{freeNow} free now</react_native_1.Text>
          </react_native_1.View>)}

        <react_native_1.View style={{ flex: 1 }}/>

        {canToggle && (collapsed
            ? <lucide_react_native_1.ChevronDown size={16} color={tokens_1.color.mute}/>
            : <lucide_react_native_1.ChevronUp size={16} color={tokens_1.color.mute}/>)}
      </react_native_1.Pressable>

      {/* Best days banner — above the grid */}
      {!collapsed && bestDays.length > 0 && (<BestDaysBanner_1.BestDaysBanner bestDays={bestDays} totalMembers={members.length} onDayPress={function (date) { return setSelectedDay(date); }}/>)}

      {/* Grid */}
      {!collapsed && (<react_native_1.View style={s.card}>
          {days.length > 0 ? (<AvailabilityGrid_1.AvailabilityGrid members={members} days={days} currentUserId={currentUserId} mode="trip" onEditOwn={function () { return expo_router_1.router.push('/availability'); }} onPlanMeetup={onPlanMeetup} onOwnCellPress={handleOwnCellPress} selectedDay={selectedDay} onSelectedDayChange={setSelectedDay}/>) : (<react_native_1.Text style={s.noDates}>
              Add trip dates to see the day-by-day availability grid.
            </react_native_1.Text>)}

          <react_native_1.Pressable style={s.editBtn} onPress={function () { return expo_router_1.router.push('/availability'); }}>
            <react_native_1.Text style={s.editBtnText}>Update my availability →</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>)}

      {canToggle && collapsed && (<react_native_1.Pressable onPress={function () { return setCollapsed(false); }}>
          <react_native_1.Text style={s.showAll}>Show all {members.length} members →</react_native_1.Text>
        </react_native_1.Pressable>)}

      {/* Cell edit sheet */}
      <CellEditSheet date={(_b = editSheet === null || editSheet === void 0 ? void 0 : editSheet.date) !== null && _b !== void 0 ? _b : null} currentStatus={(_c = editSheet === null || editSheet === void 0 ? void 0 : editSheet.status) !== null && _c !== void 0 ? _c : 'nodata'} onChoose={handleToggle} onClose={function () { return setEditSheet(null); }}/>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, gap: tokens_1.space.md },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    heading: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    badge: {
        flexDirection: 'row', alignItems: 'center', gap: 3,
        backgroundColor: '#FEF9C3',
        paddingHorizontal: 8, paddingVertical: 3,
        borderRadius: tokens_1.radius.pill, marginLeft: tokens_1.space.sm,
    },
    badgeText: __assign(__assign({}, tokens_1.type.small), { color: '#A16207', fontWeight: '700', fontSize: 11 }),
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.sm }, tokens_1.shadow.card),
    center: { height: 60, alignItems: 'center', justifyContent: 'center' },
    noDates: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center', paddingVertical: tokens_1.space.md }),
    editBtn: { alignSelf: 'flex-start' },
    editBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    showAll: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
});
var ts = react_native_1.StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(17,17,15,0.48)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        padding: tokens_1.space.lg,
        paddingTop: tokens_1.space.md,
        paddingBottom: react_native_1.Platform.OS === 'ios' ? 40 : tokens_1.space.xl,
    },
    handle: {
        width: 36, height: 4, borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center', marginBottom: tokens_1.space.md,
    },
    closeBtn: { position: 'absolute', top: tokens_1.space.md + 4, right: tokens_1.space.lg, padding: 4 },
    sheetTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: 2, paddingRight: 28 }),
    sheetSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginBottom: tokens_1.space.lg }),
    optionRow: {
        flexDirection: 'row', alignItems: 'center',
        paddingVertical: tokens_1.space.md, paddingHorizontal: tokens_1.space.sm,
        borderRadius: tokens_1.radius.sm, marginBottom: 2,
    },
    optionRowActive: { backgroundColor: tokens_1.color.signal + '12' },
    optionLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    optionLabelActive: { color: tokens_1.color.signal, fontWeight: '700' },
    checkmark: { color: tokens_1.color.signal, fontWeight: '700', fontSize: 16 },
});
