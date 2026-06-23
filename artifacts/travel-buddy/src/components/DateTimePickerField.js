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
exports.DatePickerField = DatePickerField;
/**
 * DateTimePickerField — a pressable date/time-picker input for Expo / React Native.
 *
 * Renders a tappable button showing the selected date or time.
 * On press it surfaces the native @react-native-community/datetimepicker:
 *   iOS     → inline spinner below the button + "Done" to dismiss
 *   Android → system dialog (auto-dismisses on selection or cancel)
 *
 * Props:
 *   value       — selected Date (null = nothing selected yet)
 *   onChange    — called with the newly selected Date
 *   onClear     — optional; when provided a × button appears to clear the value
 *   minimumDate — earliest selectable date (optional, date mode only)
 *   placeholder — string shown when value is null
 *   mode        — 'date' (default) | 'time'
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var datetimepicker_1 = require("@react-native-community/datetimepicker");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function formatDate(d) {
    return d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}
function formatTime(d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function DatePickerField(_a) {
    var value = _a.value, onChange = _a.onChange, onClear = _a.onClear, minimumDate = _a.minimumDate, _b = _a.placeholder, placeholder = _b === void 0 ? 'Pick a date' : _b, _c = _a.mode, mode = _c === void 0 ? 'date' : _c;
    var _d = (0, react_1.useState)(false), show = _d[0], setShow = _d[1];
    function handleChange(event, selectedDate) {
        if (react_native_1.Platform.OS === 'android') {
            setShow(false);
            if (event.type === 'set' && selectedDate)
                onChange(selectedDate);
        }
        else {
            if (selectedDate)
                onChange(selectedDate);
        }
    }
    return (<react_native_1.View>
      {/* Field row: picker button + optional clear */}
      <react_native_1.View style={s.row}>
        <react_native_1.Pressable style={[s.field, show && s.fieldOpen]} onPress={function () { return setShow(function (v) { return !v; }); }} accessibilityRole="button" accessibilityLabel={value
            ? (mode === 'time' ? "Time: ".concat(formatTime(value)) : "Date: ".concat(formatDate(value)))
            : placeholder}>
          <lucide_react_native_1.CalendarClock size={14} color={value ? tokens_1.color.signal : tokens_1.color.faint}/>
          <react_native_1.Text style={[s.fieldText, !value && s.placeholder]}>
            {value ? (mode === 'time' ? formatTime(value) : formatDate(value)) : placeholder}
          </react_native_1.Text>
        </react_native_1.Pressable>

        {value && onClear ? (<react_native_1.Pressable hitSlop={8} onPress={function () { setShow(false); onClear(); }} accessibilityRole="button" accessibilityLabel="Clear" style={s.clearBtn}>
            <lucide_react_native_1.X size={15} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>) : null}
      </react_native_1.View>

      {/* Native picker (expands below field on iOS, dialog on Android) */}
      {show && (<>
          <datetimepicker_1.default mode={mode} value={value !== null && value !== void 0 ? value : (mode === 'time' ? new Date() : (minimumDate !== null && minimumDate !== void 0 ? minimumDate : new Date()))} minimumDate={mode === 'date' ? minimumDate : undefined} display={react_native_1.Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={handleChange}/>
          {react_native_1.Platform.OS === 'ios' && (<react_native_1.Pressable style={s.doneBtn} onPress={function () { return setShow(false); }}>
              <react_native_1.Text style={s.doneBtnText}>Done</react_native_1.Text>
            </react_native_1.Pressable>)}
        </>)}
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
    },
    field: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paper,
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm + 2,
    },
    fieldOpen: {
        borderColor: tokens_1.color.signal,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    fieldText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    placeholder: {
        color: tokens_1.color.faint,
    },
    clearBtn: {
        padding: 4,
    },
    doneBtn: {
        alignItems: 'flex-end',
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderWidth: 1,
        borderTopWidth: 0,
        borderColor: tokens_1.color.signal,
        borderBottomLeftRadius: tokens_1.radius.md,
        borderBottomRightRadius: tokens_1.radius.md,
        backgroundColor: tokens_1.color.paper,
    },
    doneBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal, fontWeight: '700' }),
});
