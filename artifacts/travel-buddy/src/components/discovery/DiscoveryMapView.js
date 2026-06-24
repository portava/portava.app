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
exports.DiscoveryMapView = DiscoveryMapView;
/**
 * DiscoveryMapView — renders Discovery venue pins on a react-native-maps MapView.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_maps_1 = require("react-native-maps");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
// ── Category pin colours ──────────────────────────────────────────────────────
var CAT_COLOR = {
    food: '#E76F51',
    nightlife: '#7A4DBF',
    places: '#3A7CA5',
    activities: '#2A9D5C',
    events: '#D4A017',
    beaches: '#0096C7',
    transport: '#888888',
    for_you: '#4A90D9',
};
// ── Region helper ─────────────────────────────────────────────────────────────
function computeRegion(places) {
    if (places.length === 0)
        return null;
    var lats = places.map(function (p) { return p.lat; });
    var lngs = places.map(function (p) { return p.lng; });
    var minLat = Math.min.apply(Math, lats), maxLat = Math.max.apply(Math, lats);
    var minLng = Math.min.apply(Math, lngs), maxLng = Math.max.apply(Math, lngs);
    return {
        latitude: (minLat + maxLat) / 2,
        longitude: (minLng + maxLng) / 2,
        latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.05),
        longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.05),
    };
}
// ── Component ─────────────────────────────────────────────────────────────────
function DiscoveryMapView(_a) {
    var places = _a.places, onSelectPlace = _a.onSelectPlace;
    var mappable = (0, react_1.useMemo)(function () { return places.filter(function (p) { return p.lat != null && p.lng != null; }); }, [places]);
    var region = (0, react_1.useMemo)(function () { return computeRegion(mappable); }, [mappable]);
    if (!region) {
        return (<react_native_1.View style={s.empty}>
        <react_native_1.View style={s.emptyIcon}>
          <lucide_react_native_1.MapPin size={28} color={tokens_1.color.faint}/>
        </react_native_1.View>
        <react_native_1.Text style={s.emptyTitle}>No pins available</react_native_1.Text>
        <react_native_1.Text style={s.emptyBody}>
          These places don't have coordinates yet. Try a different search area or category.
        </react_native_1.Text>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={s.root}>
      <react_native_maps_1.default style={s.map} initialRegion={region} showsUserLocation={false} showsMyLocationButton={false}>
        {mappable.map(function (place) {
            var _a, _b, _c;
            return (<react_native_maps_1.Marker key={place.id} coordinate={{ latitude: place.lat, longitude: place.lng }} pinColor={(_a = CAT_COLOR[place.category]) !== null && _a !== void 0 ? _a : tokens_1.color.signal} title={place.name} description={(_c = (_b = place.address) !== null && _b !== void 0 ? _b : place.type) !== null && _c !== void 0 ? _c : undefined} onPress={function () { return onSelectPlace(place); }}/>);
        })}
      </react_native_maps_1.default>
      <react_native_1.View style={s.badge}>
        <lucide_react_native_1.MapPin size={10} color="#fff"/>
        <react_native_1.Text style={s.badgeText}>
          {mappable.length} {mappable.length === 1 ? 'place' : 'places'}
        </react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var s = react_native_1.StyleSheet.create({
    root: {
        flex: 1,
        position: 'relative',
    },
    map: {
        flex: 1,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.xxl,
        paddingVertical: tokens_1.space.xxxl,
    },
    emptyIcon: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.title), { fontSize: 16, color: tokens_1.color.mute }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, textAlign: 'center', maxWidth: 260 }),
    badge: {
        position: 'absolute',
        bottom: 20,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: 'rgba(0,0,0,0.65)',
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    badgeText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '600',
    },
});
