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
var useMessaging_1 = require("../hooks/useMessaging");
/** Pulse Wall header — compact city title, status chips, and action icons. */
function PulseHeader(_a) {
    var _b = _a.city, city = _b === void 0 ? 'Cebu' : _b, _c = _a.cityFull, cityFull = _c === void 0 ? 'Cebu City' : _c, _d = _a.availabilityText, availabilityText = _d === void 0 ? 'Open tonight' : _d, _e = _a.filterCount, filterCount = _e === void 0 ? 0 : _e, onFilter = _a.onFilter, onCityPress = _a.onCityPress;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var unreadMessages = (0, useMessaging_1.useUnreadCounts)().messages;
    return (<react_native_1.View style={[styles.wrap, { paddingTop: insets.top + 4 }]}>
      {/* title row */}
      <react_native_1.View style={styles.titleRow}>
        <lucide_react_native_1.Activity size={16} color={tokens_1.color.signal}/>
        <react_native_1.Text style={styles.title}>{city} Pulse</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>

        {/* Telegraph / Messages icon */}
        <react_native_1.Pressable style={styles.iconBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/messages'); }} hitSlop={8}>
          <lucide_react_native_1.MessageCircle size={17} color={tokens_1.color.ink}/>
          {unreadMessages > 0 && (<react_native_1.View style={styles.badge}>
              <react_native_1.Text style={styles.badgeText}>{unreadMessages > 9 ? '9+' : String(unreadMessages)}</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.Pressable>

        {/* Filter icon */}
        <react_native_1.Pressable style={styles.iconBtn} onPress={onFilter} hitSlop={8}>
          <lucide_react_native_1.SlidersHorizontal size={17} color={tokens_1.color.ink}/>
          {filterCount > 0 && (<react_native_1.View style={styles.badge}><react_native_1.Text style={styles.badgeText}>{filterCount}</react_native_1.Text></react_native_1.View>)}
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* compact status chips */}
      <react_native_1.View style={styles.statusRow}>
        <react_native_1.Pressable style={styles.chip} onPress={onCityPress !== null && onCityPress !== void 0 ? onCityPress : (function () { return expo_router_1.router.push('/(tabs)/discovery'); })}>
          <lucide_react_native_1.MapPin size={11} color={tokens_1.color.deep}/>
          <react_native_1.Text style={styles.chipText} numberOfLines={1}>{cityFull || city}</react_native_1.Text>
        </react_native_1.Pressable>

        <react_native_1.Pressable style={styles.chip} onPress={function () { return expo_router_1.router.push('/availability'); }}>
          <react_native_1.View style={styles.liveDot}/>
          <react_native_1.Text style={styles.chipText} numberOfLines={1}>{availabilityText}</react_native_1.Text>
          <lucide_react_native_1.Pencil size={10} color={tokens_1.color.faint}/>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrap: {
        backgroundColor: tokens_1.color.paper,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { fontSize: 17, color: tokens_1.color.ink, fontWeight: '800' }),
    iconBtn: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens_1.color.paperRaised,
    },
    badge: {
        position: 'absolute',
        top: -3,
        right: -3,
        minWidth: 15,
        height: 15,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 11,
    },
    statusRow: {
        flexDirection: 'row',
        gap: 6,
        marginTop: 6,
        flexWrap: 'wrap',
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontSize: 11, color: tokens_1.color.ink, fontWeight: '600', maxWidth: 120 }),
    liveDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: tokens_1.color.success,
    },
});
