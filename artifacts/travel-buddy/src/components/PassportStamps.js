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
exports.StampBadge = StampBadge;
exports.StampStrip = StampStrip;
exports.FeaturedStamps = FeaturedStamps;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var stampMotif_1 = require("../lib/stampMotif");
var IllustratedStamp_1 = require("./IllustratedStamp");
var tokens_1 = require("../theme/tokens");
var ICONS = {
    MapPin: lucide_react_native_1.MapPin,
    Users: lucide_react_native_1.Users,
    Gem: lucide_react_native_1.Gem,
    ShieldCheck: lucide_react_native_1.ShieldCheck,
    Crown: lucide_react_native_1.Crown,
    Ticket: lucide_react_native_1.Ticket,
    Fish: lucide_react_native_1.Fish,
    Landmark: lucide_react_native_1.Landmark,
    Soup: lucide_react_native_1.Soup,
    Building2: lucide_react_native_1.Building2,
    TorusIcon: lucide_react_native_1.Building2, // tokyo placeholder until a temple icon/Level-2 art
};
function iconFor(key) {
    var _a;
    return (_a = ICONS[key]) !== null && _a !== void 0 ? _a : lucide_react_native_1.MapPin;
}
/** One collectible stamp badge. Motif-driven: city icon+accent, else category. */
function StampBadge(_a) {
    var _b;
    var stamp = _a.stamp, _c = _a.size, size = _c === void 0 ? 84 : _c, _d = _a.rotate, rotate = _d === void 0 ? 0 : _d, onPress = _a.onPress;
    var motif = (0, stampMotif_1.motifFor)(stamp);
    var Icon = iconFor(motif.iconKey);
    var locked = stamp.locked;
    var tint = locked ? tokens_1.color.faint : motif.accent;
    var isOval = motif.frame === 'oval';
    var inner = (<react_native_1.View style={[
            styles.badge,
            {
                width: size, height: size,
                borderColor: tint,
                borderRadius: isOval ? size / 2 : tokens_1.radius.md,
                transform: [{ rotate: "".concat(rotate, "deg") }],
            },
            locked && styles.badgeLocked,
        ]}>
      <react_native_1.View style={[
            styles.innerRing,
            { borderColor: tint, borderRadius: isOval ? size / 2 : tokens_1.radius.sm },
        ]}/>
      <Icon size={size * 0.24} color={tint} strokeWidth={2.2}/>
      <react_native_1.Text style={[styles.badgeLabel, { color: tint, fontSize: size * 0.12 }]} numberOfLines={1}>
        {stamp.label}
      </react_native_1.Text>
      {(motif.caption || stamp.sublabel) ? (<react_native_1.Text style={[styles.badgeSub, { color: tint, fontSize: size * 0.095 }]} numberOfLines={1}>
          {(_b = motif.caption) !== null && _b !== void 0 ? _b : stamp.sublabel}
        </react_native_1.Text>) : null}
    </react_native_1.View>);
    return onPress ? <react_native_1.Pressable onPress={onPress} hitSlop={4}>{inner}</react_native_1.Pressable> : inner;
}
/** Small horizontal hero strip for the profile. 4–6 featured, taps to /stamps. */
function StampStrip(_a) {
    var stamps = _a.stamps;
    var earned = stamps.filter(function (s) { return !s.locked; });
    var featured = (earned.length ? earned : stamps).slice(0, 6);
    return (<react_native_1.View style={styles.stripWrap}>
      <react_native_1.Pressable style={styles.stripHead} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
        <react_native_1.Text style={styles.stripTitle}>Passport Stamps</react_native_1.Text>
        <react_native_1.Text style={styles.stripCount}>{earned.length} earned</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Text style={styles.viewAll}>View all</react_native_1.Text>
        <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.mute}/>
      </react_native_1.Pressable>
      {earned.length === 0 ? (<react_native_1.View style={styles.emptyStrip}>
          <react_native_1.Text style={styles.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</react_native_1.Text>
        </react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {featured.map(function (s, i) { return (<StampBadge key={s.id} stamp={s} size={76} rotate={((i % 3) - 1) * 3} onPress={function () { return expo_router_1.router.push('/stamps'); }}/>); })}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    badge: {
        borderWidth: 2, borderStyle: 'dashed',
        alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 4,
        backgroundColor: tokens_1.color.paper,
    },
    badgeLocked: { opacity: 0.6 },
    innerRing: { position: 'absolute', top: 5, left: 5, right: 5, bottom: 5, borderWidth: 1, opacity: 0.3 },
    badgeLabel: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', textAlign: 'center' }),
    badgeSub: { fontFamily: 'Courier', opacity: 0.85, letterSpacing: 0.5 },
    stripWrap: { marginTop: tokens_1.space.lg },
    stripHead: { flexDirection: 'row', alignItems: 'baseline', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm },
    stripTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    stripCount: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.signal }),
    viewAll: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    emptyStrip: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze },
    emptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
/* ── Featured strip using Level-2 illustrated stamps (matches the mockup) ── */
function citySlugOf(stamp) {
    var _a;
    var hay = "".concat(stamp.label, " ").concat((_a = stamp.sublabel) !== null && _a !== void 0 ? _a : '').toLowerCase();
    for (var _i = 0, _b = Object.keys(IllustratedStamp_1.CITY_ART); _i < _b.length; _i++) {
        var slug = _b[_i];
        if (hay.includes(slug))
            return slug;
    }
    return null;
}
function FeaturedStamps(_a) {
    var stamps = _a.stamps;
    var earned = stamps.filter(function (s) { return !s.locked; });
    var featured = (earned.length ? earned : stamps).slice(0, 5);
    return (<react_native_1.View style={fs.wrap}>
      <react_native_1.Pressable style={fs.head} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
        <lucide_react_native_1.Sparkles size={15} color={tokens_1.color.signal}/>
        <react_native_1.Text style={fs.title}>FEATURED STAMPS</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Text style={fs.viewAll}>View all</react_native_1.Text>
        <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.mute}/>
      </react_native_1.Pressable>
      {earned.length === 0 ? (<react_native_1.View style={fs.empty}><react_native_1.Text style={fs.emptyText}>No stamps yet — join a plan or visit a city to earn your first.</react_native_1.Text></react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={fs.strip}>
          {featured.map(function (s) {
                var _a;
                var slug = citySlugOf(s);
                var isExp = !slug; // non-city -> experience-style stamp
                return (<react_native_1.Pressable key={s.id} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
                <IllustratedStamp_1.IllustratedStamp slug={slug !== null && slug !== void 0 ? slug : 'generic'} size={92} locked={s.locked} experienceLabel={isExp ? { title: s.label, sub: (_a = s.sublabel) !== null && _a !== void 0 ? _a : '', tint: tokens_1.color.signal } : undefined}/>
              </react_native_1.Pressable>);
            })}
          {/* "More stamps" locked tile */}
          <react_native_1.Pressable style={fs.more} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
            <lucide_react_native_1.Lock size={20} color={tokens_1.color.faint}/>
            <react_native_1.Text style={fs.moreText}>More{'\n'}Stamps</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
var fs = react_native_1.StyleSheet.create({
    wrap: { marginTop: tokens_1.space.sm },
    head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.sm },
    title: { fontFamily: 'Courier', fontSize: 12, fontWeight: '700', letterSpacing: 1.5, color: tokens_1.color.ink },
    viewAll: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze },
    emptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    more: { width: 92, height: 120, borderRadius: tokens_1.radius.md, borderWidth: 2, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', gap: 6 },
    moreText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontWeight: '600', textAlign: 'center', fontFamily: 'Courier' }),
});
