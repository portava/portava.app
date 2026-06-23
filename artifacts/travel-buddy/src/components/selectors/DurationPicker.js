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
exports.DEFAULT_DURATION_OPTIONS = exports.HIGHLIGHT_EXPIRY_OPTIONS = void 0;
exports.DurationPicker = DurationPicker;
/**
 * DurationPicker — bottom-sheet duration/timer selector.
 *
 * Used for: highlight expiration, countdown timers, activity length,
 * session windows, and any "how long" field.
 *
 * value / onChange work in SECONDS.
 *
 * Props:
 *   visible     — sheet visibility
 *   value       — selected duration in seconds (null = none)
 *   onChange    — called with seconds (or null)
 *   onClose     — dismiss
 *   title       — sheet title
 *   options     — override the default chip list
 *   allowClear  — show "No duration" option
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../../theme/tokens");
var formatters_1 = require("../../lib/dateTime/formatters");
var HOURS = 3600;
exports.HIGHLIGHT_EXPIRY_OPTIONS = [
    { label: '3 h', seconds: 3 * HOURS, sub: 'Short story' },
    { label: '6 h', seconds: 6 * HOURS, sub: 'Half day' },
    { label: '12 h', seconds: 12 * HOURS },
    { label: '24 h', seconds: 24 * HOURS, sub: 'Default' },
    { label: '48 h', seconds: 48 * HOURS },
];
exports.DEFAULT_DURATION_OPTIONS = [
    { label: '15 min', seconds: 15 * 60 },
    { label: '30 min', seconds: 30 * 60 },
    { label: '1 h', seconds: HOURS },
    { label: '2 h', seconds: 2 * HOURS },
    { label: '3 h', seconds: 3 * HOURS },
    { label: '6 h', seconds: 6 * HOURS },
    { label: '12 h', seconds: 12 * HOURS },
    { label: '24 h', seconds: 24 * HOURS },
    { label: '48 h', seconds: 48 * HOURS },
];
function DurationPicker(_a) {
    var visible = _a.visible, value = _a.value, onChange = _a.onChange, onClose = _a.onClose, title = _a.title, options = _a.options, _b = _a.allowClear, allowClear = _b === void 0 ? false : _b, _c = _a.showChips, showChips = _c === void 0 ? false : _c;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var list = options !== null && options !== void 0 ? options : exports.DEFAULT_DURATION_OPTIONS;
    var _d = (0, react_1.useState)(value !== null && value !== void 0 ? value : null), selected = _d[0], setSelected = _d[1];
    (0, react_1.useEffect)(function () {
        if (visible)
            setSelected(value !== null && value !== void 0 ? value : null);
    }, [visible]);
    function pick(s) {
        setSelected(s);
        onChange(s);
        onClose();
    }
    if (showChips) {
        return (<react_native_1.View style={chips.container}>
        {list.map(function (o) { return (<react_native_1.Pressable key={o.seconds} style={[chips.chip, selected === o.seconds && chips.chipSelected]} onPress={function () { return pick(o.seconds); }}>
            <react_native_1.Text style={[chips.chipText, selected === o.seconds && chips.chipTextSelected]}>
              {o.label}
            </react_native_1.Text>
            {o.sub && (<react_native_1.Text style={[chips.chipSub, selected === o.seconds && chips.chipSubSelected]}>
                {o.sub}
              </react_native_1.Text>)}
          </react_native_1.Pressable>); })}
        {allowClear && selected !== null && (<react_native_1.Pressable style={chips.chip} onPress={function () { setSelected(null); onChange(null); onClose(); }}>
            <react_native_1.Text style={chips.chipText}>Clear</react_native_1.Text>
          </react_native_1.Pressable>)}
      </react_native_1.View>);
    }
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <react_native_1.View style={s.overlay}>
        <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
        <react_native_1.View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <react_native_1.View style={s.header}>
            <react_native_1.Text style={s.title}>{title !== null && title !== void 0 ? title : 'Select Duration'}</react_native_1.Text>
            <react_native_1.Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
              <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
            </react_native_1.Pressable>
          </react_native_1.View>

          {selected !== null && (<react_native_1.Text style={s.current}>{(0, formatters_1.formatDuration)(selected)} selected</react_native_1.Text>)}

          <react_native_1.ScrollView style={s.scroll} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {list.map(function (o) { return (<react_native_1.Pressable key={o.seconds} style={[s.row, selected === o.seconds && s.rowSelected]} onPress={function () { return pick(o.seconds); }}>
                <react_native_1.Text style={[s.rowLabel, selected === o.seconds && s.rowLabelSelected]}>
                  {o.label}
                </react_native_1.Text>
                {o.sub && (<react_native_1.Text style={[s.rowSub, selected === o.seconds && s.rowSubSelected]}>
                    {o.sub}
                  </react_native_1.Text>)}
              </react_native_1.Pressable>); })}

            {allowClear && (<react_native_1.Pressable style={s.row} onPress={function () { onChange(null); onClose(); }}>
                <react_native_1.Text style={[s.rowLabel, { color: tokens_1.color.mute }]}>No duration</react_native_1.Text>
              </react_native_1.Pressable>)}
          </react_native_1.ScrollView>
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
        maxHeight: '70%',
    },
    header: {
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.md,
    },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1 }),
    closeBtn: { padding: 4 },
    current: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600', paddingHorizontal: tokens_1.space.xl, paddingBottom: tokens_1.space.sm }),
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
});
var chips = react_native_1.StyleSheet.create({
    container: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised, alignItems: 'center',
    },
    chipSelected: { borderColor: tokens_1.color.signal, backgroundColor: "".concat(tokens_1.color.signal, "18") },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
    chipTextSelected: { color: tokens_1.color.signal },
    chipSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10 }),
    chipSubSelected: { color: tokens_1.color.signal },
});
