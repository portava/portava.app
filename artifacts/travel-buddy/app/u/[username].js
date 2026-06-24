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
exports.default = PublicPassportScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var usePublicPassport_1 = require("../../src/hooks/usePublicPassport");
var useFollow_1 = require("../../src/hooks/useFollow");
var useHighlightRingState_1 = require("../../src/hooks/useHighlightRingState");
var PassportHero_1 = require("../../src/components/PassportHero");
var HighlightViewer_1 = require("../../src/components/HighlightViewer");
var PostcardsTab_1 = require("../../src/components/PostcardsTab");
var StampsTab_1 = require("../../src/components/StampsTab");
var AboutTab_1 = require("../../src/components/AboutTab");
var MapTab_1 = require("../../src/components/MapTab");
var tokens_1 = require("../../src/theme/tokens");
var TABS = [
    { key: 'postcards', label: 'Postcards' },
    { key: 'stamps', label: 'Stamps' },
    { key: 'map', label: 'Map' },
    { key: 'about', label: 'About' },
];
function PublicPassportScreen() {
    var _a, _b, _c;
    var username = (0, expo_router_1.useLocalSearchParams)().username;
    var _d = (0, usePublicPassport_1.usePublicPassport)(username !== null && username !== void 0 ? username : ''), profile = _d.profile, postcards = _d.postcards, loading = _d.loading, error = _d.error, isPrivate = _d.isPrivate, notFound = _d.notFound;
    var follow = (0, useFollow_1.useFollow)((_a = profile === null || profile === void 0 ? void 0 : profile.id) !== null && _a !== void 0 ? _a : null);
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)((_b = profile === null || profile === void 0 ? void 0 : profile.id) !== null && _b !== void 0 ? _b : null);
    var _e = (0, react_1.useState)(false), highlightViewerOpen = _e[0], setHighlightViewerOpen = _e[1];
    var _f = (0, react_1.useState)(false), sessionAllViewed = _f[0], setSessionAllViewed = _f[1];
    var _g = (0, react_1.useState)('postcards'), tab = _g[0], setTab = _g[1];
    // Reset session-viewed flag when navigating to a different user's profile.
    (0, react_1.useEffect)(function () {
        setSessionAllViewed(false);
    }, [profile === null || profile === void 0 ? void 0 : profile.id]);
    function handleViewerClose() {
        var _a;
        setHighlightViewerOpen(false);
        // If the viewer marked all active highlights as seen, mute the ring immediately
        // without waiting for the 60-second cache TTL to expire.
        var highlights = (_a = ringState === null || ringState === void 0 ? void 0 : ringState.highlights) !== null && _a !== void 0 ? _a : [];
        if (highlights.length > 0 && highlights.every(function (h) { return useHighlightRingState_1.viewedHighlightIds.has(h.id); })) {
            setSessionAllViewed(true);
        }
    }
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var renderContent = function () {
        var _a;
        if (loading) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
        </react_native_1.View>);
        }
        if (notFound) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>🔍</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>No one here</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>@{username} doesn't exist.</react_native_1.Text>
        </react_native_1.View>);
        }
        if (isPrivate) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateIcon}>🔒</react_native_1.Text>
          <react_native_1.Text style={styles.stateTitle}>This Passport is private</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>Only the owner can see this Passport.</react_native_1.Text>
        </react_native_1.View>);
        }
        if (error) {
            return (<react_native_1.View style={styles.center}>
          <react_native_1.Text style={styles.stateTitle}>Couldn't load Passport</react_native_1.Text>
          <react_native_1.Text style={styles.stateSub}>{error}</react_native_1.Text>
        </react_native_1.View>);
        }
        if (!profile)
            return null;
        var countries = new Set(postcards.map(function (c) { return c.locationCountry; }).filter(Boolean)).size;
        var cities = new Set(postcards.map(function (c) { return c.locationCity; }).filter(Boolean)).size;
        return (<react_native_1.ScrollView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} contentContainerStyle={{ paddingTop: 0, paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        <PassportHero_1.PassportHero profile={profile} isOwner={false} isFollowing={follow.isFollowing} followLoading={follow.loading || follow.toggling} onFollowPress={follow.toggle} hasHighlights={ringState === null || ringState === void 0 ? void 0 : ringState.hasActive} allHighlightsViewed={((_a = ringState === null || ringState === void 0 ? void 0 : ringState.allViewed) !== null && _a !== void 0 ? _a : false) || sessionAllViewed} onHighlightRingPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setHighlightViewerOpen(true); } : undefined}/>

        {/* Stats row: postcards, countries, cities + followers */}
        <react_native_1.View style={styles.statsRow}>
          {[
                { n: postcards.length, label: 'Postcards' },
                { n: countries, label: 'Countries' },
                { n: cities, label: 'Cities' },
                { n: follow.followersCount, label: 'Followers' },
            ].map(function (item, i, arr) { return (<react_1.default.Fragment key={item.label}>
              {i > 0 && <react_native_1.View style={styles.statsDivider}/>}
              <react_native_1.View style={styles.statsCell}>
                <react_native_1.Text style={styles.statsN}>{follow.loading && item.label === 'Followers' ? '—' : item.n}</react_native_1.Text>
                <react_native_1.Text style={styles.statsL}>{item.label}</react_native_1.Text>
              </react_native_1.View>
            </react_1.default.Fragment>); })}
        </react_native_1.View>

        {/* Following pill */}
        {follow.followingCount > 0 && (<react_native_1.View style={styles.followingPill}>
            <lucide_react_native_1.Users size={12} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.followingText}>
              Following {follow.followingCount} {follow.followingCount === 1 ? 'traveler' : 'travelers'}
            </react_native_1.Text>
          </react_native_1.View>)}

        {/* Tab bar */}
        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBarWrap} contentContainerStyle={styles.tabBarContent}>
          {TABS.map(function (tb) { return (<react_native_1.Pressable key={tb.key} style={[styles.tab, tab === tb.key && styles.tabActive]} onPress={function () { return setTab(tb.key); }}>
              <react_native_1.Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>
                {tb.label}
              </react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.ScrollView>

        <react_native_1.View style={{ marginTop: tokens_1.space.md }}>
          {tab === 'postcards' && (<PostcardsTab_1.PostcardsTab postcards={postcards} isOwner={false}/>)}
          {tab === 'stamps' && <StampsTab_1.StampsTab stamps={[]}/>}
          {tab === 'map' && <MapTab_1.MapTab postcards={postcards}/>}
          {tab === 'about' && <AboutTab_1.AboutTab profile={profile} isOwner={false}/>}
        </react_native_1.View>
      </react_native_1.ScrollView>);
    };
    return (<react_native_1.View style={[styles.container, { paddingTop: insets.top }]}>
      <react_native_1.View style={styles.header}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} style={styles.backBtn} hitSlop={8}>
          <lucide_react_native_1.ArrowLeft size={22} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Text style={styles.headerTitle} numberOfLines={1}>
          {profile ? (('displayName' in profile && profile.displayName) || (username !== null && username !== void 0 ? username : '')) : username !== null && username !== void 0 ? username : ''}
        </react_native_1.Text>
        <react_native_1.View style={{ width: 38 }}/>
      </react_native_1.View>
      {renderContent()}
      <HighlightViewer_1.HighlightViewer visible={highlightViewerOpen} highlights={(_c = ringState === null || ringState === void 0 ? void 0 : ringState.highlights) !== null && _c !== void 0 ? _c : []} onClose={handleViewerClose}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: { flex: 1, backgroundColor: tokens_1.color.paper },
    header: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.md, paddingVertical: 10,
        borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paper,
    },
    backBtn: { padding: 6 },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, flex: 1, textAlign: 'center' }),
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: tokens_1.space.xl, gap: tokens_1.space.md, minHeight: 300 },
    stateIcon: { fontSize: 56 },
    stateTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, textAlign: 'center' }),
    stateSub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    statsRow: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm,
        paddingVertical: 10,
    },
    statsCell: { flex: 1, alignItems: 'center' },
    statsDivider: { width: 1, height: 28, backgroundColor: tokens_1.color.haze },
    statsN: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 18 }),
    statsL: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.mute, fontWeight: '700' },
    followingPill: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm,
        paddingVertical: 6, paddingHorizontal: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.pill,
        borderWidth: 1, borderColor: tokens_1.color.haze, alignSelf: 'flex-start',
    },
    followingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    tabBarWrap: { marginTop: tokens_1.space.md },
    tabBarContent: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.xs },
    tab: {
        paddingHorizontal: tokens_1.space.md, paddingVertical: 8,
        borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paperRaised,
    },
    tabActive: { backgroundColor: tokens_1.color.ink, borderColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 13 }),
    tabTextActive: { color: tokens_1.color.onInk },
});
