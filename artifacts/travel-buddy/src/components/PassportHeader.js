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
exports.InfoBar = InfoBar;
exports.PassportBackdrop = PassportBackdrop;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_svg_1 = require("react-native-svg");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
/**
 * Clickable info bar — icon-circle items, each routes somewhere (never dead).
 */
function InfoBar(_a) {
    var stats = _a.stats, onStamps = _a.onStamps, onCircle = _a.onCircle, onPlans = _a.onPlans, onCities = _a.onCities;
    var items = [
        { n: stats.stamps, label: 'Stamps', Icon: lucide_react_native_1.Stamp, tint: tokens_1.color.signal, bg: '#FCE9E4', onPress: onStamps },
        { n: stats.buddies, label: 'Circle', Icon: lucide_react_native_1.Users, tint: tokens_1.color.success, bg: '#E3F1EA', onPress: onCircle },
        { n: stats.plansJoined, label: 'Plans', Icon: lucide_react_native_1.CalendarDays, tint: tokens_1.color.deep, bg: '#E2EDF0', onPress: onPlans },
        { n: stats.citiesVisited, label: 'Cities', Icon: lucide_react_native_1.MapPin, tint: '#C8851A', bg: '#FBF0DD', onPress: onCities },
    ];
    return (<react_native_1.View style={styles.bar}>
      {items.map(function (it, i) { return (<react_1.default.Fragment key={it.label}>
          {i > 0 && <react_native_1.View style={styles.divider}/>}
          <react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [styles.cell, pressed && styles.cellPressed];
        }} onPress={it.onPress} accessibilityRole="button" accessibilityLabel={"".concat(it.n, " ").concat(it.label)}>
            <react_native_1.View style={[styles.iconCircle, { backgroundColor: it.bg }]}>
              <it.Icon size={18} color={it.tint}/>
            </react_native_1.View>
            <react_native_1.View style={styles.cellText}>
              <react_native_1.Text style={styles.n}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</react_native_1.Text>
              <react_native_1.Text style={styles.l}>{it.label}</react_native_1.Text>
            </react_native_1.View>
            <lucide_react_native_1.ChevronRight size={14} color={tokens_1.color.faint}/>
          </react_native_1.Pressable>
        </react_1.default.Fragment>); })}
    </react_native_1.View>);
}
/**
 * Passport-document backdrop — guilloche security lines + faint stamp marks.
 * Used ONLY behind the Passport header. Tasteful, low-opacity, readable.
 */
function PassportBackdrop(_a) {
    var _b = _a.height, height = _b === void 0 ? 150 : _b;
    return (<react_native_1.View style={[styles.backdrop, { height: height }]} pointerEvents="none">
      <react_native_svg_1.default width="100%" height="100%" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice">
        <react_native_svg_1.Defs>
          <react_native_svg_1.Pattern id="guilloche" width="40" height="40" patternUnits="userSpaceOnUse">
            <react_native_svg_1.Path d="M0,20 Q10,0 20,20 T40,20" stroke={tokens_1.color.onInk} strokeWidth="0.5" fill="none" opacity="0.25"/>
            <react_native_svg_1.Path d="M0,20 Q10,40 20,20 T40,20" stroke={tokens_1.color.onInk} strokeWidth="0.5" fill="none" opacity="0.25"/>
          </react_native_svg_1.Pattern>
        </react_native_svg_1.Defs>
        <react_native_svg_1.Rect x="0" y="0" width="400" height="150" fill={tokens_1.color.deep}/>
        <react_native_svg_1.Rect x="0" y="0" width="400" height="150" fill="url(#guilloche)"/>
        {/* horizontal security lines */}
        {[30, 60, 90, 120].map(function (y) { return (<react_native_svg_1.Line key={y} x1="0" y1={y} x2="400" y2={y} stroke={tokens_1.color.onInk} strokeWidth="0.4" opacity="0.12"/>); })}
        {/* faint stamp marks */}
        <react_native_svg_1.Circle cx="330" cy="40" r="26" stroke={tokens_1.color.onInk} strokeWidth="1.2" fill="none" opacity="0.14"/>
        <react_native_svg_1.Circle cx="330" cy="40" r="20" stroke={tokens_1.color.onInk} strokeWidth="0.6" fill="none" opacity="0.14"/>
        <react_native_svg_1.Circle cx="60" cy="110" r="20" stroke={tokens_1.color.signal} strokeWidth="1.2" fill="none" opacity="0.18"/>
      </react_native_svg_1.default>
      {/* MRZ-style strip at the bottom edge for passport feel */}
      <react_native_1.View style={styles.mrz}>
        <react_native_1.Text style={styles.mrzText} numberOfLines={1}>
          {'P<TRAVELBUDDY<<PASSPORT<<IDENTITY<<<<<<<<<<<<'}
        </react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    bar: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingVertical: tokens_1.space.md, marginHorizontal: tokens_1.space.lg,
    },
    cell: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4, borderRadius: tokens_1.radius.sm },
    cellPressed: { backgroundColor: tokens_1.color.haze },
    iconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    cellText: {},
    divider: { width: 1, height: 30, backgroundColor: tokens_1.color.haze },
    n: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 18 }),
    l: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden', backgroundColor: tokens_1.color.deep },
    mrz: { position: 'absolute', bottom: 4, left: 0, right: 0, paddingHorizontal: tokens_1.space.md },
    mrzText: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.onInk, opacity: 0.3, letterSpacing: 1 },
});
