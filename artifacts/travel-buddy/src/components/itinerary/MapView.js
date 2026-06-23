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
exports.ItineraryMapView = ItineraryMapView;
/**
 * MapView — shows plan items with GPS coordinates on a native map via react-native-maps.
 * Items without coordinates are shown in a fallback list below the map.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_maps_1 = require("react-native-maps");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
// ── Category pin colours ──────────────────────────────────────────────────────
var CAT_PIN = {
    accommodation: '#3A7CA5',
    activity: '#2A9D5C',
    dining: '#E76F51',
    transport: '#7A4DBF',
    free_time: '#8B6914',
    meeting_point: '#E9C46A',
    other: '#888',
};
// ── Region helper ─────────────────────────────────────────────────────────────
function computeRegion(items) {
    if (items.length === 0)
        return null;
    var lats = items.map(function (i) { return i.lat; });
    var lngs = items.map(function (i) { return i.lng; });
    var minLat = Math.min.apply(Math, lats), maxLat = Math.max.apply(Math, lats);
    var minLng = Math.min.apply(Math, lngs), maxLng = Math.max.apply(Math, lngs);
    var latDelta = Math.max((maxLat - minLat) * 1.5, 0.04);
    var lngDelta = Math.max((maxLng - minLng) * 1.5, 0.04);
    return {
        latitude: (minLat + maxLat) / 2,
        longitude: (minLng + maxLng) / 2,
        latitudeDelta: latDelta,
        longitudeDelta: lngDelta,
    };
}
// ── Pin list card (fallback for items without coordinates) ────────────────────
function PinListCard(_a) {
    var _b;
    var item = _a.item, onPress = _a.onPress;
    var pinColor = (_b = CAT_PIN[item.category]) !== null && _b !== void 0 ? _b : '#888';
    return (<react_native_1.Pressable style={pl.card} onPress={onPress}>
      <react_native_1.View style={[pl.pinDot, { backgroundColor: pinColor }]}>
        <lucide_react_native_1.MapPin size={10} color="#fff"/>
      </react_native_1.View>
      <react_native_1.View style={pl.text}>
        <react_native_1.Text style={pl.title} numberOfLines={1}>{item.title}</react_native_1.Text>
        {item.locationName && (<react_native_1.Text style={pl.loc} numberOfLines={1}>{item.locationName}</react_native_1.Text>)}
      </react_native_1.View>
    </react_native_1.Pressable>);
}
// ── Main component ────────────────────────────────────────────────────────────
function ItineraryMapView(_a) {
    var items = _a.items, onItemPress = _a.onItemPress, selectedDay = _a.selectedDay, loading = _a.loading;
    var filtered = selectedDay === 'all' ? items : items.filter(function (i) { return i.dayDate === selectedDay; });
    var coordItems = filtered.filter(function (i) { return i.lat != null && i.lng != null; });
    var noCoordItems = filtered.filter(function (i) { return i.lat == null || i.lng == null; });
    if (loading) {
        return (<react_native_1.View style={mv.empty}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    if (filtered.length === 0) {
        return (<react_native_1.View style={mv.empty}>
        <react_native_1.View style={mv.emptyIcon}><lucide_react_native_1.Navigation size={28} color={tokens_1.color.faint}/></react_native_1.View>
        <react_native_1.Text style={mv.emptyTitle}>No items for this day</react_native_1.Text>
        <react_native_1.Text style={mv.emptyBody}>Add places or activities to see them here.</react_native_1.Text>
      </react_native_1.View>);
    }
    var region = computeRegion(coordItems);
    return (<react_native_1.ScrollView contentContainerStyle={mv.wrap} showsVerticalScrollIndicator={false}>
      {coordItems.length > 0 && region ? (<react_native_1.View style={mv.mapSection}>
          <react_native_1.Text style={mv.sectionLabel}>On the map</react_native_1.Text>
          <react_native_maps_1.default style={mv.mapSurface} initialRegion={region} showsUserLocation={false} showsMyLocationButton={false}>
            {coordItems.map(function (item) {
                var _a, _b;
                return (<react_native_maps_1.Marker key={item.id} coordinate={{ latitude: item.lat, longitude: item.lng }} pinColor={(_a = CAT_PIN[item.category]) !== null && _a !== void 0 ? _a : '#888'} title={item.title} description={(_b = item.locationName) !== null && _b !== void 0 ? _b : undefined} onPress={function () { return onItemPress(item); }}/>);
            })}
          </react_native_maps_1.default>
        </react_native_1.View>) : (<react_native_1.View style={mv.noMapBanner}>
          <lucide_react_native_1.Navigation size={16} color={tokens_1.color.mute}/>
          <react_native_1.Text style={mv.noMapText}>Add places with public locations to see them on the map.</react_native_1.Text>
        </react_native_1.View>)}

      {noCoordItems.length > 0 && (<react_native_1.View style={mv.listSection}>
          <react_native_1.Text style={mv.sectionLabel}>
            {coordItems.length > 0 ? 'Other items' : 'All items'}
          </react_native_1.Text>
          {noCoordItems.map(function (item) { return (<PinListCard key={item.id} item={item} onPress={function () { return onItemPress(item); }}/>); })}
        </react_native_1.View>)}
    </react_native_1.ScrollView>);
}
// ── Styles ────────────────────────────────────────────────────────────────────
var mv = react_native_1.StyleSheet.create({
    wrap: { gap: 16, paddingBottom: 24 },
    empty: { alignItems: 'center', paddingVertical: 48, gap: 8 },
    emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: __assign(__assign({}, tokens_1.type.title), { fontSize: 16, color: tokens_1.color.mute }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, textAlign: 'center', maxWidth: 260 }),
    mapSection: { gap: 8 },
    mapSurface: { height: 300, borderRadius: tokens_1.radius.lg, overflow: 'hidden' },
    listSection: { gap: 8 },
    sectionLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }),
    noMapBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 12 },
    noMapText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
});
var pl = react_native_1.StyleSheet.create({
    card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: tokens_1.radius.md, padding: 10, borderWidth: 1, borderColor: tokens_1.color.haze },
    pinDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    text: { flex: 1, gap: 2 },
    title: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
