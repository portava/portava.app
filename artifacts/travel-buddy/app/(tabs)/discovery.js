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
exports.default = DiscoveryHub;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var DiscoveryCategoryTab_1 = require("../../src/components/discovery/DiscoveryCategoryTab");
var PlaceDetailSheet_1 = require("../../src/components/discovery/PlaceDetailSheet");
var ForYouTab_1 = require("../../src/components/discovery/ForYouTab");
var DestinationBar_1 = require("../../src/components/discovery/DestinationBar");
var PlanPickerController_1 = require("../../src/components/PlanPickerController");
var trips_1 = require("../../src/services/trips");
var tokens_1 = require("../../src/theme/tokens");
var SessionContext_1 = require("../../src/context/SessionContext");
var LocationContext_1 = require("../../src/context/LocationContext");
var LocationChip_1 = require("../../src/components/LocationChip");
var ManualCityPicker_1 = require("../../src/components/ManualCityPicker");
var FollowingHighlightsStrip_1 = require("../../src/components/FollowingHighlightsStrip");
var useFollowingHighlights_1 = require("../../src/hooks/useFollowingHighlights");
var TABS = [
    { key: 'for_you', label: 'For You', Icon: lucide_react_native_1.Sparkles },
    { key: 'places', label: 'Places', Icon: lucide_react_native_1.MapPin },
    { key: 'food', label: 'Food', Icon: lucide_react_native_1.Coffee },
    { key: 'nightlife', label: 'Nightlife', Icon: lucide_react_native_1.Moon },
    { key: 'activities', label: 'Activities', Icon: lucide_react_native_1.Activity },
    { key: 'events', label: 'Events', Icon: lucide_react_native_1.Calendar },
    { key: 'beaches', label: 'Beaches', Icon: lucide_react_native_1.Waves },
    { key: 'transport', label: 'Transport', Icon: lucide_react_native_1.Navigation },
];
var VALID_CATEGORY_KEYS = TABS.map(function (t) { return t.key; });
var CONTEXT_MODES = [
    { key: 'near_me', label: 'Near Me', Icon: lucide_react_native_1.Navigation },
    { key: 'in_city', label: 'In City', Icon: lucide_react_native_1.MapPin },
    { key: 'going_soon', label: 'Going Soon', Icon: lucide_react_native_1.Calendar },
    { key: 'around_crew', label: 'Around Crew', Icon: lucide_react_native_1.Compass },
    { key: 'safe_nearby', label: 'Safe Nearby', Icon: lucide_react_native_1.Activity },
];
// ── Main screen ───────────────────────────────────────────────────────────────
function DiscoveryHub() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var isAuthed = (0, SessionContext_1.useSession)().isAuthed;
    var openPlanPicker = (0, PlanPickerController_1.usePlanPicker)().open;
    var _a = (0, LocationContext_1.useLocationContext)(), locationState = _a.locationState, showCityPicker = _a.showCityPicker, openCityPicker = _a.openCityPicker, closeCityPicker = _a.closeCityPicker, setManualCity = _a.setManualCity;
    var _b = (0, useFollowingHighlights_1.useFollowingHighlights)(), highlightUsers = _b.users, sessionViewedIds = _b.sessionViewedIds, markSessionViewed = _b.markSessionViewed;
    // Deep-link: ?category=food navigates to that tab on mount
    var params = (0, expo_router_1.useLocalSearchParams)();
    var initialCategory = (VALID_CATEGORY_KEYS.includes(params.category)
        ? params.category
        : 'for_you');
    var _c = (0, react_1.useState)(initialCategory), activeTab = _c[0], setActiveTab = _c[1];
    // Seed from location context city if available; fall back to 'Paris' so
    // content fetches start immediately without a blank screen.
    var _d = (0, react_1.useState)(function () { var _a; return (_a = locationState.place.city) !== null && _a !== void 0 ? _a : 'Paris'; }), destination = _d[0], setDestination = _d[1];
    var _e = (0, react_1.useState)('in_city'), contextMode = _e[0], setContextMode = _e[1];
    var _f = (0, react_1.useState)(null), selectedPlace = _f[0], setSelectedPlace = _f[1];
    var _g = (0, react_1.useState)(false), detailVisible = _g[0], setDetailVisible = _g[1];
    // Keep destination in sync when location city changes (GPS capture / manual set).
    (0, react_1.useEffect)(function () {
        if (locationState.place.city) {
            setDestination(locationState.place.city);
        }
    }, [locationState.place.city]);
    // Upgrade to the user's actual trip destination once trips load.
    // Only overrides if the user hasn't set a location yet.
    (0, react_1.useEffect)(function () {
        if (!isAuthed)
            return;
        (0, trips_1.listMyTrips)().then(function (rows) {
            var _a;
            var active = (_a = rows.find(function (r) { return r.status === 'planning' || r.status === 'active'; })) !== null && _a !== void 0 ? _a : rows[0];
            if ((active === null || active === void 0 ? void 0 : active.destinationCity) && !locationState.place.city) {
                setDestination(active.destinationCity);
            }
        }).catch(function () { });
    }, [isAuthed, locationState.place.city]);
    // Re-apply deep-link category if params change (e.g. in-app navigation)
    (0, react_1.useEffect)(function () {
        if (params.category && VALID_CATEGORY_KEYS.includes(params.category)) {
            setActiveTab(params.category);
        }
    }, [params.category]);
    var handleAddToPlan = (0, react_1.useCallback)(function (place) {
        var _a;
        setDetailVisible(false);
        openPlanPicker({
            id: place.id,
            type: 'place',
            title: place.name,
            category: place.category,
            locationName: (_a = place.address) !== null && _a !== void 0 ? _a : undefined,
        });
    }, [openPlanPicker]);
    var handleAddToPlanFromPlace = (0, react_1.useCallback)(function (place) {
        handleAddToPlan({ id: place.id, name: place.name, category: place.category, address: place.address });
    }, [handleAddToPlan]);
    var handleSelectPlace = function (place) {
        setSelectedPlace(place);
        setDetailVisible(true);
    };
    var handlePickDestination = (0, react_1.useCallback)(function (city) {
        setDestination(city);
        // Also persist as manual city in the location system
        setManualCity(city).catch(function () { });
    }, [setManualCity]);
    // Derive LocationChip props from current location state (no coordinates exposed)
    var locationChipProps = (function () {
        if (!locationState.place.city)
            return null;
        if (locationState.source === 'manual_city') {
            return { variant: 'trip_city', label: locationState.place.city };
        }
        return { variant: 'current_city', label: locationState.place.city };
    })();
    return (<react_native_1.View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Header ── */}
      <react_native_1.View style={styles.header}>
        <react_native_1.View style={styles.headerLeft}>
          <lucide_react_native_1.Compass size={22} color={tokens_1.color.signal}/>
          <react_native_1.Text style={styles.headerTitle}>Discover</react_native_1.Text>
          {locationChipProps && (<LocationChip_1.LocationChip {...locationChipProps} size="sm" muted/>)}
        </react_native_1.View>
        <DestinationBar_1.DestinationBar destination={destination} onChangeDestination={setDestination}/>
      </react_native_1.View>

      {/* ── Context mode selector ── */}
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.modeBar} contentContainerStyle={styles.modeBarContent}>
        {CONTEXT_MODES.map(function (m) {
            var active = m.key === contextMode;
            return (<react_native_1.Pressable key={m.key} style={[styles.modeChip, active && styles.modeChipActive]} onPress={function () { return setContextMode(m.key); }}>
              <m.Icon size={12} color={active ? tokens_1.color.signal : tokens_1.color.mute}/>
              <react_native_1.Text style={[styles.modeChipLabel, active && styles.modeChipLabelActive]}>
                {m.label}
              </react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.ScrollView>

      {/* ── Tab bar ── */}
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
        {TABS.map(function (tab) {
            var active = tab.key === activeTab;
            return (<react_native_1.Pressable key={tab.key} style={[styles.tab, active && styles.tabActive]} onPress={function () { return setActiveTab(tab.key); }}>
              <tab.Icon size={16} color={active ? tokens_1.color.signal : tokens_1.color.mute}/>
              <react_native_1.Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                {tab.label}
              </react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.ScrollView>

      {/* ── Following highlights strip ── */}
      {isAuthed && (<FollowingHighlightsStrip_1.FollowingHighlightsStrip users={highlightUsers} sessionViewedIds={sessionViewedIds} onMarkViewed={markSessionViewed}/>)}

      {/* ── Active tab content ── */}
      <react_native_1.View style={{ flex: 1 }}>
        {activeTab === 'for_you' ? (<ForYouTab_1.ForYouTab key={"".concat(destination, "-").concat(contextMode)} destination={destination} onAddToPlan={handleAddToPlan} contextMode={contextMode}/>) : (<DiscoveryCategoryTab_1.DiscoveryCategoryTab key={"".concat(activeTab, "-").concat(destination, "-").concat(contextMode)} category={activeTab} destination={destination} onSelectPlace={handleSelectPlace} onAddToPlan={handleAddToPlanFromPlace} onPickDestination={handlePickDestination} contextMode={contextMode}/>)}
      </react_native_1.View>

      {/* ── Place detail sheet ── */}
      <PlaceDetailSheet_1.PlaceDetailSheet place={selectedPlace} visible={detailVisible} onClose={function () { return setDetailVisible(false); }} onAddToPlan={handleAddToPlanFromPlace}/>

      {/* City picker — triggered from DestinationBar or location context */}
      <ManualCityPicker_1.ManualCityPicker visible={showCityPicker} onClose={closeCityPicker} onSelect={handlePickDestination}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: tokens_1.color.paper,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        gap: tokens_1.space.md,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        flex: 1,
    },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 20 }),
    tabBar: {
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        flexGrow: 0,
    },
    tabBarContent: {
        paddingHorizontal: tokens_1.space.md,
        gap: tokens_1.space.xs,
        paddingVertical: tokens_1.space.sm,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    tabActive: {
        backgroundColor: tokens_1.color.signal + '12',
        borderColor: tokens_1.color.signal + '40',
    },
    tabLabel: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.mute, fontSize: 12, fontWeight: '600' }),
    tabLabelActive: {
        color: tokens_1.color.signal,
        fontWeight: '700',
    },
    modeBar: {
        flexGrow: 0,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        backgroundColor: tokens_1.color.paper,
    },
    modeBarContent: {
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.xs,
        gap: tokens_1.space.xs,
    },
    modeChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 4,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: tokens_1.color.haze,
    },
    modeChipActive: {
        backgroundColor: tokens_1.color.signal + '14',
        borderColor: tokens_1.color.signal + '50',
    },
    modeChipLabel: {
        fontSize: 11,
        fontWeight: '600',
        color: tokens_1.color.mute,
    },
    modeChipLabelActive: {
        color: tokens_1.color.signal,
    },
});
