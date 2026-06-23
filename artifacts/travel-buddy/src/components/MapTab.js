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
exports.MapTab = MapTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
var map_1 = require("../services/map");
/** Single nearby-traveler chip: avatar with HighlightRing + name label. */
function NearbyUserChip(_a) {
    var _b, _c;
    var user = _a.user;
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)(user.id);
    var _d = (0, react_1.useState)(false), viewerOpen = _d[0], setViewerOpen = _d[1];
    return (<>
      <react_native_1.Pressable style={mp.chip} onPress={function () {
            if (ringState === null || ringState === void 0 ? void 0 : ringState.hasActive)
                setViewerOpen(true);
        }}>
        <HighlightRing_1.HighlightRing hasActive={(_b = ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) !== null && _b !== void 0 ? _b : false} allViewed={(_c = ringState === null || ringState === void 0 ? void 0 : ringState.allViewed) !== null && _c !== void 0 ? _c : false} size={44} ringWidth={2} gap={2} onPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setViewerOpen(true); } : undefined}>
          {user.avatarUrl ? (<react_native_1.Image source={{ uri: user.avatarUrl }} style={mp.chipAvatar}/>) : (<react_native_1.View style={[mp.chipAvatar, mp.chipAvatarFallback]}>
              <react_native_1.Text style={mp.chipAvatarInitial}>
                {user.name.charAt(0).toUpperCase()}
              </react_native_1.Text>
            </react_native_1.View>)}
        </HighlightRing_1.HighlightRing>
        <react_native_1.Text style={mp.chipName} numberOfLines={1}>
          {user.name.split(' ')[0]}
        </react_native_1.Text>
      </react_native_1.Pressable>
      {(ringState === null || ringState === void 0 ? void 0 : ringState.highlights) && (<HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={ringState.highlights} onClose={function () { return setViewerOpen(false); }}/>)}
    </>);
}
/** Map tab — placeholder with city-level location grid. No exact GPS exposed. */
function MapTab(_a) {
    var postcards = _a.postcards, currentCity = _a.currentCity, currentUserId = _a.currentUserId;
    var withLocation = postcards.filter(function (c) { return c.locationCity || c.locationName; });
    var cities = __spreadArray([], new Map(withLocation.map(function (c) { var _a; return [(_a = c.locationCity) !== null && _a !== void 0 ? _a : c.locationName, c]; })).entries(), true);
    var _b = (0, react_1.useState)([]), nearbyUsers = _b[0], setNearbyUsers = _b[1];
    var _c = (0, react_1.useState)(false), loadingNearby = _c[0], setLoadingNearby = _c[1];
    (0, react_1.useEffect)(function () {
        if (!currentCity || !currentUserId)
            return;
        setLoadingNearby(true);
        (0, map_1.listNearbyUsers)(currentCity, currentUserId)
            .then(setNearbyUsers)
            .catch(function () { return setNearbyUsers([]); })
            .finally(function () { return setLoadingNearby(false); });
    }, [currentCity, currentUserId]);
    var showNearby = loadingNearby || nearbyUsers.length > 0;
    return (<react_native_1.View style={mp.wrap}>
      <react_native_1.View style={mp.placeholder}>
        <react_native_1.Text style={mp.placeholderIcon}>🗺️</react_native_1.Text>
        <react_native_1.Text style={mp.placeholderText}>Interactive map coming soon</react_native_1.Text>
        <react_native_1.Text style={mp.placeholderSub}>City-level only — exact GPS is never shown</react_native_1.Text>
      </react_native_1.View>

      {/* Nearby Travelers strip — only shown when there's real data or loading */}
      {showNearby && (<>
          <react_native_1.Text style={mp.sectionLabel}>
            Nearby Travelers{currentCity ? " in ".concat(currentCity) : ''}
          </react_native_1.Text>
          {loadingNearby ? (<react_native_1.View style={mp.loadingRow}>
              <react_native_1.ActivityIndicator size="small" color={tokens_1.color.deep}/>
            </react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={mp.nearbyStrip}>
              {nearbyUsers.map(function (u) { return (<NearbyUserChip key={u.id} user={u}/>); })}
            </react_native_1.ScrollView>)}
        </>)}

      {cities.length > 0 && (<>
          <react_native_1.Text style={mp.citiesLabel}>Postcard cities ({cities.length})</react_native_1.Text>
          <react_native_1.View style={mp.chips}>
            {cities.map(function (_a) {
                var city = _a[0], card = _a[1];
                return (<react_native_1.View key={city} style={[mp.cityChip, card.locationVerified && mp.chipVerified]}>
                <react_native_1.Text style={mp.chipText}>{city}</react_native_1.Text>
                {card.locationVerified && <react_native_1.Text style={mp.chipBadge}>✓</react_native_1.Text>}
              </react_native_1.View>);
            })}
          </react_native_1.View>
        </>)}
    </react_native_1.View>);
}
var mp = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    placeholder: {
        height: 200, backgroundColor: tokens_1.color.paperRaised, borderRadius: 12,
        borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', gap: 8,
        marginBottom: tokens_1.space.lg,
    },
    placeholderIcon: { fontSize: 48 },
    placeholderText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    placeholderSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    sectionLabel: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.sm }),
    loadingRow: { height: 72, justifyContent: 'center', alignItems: 'center', marginBottom: tokens_1.space.lg },
    nearbyStrip: { gap: tokens_1.space.md, paddingBottom: tokens_1.space.lg, paddingRight: tokens_1.space.md },
    chip: { alignItems: 'center', gap: 4, width: 60 },
    chipAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: tokens_1.color.haze },
    chipAvatarFallback: { justifyContent: 'center', alignItems: 'center', backgroundColor: tokens_1.color.haze },
    chipAvatarInitial: { fontSize: 18, fontWeight: '600', color: tokens_1.color.deep },
    chipName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600', fontSize: 10, textAlign: 'center' }),
    citiesLabel: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.sm }),
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    cityChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: 20,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: 12, paddingVertical: 6,
    },
    chipVerified: { borderColor: tokens_1.color.success, backgroundColor: '#E3F1EA' },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
    chipBadge: { fontSize: 10, color: tokens_1.color.success },
});
