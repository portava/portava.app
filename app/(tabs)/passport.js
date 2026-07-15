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
exports.default = Passport;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("../../src/components/ui");
var PassportStamps_1 = require("../../src/components/PassportStamps");
var PassportStampCard_1 = require("../../src/components/PassportStampCard");
var PostcardTile_1 = require("../../src/components/PostcardTile");
var PassportHero_1 = require("../../src/components/PassportHero");
var PassportHeader_1 = require("../../src/components/PassportHeader");
var PassportSections_1 = require("../../src/components/PassportSections");
var usePassport_1 = require("../../src/hooks/usePassport");
var useCityPulse_1 = require("../../src/hooks/useCityPulse");
var availability_1 = require("../../src/lib/availability");
var AvailabilityCard_1 = require("../../src/components/AvailabilityCard");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
function Passport() {
    var _a;
    var _b = (0, usePassport_1.usePassport)(), data = _b.data, loading = _b.loading, error = _b.error;
    var availability = (0, useCityPulse_1.useAvailability)().availability;
    var availStatus = (0, availability_1.resolveStatus)(availability, new Date().toISOString(), 'cebu');
    var _c = (0, react_1.useState)('plans'), tab = _c[0], setTab = _c[1];
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var myPosts = cebu_1.posts.slice(0, 4);
    if (loading) {
        return <react_native_1.View style={[styles.center, { backgroundColor: tokens_1.color.paper }]}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>;
    }
    if (error || !data) {
        return <react_native_1.View style={[styles.center, { backgroundColor: tokens_1.color.paper }]}><react_native_1.Text style={styles.errText}>Couldn't load your Passport.</react_native_1.Text></react_native_1.View>;
    }
    return (<react_native_1.ScrollView style={{ flex: 1, backgroundColor: tokens_1.color.paper }} contentContainerStyle={{ paddingTop: insets.top, paddingBottom: tokens_1.space.xxxl }}>
      {/* Passport-document hero card */}
      <PassportHero_1.PassportHero user={data.user} trustScore={data.trust.score}/>

      {/* Clickable info bar */}
      <PassportHeader_1.InfoBar stats={data.stats} onStamps={function () { return setTab('stamps'); }} onCircle={function () { return expo_router_1.router.push('/circle'); }} onPlans={function () { return setTab('plans'); }} onCities={function () { return expo_router_1.router.push('/(tabs)/trips'); }}/>

      {/* Availability */}
      <react_native_1.View style={{ paddingHorizontal: tokens_1.space.lg }}>
        <AvailabilityCard_1.AvailabilityCard status={availStatus}/>
      </react_native_1.View>

      {/* Featured illustrated stamps */}
      <PassportStampCard_1.PassportStampStrip stamps={data.stamps}/>

      {/* Small actions above tabs: Saved + Compass AI */}
      <react_native_1.View style={styles.miniActions}>
        <react_native_1.Pressable style={styles.miniBtn} onPress={function () { return expo_router_1.router.push('/saved'); }}>
          <lucide_react_native_1.Bookmark size={15} color={tokens_1.color.ink}/><react_native_1.Text style={styles.miniText}>Saved</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.miniBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
          <lucide_react_native_1.Sparkles size={15} color={tokens_1.color.signal}/><react_native_1.Text style={styles.miniText}>Compass AI</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Tabs */}
      <react_native_1.View style={styles.tabBar}>
        {['plans', 'stamps', 'postcards'].map(function (tb) { return (<react_native_1.Pressable key={tb} style={[styles.tab, tab === tb && styles.tabActive]} onPress={function () { return setTab(tb); }}>
            <react_native_1.Text style={[styles.tabText, tab === tb && styles.tabTextActive]}>
              {tb === 'plans' ? 'Plans' : tb === 'stamps' ? 'Stamps' : 'Postcards'}
            </react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.View>

      {tab === 'plans' && (<react_native_1.View>
          {((_a = availability === null || availability === void 0 ? void 0 : availability.trips) === null || _a === void 0 ? void 0 : _a.length) ? (<PassportSections_1.PassportSection title="Trip windows">
              <react_native_1.View style={{ gap: tokens_1.space.sm }}>
                {availability.trips.map(function (tw) { return (<react_native_1.View key={tw.id} style={styles.tripWindow}>
                    <ui_1.Stamp label={tw.citySlug} tone="deep"/>
                    <react_native_1.View style={{ flex: 1 }}>
                      <react_native_1.Text style={styles.twDates}>{tw.startDate} – {tw.endDate}</react_native_1.Text>
                      <react_native_1.Text style={styles.twBlocks}>Open {tw.blocks.join(', ')}</react_native_1.Text>
                    </react_native_1.View>
                    <ui_1.Stamp label="active" tone="signal" rotate={2}/>
                  </react_native_1.View>); })}
              </react_native_1.View>
            </PassportSections_1.PassportSection>) : null}
          <PassportSections_1.PassportSection title="Your plans" action="See all" onAction={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
            <PassportSections_1.PlanRow plans={data.plans}/>
          </PassportSections_1.PassportSection>
        </react_native_1.View>)}

      {tab === 'stamps' && (<react_native_1.View>
          <PassportSections_1.PassportSection title="All stamps" action="Open collection" onAction={function () { return expo_router_1.router.push('/stamps'); }}>
            <react_native_1.View style={styles.stampGrid}>
              {data.stamps.map(function (s, i) { return (<react_native_1.View key={s.id} style={styles.stampCell}>
                  <PassportStamps_1.StampBadge stamp={s} size={88} rotate={((i % 3) - 1) * 4} onPress={function () { return expo_router_1.router.push('/stamps'); }}/>
                </react_native_1.View>); })}
            </react_native_1.View>
          </PassportSections_1.PassportSection>
          <PassportSections_1.PassportSection title="Perks" action="View all" onAction={function () { return expo_router_1.router.push('/saved'); }}>
            <PassportSections_1.PerksRow perks={data.perks.slice(0, 2)}/>
          </PassportSections_1.PassportSection>
        </react_native_1.View>)}

      {tab === 'postcards' && (<PassportSections_1.PassportSection title="Your postcards">
          <PostcardTile_1.PostcardWall posts={myPosts}/>
        </PassportSections_1.PassportSection>)}
    </react_native_1.ScrollView>);
}
var styles = react_native_1.StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    errText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    miniActions: { flexDirection: 'row', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.lg },
    miniBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    miniText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    tabBar: { flexDirection: 'row', gap: tokens_1.space.sm, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, padding: 4, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill },
    tab: { flex: 1, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    tabActive: { backgroundColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontSize: 14 }),
    tabTextActive: { color: tokens_1.color.onInk },
    tripWindow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    twDates: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    twBlocks: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    stampGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: tokens_1.space.lg },
    stampCell: { width: '31%', alignItems: 'center' },
});
