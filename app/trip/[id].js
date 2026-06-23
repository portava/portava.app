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
exports.default = TripDetail;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var TripPage_1 = require("../../src/components/TripPage");
var TripPage2_1 = require("../../src/components/TripPage2");
var tripDetail_1 = require("../../src/data/tripDetail");
var SessionContext_1 = require("../../src/context/SessionContext");
var useBackend_1 = require("../../src/hooks/useBackend");
var tokens_1 = require("../../src/theme/tokens");
function TripDetail() {
    var _a, _b, _c, _d;
    var id = (0, expo_router_1.useLocalSearchParams)().id;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _e = (0, SessionContext_1.useSession)(), configured = _e.configured, isAuthed = _e.isAuthed;
    var live = configured && isAuthed;
    var _f = (0, useBackend_1.useTrip)(live ? id : undefined), realTrip = _f.data, loading = _f.loading;
    // Live: merge the real trip row into the hero; keep mock sub-sections until their
    // tables land. Mock fallback when not signed in.
    var trip = live && realTrip ? __assign(__assign({}, tripDetail_1.mockTripDetail), { id: realTrip.id, title: realTrip.title, destinationCity: realTrip.destinationCity, destinationCountry: (_a = realTrip.destinationCountry) !== null && _a !== void 0 ? _a : tripDetail_1.mockTripDetail.destinationCountry, startDate: (_b = realTrip.startDate) !== null && _b !== void 0 ? _b : tripDetail_1.mockTripDetail.startDate, endDate: (_c = realTrip.endDate) !== null && _c !== void 0 ? _c : tripDetail_1.mockTripDetail.endDate, status: realTrip.status, visibility: realTrip.visibility, coverUrl: (_d = realTrip.coverUrl) !== null && _d !== void 0 ? _d : tripDetail_1.mockTripDetail.coverUrl }) : tripDetail_1.mockTripDetail;
    if (live && loading) {
        return <react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper, alignItems: 'center', justifyContent: 'center' }}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>;
    }
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      {/* top bar */}
      <react_native_1.View style={[styles.topBar, { paddingTop: insets.top + tokens_1.space.sm }]}>
        <react_native_1.Pressable style={styles.backBtn} onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}>
          <lucide_react_native_1.ChevronLeft size={22} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.backText}>My Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={styles.topBtn} onPress={function () { }} hitSlop={6}>
          <lucide_react_native_1.Share2 size={15} color={tokens_1.color.ink}/><react_native_1.Text style={styles.topBtnText}>Share Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.topBtn} onPress={function () { return expo_router_1.router.push('/settings'); }} hitSlop={6}>
          <lucide_react_native_1.Pencil size={15} color={tokens_1.color.ink}/><react_native_1.Text style={styles.topBtnText}>Edit Trip</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.topIcon} hitSlop={6}><lucide_react_native_1.MoreHorizontal size={18} color={tokens_1.color.ink}/></react_native_1.Pressable>
      </react_native_1.View>

      <react_native_1.ScrollView contentContainerStyle={{ paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
        <TripPage_1.TripHero trip={trip}/>
        <TripPage_1.TodayNextUp nextUp={tripDetail_1.mockNextUp}/>
        <TripPage_1.TripTimeline days={trip.timeline}/>
        <TripPage_1.SavedIdeas ideas={trip.savedIdeas}/>
        <TripPage2_1.TripPlans plans={tripDetail_1.tripPlans}/>
        <TripPage2_1.TripCircle cityCount={tripDetail_1.tripCircle.cityCount} inCity={tripDetail_1.tripCircle.inCity} suggested={tripDetail_1.tripCircle.suggested}/>
        <TripPage2_1.CompassTripBrief />
        <TripPage2_1.TripStamps stamps={tripDetail_1.tripStamps}/>
        <TripMapPlaceholder />
        <TripPage2_1.TripSafety />
        <TripPage2_1.TripPostsSection posts={tripDetail_1.tripPosts}/>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    topBar: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    backText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
    topBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    topBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    topIcon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
});
/* Trip map section — placeholder this pass. Live location is OFF/private by default
   and never rendered until the Live Map UI pass. */
function TripMapPlaceholder() {
    return (<react_native_1.View style={mp.wrap}>
      <react_native_1.Text style={mp.h}>Trip Map</react_native_1.Text>
      <react_native_1.View style={mp.card}>
        <react_native_1.View style={mp.iconWrap}><lucide_react_native_1.Map size={26} color={tokens_1.color.deep}/></react_native_1.View>
        <react_native_1.Text style={mp.title}>Map coming soon</react_native_1.Text>
        <react_native_1.Text style={mp.sub}>Saved places and trip pins will appear here.</react_native_1.Text>
        <react_native_1.View style={mp.privacy}>
          <lucide_react_native_1.Lock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={mp.privacyText}>Location sharing is private by default.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
var mp = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, gap: tokens_1.space.md },
    h: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    card: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, borderStyle: 'dashed', padding: tokens_1.space.xl, alignItems: 'center', gap: 6 },
    iconWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 15 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    privacy: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: tokens_1.space.sm, backgroundColor: tokens_1.color.paper, paddingHorizontal: tokens_1.space.md, paddingVertical: 5, borderRadius: tokens_1.radius.pill },
    privacyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
