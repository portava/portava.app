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
exports.Stamp = Stamp;
exports.Chip = Chip;
exports.Avatar = Avatar;
exports.Scrim = Scrim;
exports.needsContrastFallback = needsContrastFallback;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_linear_gradient_1 = require("expo-linear-gradient");
var tokens_1 = require("../theme/tokens");
/** Passport-stamp tag: monospace, uppercased, slightly rotated. The signature device. */
function Stamp(_a) {
    var label = _a.label, _b = _a.tone, tone = _b === void 0 ? 'ink' : _b, _c = _a.rotate, rotate = _c === void 0 ? -3 : _c, style = _a.style;
    var border = tone === 'signal' ? tokens_1.color.signal : tone === 'deep' ? tokens_1.color.deep : tone === 'onInk' ? tokens_1.color.onInk : tokens_1.color.ink;
    var ink = border;
    return (<react_native_1.View style={[
            styles.stamp,
            { borderColor: border, transform: [{ rotate: "".concat(rotate, "deg") }] },
            style,
        ]}>
      <react_native_1.Text style={[styles.stampText, { color: ink }]} numberOfLines={1}>
        {label.toUpperCase()}
      </react_native_1.Text>
    </react_native_1.View>);
}
/** Soft pill chip for filters / categories (non-stamp, quieter). */
function Chip(_a) {
    var label = _a.label, active = _a.active, onPress = _a.onPress;
    return (<react_native_1.Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} accessibilityRole="button">
      <react_native_1.Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
function Avatar(_a) {
    var uri = _a.uri, _b = _a.size, size = _b === void 0 ? 36 : _b;
    return (<react_native_1.Image source={{ uri: uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tokens_1.color.haze }}/>);
}
/** Bottom-up gradient scrim — readability rule for any text-over-image. */
function Scrim(_a) {
    var style = _a.style;
    return (<expo_linear_gradient_1.LinearGradient colors={[tokens_1.color.scrimTop, tokens_1.color.scrimBottom]} locations={[0.35, 1]} style={[react_native_1.StyleSheet.absoluteFill, style]} pointerEvents="none"/>);
}
/** brightness > 0.62 means overlay text won't hold contrast -> use caption-below fallback. */
function needsContrastFallback(brightness) {
    return (brightness !== null && brightness !== void 0 ? brightness : 0) > 0.62;
}
var styles = react_native_1.StyleSheet.create({
    stamp: {
        borderWidth: 1.5,
        borderRadius: tokens_1.radius.sm,
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 3,
        alignSelf: 'flex-start',
        backgroundColor: 'transparent',
    },
    stampText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier' }),
    chip: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
    },
    chipActive: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600', color: tokens_1.color.ink }),
    chipTextActive: { color: tokens_1.color.onInk },
});
