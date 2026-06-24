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
var usePosts_1 = require("../../src/hooks/usePosts");
var intelligence_1 = require("../../src/services/intelligence");
var availability_1 = require("../../src/lib/availability");
var recommend_1 = require("../../src/lib/recommend");
var tokens_1 = require("../../src/theme/tokens");
var LocationContext_1 = require("../../src/context/LocationContext");
var LocationPermissionPrompt_1 = require("../../src/components/LocationPermissionPrompt");
var ManualCityPicker_1 = require("../../src/components/ManualCityPicker");
var QUICK_FILTERS = ['All', 'Plans', 'Posts', 'Questions', 'Hidden Gems', 'Itineraries', 'Circle'];
/** Convert a real PostRow from the API into a PulseFeedItem for the Pulse Wall. */
function postRowToFeedItem(p) {
    var _a, _b, _c, _d, _e, _f;
    return {
        id: p.id,
        type: 'post',
        city: (_a = p.locationCity) !== null && _a !== void 0 ? _a : 'Traveler Post',
        author: {
            id: p.authorId,
            name: (_c = (_b = p.author) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : 'Traveler',
            avatarUrl: (_e = (_d = p.author) === null || _d === void 0 ? void 0 : _d.avatarUrl) !== null && _e !== void 0 ? _e : '',
        },
        createdAt: p.createdAt,
        timeAgo: timeAgo(p.createdAt),
        tags: [],
        mediaUrl: p.mediaUrls[0],
        caption: p.content,
        source: 'user',
        neighborhood: (_f = p.locationName) !== null && _f !== void 0 ? _f : undefined,
        visibility: p.visibility === 'trip_only' ? 'private' : p.visibility,
        likeCount: p.likeCount,
        commentCount: p.commentCount,
        likedByMe: p.likedByMe,
        canLike: p.canLike,
        canComment: p.canComment,
        canShare: p.canShare,
    };
}
function timeAgo(iso) {
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60)
        return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60)
        return "".concat(m, "m ago");
    var h = Math.floor(m / 60);
    if (h < 24)
        return "".concat(h, "h ago");
    return "".concat(Math.floor(h / 24), "d ago");
}
function Pulse() {
    var _a;
    var _b = (0, react_1.useState)('forYou'), feedMode = _b[0], setFeedMode = _b[1];
    var _c = (0, react_1.useState)(['All']), active = _c[0], setActive = _c[1];
    var _d = (0, react_1.useState)(false), sheetOpen = _d[0], setSheetOpen = _d[1];
    var _e = (0, react_1.useState)(false), createOpen = _e[0], setCreateOpen = _e[1];
    var _f = (0, react_1.useState)({}), categoryAffinities = _f[0], setCategoryAffinities = _f[1];
    var _g = (0, LocationContext_1.useLocationContext)(), locationState = _g.locationState, openCityPicker = _g.openCityPicker;
    var activeCity = (_a = locationState.place.city) !== null && _a !== void 0 ? _a : 'Cebu City';
    var activeCitySlug = activeCity.toLowerCase().replace(/\s+/g, '-');
    // Load learned category affinities from the preference engine so Pulse
    // ranking improves as the user interacts with recommendations.
    (0, react_1.useEffect)(function () {
        (0, intelligence_1.fetchPreferences)().then(function (res) {
            var _a, _b;
            if (res.ok && ((_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a.inferred) === null || _b === void 0 ? void 0 : _b.categoryAffinities)) {
                setCategoryAffinities(res.data.inferred.categoryAffinities);
            }
        }).catch(function () { });
    }, []);
    var _h = (0, useCityPulse_1.useCityPulse)({ currentCitySlug: activeCitySlug, interests: cebu_1.me.interests, categoryAffinities: categoryAffinities }), buckets = _h.buckets, status = _h.status;
    var realFeed = (0, usePosts_1.useGlobalFeed)();
    var followingFeed = (0, usePosts_1.useFollowingFeed)();
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        realFeed.reload();
        if (feedMode === 'following')
            followingFeed.reload();
    }, [realFeed.reload, followingFeed.reload, feedMode]));
    // When switching to Following, load it on first activation.
    var handleFeedMode = (0, react_1.useCallback)(function (mode) {
        setFeedMode(mode);
        if (mode === 'following')
            followingFeed.reload();
    }, [followingFeed.reload]);
    var fits = __spreadArray(__spreadArray([], buckets.fitsAvailability, true), buckets.openNearby, true);
    var noFits = fits.length === 0;
    var realItems = (0, react_1.useMemo)(function () {
        var _a;
        return ((_a = realFeed.data) !== null && _a !== void 0 ? _a : [])
            .filter(function (p) { return p.mediaUrls.length > 0; })
            .map(postRowToFeedItem);
    }, [realFeed.data]);
    var mockFeed = (0, react_1.useMemo)(function () { return (0, recommend_1.filterPulseFeed)(pulseFeed_1.pulseFeed, active); }, [active]);
    var forYouFeed = (0, react_1.useMemo)(function () {
        var filteredReal = active.includes('All') || active.includes('Posts')
            ? realItems
            : realItems.filter(function () { return false; });
        return __spreadArray(__spreadArray([], filteredReal, true), mockFeed, true);
    }, [realItems, mockFeed, active]);
    var followingItems = (0, react_1.useMemo)(function () { var _a; return ((_a = followingFeed.data) !== null && _a !== void 0 ? _a : []).map(postRowToFeedItem); }, [followingFeed.data]);
    var feed = feedMode === 'following' ? followingItems : forYouFeed;
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

      {/* Pulse Wall — feed mode toggle + quick filters */}
      <react_native_1.Text style={styles.wallTitle}>Pulse Wall</react_native_1.Text>

      {/* For You / Following toggle */}
      <react_native_1.View style={styles.modeRow}>
        <react_native_1.Pressable style={[styles.modeBtn, feedMode === 'forYou' && styles.modeBtnActive]} onPress={function () { return handleFeedMode('forYou'); }}>
          <react_native_1.Text style={[styles.modeBtnText, feedMode === 'forYou' && styles.modeBtnTextActive]}>For You</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={[styles.modeBtn, feedMode === 'following' && styles.modeBtnActive]} onPress={function () { return handleFeedMode('following'); }}>
          <react_native_1.Text style={[styles.modeBtnText, feedMode === 'following' && styles.modeBtnTextActive]}>Following</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Quick filter chips — only visible in For You mode */}
      {feedMode === 'forYou' && (<react_native_1.FlatList data={QUICK_FILTERS} horizontal showsHorizontalScrollIndicator={false} keyExtractor={function (x) { return x; }} contentContainerStyle={styles.filterRow} renderItem={function (_a) {
                var item = _a.item;
                return (<ui_1.Chip label={item} active={active.includes(item)} onPress={function () { return toggleQuick(item); }}/>);
            }}/>)}
    </react_native_1.View>);
    var FollowingEmpty = (<react_native_1.View style={styles.followingEmpty}>
      <react_native_1.Text style={styles.followingEmptyTitle}>Follow travelers to see their public posts here.</react_native_1.Text>
      <react_native_1.Pressable style={styles.exploreBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}>
        <react_native_1.Text style={styles.exploreBtnText}>Explore travelers</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
    var FollowingError = (<react_native_1.View style={styles.followingEmpty}>
      <react_native_1.Text style={styles.followingEmptyTitle}>Couldn't load your Following feed.</react_native_1.Text>
      <react_native_1.Pressable style={styles.exploreBtn} onPress={function () { return followingFeed.reload(); }}>
        <react_native_1.Text style={styles.exploreBtnText}>Retry</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
    var Footer = (<react_native_1.View>
      {feedMode === 'following' ? (followingFeed.loading ? (<react_native_1.View style={styles.loadingWrap}><react_native_1.ActivityIndicator size="large" color={tokens_1.color.signal}/></react_native_1.View>) : followingFeed.error ? (FollowingError) : followingItems.length === 0 ? (FollowingEmpty) : null) : (feed.length === 0 ? (<primitives_1.TravelEmptyState title="No results for these filters" sub="Try clearing a filter or switch to All." action="Clear filters" onAction={function () { return setActive(['All']); }}/>) : null)}
      {/* Editorial inspiration — shown only in For You mode */}
      {feedMode === 'forYou' && (<>
          <react_native_1.Text style={styles.inspoLabel}>INSPIRATION · EDITORIAL</react_native_1.Text>
          {cebu_1.posts.slice(0, 3).map(function (p) { return (<react_native_1.View key={p.id} style={{ paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.lg }}><PostCard_1.PostCard post={p}/></react_native_1.View>); })}
        </>)}
    </react_native_1.View>);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <PulseHeader_1.PulseHeader city={activeCity} cityFull={activeCity} availabilityText={status === 'not_set' ? 'Availability not set' : availability_1.STATUS_LABEL[status]} filterCount={filterCount} onSearch={function () { return expo_router_1.router.push('/(tabs)/discovery'); }} onFilter={function () { return setSheetOpen(true); }} onCityPress={openCityPicker}/>
      <react_native_1.FlatList data={feed} keyExtractor={function (it) { return it.id; }} ListHeaderComponent={Header} ListFooterComponent={Footer} renderItem={function (_a) {
            var item = _a.item;
            return (<react_native_1.View style={{ paddingHorizontal: tokens_1.space.lg }}>
            <PulseFeedCard_1.PulseFeedCard item={item}/>
          </react_native_1.View>);
        }} ItemSeparatorComponent={function () { return <react_native_1.View style={{ height: tokens_1.space.md }}/>; }} contentContainerStyle={{ paddingBottom: 120 }} showsVerticalScrollIndicator={false} refreshControl={<react_native_1.RefreshControl refreshing={feedMode === 'following' ? followingFeed.loading : realFeed.loading} onRefresh={feedMode === 'following' ? followingFeed.reload : realFeed.reload} tintColor={tokens_1.color.signal}/>}/>

      <PulseCreate_1.PulseFilterSheet visible={sheetOpen} active={active.filter(function (f) { return f !== 'All'; })} onToggle={toggleSheet} onClear={function () { return setActive(['All']); }} onClose={function () { return setSheetOpen(false); }}/>
      <PulseCreate_1.UnifiedPostComposer visible={createOpen} onClose={function () { return setCreateOpen(false); }} onSuccess={function () { return realFeed.reload(); }}/>

      {/* Location overlays */}
      <LocationPermissionPrompt_1.LocationPermissionPrompt />
      <ManualCityPicker_1.ManualCityPicker />
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
    modeRow: { flexDirection: 'row', marginHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.md, borderRadius: 12, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, padding: 3, gap: 3 },
    modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
    modeBtnActive: { backgroundColor: tokens_1.color.paper, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
    modeBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 14, color: tokens_1.color.mute }),
    modeBtnTextActive: { color: tokens_1.color.ink },
    filterRow: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md },
    inspoLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.faint, letterSpacing: 1.5, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xxl, marginBottom: tokens_1.space.md },
    followingEmpty: { marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, padding: tokens_1.space.xl, borderRadius: 16, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, alignItems: 'center', gap: tokens_1.space.md },
    followingEmptyTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.deep, textAlign: 'center', lineHeight: 22 }),
    exploreBtn: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: 10, borderRadius: 10 },
    exploreBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: '#fff', fontSize: 14 }),
    loadingWrap: { paddingVertical: tokens_1.space.xxl, alignItems: 'center' },
});
