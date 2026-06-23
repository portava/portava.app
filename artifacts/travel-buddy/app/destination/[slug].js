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
exports.default = Destination;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("../../src/components/ui");
var PostCard_1 = require("../../src/components/PostCard");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
var TABS = ['Feed', 'Questions', 'Best areas', 'Travelers', 'Events'];
function Destination() {
    (0, expo_router_1.useLocalSearchParams)();
    var _a = (0, react_1.useState)('Feed'), tab = _a[0], setTab = _a[1];
    var feed = cebu_1.posts.filter(function (p) { return tab === 'Questions' ? p.kind === 'question' : true; });
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.ScrollView stickyHeaderIndices={[1]} contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }}>
        <react_native_1.View style={styles.hero}>
          <react_native_1.Image source={{ uri: cebu_1.cebu.coverUrl }} style={react_native_1.StyleSheet.absoluteFill}/>
          <react_native_1.View style={styles.heroScrim}/>
          <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} style={styles.back} hitSlop={8}><lucide_react_native_1.ChevronLeft size={26} color={tokens_1.color.onInk}/></react_native_1.Pressable>
          <react_native_1.View style={styles.heroBody}>
            <ui_1.Stamp label={cebu_1.cebu.trending ? 'trending' : 'destination'} tone="onInk"/>
            <react_native_1.Text style={styles.heroTitle}>{cebu_1.cebu.city}</react_native_1.Text>
            <react_native_1.Text style={styles.heroSub}>{cebu_1.cebu.travelerCount.toLocaleString()} travelers · {cebu_1.cebu.country}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={styles.tabBar}>
          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md }}>
            {TABS.map(function (x) { return <ui_1.Chip key={x} label={x} active={x === tab} onPress={function () { return setTab(x); }}/>; })}
          </react_native_1.ScrollView>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.aiBanner} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
          <lucide_react_native_1.Sparkles size={16} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.aiText}>Ask AI to summarize Cebu nightlife, beaches, or build a plan</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }}>
          {feed.map(function (p) { return <PostCard_1.PostCard key={p.id} post={p}/>; })}
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    hero: { height: 240, justifyContent: 'flex-end' },
    heroScrim: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(17,17,15,0.35)' }),
    back: { position: 'absolute', top: tokens_1.space.xxl, left: tokens_1.space.lg },
    heroBody: { padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    heroTitle: __assign(__assign({}, tokens_1.type.hero), { fontSize: 40, lineHeight: 42, color: tokens_1.color.onInk }),
    heroSub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.onInkMute }),
    tabBar: { backgroundColor: tokens_1.color.paper, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    aiBanner: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, margin: tokens_1.space.lg, marginBottom: 0, padding: tokens_1.space.md, borderRadius: tokens_1.radius.md, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    aiText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, flex: 1 }),
});
