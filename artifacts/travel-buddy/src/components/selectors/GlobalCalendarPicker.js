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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GlobalCalendarPicker = GlobalCalendarPicker;
/**
 * GlobalCalendarPicker — app-wide date / date-range picker.
 *
 * Renders as a bottom-sheet modal with a full month grid.
 * Replaces native DateTimePicker for date fields across the app.
 *
 * Modes:
 *   "single"  — pick one date
 *   "range"   — pick start + end date
 *
 * Props:
 *   visible        — control sheet visibility
 *   mode           — "single" | "range"
 *   value          — ISO string (single) or { start, end } (range)
 *   minDate        — ISO string; earlier dates are disabled
 *   maxDate        — ISO string; later dates are disabled
 *   allowPast      — if false (default for future events), past dates greyed
 *   onConfirm      — called with ISO value on confirm
 *   onCancel       — called on cancel/backdrop press
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../../theme/tokens");
var formatters_1 = require("../../lib/dateTime/formatters");
var DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
/** Build a 6-row × 7-col grid of Date | null for the given year/month */
function buildGrid(year, month) {
    var firstDay = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var cells = [];
    for (var i = 0; i < firstDay; i++)
        cells.push(null);
    for (var d = 1; d <= daysInMonth; d++)
        cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0)
        cells.push(null);
    var rows = [];
    for (var i = 0; i < cells.length; i += 7)
        rows.push(cells.slice(i, i + 7));
    return rows;
}
function GlobalCalendarPicker(props) {
    var visible = props.visible, mode = props.mode, minDate = props.minDate, maxDate = props.maxDate, _a = props.allowPast, allowPast = _a === void 0 ? false : _a, onCancel = props.onCancel, title = props.title;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var today = (0, formatters_1.toMidnight)(new Date());
    var _b = (0, react_1.useState)(today.getFullYear()), viewYear = _b[0], setViewYear = _b[1];
    var _c = (0, react_1.useState)(today.getMonth()), viewMonth = _c[0], setViewMonth = _c[1];
    // Local selection state
    var _d = (0, react_1.useState)(null), singleSel = _d[0], setSingleSel = _d[1];
    var _e = (0, react_1.useState)(null), rangeStart = _e[0], setRangeStart = _e[1];
    var _f = (0, react_1.useState)(null), rangeEnd = _f[0], setRangeEnd = _f[1];
    var _g = (0, react_1.useState)(false), selectingEnd = _g[0], setSelectingEnd = _g[1];
    // Sync from props.value when sheet opens
    (0, react_1.useEffect)(function () {
        if (!visible)
            return;
        if (mode === 'single') {
            var v = props.value;
            var parsed = v ? (0, formatters_1.fromISODate)(v) : null;
            setSingleSel(parsed);
            if (parsed) {
                setViewYear(parsed.getFullYear());
                setViewMonth(parsed.getMonth());
            }
            else {
                setViewYear(today.getFullYear());
                setViewMonth(today.getMonth());
            }
        }
        else {
            var v = props.value;
            var s_1 = (v === null || v === void 0 ? void 0 : v.start) ? (0, formatters_1.fromISODate)(v.start) : null;
            var e = (v === null || v === void 0 ? void 0 : v.end) ? (0, formatters_1.fromISODate)(v.end) : null;
            setRangeStart(s_1);
            setRangeEnd(e);
            setSelectingEnd(false);
            if (s_1) {
                setViewYear(s_1.getFullYear());
                setViewMonth(s_1.getMonth());
            }
            else {
                setViewYear(today.getFullYear());
                setViewMonth(today.getMonth());
            }
        }
    }, [visible]);
    var minD = minDate ? (0, formatters_1.fromISODate)(minDate) : null;
    var maxD = maxDate ? (0, formatters_1.fromISODate)(maxDate) : null;
    function isDisabled(d) {
        if (!allowPast && (0, formatters_1.isBeforeDay)(d, today))
            return true;
        if (minD && (0, formatters_1.isBeforeDay)(d, minD))
            return true;
        if (maxD && (0, formatters_1.isAfterDay)(d, maxD))
            return true;
        return false;
    }
    function prevMonth() {
        if (viewMonth === 0) {
            setViewYear(function (y) { return y - 1; });
            setViewMonth(11);
        }
        else
            setViewMonth(function (m) { return m - 1; });
    }
    function nextMonth() {
        if (viewMonth === 11) {
            setViewYear(function (y) { return y + 1; });
            setViewMonth(0);
        }
        else
            setViewMonth(function (m) { return m + 1; });
    }
    function handleDayPress(d) {
        if (isDisabled(d))
            return;
        if (mode === 'single') {
            setSingleSel(d);
        }
        else {
            if (!selectingEnd || !rangeStart) {
                setRangeStart(d);
                setRangeEnd(null);
                setSelectingEnd(true);
            }
            else {
                if ((0, formatters_1.isBeforeDay)(d, rangeStart)) {
                    setRangeStart(d);
                    setRangeEnd(rangeStart);
                }
                else {
                    setRangeEnd(d);
                }
                setSelectingEnd(false);
            }
        }
    }
    function handleToday() {
        setViewYear(today.getFullYear());
        setViewMonth(today.getMonth());
        if (mode === 'single')
            setSingleSel(today);
        else {
            setRangeStart(today);
            setRangeEnd(null);
            setSelectingEnd(true);
        }
    }
    function handleConfirm() {
        if (mode === 'single') {
            props.onConfirm(singleSel ? (0, formatters_1.toISODate)(singleSel) : null);
        }
        else {
            props.onConfirm({
                start: rangeStart ? (0, formatters_1.toISODate)(rangeStart) : null,
                end: rangeEnd ? (0, formatters_1.toISODate)(rangeEnd) : null,
            });
        }
    }
    function handleClear() {
        if (mode === 'single') {
            setSingleSel(null);
            props.onConfirm(null);
        }
        else {
            setRangeStart(null);
            setRangeEnd(null);
            setSelectingEnd(false);
            props.onConfirm({ start: null, end: null });
        }
    }
    // Calendar grid
    var rows = buildGrid(viewYear, viewMonth);
    function dayStyle(d) {
        if (!d)
            return null;
        var disabled = isDisabled(d);
        var todayDay = (0, formatters_1.isSameDay)(d, today);
        if (mode === 'single') {
            var selected = singleSel && (0, formatters_1.isSameDay)(d, singleSel);
            return { disabled: disabled, today: todayDay, selected: !!selected, inRange: false, rangeStart: false, rangeEnd: false };
        }
        else {
            var isStart = rangeStart && (0, formatters_1.isSameDay)(d, rangeStart);
            var isEnd = rangeEnd && (0, formatters_1.isSameDay)(d, rangeEnd);
            var inRange = !!(rangeStart && rangeEnd && (0, formatters_1.isBetweenDays)(d, rangeStart, rangeEnd));
            return { disabled: disabled, today: todayDay, selected: !!(isStart || isEnd), inRange: inRange, rangeStart: !!isStart, rangeEnd: !!isEnd };
        }
    }
    // Selection summary label
    var summaryLabel = '';
    if (mode === 'single' && singleSel)
        summaryLabel = (0, formatters_1.formatDisplayDate)(singleSel);
    else if (mode === 'range') {
        if (rangeStart && rangeEnd)
            summaryLabel = (0, formatters_1.formatDisplayDateRange)(rangeStart, rangeEnd);
        else if (rangeStart)
            summaryLabel = selectingEnd ? "".concat((0, formatters_1.formatDisplayDate)(rangeStart), " \u2192 pick end") : (0, formatters_1.formatDisplayDate)(rangeStart);
    }
    var canConfirm = mode === 'single' ? !!singleSel : !!rangeStart;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <react_native_1.View style={s.overlay}>
        <react_native_1.Pressable style={s.backdrop} onPress={onCancel}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          {/* Header */}
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>{title !== null && title !== void 0 ? title : (mode === 'range' ? 'Select Dates' : 'Select Date')}</react_native_1.Text>
            <react_native_1.Pressable style={s.closeBtn} onPress={onCancel} hitSlop={12}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Month nav */}
          <react_native_1.View style={s.monthNav}>
            <react_native_1.Pressable onPress={prevMonth} hitSlop={12} style={s.navBtn}>
              <lucide_react_native_1.ChevronLeft size={20} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
            <react_native_1.Text style={s.monthLabel}>{(0, formatters_1.monthName)(viewMonth)} {viewYear}</react_native_1.Text>
            <react_native_1.Pressable onPress={nextMonth} hitSlop={12} style={s.navBtn}>
              <lucide_react_native_1.ChevronRight size={20} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Day-of-week labels */}
          <react_native_1.View style={s.dayLabels}>
            {DAY_LABELS.map(function (l) { return (<react_native_1.Text key={l} style={s.dayLabel}>{l}</react_native_1.Text>); })}
          </react_native_1.View>

          {/* Calendar grid */}
          {rows.map(function (row, ri) { return (<react_native_1.View key={ri} style={s.row}>
              {row.map(function (d, ci) {
                if (!d)
                    return <react_native_1.View key={ci} style={s.cell}/>;
                var ds = dayStyle(d);
                if (!ds)
                    return <react_native_1.View key={ci} style={s.cell}/>;
                return (<react_native_1.Pressable key={ci} style={[
                        s.cell,
                        ds.inRange && s.cellInRange,
                        ds.rangeStart && s.cellRangeEdge,
                        ds.rangeEnd && s.cellRangeEdge,
                    ]} onPress={function () { return handleDayPress(d); }} disabled={ds.disabled}>
                    <react_native_1.View style={[
                        s.dayCircle,
                        ds.selected && s.daySelected,
                        !ds.selected && ds.today && s.dayToday,
                    ]}>
                      <react_native_1.Text style={[
                        s.dayText,
                        ds.disabled && s.dayDisabled,
                        ds.selected && s.daySelectedText,
                        !ds.selected && ds.today && s.dayTodayText,
                    ]}>
                        {d.getDate()}
                      </react_native_1.Text>
                    </react_native_1.View>
                  </react_native_1.Pressable>);
            })}
            </react_native_1.View>); })}

          {/* Summary + quick actions */}
          <react_native_1.View style={s.footer}>
            <react_native_1.Pressable onPress={handleToday} style={s.todayBtn}>
              <react_native_1.Text style={s.todayText}>Today</react_native_1.Text>
            </react_native_1.Pressable>
            {summaryLabel ? (<react_native_1.Text style={s.summary} numberOfLines={1}>{summaryLabel}</react_native_1.Text>) : (<react_native_1.Text style={s.summaryPlaceholder}>
                {mode === 'range' ? 'Pick a start date' : 'No date selected'}
              </react_native_1.Text>)}
            <react_native_1.Pressable onPress={handleClear} hitSlop={8}>
              <react_native_1.Text style={s.clearText}>Clear</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>

          {/* Confirm */}
          <react_native_1.Pressable style={[s.confirmBtn, !canConfirm && s.confirmDisabled]} onPress={handleConfirm} disabled={!canConfirm}>
            <react_native_1.Text style={s.confirmText}>
              {mode === 'range' && selectingEnd && rangeStart && !rangeEnd
            ? 'Skip end date'
            : 'Confirm'}
            </react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var CELL_SIZE = 44;
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.5)' }),
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        paddingHorizontal: tokens_1.space.md,
        paddingTop: tokens_1.space.md,
    },
    header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.sm, paddingBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { padding: 4 },
    monthNav: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.sm, marginBottom: tokens_1.space.sm,
    },
    navBtn: { padding: 4 },
    monthLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 16 }),
    dayLabels: { flexDirection: 'row', marginBottom: 4 },
    dayLabel: {
        width: CELL_SIZE, textAlign: 'center', fontSize: 11,
        fontWeight: '600', color: tokens_1.color.mute, fontFamily: 'Courier',
    },
    row: { flexDirection: 'row' },
    cell: {
        width: CELL_SIZE, height: CELL_SIZE,
        alignItems: 'center', justifyContent: 'center',
    },
    cellInRange: { backgroundColor: "".concat(tokens_1.color.signal, "18") },
    cellRangeEdge: { backgroundColor: "".concat(tokens_1.color.signal, "28") },
    dayCircle: {
        width: 36, height: 36, borderRadius: 18,
        alignItems: 'center', justifyContent: 'center',
    },
    daySelected: { backgroundColor: tokens_1.color.signal },
    dayToday: { borderWidth: 1.5, borderColor: tokens_1.color.signal },
    dayText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontSize: 14 }),
    dayDisabled: { color: tokens_1.color.faint },
    daySelectedText: { color: tokens_1.color.onInk, fontWeight: '700' },
    dayTodayText: { color: tokens_1.color.signal, fontWeight: '600' },
    footer: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.sm, paddingVertical: tokens_1.space.md,
        gap: tokens_1.space.md,
    },
    todayBtn: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
    },
    todayText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
    summary: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.ink, textAlign: 'center' }),
    summaryPlaceholder: __assign(__assign({ flex: 1 }, tokens_1.type.body), { color: tokens_1.color.faint, textAlign: 'center' }),
    clearText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    confirmBtn: {
        backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.pill,
        paddingVertical: 14, alignItems: 'center', marginHorizontal: tokens_1.space.sm, marginTop: tokens_1.space.xs,
    },
    confirmDisabled: { opacity: 0.35 },
    confirmText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
