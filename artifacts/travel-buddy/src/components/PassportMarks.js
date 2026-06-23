"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PassportMonogramWatermark = PassportMonogramWatermark;
exports.PassportInkStamp = PassportInkStamp;
exports.PassportHeroBackdrop = PassportHeroBackdrop;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_svg_1 = require("react-native-svg");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
/**
 * Passport authenticity primitives. All subtle/low-opacity by design — these are
 * security-print details, not decoration. Used ONLY inside the Passport hero.
 *
 * - PassportMonogramWatermark : large faint "TB" behind the photo (4–10%)
 * - PassportInkStamp          : rotated plane + TRAVEL BUDDY entry stamp
 * - PassportHeroBackdrop      : guilloche + faint bg stamps + paper grain
 */
/** Large subtle TB monogram, sits behind the photo. opacity 4–10%. */
function PassportMonogramWatermark(_a) {
    var _b = _a.size, size = _b === void 0 ? 200 : _b;
    return (<react_native_1.View pointerEvents="none" style={[wm.wrap, { width: size, height: size }]}>
      <react_native_svg_1.default width={size} height={size} viewBox="0 0 200 200">
        {/* guilloche rosette rings */}
        {[78, 66, 54, 42].map(function (r) { return (<react_native_svg_1.Circle key={r} cx="100" cy="100" r={r} stroke={tokens_1.color.deep} strokeWidth="0.6" fill="none" opacity={0.07}/>); })}
        {/* TB monogram */}
        <react_native_svg_1.G opacity={0.08}>
          {/* T */}
          <react_native_svg_1.Path d="M58 78 H92 M75 78 V128" stroke={tokens_1.color.deep} strokeWidth="7" strokeLinecap="round" fill="none"/>
          {/* B */}
          <react_native_svg_1.Path d="M108 78 V128 M108 78 H128 Q140 78 140 90 Q140 102 128 102 H108 M108 102 H130 Q143 102 143 115 Q143 128 130 128 H108" stroke={tokens_1.color.deep} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </react_native_svg_1.G>
      </react_native_svg_1.default>
    </react_native_1.View>);
}
/** Rotated entry-stamp: plane + TRAVEL BUDDY, muted ink. Top-right of hero. */
function PassportInkStamp(_a) {
    var _b = _a.rotate, rotate = _b === void 0 ? -8 : _b;
    return (<react_native_1.View pointerEvents="none" style={[ink.wrap, { transform: [{ rotate: "".concat(rotate, "deg") }] }]}>
      <react_native_1.View style={ink.ring}>
        <lucide_react_native_1.Plane size={14} color={tokens_1.color.deep}/>
        <react_native_1.Text style={ink.top}>TRAVEL BUDDY</react_native_1.Text>
        <react_native_1.View style={ink.divider}/>
        <react_native_1.Text style={ink.bottom}>★ VERIFIED ★</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
/** Hero backdrop: guilloche security lines + 1-2 faint bg stamps + paper grain. */
function PassportHeroBackdrop() {
    return (<react_native_svg_1.default style={react_native_1.StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 360 420">
      <react_native_svg_1.Defs>
        <react_native_svg_1.Pattern id="hg" width="22" height="22" patternUnits="userSpaceOnUse">
          <react_native_svg_1.Path d="M0,11 Q5.5,2 11,11 T22,11" stroke={tokens_1.color.deep} strokeWidth="0.4" fill="none" opacity="0.06"/>
          <react_native_svg_1.Path d="M0,11 Q5.5,20 11,11 T22,11" stroke={tokens_1.color.deep} strokeWidth="0.4" fill="none" opacity="0.06"/>
        </react_native_svg_1.Pattern>
        <react_native_svg_1.Pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse">
          <react_native_svg_1.Circle cx="0.5" cy="0.5" r="0.3" fill={tokens_1.color.ink} opacity="0.025"/>
        </react_native_svg_1.Pattern>
      </react_native_svg_1.Defs>
      <react_native_svg_1.Rect x="0" y="0" width="360" height="420" fill="url(#hg)"/>
      <react_native_svg_1.Rect x="0" y="0" width="360" height="420" fill="url(#grain)"/>
      {/* faint background TRAVEL BUDDY stamp marks (3-7%) */}
      <react_native_svg_1.G opacity="0.05">
        <react_native_svg_1.Circle cx="300" cy="300" r="42" stroke={tokens_1.color.deep} strokeWidth="1.5" fill="none"/>
        <react_native_svg_1.Circle cx="300" cy="300" r="33" stroke={tokens_1.color.deep} strokeWidth="0.6" fill="none"/>
      </react_native_svg_1.G>
      <react_native_svg_1.G opacity="0.04">
        <react_native_svg_1.Circle cx="50" cy="360" r="30" stroke={tokens_1.color.signal} strokeWidth="1.5" fill="none"/>
      </react_native_svg_1.G>
    </react_native_svg_1.default>);
}
var wm = react_native_1.StyleSheet.create({
    wrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});
var ink = react_native_1.StyleSheet.create({
    wrap: { alignItems: 'center', justifyContent: 'center' },
    ring: {
        width: 78, height: 78, borderRadius: 39, borderWidth: 1.5, borderColor: tokens_1.color.deep,
        alignItems: 'center', justifyContent: 'center', gap: 2, opacity: 0.45,
        borderStyle: 'solid',
    },
    top: { fontFamily: 'Courier', fontSize: 7, fontWeight: '700', color: tokens_1.color.deep, letterSpacing: 0.5, textAlign: 'center' },
    divider: { width: 44, height: 0.6, backgroundColor: tokens_1.color.deep, opacity: 0.5 },
    bottom: { fontFamily: 'Courier', fontSize: 6.5, fontWeight: '700', color: tokens_1.color.deep, letterSpacing: 1 },
});
