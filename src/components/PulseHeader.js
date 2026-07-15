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
exports.PulseHeader = PulseHeader;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
/** Pulse Wall header: city title + subtitle, search/filter/create, status row. */
function PulseHeader(_a) {
    var _b = _a.city, city = _b === void 0 ? 'Cebu' : _b, _c = _a.area, area = _c === void 0 ? 'Lahug District' : _c, _d = _a.cityFull, cityFull = _d === void 0 ? 'Cebu City, Philippines' : _d, _e = _a.availabilityText, availabilityText = _e === void 0 ? 'Open tonight' : _e, _f = _a.availabilityTime, availabilityTime = _f === void 0 ? '6:00 PM – 1:00 AM' : _f, _g = _a.travelerType, travelerType = _g === void 0 ? 'Solo Traveler' : _g, _h = _a.openToMeet, openToMeet = _h === void 0 ? true : _h, _j = _a.filterCount, filterCount = _j === void 0 ? 0 : _j, onSearch = _a.onSearch, onFilter = _a.onFilter, onCreate = _a.onCreate;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<react_native_1.View style={[styles.wrap, { paddingTop: insets.top + tokens_1.space.sm }]}>
      {/* title row */}
      <react_native_1.View style={styles.titleRow}>
        <lucide_react_native_1.Activity size={26} color={tokens_1.color.signal}/>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={styles.title}>{city} Pulse</react_native_1.Text>
          <react_native_1.Text style={styles.subtitle}>What travelers are sharing in your city</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.iconBtn} onPress={onSearch} hitSlop={6}>
          <lucide_react_native_1.Search size={20} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={styles.filterBtn} onPress={onFilter} hitSlop={6}>
          <lucide_react_native_1.SlidersHorizontal size={18} color={tokens_1.color.ink}/>
          <react_native_1.Text style={styles.filterText}>Filter</react_native_1.Text>
          {filterCount > 0 && <react_native_1.View style={styles.badge}><react_native_1.Text style={styles.badgeText}>{filterCount}</react_native_1.Text></react_native_1.View>}
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* status row */}
      <react_native_1.View style={styles.statusRow}>
        <react_native_1.Pressable style={styles.statusCard} onPress={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}>
          <lucide_react_native_1.MapPin size={16} color={tokens_1.color.deep}/>
          <react_native_1.View>
            <react_native_1.Text style={styles.statusMain}>{cityFull}</react_native_1.Text>
            <react_native_1.Text style={styles.statusSub}>{area}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={styles.statusCard} onPress={function () { return expo_router_1.router.push('/availability'); }}>
          <react_native_1.View style={styles.liveDot}/>
          <react_native_1.View>
            <react_native_1.Text style={styles.statusMain}>{availabilityText}</react_native_1.Text>
            <react_native_1.Text style={styles.statusSub}>{availabilityTime}</react_native_1.Text>
          </react_native_1.View>
          <lucide_react_native_1.Pencil size={13} color={tokens_1.color.faint}/>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={styles.statusCard} onPress={function () { return expo_router_1.router.push('/(tabs)/passport'); }}>
          <lucide_react_native_1.User size={16} color={tokens_1.color.ink}/>
          <react_native_1.View>
            <react_native_1.Text style={styles.statusMain}>{travelerType}</react_native_1.Text>
            <react_native_1.Text style={styles.statusSub}>{openToMeet ? 'Open to Meet' : 'Private'}</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={styles.createBtn} onPress={onCreate}>
          <react_native_1.Text style={styles.createText}>Create</react_native_1.Text>
          <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: tokens_1.color.paper, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 28 }),
    subtitle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
    iconBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.md, height: 42, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    filterText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    badgeText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.md, flexWrap: 'wrap' },
    statusCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm },
    statusMain: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    statusSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: tokens_1.color.success },
    createBtn: __assign({ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md }, tokens_1.shadow.card),
    createText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
