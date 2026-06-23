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
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var datetimepicker_1 = require("@react-native-community/datetimepicker");
var tokens_1 = require("../theme/tokens");
function toDate(dateStr) {
    if (!dateStr)
        return new Date();
    var d = new Date(dateStr + 'T00:00:00');
    return isNaN(d.getTime()) ? new Date() : d;
}
function fmtDate(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime()))
        return dateStr;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function toYMD(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return "".concat(y, "-").concat(m, "-").concat(d);
}
function DatePickerField(_a) {
    var value = _a.value, onChange = _a.onChange, _b = _a.placeholder, placeholder = _b === void 0 ? 'Select date' : _b, style = _a.style;
    var _c = (0, react_1.useState)(false), showPicker = _c[0], setShowPicker = _c[1];
    var _d = (0, react_1.useState)(toDate(value)), tempDate = _d[0], setTempDate = _d[1];
    var handleOpen = function () {
        setTempDate(toDate(value));
        setShowPicker(true);
    };
    var handleAndroidChange = function (event, selectedDate) {
        setShowPicker(false);
        if (event.type === 'dismissed' || !selectedDate)
            return;
        onChange(toYMD(selectedDate));
    };
    var handleIOSChange = function (_event, selectedDate) {
        if (selectedDate)
            setTempDate(selectedDate);
    };
    var handleIOSConfirm = function () {
        setShowPicker(false);
        onChange(toYMD(tempDate));
    };
    var handleIOSCancel = function () {
        setShowPicker(false);
    };
    return (<>
      <react_native_1.View style={[dp.field, style]}>
        <react_native_1.Pressable style={dp.inner} onPress={handleOpen} accessibilityRole="button" accessibilityLabel={value ? fmtDate(value) : placeholder}>
          <lucide_react_native_1.Calendar size={15} color={value ? tokens_1.color.ink : tokens_1.color.faint}/>
          <react_native_1.Text style={[dp.fieldText, !value && dp.placeholder]} numberOfLines={1}>
            {value ? fmtDate(value) : placeholder}
          </react_native_1.Text>
        </react_native_1.Pressable>
        {value ? (<react_native_1.Pressable hitSlop={8} onPress={function () { return onChange(''); }} accessibilityLabel="Clear date">
            <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>) : null}
      </react_native_1.View>

      {showPicker && react_native_1.Platform.OS === 'android' && (<datetimepicker_1.default value={toDate(value)} mode="date" display="default" onChange={handleAndroidChange}/>)}

      {showPicker && react_native_1.Platform.OS === 'ios' && (<react_native_1.Modal transparent animationType="slide" onRequestClose={handleIOSCancel}>
          <react_native_1.Pressable style={dp.overlay} onPress={handleIOSCancel}/>
          <react_native_1.View style={dp.iosSheet}>
            <react_native_1.View style={dp.iosBar}>
              <react_native_1.Pressable onPress={handleIOSCancel} hitSlop={8}>
                <react_native_1.Text style={dp.cancelText}>Cancel</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Pressable onPress={handleIOSConfirm} hitSlop={8}>
                <react_native_1.Text style={dp.doneText}>Done</react_native_1.Text>
              </react_native_1.Pressable>
            </react_native_1.View>
            <datetimepicker_1.default value={tempDate} mode="date" display="spinner" onChange={handleIOSChange} style={{ height: 200 }}/>
          </react_native_1.View>
        </react_native_1.Modal>)}
    </>);
}
var dp = react_native_1.StyleSheet.create({
    field: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised,
    },
    inner: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    fieldText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
    placeholder: { color: tokens_1.color.faint },
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    iosSheet: {
        backgroundColor: tokens_1.color.paper,
        borderTopLeftRadius: 20, borderTopRightRadius: 20,
        paddingBottom: 34,
    },
    iosBar: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
    },
    cancelText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    doneText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
});
