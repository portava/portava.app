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
exports.TripPlans = TripPlans;
exports.TripCircle = TripCircle;
exports.CompassTripBrief = CompassTripBrief;
exports.TripStamps = TripStamps;
exports.TripMapPreview = TripMapPreview;
exports.TripSafety = TripSafety;
exports.TripPostsSection = TripPostsSection;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var PassportStampCard_1 = require("./PassportStampCard");
var primitives_1 = require("./primitives");
var tokens_1 = require("../theme/tokens");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
var PLAN_TABS = [
    { key: 'joined', label: 'Joined' },
    { key: 'hosting', label: 'Hosting' },
    { key: 'requested', label: 'Requested' },
    { key: 'past', label: 'Past' },
    { key: 'saved', label: 'Saved' },
];
/* ── Plans ── */
function TripPlans(_a) {
    var plans = _a.plans;
    var _b = (0, react_1.useState)('joined'), tab = _b[0], setTab = _b[1];
    var visible = plans.filter(function (p) { return p.status === tab; });
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Plans" onAction={function () { return expo_router_1.router.push('/(tabs)/trips'); }} actionLabel="View all"/>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={p.tabs}>
        {PLAN_TABS.map(function (tb) { return (<react_native_1.Pressable key={tb.key} style={[p.tab, tab === tb.key && p.tabOn]} onPress={function () { return setTab(tb.key); }}>
            <react_native_1.Text style={[p.tabText, tab === tb.key && p.tabTextOn]}>{tb.label}</react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.ScrollView>
      {visible.length === 0 ? (<primitives_1.TravelEmptyState title="No trip plans yet" sub="Add one from Pulse or create your own." action="Browse Pulse" onAction={function () { return expo_router_1.router.push('/'); }}/>) : (<react_native_1.View style={p.list}>
          {visible.map(function (plan) { return (<react_native_1.View key={plan.id} style={p.card}>
              <react_native_1.View style={p.media}/>
              <react_native_1.View style={p.body}>
                <react_native_1.Text style={p.title} numberOfLines={1}>{plan.title}</react_native_1.Text>
                <react_native_1.View style={p.line}><lucide_react_native_1.Clock size={12} color={tokens_1.color.mute}/><react_native_1.Text style={p.lineText}>{plan.time}</react_native_1.Text></react_native_1.View>
                <react_native_1.View style={p.line}><lucide_react_native_1.MapPin size={12} color={tokens_1.color.mute}/><react_native_1.Text style={p.lineText} numberOfLines={1}>{plan.neighborhood}</react_native_1.Text></react_native_1.View>
                <react_native_1.Text style={p.going}>{plan.attendeeCount} going</react_native_1.Text>
              </react_native_1.View>
              <react_native_1.View style={p.actions}>
                <react_native_1.Pressable style={p.viewBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}><react_native_1.Text style={p.viewText}>View Plan</react_native_1.Text></react_native_1.Pressable>
                {plan.hasGroup ? (<react_native_1.Pressable style={p.msgBtn} onPress={function () { return expo_router_1.router.push('/messages'); }} hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.MessageCircle size={15} color={tokens_1.color.mute}/></react_native_1.Pressable>) : null}
              </react_native_1.View>
            </react_native_1.View>); })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
/* ── Member avatar with highlight ring ── */
function MemberAvatar(_a) {
    var u = _a.u, currentUserId = _a.currentUserId;
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)(u.id);
    var _b = (0, react_1.useState)(false), viewerOpen = _b[0], setViewerOpen = _b[1];
    var img = <react_native_1.Image source={{ uri: u.avatarUrl }} style={c.avatar}/>;
    if (!(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive)) {
        return (<react_native_1.Pressable key={u.id} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }} style={c.avatarWrap}>
        {img}
        <react_native_1.View style={c.onlineDot}/>
      </react_native_1.Pressable>);
    }
    return (<>
      <react_native_1.Pressable style={c.avatarWrap} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }}>
        <HighlightRing_1.HighlightRing size={48} hasActive allViewed={ringState.allViewed} onPress={function () { return setViewerOpen(true); }}>
          {img}
        </HighlightRing_1.HighlightRing>
        <react_native_1.View style={c.onlineDot}/>
      </react_native_1.Pressable>
      <HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={ringState.highlights} currentUserId={currentUserId !== null && currentUserId !== void 0 ? currentUserId : undefined} onClose={function () { return setViewerOpen(false); }}/>
    </>);
}
/* ── Trip Circle ── */
function TripCircle(_a) {
    var cityCount = _a.cityCount, inCity = _a.inCity, suggested = _a.suggested, currentUserId = _a.currentUserId;
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Trip Circle" onAction={function () { return expo_router_1.router.push('/circle'); }} actionLabel="View all"/>
      <react_native_1.View style={c.card}>
        <react_native_1.Text style={c.count}>{cityCount} buddies are in Cebu</react_native_1.Text>
        <react_native_1.View style={c.avatars}>
          {inCity.map(function (u) { return (<MemberAvatar key={u.id} u={u} currentUserId={currentUserId}/>); })}
          <react_native_1.Pressable style={c.inviteBtn} onPress={function () { return expo_router_1.router.push('/circle'); }}>
            <lucide_react_native_1.UserPlus size={16} color={tokens_1.color.signal}/>
          </react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.Pressable style={c.inviteRow} onPress={function () { return expo_router_1.router.push('/circle'); }}>
          <lucide_react_native_1.Plus size={14} color={tokens_1.color.signal}/><react_native_1.Text style={c.inviteText}>Invite more buddies</react_native_1.Text>
        </react_native_1.Pressable>

        <react_native_1.View style={c.divider}/>
        <react_native_1.Text style={c.suggestLabel}>People you may want to connect with</react_native_1.Text>
        <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={c.suggestRow}>
          {suggested.map(function (u) { return (<react_native_1.Pressable key={u.id} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }}>
              <react_native_1.Image source={{ uri: u.avatarUrl }} style={c.suggestAvatar}/>
            </react_native_1.Pressable>); })}
          <react_native_1.Pressable style={c.suggestMore} onPress={function () { return expo_router_1.router.push('/circle'); }}><lucide_react_native_1.ChevronRight size={18} color={tokens_1.color.mute}/></react_native_1.Pressable>
        </react_native_1.ScrollView>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Compass Trip Brief ── */
function CompassTripBrief() {
    var prompts = ['Build tonight from saved ideas', 'Find plans that fit my availability', 'Summarize this trip', 'Suggest what to do next'];
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Compass Trip Brief"/>
      <react_native_1.View style={cb.card}>
        <react_native_1.View style={cb.head}>
          <react_native_1.View style={cb.icon}><lucide_react_native_1.Sparkles size={18} color={tokens_1.color.onInk}/></react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={cb.title}>Let Compass build your perfect night</react_native_1.Text>
            <react_native_1.Text style={cb.sub}>Based on your trip city, dates, saved ideas, and availability.</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.Pressable style={cb.cta} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
          <lucide_react_native_1.Sparkles size={16} color={tokens_1.color.onInk}/><react_native_1.Text style={cb.ctaText}>Ask Compass</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.View style={cb.chips}>
          {prompts.map(function (pr) { return (<react_native_1.Pressable key={pr} style={cb.chip} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}>
              <react_native_1.Text style={cb.chipText}>{pr}</react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Trip Stamps ── */
function TripStamps(_a) {
    var stamps = _a.stamps;
    var earned = stamps.filter(function (s) { return !s.locked; });
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Trip Stamps" onAction={function () { return expo_router_1.router.push('/stamps'); }} actionLabel="View all"/>
      {stamps.length === 0 ? (<primitives_1.TravelEmptyState title="No trip stamps yet" sub="Earn stamps by joining plans, checking in, and sharing discoveries."/>) : (<react_native_1.View>
          <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ts.strip}>
            {stamps.map(function (s, i) { return <PassportStampCard_1.PassportStampCard key={s.id} stamp={s} rotate={((i % 3) - 1) * 2} onPress={function () { return expo_router_1.router.push('/stamps'); }}/>; })}
          </react_native_1.ScrollView>
          <react_native_1.Text style={ts.note}>{earned.length} earned · {stamps.length - earned.length} to unlock</react_native_1.Text>
        </react_native_1.View>)}
    </react_native_1.View>);
}
/* ── Map Preview (compact stub — approximate only, no live location) ── */
function TripMapPreview() {
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Map Preview" onAction={function () { return expo_router_1.router.push('/(tabs)/discovery'); }} actionLabel="View map"/>
      <react_native_1.View style={m.card}>
        <react_native_1.View style={m.map}>
          {/* stylized markers — approximate only */}
          <react_native_1.View style={[m.pin, { top: '30%', left: '25%', backgroundColor: tokens_1.color.signal }]}/>
          <react_native_1.View style={[m.pin, { top: '55%', left: '60%', backgroundColor: tokens_1.color.deep }]}/>
          <react_native_1.View style={[m.pin, { top: '40%', left: '75%', backgroundColor: tokens_1.color.success }]}/>
          <react_native_1.View style={m.cityLabel}><react_native_1.Text style={m.cityText}>Cebu City</react_native_1.Text></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={m.legend}>
          <react_native_1.View style={m.legendItem}><react_native_1.View style={[m.dot, { backgroundColor: tokens_1.color.signal }]}/><react_native_1.Text style={m.legendText}>Plans</react_native_1.Text></react_native_1.View>
          <react_native_1.View style={m.legendItem}><react_native_1.View style={[m.dot, { backgroundColor: tokens_1.color.deep }]}/><react_native_1.Text style={m.legendText}>Saved</react_native_1.Text></react_native_1.View>
          <react_native_1.View style={m.legendItem}><react_native_1.View style={[m.dot, { backgroundColor: tokens_1.color.success }]}/><react_native_1.Text style={m.legendText}>Hidden Gems</react_native_1.Text></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={m.noteRow}><lucide_react_native_1.Info size={11} color={tokens_1.color.mute}/><react_native_1.Text style={m.note}>Approximate areas only — exact locations stay private.</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Safety / Check-In (compact stub) ── */
function TripSafety() {
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Safety & Check-In"/>
      <react_native_1.View style={sf.card}>
        <react_native_1.View style={sf.head}>
          <react_native_1.View style={sf.icon}><lucide_react_native_1.ShieldCheck size={18} color={tokens_1.color.success}/></react_native_1.View>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={sf.title}>All good!</react_native_1.Text>
            <react_native_1.Text style={sf.sub}>You're checked in and sharing your trip with your Circle.</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={sf.btns}>
          <react_native_1.Pressable style={sf.btn} onPress={function () { return react_native_1.Alert.alert('Coming Soon', 'Safe Return check-ins are coming in a future update.', [{ text: 'OK' }]); }}><react_native_1.Text style={sf.btnText}>Start Safe Return</react_native_1.Text></react_native_1.Pressable>
          <react_native_1.Pressable style={sf.btn} onPress={function () { return react_native_1.Alert.alert('Coming Soon', 'Emergency Contacts management is coming in a future update.', [{ text: 'OK' }]); }}><react_native_1.Text style={sf.btnText}>Emergency Contacts</react_native_1.Text></react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.View style={sf.noteRow}><lucide_react_native_1.Info size={11} color={tokens_1.color.mute}/><react_native_1.Text style={sf.note}>Privacy-first — you control what your Circle sees.</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Trip Posts (compact stub) ── */
function TripPostsSection(_a) {
    var posts = _a.posts;
    return (<react_native_1.View>
      <primitives_1.TravelSectionHeader title="Trip Posts" onAction={posts.length ? function () { return expo_router_1.router.push('/(tabs)/passport'); } : undefined} actionLabel="View all"/>
      {posts.length === 0 ? (<primitives_1.TravelEmptyState title="No trip posts yet" sub="Share a moment from this trip — it’ll appear here and on your Passport." action="Add Post" onAction={function () { return expo_router_1.router.push('/create'); }}/>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tp.strip}>
          {posts.map(function (post) { return (<react_native_1.Pressable key={post.id} style={tp.tile} onPress={function () { return expo_router_1.router.push('/(tabs)/passport'); }}>
              <react_native_1.View style={tp.media}/>
              <react_native_1.Text style={tp.caption} numberOfLines={2}>{post.caption}</react_native_1.Text>
            </react_native_1.Pressable>); })}
          <react_native_1.Pressable style={tp.addTile} onPress={function () { return expo_router_1.router.push('/create'); }}>
            <lucide_react_native_1.ImagePlus size={20} color={tokens_1.color.signal}/><react_native_1.Text style={tp.addText}>Add Post</react_native_1.Text>
          </react_native_1.Pressable>
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
var p = react_native_1.StyleSheet.create({
    tabs: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md },
    tab: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    tabOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    tabText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 13 }),
    tabTextOn: { color: tokens_1.color.onInk },
    list: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg },
    card: __assign({ flexDirection: 'row', backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { width: 84, backgroundColor: tokens_1.color.deep },
    body: { flex: 1, padding: tokens_1.space.md, gap: 2 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    line: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    lineText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    going: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 2 }),
    actions: { justifyContent: 'center', alignItems: 'center', gap: tokens_1.space.sm, paddingRight: tokens_1.space.md },
    viewBtn: { borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: 6 },
    viewText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
    msgBtn: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
});
var c = react_native_1.StyleSheet.create({
    card: __assign({ marginHorizontal: tokens_1.space.lg, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    count: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    avatars: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    avatarWrap: {},
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: tokens_1.color.haze },
    onlineDot: { position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: tokens_1.color.success, borderWidth: 2, borderColor: tokens_1.color.paperRaised },
    inviteBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    inviteText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.signal }),
    divider: { height: 1, backgroundColor: tokens_1.color.haze },
    suggestLabel: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    suggestRow: { gap: tokens_1.space.sm, alignItems: 'center' },
    suggestAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.haze },
    suggestMore: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
});
var cb = react_native_1.StyleSheet.create({
    card: __assign({ marginHorizontal: tokens_1.space.lg, backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontSize: 16 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInkMute, marginTop: 1 }),
    cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    ctaText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm },
    chipText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '600', fontSize: 12 }),
});
var ts = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.xs },
    note: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm }),
});
var m = react_native_1.StyleSheet.create({
    card: __assign({ marginHorizontal: tokens_1.space.lg, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    map: { height: 150, backgroundColor: '#DDE6E8' },
    pin: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: tokens_1.color.paper },
    cityLabel: { position: 'absolute', top: '44%', left: '38%', backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    cityText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 11 }),
    legend: { flexDirection: 'row', gap: tokens_1.space.lg, padding: tokens_1.space.md },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    legendText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12 }),
    noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tokens_1.space.md, paddingBottom: tokens_1.space.md },
    note: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
var sf = react_native_1.StyleSheet.create({
    card: __assign({ marginHorizontal: tokens_1.space.lg, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.card),
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E3F1EA', alignItems: 'center', justifyContent: 'center' },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 15 }),
    sub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
    btns: { flexDirection: 'row', gap: tokens_1.space.sm },
    btn: { flex: 1, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm, alignItems: 'center' },
    btnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink, fontSize: 12 }),
    noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    note: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
var tp = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg },
    tile: { width: 140, gap: 6 },
    media: { height: 100, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.deep },
    caption: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontSize: 12 }),
    addTile: { width: 140, height: 130, borderRadius: tokens_1.radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', gap: 6 },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.signal }),
});
