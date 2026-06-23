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
exports.HiddenGemCard = HiddenGemCard;
exports.HiddenGemsSection = HiddenGemsSection;
exports.NeighborhoodCard = NeighborhoodCard;
exports.NeighborhoodsSection = NeighborhoodsSection;
exports.TravelerPickCard = TravelerPickCard;
exports.TravelerPicksSection = TravelerPicksSection;
exports.SavedIdeasSection = SavedIdeasSection;
exports.AskCompassCard = AskCompassCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var primitives_1 = require("./primitives");
var AttachController_1 = require("./AttachController");
/* small provisional note */
function Prov(_a) {
    var _b = _a.text, text = _b === void 0 ? 'Starter city note — provisional' : _b;
    return (<react_native_1.View style={g.provRow}>
      <lucide_react_native_1.Info size={11} color={tokens_1.color.mute}/>
      <react_native_1.Text style={g.provText}>{text}</react_native_1.Text>
    </react_native_1.View>);
}
/* ── Hidden Gems ── */
function HiddenGemCard(_a) {
    var gem = _a.gem;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View style={g.card}>
      <react_native_1.View style={g.media}>
        <react_native_1.View style={g.gemBadge}><lucide_react_native_1.Gem size={14} color={tokens_1.color.onInk}/></react_native_1.View>
        <react_native_1.Pressable style={g.saveIcon} hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={15} color={tokens_1.color.onInk}/></react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.View style={g.body}>
        <react_native_1.Text style={g.name} numberOfLines={1}>{gem.name}</react_native_1.Text>
        <react_native_1.View style={g.locRow}><lucide_react_native_1.MapPin size={11} color={tokens_1.color.mute}/><react_native_1.Text style={g.loc} numberOfLines={1}>{gem.neighborhood}</react_native_1.Text></react_native_1.View>
        <react_native_1.Text style={g.blurb} numberOfLines={2}>{gem.blurb}</react_native_1.Text>
        {gem.submittedBy ? (<react_native_1.View style={g.byRow}>
            <react_native_1.Image source={{ uri: gem.submittedBy.avatarUrl }} style={g.byAvatar}/>
            <react_native_1.Text style={g.by}>By {gem.submittedBy.name}</react_native_1.Text>
          </react_native_1.View>) : null}
        <react_native_1.View style={g.btnRow}>
          <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [g.addBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={function () { return attach.open({ id: gem.id, type: 'hidden_gem', title: gem.name, city: gem.city, category: 'Hidden Gem' }, 'plan'); }}>
            <react_native_1.Text style={g.addText}>Add to Plan</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
function HiddenGemsSection(_a) {
    var gems = _a.gems;
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Hidden Gems (By Travelers)" onAction={function () { return expo_router_1.router.push('/saved'); }}/>
      {gems.length === 0 ? (<primitives_1.TravelEmptyState title="No hidden gems yet" sub="Be the first to share a spot travelers should know about."/>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={g.strip}>
          {gems.slice(0, 5).map(function (gem) { return <HiddenGemCard key={gem.id} gem={gem}/>; })}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
/* ── Neighborhoods / Areas by Vibe ── */
function NeighborhoodCard(_a) {
    var n = _a.n;
    return (<react_native_1.Pressable style={nb.card} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
      <react_native_1.View style={nb.media}/>
      <react_native_1.View style={nb.overlay}>
        <react_native_1.Text style={nb.vibe} numberOfLines={1}>{n.vibe}</react_native_1.Text>
        <react_native_1.Text style={nb.area} numberOfLines={1}>{n.area}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function NeighborhoodsSection(_a) {
    var items = _a.items;
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Neighborhoods / Areas by Vibe" onAction={function () { return expo_router_1.router.push('/saved'); }}/>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={nb.strip}>
        {items.slice(0, 5).map(function (n) { return <NeighborhoodCard key={n.id} n={n}/>; })}
      </react_native_1.ScrollView>
      <react_native_1.View style={{ paddingHorizontal: tokens_1.space.lg }}><Prov text="Often associated with — starter city notes, provisional"/></react_native_1.View>
    </react_native_1.View>);
}
/* ── Traveler Picks ── */
function TravelerPickCard(_a) {
    var pick = _a.pick;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View style={tp.card}>
      <react_native_1.View style={tp.head}>
        <react_native_1.Image source={{ uri: pick.user.avatarUrl }} style={tp.avatar}/>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={tp.user}>{pick.user.name}</react_native_1.Text>
          <react_native_1.Text style={tp.time}>{pick.timeAgo}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={tp.tag}><react_native_1.Text style={tp.tagText}>{pick.tag}</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={tp.placeRow}>
        <react_native_1.Text style={tp.place} numberOfLines={1}>{pick.place}</react_native_1.Text>
        {pick.rating ? (<react_native_1.View style={tp.rating}><lucide_react_native_1.Star size={12} color={tokens_1.color.warn} fill={tokens_1.color.warn}/><react_native_1.Text style={tp.ratingText}>{pick.rating}</react_native_1.Text></react_native_1.View>) : null}
      </react_native_1.View>
      <react_native_1.Text style={tp.note} numberOfLines={1}>{pick.note}</react_native_1.Text>
      <react_native_1.View style={tp.btnRow}>
        <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [tp.saveBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} hitSlop={tokens_1.layout.hitSlop}>
          <lucide_react_native_1.Bookmark size={14} color={tokens_1.color.mute}/><react_native_1.Text style={tp.saveText}>Save</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [tp.addBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={function () { return attach.open({ id: pick.id, type: 'place', title: pick.place, city: pick.city, category: pick.tag }, 'plan'); }}>
          <react_native_1.Text style={tp.addText}>Add to Plan</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
function TravelerPicksSection(_a) {
    var picks = _a.picks;
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Traveler Picks" onAction={function () { return expo_router_1.router.push('/saved'); }}/>
      {picks.length === 0 ? (<primitives_1.TravelEmptyState title="No traveler picks yet" sub="Recommendations from travelers will show up here."/>) : (<react_native_1.View style={tp.strip}>
          {picks.slice(0, 3).map(function (p) { return <TravelerPickCard key={p.id} pick={p}/>; })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
/* ── Saved Ideas ── */
function SavedIdeasSection(_a) {
    var items = _a.items;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Saved Ideas" onAction={function () { return expo_router_1.router.push('/saved'); }}/>
      {items.length === 0 ? (<primitives_1.TravelEmptyState title="Nothing saved yet" sub="Save places, gems, and experiences to build your trip." action="Explore the city" onAction={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}/>) : (<react_native_1.View style={sv.list}>
          {items.map(function (it) { return (<react_native_1.View key={it.id} style={sv.row}>
              <react_native_1.View style={sv.thumb}/>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={sv.name} numberOfLines={1}>{it.name}</react_native_1.Text>
                <react_native_1.Text style={sv.meta} numberOfLines={1}>{it.type} · {it.neighborhood}</react_native_1.Text>
              </react_native_1.View>
              <react_native_1.Pressable style={function (_a) {
                var pressed = _a.pressed;
                return [sv.addBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
            }} onPress={function () { return attach.open({ id: it.id, type: 'place', title: it.name, city: it.neighborhood, category: it.type }, 'trip'); }}>
                <lucide_react_native_1.Plus size={13} color={tokens_1.color.signal}/><react_native_1.Text style={sv.addText}>Add to Trip</react_native_1.Text>
              </react_native_1.Pressable>
              <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={17} color={tokens_1.color.signal} fill={tokens_1.color.signal}/></react_native_1.Pressable>
            </react_native_1.View>); })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
/* ── Ask Compass card ── */
function AskCompassCard() {
    var prompts = ['Build a night from these', 'Find more like this', 'Turn saved ideas into a plan', "What matches my vibe?"];
    return (<react_native_1.View style={ac.card}>
      <react_native_1.View style={ac.head}>
        <react_native_1.View style={ac.icon}><lucide_react_native_1.Sparkles size={18} color={tokens_1.color.onInk}/></react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}>
          <react_native_1.Text style={ac.title}>Ask Compass</react_native_1.Text>
          <react_native_1.Text style={ac.sub}>Turn discoveries into a plan. Uses your saved ideas and interests.</react_native_1.Text>
        </react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={ac.prompts}>
        {prompts.map(function (p) { return (<react_native_1.Pressable key={p} style={function (_a) {
            var pressed = _a.pressed;
            return [ac.prompt, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
            <react_native_1.Text style={ac.promptText}>{p}</react_native_1.Text>
            <lucide_react_native_1.ChevronRight size={14} color={tokens_1.color.signal}/>
          </react_native_1.Pressable>); })}
      </react_native_1.View>
    </react_native_1.View>);
}
var g = react_native_1.StyleSheet.create({
    provRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: tokens_1.space.sm },
    provText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, fontStyle: 'italic' }),
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.xs },
    card: __assign({ width: 200, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { height: 120, backgroundColor: tokens_1.color.deep, padding: tokens_1.space.sm, justifyContent: 'space-between', flexDirection: 'row' },
    gemBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: tokens_1.color.success, alignItems: 'center', justifyContent: 'center' },
    saveIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
    body: { padding: tokens_1.space.md, gap: 3 },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    blurb: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, marginTop: 2 }),
    byRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
    byAvatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: tokens_1.color.haze },
    by: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    btnRow: { marginTop: tokens_1.space.sm },
    addBtn: { borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingVertical: 6, alignItems: 'center' },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
});
var nb = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.xs },
    card: __assign({ width: 150, height: 96, borderRadius: tokens_1.radius.md, overflow: 'hidden', backgroundColor: tokens_1.color.ink }, tokens_1.shadow.card),
    media: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: tokens_1.color.deep }),
    overlay: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { justifyContent: 'flex-end', padding: tokens_1.space.sm, backgroundColor: 'rgba(17,17,15,0.28)' }),
    vibe: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 14 }),
    area: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInkMute, fontSize: 11 }),
});
var tp = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg },
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: 6 }, tokens_1.shadow.card),
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: tokens_1.color.haze },
    user: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    tag: { backgroundColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.sm, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    tagText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700', fontSize: 11 }),
    placeRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    place: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, flex: 1 }),
    rating: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    ratingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700' }),
    note: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    btnRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: 2 },
    saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.sm, borderWidth: 1, borderColor: tokens_1.color.haze },
    saveText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '700' }),
    addBtn: { flex: 1, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingVertical: 6, alignItems: 'center' },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
});
var sv = react_native_1.StyleSheet.create({
    list: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg },
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.sm },
    thumb: { width: 44, height: 44, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.deep },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: tokens_1.space.sm, paddingVertical: 6, borderRadius: tokens_1.radius.sm, borderWidth: 1, borderColor: tokens_1.color.haze },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.signal, fontSize: 12 }),
});
var ac = react_native_1.StyleSheet.create({
    card: __assign({ marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.onInk, fontSize: 18 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInkMute, marginTop: 1 }),
    prompts: { gap: tokens_1.space.sm },
    prompt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.md },
    promptText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 14 }),
});
