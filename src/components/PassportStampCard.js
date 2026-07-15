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
exports.PassportStampCard = PassportStampCard;
exports.PassportStampStrip = PassportStampStrip;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var KIND_CATEGORY = {
    city: { category: 'ARRIVAL', Icon: lucide_react_native_1.Plane },
    plan: { category: 'JOINED', Icon: lucide_react_native_1.Users },
    gem: { category: 'FOUND', Icon: lucide_react_native_1.Gem },
    safe: { category: 'CHECKED', Icon: lucide_react_native_1.ShieldCheck },
    host: { category: 'HOSTED', Icon: lucide_react_native_1.MapPin },
    perk: { category: 'PERK', Icon: lucide_react_native_1.Gem },
};
/** Derive a clean CITY · CATEGORY view from a stamp, honest about dates. */
function toView(s) {
    var _a, _b;
    var km = (_a = KIND_CATEGORY[s.kind]) !== null && _a !== void 0 ? _a : { category: 'STAMP', Icon: lucide_react_native_1.MapPin };
    // city stamps: label is the city; non-city: label is the achievement
    var city = s.label.toUpperCase();
    // category: prefer an explicit sublabel hint, else kind-based
    var category = km.category;
    var Icon = km.Icon;
    var sub = ((_b = s.sublabel) !== null && _b !== void 0 ? _b : '').toLowerCase();
    if (sub.includes('night')) {
        category = 'NIGHTLIFE';
        Icon = lucide_react_native_1.Moon;
    }
    else if (sub.includes('food') || sub.includes('lechon')) {
        category = 'FOOD';
        Icon = lucide_react_native_1.Utensils;
    }
    // status / date — never fabricated
    var status;
    if (s.locked)
        status = 'LOCKED';
    else if (s.earnedAt)
        status = new Date(s.earnedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }).toUpperCase();
    else
        status = 'EARNED';
    return { city: city, category: category, status: status, Icon: Icon, locked: !!s.locked };
}
function PassportStampCard(_a) {
    var stamp = _a.stamp, _b = _a.rotate, rotate = _b === void 0 ? 0 : _b, onPress = _a.onPress;
    var v = toView(stamp);
    var tint = v.locked ? tokens_1.color.faint : tokens_1.color.deep;
    return (<react_native_1.Pressable onPress={onPress} hitSlop={4} style={function (_a) {
        var pressed = _a.pressed;
        return [{ opacity: pressed ? 0.85 : 1 }];
    }}>
      <react_native_1.View style={[sc.card, { borderColor: tint, transform: [{ rotate: "".concat(rotate, "deg") }] }, v.locked && sc.locked]}>
        {/* inner distressed ring */}
        <react_native_1.View style={[sc.innerRing, { borderColor: tint }]}/>
        {/* icon */}
        <react_native_1.View style={sc.iconRow}>
          {v.locked ? <lucide_react_native_1.Lock size={15} color={tint}/> : <v.Icon size={15} color={tint} strokeWidth={2}/>}
        </react_native_1.View>
        {/* city */}
        <react_native_1.Text style={[sc.city, { color: tint }]} numberOfLines={1}>{v.city}</react_native_1.Text>
        {/* category */}
        <react_native_1.Text style={[sc.category, { color: tint }]} numberOfLines={1}>{v.category}</react_native_1.Text>
        {/* status divider + date */}
        <react_native_1.View style={[sc.statusDivider, { backgroundColor: tint }]}/>
        <react_native_1.Text style={[sc.status, { color: tint }]} numberOfLines={1}>{v.status}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function PassportStampStrip(_a) {
    var stamps = _a.stamps;
    var earned = stamps.filter(function (s) { return !s.locked; });
    var featured = (earned.length ? __spreadArray(__spreadArray([], earned, true), stamps.filter(function (s) { return s.locked; }), true) : stamps).slice(0, 6);
    return (<react_native_1.View style={sc.stripWrap}>
      <react_native_1.Pressable style={sc.head} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
        <lucide_react_native_1.Plane size={14} color={tokens_1.color.deep}/>
        <react_native_1.Text style={sc.headTitle}>PASSPORT STAMPS</react_native_1.Text>
        <react_native_1.Text style={sc.headCount}>{earned.length} earned</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Text style={sc.viewAll}>View all</react_native_1.Text>
        <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.mute}/>
      </react_native_1.Pressable>
      {earned.length === 0 ? (<react_native_1.View style={sc.empty}><react_native_1.Text style={sc.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</react_native_1.Text></react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={sc.strip}>
          {featured.map(function (s, i) { return (<PassportStampCard key={s.id} stamp={s} rotate={((i % 3) - 1) * 2.5} onPress={function () { return expo_router_1.router.push('/stamps'); }}/>); })}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
var STAMP_W = 104;
var sc = react_native_1.StyleSheet.create({
    card: {
        width: STAMP_W, height: STAMP_W * 1.12,
        borderWidth: 2, borderStyle: 'dashed', borderRadius: tokens_1.radius.sm,
        backgroundColor: tokens_1.color.paper, alignItems: 'center', justifyContent: 'center',
        paddingHorizontal: 6, gap: 2,
    },
    locked: { backgroundColor: '#F2F0EB' },
    innerRing: { position: 'absolute', top: 4, left: 4, right: 4, bottom: 4, borderWidth: 0.8, borderRadius: 4, opacity: 0.3 },
    iconRow: { marginBottom: 1 },
    city: { fontFamily: 'Courier', fontWeight: '700', fontSize: 13, letterSpacing: 0.5, textAlign: 'center' },
    category: { fontFamily: 'Courier', fontWeight: '700', fontSize: 9, letterSpacing: 1, textAlign: 'center', opacity: 0.85 },
    statusDivider: { width: 36, height: 0.8, opacity: 0.4, marginVertical: 3 },
    status: { fontFamily: 'Courier', fontSize: 7.5, letterSpacing: 0.5, opacity: 0.7 },
    stripWrap: { marginTop: tokens_1.space.sm },
    head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm },
    headTitle: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', letterSpacing: 1.5, color: tokens_1.color.ink },
    headCount: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontFamily: 'Courier', fontSize: 11 }),
    viewAll: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze },
    emptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
