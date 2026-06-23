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
exports.AvailabilityGrid = AvailabilityGrid;
/**
 * AvailabilityGrid — day-level grid: rows = members, columns = specific dates.
 *
 * Modes:
 *  trip   — reads member.openDays (trip-scoped) with weeklyDays fallback
 *  circle — reads member.weeklyDays mapped to upcoming calendar dates
 *
 * Layout: sticky left column (member names) + horizontally-scrollable day columns.
 * Tapping a day column header opens a summary modal with free / not-set members
 * and an optional "Plan meetup this day" CTA.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
// ── Layout constants ──────────────────────────────────────────────────────────
var NAME_W = 92; // sticky left column width
var DAY_W = 34; // each day column width
var CELL = 22; // square cell size
var HEAD_H = 46; // header row height
var ROW_H = 36; // member row height
var WEEKDAY_IDX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
var DAY_ABBR = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function hasAnyData(member, mode) {
    if (mode === 'trip' && member.openDays != null) {
        return Object.keys(member.openDays).length > 0;
    }
    return Object.keys(member.weeklyDays).length > 0;
}
function getCellStatus(member, date, mode) {
    var _a, _b, _c;
    if (!hasAnyData(member, mode))
        return 'nodata';
    if (mode === 'trip' && member.openDays != null) {
        return ((_b = (_a = member.openDays[date]) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) > 0 ? 'free' : 'unknown';
    }
    var wd = WEEKDAY_IDX[new Date(date + 'T12:00:00').getDay()];
    return (((_c = member.weeklyDays[wd]) !== null && _c !== void 0 ? _c : []).length > 0) ? 'free' : 'unknown';
}
function dayLabel(date) {
    var d = new Date(date + 'T12:00:00');
    return { abbr: DAY_ABBR[d.getDay()], num: String(d.getDate()) };
}
function formatFullDate(date) {
    return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'long', month: 'short', day: 'numeric',
    });
}
// ── Avatar ────────────────────────────────────────────────────────────────────
function MemberAvatar(_a) {
    var _b, _c;
    var m = _a.m, _d = _a.size, size = _d === void 0 ? 22 : _d;
    var style = { width: size, height: size, borderRadius: size / 2 };
    if (m.avatarUrl)
        return <react_native_1.Image source={{ uri: m.avatarUrl }} style={style}/>;
    return (<react_native_1.View style={[style, g.avatarFb]}>
      <react_native_1.Text style={{ fontSize: size * 0.42, fontWeight: '700', color: tokens_1.color.mute }}>
        {(((_c = (_b = m.name) !== null && _b !== void 0 ? _b : m.handle) !== null && _c !== void 0 ? _c : '?')[0]).toUpperCase()}
      </react_native_1.Text>
    </react_native_1.View>);
}
// ── Cell ─────────────────────────────────────────────────────────────────────
function Cell(_a) {
    var status = _a.status, isOwn = _a.isOwn;
    return (<react_native_1.View style={[
            g.cell,
            status === 'free' ? g.cellFree :
                status === 'nodata' ? g.cellNoData : g.cellUnknown,
            isOwn && g.cellMine,
        ]}>
      {status === 'nodata' && <react_native_1.Text style={g.cellQ}>?</react_native_1.Text>}
    </react_native_1.View>);
}
function DaySummaryModal(_a) {
    var date = _a.date, members = _a.members, mode = _a.mode, onClose = _a.onClose, onPlanMeetup = _a.onPlanMeetup;
    if (!date)
        return null;
    var freeMembers = members.filter(function (m) { return getCellStatus(m, date, mode) === 'free'; });
    var notFreeMembers = members.filter(function (m) { return getCellStatus(m, date, mode) !== 'free'; });
    return (<react_native_1.Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={ds.overlay} onPress={onClose}>
        <react_native_1.Pressable style={ds.sheet} onPress={function () { }}>
          <react_native_1.View style={ds.handle}/>
          <react_native_1.Pressable style={ds.closeBtn} onPress={onClose} hitSlop={8}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>

          <react_native_1.Text style={ds.dateTitle}>{formatFullDate(date)}</react_native_1.Text>

          {/* Free */}
          <react_native_1.Text style={ds.sectionLabel}>🟢 Free</react_native_1.Text>
          {freeMembers.length === 0 ? (<react_native_1.Text style={ds.empty}>No one has marked this day free yet.</react_native_1.Text>) : (freeMembers.map(function (m) {
            var _a, _b, _c;
            return (<react_native_1.Pressable key={m.userId} style={ds.memberRow} onPress={m.handle ? function () { onClose(); expo_router_1.router.push("/u/".concat(m.handle)); } : undefined}>
                <MemberAvatar m={m} size={28}/>
                <react_native_1.Text style={ds.memberName}>{(_b = (_a = m.name) !== null && _a !== void 0 ? _a : m.handle) !== null && _b !== void 0 ? _b : 'Traveler'}</react_native_1.Text>
                {((_c = m.quickStatus) === null || _c === void 0 ? void 0 : _c.status) === 'free_now' && (<react_native_1.View style={ds.nowChip}><react_native_1.Text style={ds.nowChipText}>Now</react_native_1.Text></react_native_1.View>)}
              </react_native_1.Pressable>);
        }))}

          {/* Not free / no data */}
          {notFreeMembers.length > 0 && (<>
              <react_native_1.Text style={[ds.sectionLabel, { marginTop: tokens_1.space.md }]}>⚫ Not set / Unavailable</react_native_1.Text>
              {notFreeMembers.map(function (m) {
                var _a, _b;
                return (<react_native_1.View key={m.userId} style={[ds.memberRow, { opacity: 0.4 }]}>
                  <MemberAvatar m={m} size={28}/>
                  <react_native_1.Text style={ds.memberName}>{(_b = (_a = m.name) !== null && _a !== void 0 ? _a : m.handle) !== null && _b !== void 0 ? _b : 'Traveler'}</react_native_1.Text>
                </react_native_1.View>);
            })}
            </>)}

          {/* Plan meetup CTA */}
          {onPlanMeetup && (<react_native_1.Pressable style={ds.planBtn} onPress={function () { onClose(); onPlanMeetup(date); }}>
              <lucide_react_native_1.CalendarPlus size={15} color={tokens_1.color.onInk}/>
              <react_native_1.Text style={ds.planBtnText}>Plan meetup this day</react_native_1.Text>
            </react_native_1.Pressable>)}
        </react_native_1.Pressable>
      </react_native_1.Pressable>
    </react_native_1.Modal>);
}
function AvailabilityGrid(_a) {
    var members = _a.members, days = _a.days, currentUserId = _a.currentUserId, mode = _a.mode, onEditOwn = _a.onEditOwn, onPlanMeetup = _a.onPlanMeetup, onOwnCellPress = _a.onOwnCellPress, externalSelectedDay = _a.selectedDay, onSelectedDayChange = _a.onSelectedDayChange;
    var _b = (0, react_1.useState)(null), internalDay = _b[0], setInternalDay = _b[1];
    // Support controlled (selectedDay prop) and uncontrolled (internal state) modes
    var isControlled = externalSelectedDay !== undefined;
    var selectedDay = isControlled ? (externalSelectedDay !== null && externalSelectedDay !== void 0 ? externalSelectedDay : null) : internalDay;
    var setSelectedDay = function (day) {
        if (!isControlled)
            setInternalDay(day);
        onSelectedDayChange === null || onSelectedDayChange === void 0 ? void 0 : onSelectedDayChange(day);
    };
    // Current user first, then alphabetical
    var sorted = __spreadArray([], members, true).sort(function (a, b) {
        var _a, _b, _c, _d;
        if (a.userId === currentUserId)
            return -1;
        if (b.userId === currentUserId)
            return 1;
        return ((_b = (_a = a.name) !== null && _a !== void 0 ? _a : a.handle) !== null && _b !== void 0 ? _b : '').localeCompare((_d = (_c = b.name) !== null && _c !== void 0 ? _c : b.handle) !== null && _d !== void 0 ? _d : '');
    });
    if (days.length === 0 || sorted.length === 0)
        return null;
    return (<react_native_1.View>
      <react_native_1.View style={g.root}>
        {/* ── Sticky left column ── */}
        <react_native_1.View style={[g.nameCol, { width: NAME_W }]}>
          {/* spacer matching header height */}
          <react_native_1.View style={{ height: HEAD_H }}/>

          {sorted.map(function (m) {
            var _a, _b;
            var isMe = m.userId === currentUserId;
            return (<react_native_1.Pressable key={m.userId} style={[g.nameRow, { height: ROW_H }]} onPress={isMe ? onEditOwn : undefined} hitSlop={4}>
                <MemberAvatar m={m} size={22}/>
                <react_native_1.Text style={[g.nameTxt, isMe && g.nameTxtMe]} numberOfLines={1}>
                  {isMe ? 'You ✏️' : ((_b = (_a = m.name) !== null && _a !== void 0 ? _a : m.handle) !== null && _b !== void 0 ? _b : '…')}
                </react_native_1.Text>
              </react_native_1.Pressable>);
        })}
        </react_native_1.View>

        {/* ── Scrollable day columns ── */}
        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <react_native_1.View>
            {/* Day headers */}
            <react_native_1.View style={[g.headerRow, { height: HEAD_H }]}>
              {days.map(function (d) {
            var _a = dayLabel(d), abbr = _a.abbr, num = _a.num;
            var isToday = d === new Date().toISOString().slice(0, 10);
            return (<react_native_1.Pressable key={d} style={[g.dayHead, { width: DAY_W, height: HEAD_H }, isToday && g.dayHeadToday]} onPress={function () { return setSelectedDay(d); }}>
                    <react_native_1.Text style={[g.dayAbbr, isToday && g.dayAbbrToday]}>{abbr}</react_native_1.Text>
                    <react_native_1.Text style={[g.dayNum, isToday && g.dayNumToday]}>{num}</react_native_1.Text>
                  </react_native_1.Pressable>);
        })}
            </react_native_1.View>

            {/* Member rows */}
            {sorted.map(function (m) {
            var isMe = m.userId === currentUserId;
            return (<react_native_1.View key={m.userId} style={[g.memberRow, { height: ROW_H }]}>
                  {days.map(function (d) {
                    var status = getCellStatus(m, d, mode);
                    if (isMe && onOwnCellPress) {
                        return (<react_native_1.Pressable key={d} style={[g.cellWrap, { width: DAY_W, height: ROW_H }]} onPress={function () { return onOwnCellPress(d, status); }} hitSlop={2}>
                          <Cell status={status} isOwn/>
                        </react_native_1.Pressable>);
                    }
                    return (<react_native_1.View key={d} style={[g.cellWrap, { width: DAY_W, height: ROW_H }]}>
                        <Cell status={status}/>
                      </react_native_1.View>);
                })}
                </react_native_1.View>);
        })}
          </react_native_1.View>
        </react_native_1.ScrollView>
      </react_native_1.View>

      {/* Legend */}
      <react_native_1.View style={g.legend}>
        <react_native_1.View style={[g.legendDot, { backgroundColor: '#22C55E' }]}/>
        <react_native_1.Text style={g.legendTxt}>Free</react_native_1.Text>
        <react_native_1.View style={[g.legendDot, { backgroundColor: tokens_1.color.haze }]}/>
        <react_native_1.Text style={g.legendTxt}>Not set</react_native_1.Text>
        <react_native_1.View style={[g.legendDot, { backgroundColor: '#F0EDE8' }]}/>
        <react_native_1.Text style={g.legendTxt}>No data</react_native_1.Text>
      </react_native_1.View>

      {/* Day summary modal */}
      <DaySummaryModal date={selectedDay} members={sorted} mode={mode} onClose={function () { return setSelectedDay(null); }} onPlanMeetup={onPlanMeetup}/>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var g = react_native_1.StyleSheet.create({
    root: { flexDirection: 'row', overflow: 'hidden' },
    nameCol: { flexShrink: 0 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 2, paddingRight: 4 },
    nameTxt: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, flex: 1, fontSize: 11, lineHeight: 14 }),
    nameTxtMe: { color: tokens_1.color.signal, fontWeight: '700' },
    avatarFb: { backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    headerRow: { flexDirection: 'row' },
    dayHead: { alignItems: 'center', justifyContent: 'center', gap: 1 },
    dayHeadToday: { backgroundColor: tokens_1.color.haze, borderRadius: 6 },
    dayAbbr: { fontSize: 9, fontWeight: '700', color: tokens_1.color.mute, textTransform: 'uppercase', letterSpacing: 0.3 },
    dayAbbrToday: { color: tokens_1.color.signal },
    dayNum: { fontSize: 13, fontWeight: '800', color: tokens_1.color.ink, lineHeight: 15 },
    dayNumToday: { color: tokens_1.color.signal },
    memberRow: { flexDirection: 'row' },
    cellWrap: { alignItems: 'center', justifyContent: 'center' },
    cell: { width: CELL, height: CELL, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
    cellFree: { backgroundColor: '#22C55E' },
    cellUnknown: { backgroundColor: tokens_1.color.haze },
    cellNoData: { backgroundColor: '#F0EDE8' },
    cellMine: { borderWidth: 1.5, borderColor: tokens_1.color.signal + '80' },
    cellQ: { fontSize: 9, fontWeight: '700', color: tokens_1.color.faint },
    legend: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: tokens_1.space.sm, flexWrap: 'wrap' },
    legendDot: { width: 10, height: 10, borderRadius: 3 },
    legendTxt: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, marginRight: 6 }),
});
var ds = react_native_1.StyleSheet.create({
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
        maxHeight: '78%',
    },
    handle: {
        width: 36, height: 4, borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center', marginBottom: tokens_1.space.md,
    },
    closeBtn: { position: 'absolute', top: tokens_1.space.md + 4, right: tokens_1.space.lg, padding: 4 },
    dateTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.md, paddingRight: 28 }),
    sectionLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, marginBottom: 6, fontSize: 12 }),
    empty: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginBottom: tokens_1.space.sm }),
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingVertical: 5 },
    memberName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, flex: 1, fontWeight: '600' }),
    nowChip: {
        backgroundColor: '#DCFCE7',
        paddingHorizontal: 6, paddingVertical: 2,
        borderRadius: tokens_1.radius.pill,
    },
    nowChipText: { fontSize: 10, fontWeight: '700', color: '#16A34A' },
    planBtn: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm + 2,
        marginTop: tokens_1.space.lg, alignSelf: 'flex-start',
    },
    planBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
