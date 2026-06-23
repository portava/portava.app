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
 * MapView.web.tsx — web-safe stub for ItineraryMapView.
 * react-native-maps uses codegenNativeComponent (TurboModules) which is not
 * available in react-native-web. Metro automatically picks this file over
 * MapView.tsx when bundling for web, so the native file is unchanged.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
var CAT_PIN = {
    accommodation: '#3A7CA5',
    activity: '#2A9D5C',
    dining: '#E76F51',
    transport: '#7A4DBF',
    free_time: '#8B6914',
    meeting_point: '#E9C46A',
    other: '#888',
};
function ItineraryMapView(_a) {
    var items = _a.items, onItemPress = _a.onItemPress, selectedDay = _a.selectedDay, loading = _a.loading;
    var filtered = selectedDay === 'all' ? items : items.filter(function (i) { return i.dayDate === selectedDay; });
    if (loading) {
        return (<react_native_1.View style={s.empty}>
        <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      </react_native_1.View>);
    }
    if (filtered.length === 0) {
        return (<react_native_1.View style={s.empty}>
        <react_native_1.View style={s.emptyIcon}><lucide_react_native_1.Navigation size={28} color={tokens_1.color.faint}/></react_native_1.View>
        <react_native_1.Text style={s.emptyTitle}>No items for this day</react_native_1.Text>
        <react_native_1.Text style={s.emptyBody}>Add places or activities to see them here.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<react_native_1.ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
      <react_native_1.View style={s.banner}>
        <lucide_react_native_1.Navigation size={14} color={tokens_1.color.mute}/>
        <react_native_1.Text style={s.bannerText}>Map view is available in the mobile app.</react_native_1.Text>
      </react_native_1.View>
      {filtered.map(function (item) {
            var _a;
            var pinColor = (_a = CAT_PIN[item.category]) !== null && _a !== void 0 ? _a : '#888';
            return (<react_native_1.Pressable key={item.id} style={s.card} onPress={function () { return onItemPress(item); }}>
            <react_native_1.View style={[s.pinDot, { backgroundColor: pinColor }]}>
              <lucide_react_native_1.MapPin size={10} color="#fff"/>
            </react_native_1.View>
            <react_native_1.View style={s.cardText}>
              <react_native_1.Text style={s.cardTitle} numberOfLines={1}>{item.title}</react_native_1.Text>
              {item.locationName && (<react_native_1.Text style={s.cardLoc} numberOfLines={1}>{item.locationName}</react_native_1.Text>)}
            </react_native_1.View>
          </react_native_1.Pressable>);
        })}
    </react_native_1.ScrollView>);
}
var s = react_native_1.StyleSheet.create({
    list: { gap: 8, paddingBottom: 24 },
    empty: { alignItems: 'center', paddingVertical: 48, gap: 8 },
    emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    emptyTitle: __assign(__assign({}, tokens_1.type.title), { fontSize: 16, color: tokens_1.color.mute }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.faint, textAlign: 'center', maxWidth: 260 }),
    banner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: 12, marginBottom: 4 },
    bannerText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, flex: 1 }),
    card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: tokens_1.radius.md, padding: 10, borderWidth: 1, borderColor: tokens_1.color.haze },
    pinDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    cardText: { flex: 1, gap: 2 },
    cardTitle: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    cardLoc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
