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
exports.DiscoveryHeader = DiscoveryHeader;
exports.CompassPickBlock = CompassPickBlock;
exports.CategoryChips = CategoryChips;
exports.FeaturedCard = FeaturedCard;
exports.SectionHead = SectionHead;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
/* ── Header ── */
function DiscoveryHeader(_a) {
    var _b = _a.city, city = _b === void 0 ? 'Cebu' : _b, _c = _a.filterCount, filterCount = _c === void 0 ? 0 : _c, onSearch = _a.onSearch, onFilter = _a.onFilter, onSaved = _a.onSaved;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<react_native_1.View style={[h.wrap, { paddingTop: insets.top + tokens_1.space.sm }]}>
      <react_native_1.View style={h.row}>
        <lucide_react_native_1.Compass size={26} color={tokens_1.color.signal}/>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={h.title}>{city} Discovery</react_native_1.Text>
          <react_native_1.Text style={h.sub}>Places, gems, and experiences that match your vibe</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={h.controls}>
        <react_native_1.Pressable style={h.iconBtn} onPress={onSearch} hitSlop={6}><lucide_react_native_1.Search size={20} color={tokens_1.color.ink}/></react_native_1.Pressable>
        <react_native_1.Pressable style={h.filterBtn} onPress={onFilter} hitSlop={6}>
          <lucide_react_native_1.SlidersHorizontal size={18} color={tokens_1.color.ink}/>
          <react_native_1.Text style={h.filterText}>Filter</react_native_1.Text>
          {filterCount > 0 && <react_native_1.View style={h.badge}><react_native_1.Text style={h.badgeText}>{filterCount}</react_native_1.Text></react_native_1.View>}
        </react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={h.savedBtn} onPress={onSaved} hitSlop={6}>
          <lucide_react_native_1.Bookmark size={17} color={tokens_1.color.signal}/>
          <react_native_1.Text style={h.savedText}>Saved</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Provisional label pill ── */
function ProvNote(_a) {
    var text = _a.text;
    return (<react_native_1.View style={p.row}>
      <lucide_react_native_1.Info size={12} color={tokens_1.color.mute}/>
      <react_native_1.Text style={p.text}>{text}</react_native_1.Text>
    </react_native_1.View>);
}
/* ── Compass Pick / For You ── */
function CompassPickBlock(_a) {
    var pick = _a.pick, side = _a.side;
    return (<react_native_1.View style={cp.wrap}>
      {/* hero pick */}
      <react_native_1.Pressable style={cp.hero} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
        <react_native_1.View style={cp.heroMedia}>
          <react_native_1.View style={cp.labelDark}><react_native_1.Text style={cp.labelDarkText}>COMPASS PICK</react_native_1.Text></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={cp.heroBody}>
          <react_native_1.View style={cp.heroTitleRow}>
            <react_native_1.Text style={cp.heroTitle}>{pick.name}</react_native_1.Text>
            <lucide_react_native_1.Sparkles size={16} color={tokens_1.color.signal}/>
          </react_native_1.View>
          <react_native_1.Text style={cp.heroSub}>Top nightlife spot right now</react_native_1.Text>
          <react_native_1.View style={cp.locRow}><lucide_react_native_1.MapPin size={13} color={tokens_1.color.onInk}/><react_native_1.Text style={cp.heroLoc}>{pick.neighborhood}, {pick.city}</react_native_1.Text></react_native_1.View>
          <react_native_1.View style={cp.matchRow}><lucide_react_native_1.Info size={13} color={tokens_1.color.onInk}/><react_native_1.Text style={cp.matchText}>Matches your nightlife interest</react_native_1.Text></react_native_1.View>
          <react_native_1.View style={cp.heroBtns}>
            <react_native_1.Pressable style={cp.ghostBtn}><react_native_1.Text style={cp.ghostText}>View Details</react_native_1.Text></react_native_1.Pressable>
            <react_native_1.Pressable style={cp.addBtn}><lucide_react_native_1.Plus size={15} color={tokens_1.color.onInk}/><react_native_1.Text style={cp.addText}>Add to Plan</react_native_1.Text></react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.View>
      </react_native_1.Pressable>

      {/* two side cards */}
      <react_native_1.View style={cp.sideCol}>
        {side.map(function (s) { return (<react_native_1.Pressable key={s.id} style={cp.sideCard} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
            <react_native_1.View style={cp.sideBody}>
              <react_native_1.View style={[cp.sideTag, s.source === 'traveler' ? cp.tagGreen : cp.tagGray]}>
                <react_native_1.Text style={[cp.sideTagText, s.source === 'traveler' ? cp.tagGreenText : cp.tagGrayText]}>
                  {s.source === 'traveler' ? 'POPULAR WITH TRAVELERS' : 'STARTER CITY NOTE'}
                </react_native_1.Text>
              </react_native_1.View>
              <react_native_1.Text style={cp.sideTitle}>{s.name}</react_native_1.Text>
              <react_native_1.Text style={cp.sideBlurb} numberOfLines={2}>{s.blurb}</react_native_1.Text>
              {s.source === 'traveler' && s.savedCount
                ? <react_native_1.View style={cp.savedRow}><lucide_react_native_1.Bookmark size={11} color={tokens_1.color.mute}/><react_native_1.Text style={cp.savedNote}>Saved by {s.savedCount} travelers</react_native_1.Text></react_native_1.View>
                : <ProvNote text="Starter city note — provisional"/>}
            </react_native_1.View>
            <react_native_1.View style={cp.sideThumb}/>
          </react_native_1.Pressable>); })}
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Category chips with icons ── */
function CategoryChips(_a) {
    var active = _a.active, onPick = _a.onPick, categories = _a.categories;
    return (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cc.row}>
      {categories.map(function (c) {
            var on = c === active;
            return (<react_native_1.Pressable key={c} style={[cc.chip, on && cc.chipOn]} onPress={function () { return onPick(c); }}>
            <react_native_1.Text style={[cc.chipText, on && cc.chipTextOn]}>{c}</react_native_1.Text>
          </react_native_1.Pressable>);
        })}
    </react_native_1.ScrollView>);
}
/* ── Featured experience card (horizontal) ── */
function FeaturedCard(_a) {
    var item = _a.item, onAdd = _a.onAdd;
    return (<react_native_1.Pressable style={fc.card} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
      <react_native_1.View style={fc.media}>
        <react_native_1.View style={fc.sparkle}><lucide_react_native_1.Sparkles size={14} color={tokens_1.color.onInk}/></react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={fc.body}>
        <react_native_1.Text style={fc.title} numberOfLines={1}>{item.name}</react_native_1.Text>
        <react_native_1.Text style={fc.sub} numberOfLines={1}>{item.blurb}</react_native_1.Text>
        <react_native_1.View style={fc.locRow}><lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/><react_native_1.Text style={fc.loc} numberOfLines={1}>{item.neighborhood}</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={fc.btnRow}>
          <react_native_1.Pressable style={fc.addBtn} onPress={onAdd}><react_native_1.Text style={fc.addText}>Add to Plan</react_native_1.Text></react_native_1.Pressable>
          <react_native_1.Pressable style={fc.saveBtn} hitSlop={6}><lucide_react_native_1.Bookmark size={16} color={tokens_1.color.mute}/></react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function SectionHead(_a) {
    var title = _a.title, onViewAll = _a.onViewAll;
    return (<react_native_1.View style={sh.row}>
      <react_native_1.Text style={sh.title}>{title}</react_native_1.Text>
      <react_native_1.View style={{ flex: 1 }}/>
      {onViewAll && (<react_native_1.Pressable style={sh.viewAll} onPress={onViewAll} hitSlop={6}>
          <react_native_1.Text style={sh.viewAllText}>View all</react_native_1.Text>
          <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.signal}/>
        </react_native_1.Pressable>)}
    </react_native_1.View>);
}
var h = react_native_1.StyleSheet.create({
    wrap: { backgroundColor: tokens_1.color.paper, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 28 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
    controls: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.md },
    iconBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
    filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.md, height: 42, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    filterText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    badgeText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    savedBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.md, height: 42, borderRadius: tokens_1.radius.pill, borderWidth: 1.5, borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.paperRaised },
    savedText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.signal }),
});
var p = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    text: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontStyle: 'italic' }),
});
var cp = react_native_1.StyleSheet.create({
    wrap: { flexDirection: 'row', gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg },
    hero: __assign({ flex: 1.3, borderRadius: tokens_1.radius.lg, overflow: 'hidden', backgroundColor: tokens_1.color.ink }, tokens_1.shadow.card),
    heroMedia: { height: 90, backgroundColor: tokens_1.color.deep, padding: tokens_1.space.md },
    labelDark: { alignSelf: 'flex-start', backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    labelDarkText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    heroBody: { padding: tokens_1.space.md, gap: 5 },
    heroTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    heroTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.onInk, fontSize: 19 }),
    heroSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.haze }),
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    heroLoc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk }),
    matchRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', alignSelf: 'flex-start', paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm, marginTop: 2 },
    matchText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontSize: 11 }),
    heroBtns: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    ghostBtn: { flex: 1, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm, alignItems: 'center' },
    ghostText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    addBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    sideCol: { flex: 1, gap: tokens_1.space.md },
    sideCard: { flex: 1, flexDirection: 'row', backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' },
    sideBody: { flex: 1, padding: tokens_1.space.sm, gap: 3 },
    sideTag: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    tagGray: { backgroundColor: tokens_1.color.haze },
    tagGreen: { backgroundColor: '#E3F1EA' },
    sideTagText: { fontFamily: 'Courier', fontSize: 7.5, fontWeight: '700', letterSpacing: 0.5 },
    tagGrayText: { color: tokens_1.color.mute },
    tagGreenText: { color: tokens_1.color.success },
    sideTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    sideBlurb: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    savedRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
    savedNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10 }),
    sideThumb: { width: 60, backgroundColor: tokens_1.color.deep },
});
var cc = react_native_1.StyleSheet.create({
    row: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    chipOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    chipTextOn: { color: tokens_1.color.onInk },
});
var fc = react_native_1.StyleSheet.create({
    card: __assign({ width: 160, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { height: 110, backgroundColor: tokens_1.color.deep, padding: tokens_1.space.sm },
    sparkle: { width: 26, height: 26, borderRadius: 13, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    body: { padding: tokens_1.space.md, gap: 3 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    btnRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    addBtn: { flex: 1, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingVertical: 6, alignItems: 'center' },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
    saveBtn: { padding: 4 },
});
var sh = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, marginBottom: tokens_1.space.md },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    viewAllText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
});
