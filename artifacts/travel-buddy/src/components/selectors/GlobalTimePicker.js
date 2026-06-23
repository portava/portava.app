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
exports.GlobalTimePicker = GlobalTimePicker;
/**
 * GlobalTimePicker — app-wide time picker with quick presets.
 *
 * Shows a bottom sheet with preset options (Now, Morning, Afternoon, Evening…)
 * and a "Custom" option that opens the native time picker.
 *
 * Props:
 *   visible    — sheet visibility
 *   value      — currently selected time as "HH:mm" (24h, local)
 *   onChange   — called with "HH:mm" string (or null to clear)
 *   onClose    — dismiss sheet
 *   title      — optional sheet title
 *   presets    — override preset list
 *   allowClear — show a "No time" option (default false)
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var datetimepicker_1 = require("@react-native-community/datetimepicker");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../../theme/tokens");
var formatters_1 = require("../../lib/dateTime/formatters");
var DEFAULT_PRESETS = [
    { label: 'Morning', value: '08:00', sub: '8:00 AM' },
    { label: 'Noon', value: '12:00', sub: '12:00 PM' },
    { label: 'Afternoon', value: '14:00', sub: '2:00 PM' },
    { label: 'Evening', value: '18:00', sub: '6:00 PM' },
    { label: 'Tonight', value: '21:00', sub: '9:00 PM' },
    { label: 'Late Night', value: '23:00', sub: '11:00 PM' },
];
function GlobalTimePicker(_a) {
    var visible = _a.visible, value = _a.value, onChange = _a.onChange, onClose = _a.onClose, title = _a.title, presets = _a.presets, _b = _a.allowClear, allowClear = _b === void 0 ? false : _b;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var list = presets !== null && presets !== void 0 ? presets : DEFAULT_PRESETS;
    var _c = (0, react_1.useState)(false), showNative = _c[0], setShowNative = _c[1];
    var _d = (0, react_1.useState)(new Date()), nativeDate = _d[0], setNativeDate = _d[1];
    var _e = (0, react_1.useState)(value !== null && value !== void 0 ? value : null), pendingValue = _e[0], setPendingValue = _e[1];
    (0, react_1.useEffect)(function () {
        if (visible) {
            setPendingValue(value !== null && value !== void 0 ? value : null);
            setShowNative(false);
            var d = value ? (0, formatters_1.fromHHmm)(value) : new Date();
            setNativeDate(d !== null && d !== void 0 ? d : new Date());
        }
    }, [visible]);
    function pickPreset(preset) {
        setPendingValue(preset.value);
        onChange(preset.value);
        onClose();
    }
    function pickNow() {
        var now = new Date();
        var hhmm = (0, formatters_1.toHHmm)(now);
        setPendingValue(hhmm);
        onChange(hhmm);
        onClose();
    }
    function openCustom() {
        var d = pendingValue ? (0, formatters_1.fromHHmm)(pendingValue) : new Date();
        setNativeDate(d !== null && d !== void 0 ? d : new Date());
        setShowNative(true);
    }
    function handleNativeChange(event, selectedDate) {
        if (react_native_1.Platform.OS === 'android') {
            setShowNative(false);
            if (event.type === 'set' && selectedDate) {
                var hhmm = (0, formatters_1.toHHmm)(selectedDate);
                setPendingValue(hhmm);
                onChange(hhmm);
                onClose();
            }
        }
        else {
            if (selectedDate) {
                setNativeDate(selectedDate);
                var hhmm = (0, formatters_1.toHHmm)(selectedDate);
                setPendingValue(hhmm);
            }
        }
    }
    function confirmCustom() {
        var hhmm = (0, formatters_1.toHHmm)(nativeDate);
        onChange(hhmm);
        setShowNative(false);
        onClose();
    }
    var selectedLabel = pendingValue
        ? (function () { var d = (0, formatters_1.fromHHmm)(pendingValue); return d ? (0, formatters_1.formatDisplayTime)(d) : pendingValue; })()
        : null;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <react_native_1.View style={s.overlay}>
        <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>{title !== null && title !== void 0 ? title : 'Select Time'}</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {selectedLabel && (<react_native_1.View style={s.currentRow}>
              <lucide_react_native_1.Clock size={14} color={tokens_1.color.signal}/>
              <react_native_1.Text style={s.currentText}>{selectedLabel}</react_native_1.Text>
            </react_native_1.View>)}

          <react_native_1.ScrollView style={s.scroll} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {/* Now */}
            <react_native_1.Pressable style={s.row} onPress={pickNow}>
              <react_native_1.Text style={s.rowLabel}>Now</react_native_1.Text>
              <react_native_1.Text style={s.rowSub}>{(0, formatters_1.formatDisplayTime)(new Date())}</react_native_1.Text>
            </react_native_1.Pressable>

            {/* Presets */}
            {list.map(function (p) { return (<react_native_1.Pressable key={p.value} style={[s.row, pendingValue === p.value && s.rowSelected]} onPress={function () { return pickPreset(p); }}>
                <react_native_1.Text style={[s.rowLabel, pendingValue === p.value && s.rowLabelSelected]}>
                  {p.label}
                </react_native_1.Text>
                {p.sub && (<react_native_1.Text style={[s.rowSub, pendingValue === p.value && s.rowSubSelected]}>
                    {p.sub}
                  </react_native_1.Text>)}
              </react_native_1.Pressable>); })}

            {/* Custom */}
            <react_native_1.Pressable style={s.row} onPress={openCustom}>
              <react_native_1.Text style={s.rowLabel}>Custom…</react_native_1.Text>
              <react_native_1.Text style={s.rowSub}>Choose any time</react_native_1.Text>
            </react_native_1.Pressable>

            {/* Clear */}
            {allowClear && (<react_native_1.Pressable style={s.row} onPress={function () { onChange(null); onClose(); }}>
                <react_native_1.Text style={[s.rowLabel, { color: tokens_1.color.mute }]}>No time</react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.ScrollView>

          {/* Native time picker for custom */}
          {showNative && (<>
              <datetimepicker_1.default mode="time" value={nativeDate} display={react_native_1.Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={handleNativeChange}/>
              {react_native_1.Platform.OS === 'ios' && (<react_native_1.Pressable style={s.doneBtn} onPress={confirmCustom}>
                  <react_native_1.Text style={s.doneBtnText}>Done</react_native_1.Text>
                </react_native_1.Pressable>)}
            </>)}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var s = react_native_1.StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.5)' }),
    sheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: tokens_1.radius.lg,
        borderTopRightRadius: tokens_1.radius.lg,
        paddingTop: tokens_1.space.md,
        maxHeight: '75%',
    },
    header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { padding: 4 },
    currentRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.md,
    },
    currentText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
    scroll: { flex: 1 },
    list: { paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.lg },
    row: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: 14,
        borderBottomWidth: react_native_1.StyleSheet.hairlineWidth, borderBottomColor: tokens_1.color.haze,
    },
    rowSelected: { backgroundColor: "".concat(tokens_1.color.signal, "10") },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    rowLabelSelected: { color: tokens_1.color.signal },
    rowSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    rowSubSelected: { color: tokens_1.color.signal },
    doneBtn: {
        alignItems: 'flex-end', paddingHorizontal: tokens_1.space.xl, paddingVertical: tokens_1.space.md,
    },
    doneBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontWeight: '700' }),
});
