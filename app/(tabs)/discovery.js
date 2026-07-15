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
exports.default = Discovery;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var DiscoveryWall_1 = require("../../src/components/DiscoveryWall");
var DiscoveryWall2_1 = require("../../src/components/DiscoveryWall2");
var discovery_1 = require("../../src/data/discovery");
var AttachController_1 = require("../../src/components/AttachController");
var tokens_1 = require("../../src/theme/tokens");
function Discovery() {
    var _a = (0, react_1.useState)('All'), cat = _a[0], setCat = _a[1];
    var attach = (0, AttachController_1.useAttach)();
    // simple filter: 'All' shows everything; otherwise match category label
    var visibleFeatured = cat === 'All'
        ? discovery_1.featuredExperiences
        : discovery_1.featuredExperiences.filter(function (f) { return f.category.toLowerCase() === cat.toLowerCase().replace(' ', '_'); });
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <DiscoveryWall_1.DiscoveryHeader city="Cebu" filterCount={cat !== 'All' ? 1 : 0} onSearch={function () { return expo_router_1.router.push('/(tabs)/ai'); }} onFilter={function () { return expo_router_1.router.push('/(tabs)/ai'); }} onSaved={function () { return expo_router_1.router.push('/saved'); }}/>
      <react_native_1.ScrollView contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        {/* Compass Pick / For You */}
        <react_native_1.View style={{ marginTop: tokens_1.space.lg }}>
          <DiscoveryWall_1.CompassPickBlock pick={discovery_1.compassPick} side={discovery_1.forYouSide}/>
        </react_native_1.View>

        {/* Category chips */}
        <DiscoveryWall_1.CategoryChips active={cat} onPick={setCat} categories={discovery_1.DISCOVERY_CATEGORIES}/>

        {/* Map placeholder — links to the Live Map (placeholder this pass) */}
        <react_native_1.Pressable style={styles.mapCard} onPress={function () { return expo_router_1.router.push('/live-map'); }}>
          <react_native_1.View style={styles.mapIcon}><lucide_react_native_1.Map size={20} color={tokens_1.color.deep}/></react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={styles.mapTitle}>Explore on the map</react_native_1.Text>
            <react_native_1.Text style={styles.mapSub}>Saved pins & circle locations · private by default</react_native_1.Text>
          </react_native_1.View>
          <lucide_react_native_1.ChevronRight size={18} color={tokens_1.color.faint}/>
        </react_native_1.Pressable>

        {/* Featured Experiences */}
        <DiscoveryWall_1.SectionHead title="Featured Experiences" onViewAll={function () { return expo_router_1.router.push('/(tabs)/ai'); }}/>
        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {(visibleFeatured.length ? visibleFeatured : discovery_1.featuredExperiences).map(function (f) { return (<DiscoveryWall_1.FeaturedCard key={f.id} item={f} onAdd={function () { return attach.open({ id: f.id, type: 'experience', title: f.name, city: 'Cebu', category: 'Experience' }, 'plan'); }}/>); })}
        </react_native_1.ScrollView>

        {/* ── Pass 2 sections ── */}
        <DiscoveryWall2_1.HiddenGemsSection gems={discovery_1.hiddenGems}/>
        <DiscoveryWall2_1.NeighborhoodsSection items={discovery_1.neighborhoods}/>
        <DiscoveryWall2_1.TravelerPicksSection picks={discovery_1.travelerPicks}/>
        <DiscoveryWall2_1.SavedIdeasSection items={discovery_1.savedIdeas}/>
        <DiscoveryWall2_1.AskCompassCard />
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    mapCard: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    mapIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
    mapTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    mapSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
