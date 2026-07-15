"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CITY_ART = void 0;
exports.IllustratedStamp = IllustratedStamp;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_svg_1 = require("react-native-svg");
var tokens_1 = require("../theme/tokens");
exports.CITY_ART = {
    cebu: { city: 'CEBU', country: 'PHILIPPINES', tint: '#0A3D4A' },
    manila: { city: 'MANILA', country: 'PHILIPPINES', tint: '#C0392B' },
    bangkok: { city: 'BANGKOK', country: 'THAILAND', tint: '#5B3A9E' },
    bali: { city: 'BALI', country: 'INDONESIA', tint: '#2E7D5B' },
    tokyo: { city: 'TOKYO', country: 'JAPAN', tint: '#C0392B' },
};
function Landmark(_a) {
    var slug = _a.slug, tint = _a.tint;
    var s = { stroke: tint, strokeWidth: 1.8, fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round' };
    switch (slug) {
        case 'cebu':
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Line x1="18" y1="40" x2="82" y2="40"/>
          <react_native_svg_1.Path d="M32 40 L32 8 M68 40 L68 8"/>
          <react_native_svg_1.Path d="M32 8 L16 40 M32 8 L48 40 M68 8 L52 40 M68 8 L84 40"/>
          <react_native_svg_1.Path d="M14 46 q9 -5 18 0 t18 0 t18 0 t18 0"/>
        </react_native_svg_1.G>);
        case 'manila':
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Rect x="16" y="20" width="14" height="24"/>
          <react_native_svg_1.Rect x="34" y="12" width="10" height="32"/>
          <react_native_svg_1.Path d="M39 12 L39 4 M36 7 L42 7"/>
          <react_native_svg_1.Rect x="50" y="24" width="16" height="20"/>
          <react_native_svg_1.Path d="M50 24 L58 14 L66 24"/>
          <react_native_svg_1.Rect x="70" y="28" width="12" height="16"/>
        </react_native_svg_1.G>);
        case 'bangkok':
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Path d="M50 4 L50 0"/>
          <react_native_svg_1.Path d="M44 14 L50 4 L56 14 Z"/>
          <react_native_svg_1.Path d="M40 26 L50 12 L60 26 Z"/>
          <react_native_svg_1.Path d="M32 42 L50 22 L68 42 Z"/>
          <react_native_svg_1.Rect x="40" y="42" width="20" height="6"/>
        </react_native_svg_1.G>);
        case 'bali':
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Path d="M44 16 L56 16 L52 10 L48 10 Z"/>
          <react_native_svg_1.Path d="M42 26 L58 26 L55 18 L45 18 Z"/>
          <react_native_svg_1.Path d="M40 36 L60 36 L57 28 L43 28 Z"/>
          <react_native_svg_1.Rect x="47" y="36" width="6" height="10"/>
          <react_native_svg_1.Path d="M22 46 q3 -22 8 -26 M30 22 q-9 -3 -13 2 M30 22 q9 -3 13 2"/>
        </react_native_svg_1.G>);
        case 'tokyo':
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Path d="M26 16 L52 16 M28 11 L50 11"/>
          <react_native_svg_1.Path d="M31 11 L31 44 M47 11 L47 44"/>
          <react_native_svg_1.Path d="M68 44 L68 18 L64 44 M68 18 L72 44 M68 18 L68 12"/>
          <react_native_svg_1.Line x1="64" y1="32" x2="72" y2="32"/>
        </react_native_svg_1.G>);
        default:
            return (<react_native_svg_1.G {...s}>
          <react_native_svg_1.Rect x="22" y="24" width="12" height="20"/>
          <react_native_svg_1.Rect x="40" y="14" width="12" height="30"/>
          <react_native_svg_1.Rect x="58" y="28" width="12" height="16"/>
        </react_native_svg_1.G>);
    }
}
function ExperienceGlyph(_a) {
    var tint = _a.tint;
    return (<react_native_svg_1.G stroke={tint} strokeWidth="1.6" fill="none">
      <react_native_svg_1.Circle cx="50" cy="24" r="16"/>
      <react_native_svg_1.Line x1="34" y1="24" x2="66" y2="24"/>
      <react_native_svg_1.Line x1="50" y1="8" x2="50" y2="40"/>
      <react_native_svg_1.Path d="M37 13 Q50 22 63 13 M37 35 Q50 26 63 35"/>
      <react_native_svg_1.Line x1="50" y1="8" x2="50" y2="2"/>
    </react_native_svg_1.G>);
}
function IllustratedStamp(_a) {
    var _b, _c, _d, _e, _f, _g;
    var slug = _a.slug, _h = _a.size, size = _h === void 0 ? 110 : _h, experienceLabel = _a.experienceLabel, locked = _a.locked;
    var art = exports.CITY_ART[slug];
    var tint = locked ? tokens_1.color.faint : (_c = (_b = experienceLabel === null || experienceLabel === void 0 ? void 0 : experienceLabel.tint) !== null && _b !== void 0 ? _b : art === null || art === void 0 ? void 0 : art.tint) !== null && _c !== void 0 ? _c : tokens_1.color.deep;
    var title = (_e = (_d = experienceLabel === null || experienceLabel === void 0 ? void 0 : experienceLabel.title) !== null && _d !== void 0 ? _d : art === null || art === void 0 ? void 0 : art.city) !== null && _e !== void 0 ? _e : slug.toUpperCase();
    var sub = (_g = (_f = experienceLabel === null || experienceLabel === void 0 ? void 0 : experienceLabel.sub) !== null && _f !== void 0 ? _f : art === null || art === void 0 ? void 0 : art.country) !== null && _g !== void 0 ? _g : '';
    var w = size;
    var h = Math.round(size * 1.3);
    return (<react_native_1.View style={{ width: w, height: h }}>
      <react_native_svg_1.default width={w} height={h} viewBox="0 0 100 130">
        {/* arched passport frame */}
        <react_native_svg_1.Path d="M14 34 Q14 12 50 12 Q86 12 86 34 L86 116 Q86 122 80 122 L20 122 Q14 122 14 116 Z" stroke={tint} strokeWidth="2.2" fill={locked ? '#F0EEE9' : tokens_1.color.paper}/>
        <react_native_svg_1.Path d="M18 34 Q18 16 50 16 Q82 16 82 34 L82 113 Q82 118 78 118 L22 118 Q18 118 18 113 Z" stroke={tint} strokeWidth="0.7" fill="none" opacity={0.45}/>
        {/* title divider lines */}
        <react_native_svg_1.Line x1="24" y1="34" x2="76" y2="34" stroke={tint} strokeWidth="0.5" opacity={0.4}/>
        <react_native_svg_1.Line x1="24" y1="98" x2="76" y2="98" stroke={tint} strokeWidth="0.5" opacity={0.4}/>
        {/* landmark, vertically centered between dividers */}
        <react_native_svg_1.G transform="translate(0, 44)">
          {experienceLabel ? <ExperienceGlyph tint={tint}/> : <Landmark slug={slug} tint={tint}/>}
        </react_native_svg_1.G>
      </react_native_svg_1.default>
      {/* labels layered over the SVG */}
      <react_native_1.View pointerEvents="none" style={styles.labels}>
        <react_native_1.Text style={[styles.title, { color: tint }]} numberOfLines={1}>{title}</react_native_1.Text>
      </react_native_1.View>
      {sub ? (<react_native_1.View pointerEvents="none" style={styles.subWrap}>
          <react_native_1.Text style={[styles.sub, { color: tint }]} numberOfLines={1}>{sub}</react_native_1.Text>
        </react_native_1.View>) : null}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    labels: { position: 'absolute', top: '14%', left: 0, right: 0, alignItems: 'center' },
    title: { fontFamily: 'Courier', fontWeight: '700', fontSize: 11, letterSpacing: 1.5 },
    subWrap: { position: 'absolute', bottom: '13%', left: 0, right: 0, alignItems: 'center' },
    sub: { fontFamily: 'Courier', fontWeight: '700', fontSize: 7.5, letterSpacing: 1 },
});
