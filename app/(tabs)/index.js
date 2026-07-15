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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Pulse;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var cebu_1 = require("../../src/data/cebu");
var pulseFeed_1 = require("../../src/data/pulseFeed");
var PostCard_1 = require("../../src/components/PostCard");
var PulseHeader_1 = require("../../src/components/PulseHeader");
var PulseFits_1 = require("../../src/components/PulseFits");
var PulseFeedCard_1 = require("../../src/components/PulseFeedCard");
var PulseCreate_1 = require("../../src/components/PulseCreate");
var ui_1 = require("../../src/components/ui");
var primitives_1 = require("../../src/components/primitives");
var useCityPulse_1 = require("../../src/hooks/useCityPulse");
var availability_1 = require("../../src/lib/availability");
var recommend_1 = require("../../src/lib/recommend");
var tokens_1 = require("../../src/theme/tokens");
var QUICK_FILTERS = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];
var CURRENT_CITY = 'cebu';
function Pulse() {
    var _a = (0, react_1.useState)(['All']), active = _a[0], setActive = _a[1];
    var _b = (0, react_1.useState)(false), sheetOpen = _b[0], setSheetOpen = _b[1];
    var _c = (0, react_1.useState)(false), createOpen = _c[0], setCreateOpen = _c[1];
    var _d = (0, useCityPulse_1.useCityPulse)({ currentCitySlug: CURRENT_CITY, interests: cebu_1.me.interests }), buckets = _d.buckets, status = _d.status;
    var fits = __spreadArray(__spreadArray([], buckets.fitsAvailability, true), buckets.openNearby, true);
    var noFits = fits.length === 0;
    var feed = (0, react_1.useMemo)(function () { return (0, recommend_1.filterPulseFeed)(pulseFeed_1.pulseFeed, active); }, [active]);
    var filterCount = active.filter(function (f) { return f !== 'All'; }).length;
    function toggleQuick(f) {
        if (f === 'All') {
            setActive(['All']);
            return;
        }
        setActive(function (prev) {
            var without = prev.filter(function (x) { return x !== 'All'; });
            return without.includes(f) ? (without.filter(function (x) { return x !== f; }).length ? without.filter(function (x) { return x !== f; }) : ['All']) : __spreadArray(__spreadArray([], without, true), [f], false);
        });
    }
    function toggleSheet(f) {
        if (f === 'All') {
            setActive(['All']);
            return;
        }
        setActive(function (prev) {
            var without = prev.filter(function (x) { return x !== 'All'; });
            return without.includes(f) ? (without.filter(function (x) { return x !== f; }).length ? without.filter(function (x) { return x !== f; }) : ['All']) : __spreadArray(__spreadArray([], without, true), [f], false);
        });
    }
    var Header = (<react_native_1.View>
      {/* Fits your time */}
      <react_native_1.View style={styles.fitsHead}>
        <react_native_1.Text style={styles.sectionTitle}>Fits your time</react_native_1.Text>
        <react_native_1.View style={styles.insideBadge}><react_native_1.Text style={styles.insideText}>Inside your availability</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}/>
        {fits.length > 0 && (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}><react_native_1.Text style={styles.viewAll}>View all ({fits.length})</react_native_1.Text></react_native_1.Pressable>)}
      </react_native_1.View>
      {noFits ? (<react_native_1.View style={styles.empty}>
          <react_native_1.Text style={styles.emptyTitle}>{status === 'not_set' ? 'Set your availability to see better matches.' : 'No plans fit your availability yet.'}</react_native_1.Text>
          <react_native_1.Text style={styles.emptySub}>Check flexible options below or create a plan.</react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fitsStrip}>
          {fits.map(function (e) { return <PulseFits_1.FitsCard key={e.id} ev={e}/>; })}
        </react_native_1.ScrollView>)}

      {/* When you're flexible */}
      <PulseFits_1.FlexibleStrip events={buckets.flexible}/>

      {/* Pulse Wall title + quick filter chips */}
      <react_native_1.Text style={styles.wallTitle}>Pulse Wall</react_native_1.Text>
      <react_native_1.FlatList data={QUICK_FILTERS} horizontal showsHorizontalScrollIndicator={false} keyExtractor={function (x) { return x; }} contentContainerStyle={styles.filterRow} renderItem={function (_a) {
            var item = _a.item;
            return (<ui_1.Chip label={item} active={active.includes(item)} onPress={function () { return toggleQuick(item); }}/>);
        }}/>
    </react_native_1.View>);
    var Footer = (<react_native_1.View>
      {feed.length === 0 ? (<primitives_1.TravelEmptyState title="No results for these filters" sub="Try clearing a filter or switch to All." action="Clear filters" onAction={function () { return setActive(['All']); }}/>) : null}
      {/* Editorial inspiration — labeled, not live activity */}
      <react_native_1.Text style={styles.inspoLabel}>INSPIRATION · EDITORIAL</react_native_1.Text>
      {cebu_1.posts.slice(0, 3).map(function (p) { return (<react_native_1.View key={p.id} style={{ paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.lg }}><PostCard_1.PostCard post={p}/></react_native_1.View>); })}
    </react_native_1.View>);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <PulseHeader_1.PulseHeader city="Cebu" availabilityText={status === 'not_set' ? 'Availability not set' : availability_1.STATUS_LABEL[status]} filterCount={filterCount} onSearch={function () { return expo_router_1.router.push('/(tabs)/discovery'); }} onFilter={function () { return setSheetOpen(true); }} onCreate={function () { return setCreateOpen(true); }}/>
      <react_native_1.FlatList data={feed} keyExtractor={function (it) { return it.id; }} ListHeaderComponent={Header} ListFooterComponent={Footer} renderItem={function (_a) {
        var item = _a.item;
        return <react_native_1.View style={{ paddingHorizontal: tokens_1.space.lg }}><PulseFeedCard_1.PulseFeedCard item={item}/></react_native_1.View>;
    }} ItemSeparatorComponent={function () { return <react_native_1.View style={{ height: tokens_1.space.md }}/>; }} contentContainerStyle={{ paddingBottom: 120 }} showsVerticalScrollIndicator={false}/>

      <PulseCreate_1.PulseFAB onPress={function () { return setCreateOpen(true); }}/>
      <PulseCreate_1.PulseFilterSheet visible={sheetOpen} active={active.filter(function (f) { return f !== 'All'; })} onToggle={toggleSheet} onClear={function () { return setActive(['All']); }} onClose={function () { return setSheetOpen(false); }}/>
      <PulseCreate_1.PulseCreateMenu visible={createOpen} onClose={function () { return setCreateOpen(false); }}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    fitsHead: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.lg, marginBottom: tokens_1.space.md, flexWrap: 'wrap' },
    sectionTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    insideBadge: { backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: 999, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3 },
    insideText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontSize: 11, fontWeight: '600' }),
    viewAll: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    fitsStrip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: 14, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    emptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 4 }),
    wallTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xxl, marginBottom: tokens_1.space.md }),
    filterRow: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md },
    inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.faint, letterSpacing: 1.5, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xxl, marginBottom: tokens_1.space.md },
});
