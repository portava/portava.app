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
exports.LocationPrivacySelector = LocationPrivacySelector;
/**
 * LocationPrivacySelector — inline chip row for choosing location visibility.
 *
 * Options: Hidden / City only / Neighborhood / Exact place
 * Default: City only
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var OPTIONS = [
    { value: 'hidden', label: 'Hidden', sub: 'No location', Icon: lucide_react_native_1.EyeOff },
    { value: 'city', label: 'City', sub: 'City only', Icon: lucide_react_native_1.MapPin },
    { value: 'neighborhood', label: 'Area', sub: 'Neighborhood', Icon: lucide_react_native_1.MapPin },
    { value: 'exact', label: 'Exact', sub: 'Full place', Icon: lucide_react_native_1.Navigation },
];
function LocationPrivacySelector(_a) {
    var value = _a.value, onChange = _a.onChange, label = _a.label;
    return (<react_native_1.View>
      {label && <react_native_1.Text style={s.label}>{label}</react_native_1.Text>}
      <react_native_1.View style={s.row}>
        {OPTIONS.map(function (opt) {
            var selected = opt.value === value;
            return (<react_native_1.Pressable key={opt.value} style={[s.chip, selected && s.chipSelected]} onPress={function () { return onChange(opt.value); }}>
              <opt.Icon size={12} color={selected ? tokens_1.color.signal : tokens_1.color.mute}/>
              <react_native_1.Text style={[s.chipText, selected && s.chipTextSelected]}>{opt.label}</react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.View>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginBottom: tokens_1.space.sm, fontSize: 11 }),
    row: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    chipSelected: { borderColor: tokens_1.color.signal, backgroundColor: "".concat(tokens_1.color.signal, "15") },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    chipTextSelected: { color: tokens_1.color.signal },
});
