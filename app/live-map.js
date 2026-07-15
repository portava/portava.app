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
exports.default = LiveMap;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var tokens_1 = require("../src/theme/tokens");
/**
 * Live Map — PLACEHOLDER this pass. The map data model + privacy rules exist in the
 * backend (migration 0002), but NO live user locations are rendered yet. Location
 * sharing is OFF/private by default and only ever shown to accepted circle members
 * who opt in — enforced by RLS, not the UI.
 */
function LiveMap() {
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Live Map" back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg, paddingBottom: tokens_1.space.xxxl }}>
        <react_native_1.View style={s.hero}>
          <react_native_1.View style={s.iconWrap}><lucide_react_native_1.Map size={30} color={tokens_1.color.deep}/></react_native_1.View>
          <react_native_1.Text style={s.title}>Map coming soon</react_native_1.Text>
          <react_native_1.Text style={s.sub}>No public circle locations or saved pins yet.</react_native_1.Text>
          <react_native_1.View style={s.privacyPill}>
            <lucide_react_native_1.Lock size={12} color={tokens_1.color.mute}/>
            <react_native_1.Text style={s.privacyText}>Location sharing is private by default</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>

        <react_native_1.Text style={s.sectionLabel}>WHAT THE MAP WILL SHOW</react_native_1.Text>
        <Row icon={<lucide_react_native_1.MapPin size={18} color={tokens_1.color.signal}/>} title="Your saved pins" sub="Places you save and trip-linked spots."/>
        <Row icon={<lucide_react_native_1.Users size={18} color={tokens_1.color.deep}/>} title="Circle members who opt in" sub="Only accepted circle members who choose to share — never anyone else."/>
        <Row icon={<lucide_react_native_1.Ghost size={18} color={tokens_1.color.mute}/>} title="Ghost Mode" sub="Hide yourself instantly, anytime. On by default."/>

        <react_native_1.View style={s.note}>
          <lucide_react_native_1.Lock size={14} color={tokens_1.color.deep}/>
          <react_native_1.Text style={s.noteText}>
            Your location is never shared unless you turn it on. We never show exact live
            location to anyone outside your accepted circle, and stale pings are hidden.
          </react_native_1.Text>
        </react_native_1.View>

        <react_native_1.Pressable style={s.cta} onPress={function () { return expo_router_1.router.push('/settings'); }}>
          <react_native_1.Text style={s.ctaText}>Location privacy settings</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
function Row(_a) {
    var icon = _a.icon, title = _a.title, sub = _a.sub;
    return (<react_native_1.View style={s.row}>
      <react_native_1.View style={s.rowIcon}>{icon}</react_native_1.View>
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.Text style={s.rowTitle}>{title}</react_native_1.Text>
        <react_native_1.Text style={s.rowSub}>{sub}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
var s = react_native_1.StyleSheet.create({
    hero: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.xl, alignItems: 'center', gap: 6 }, tokens_1.shadow.card),
    iconWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    privacyPill: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill },
    privacyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontWeight: '600' }),
    sectionLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.faint, letterSpacing: 1.5, fontSize: 10 }),
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    rowIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    rowTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    rowSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    note: { flexDirection: 'row', gap: tokens_1.space.sm, backgroundColor: '#E2EDF0', borderRadius: tokens_1.radius.md, padding: tokens_1.space.md },
    noteText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, flex: 1, fontSize: 12 }),
    cta: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center' },
    ctaText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
