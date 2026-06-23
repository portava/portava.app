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
exports.FitsCard = FitsCard;
exports.FlexibleStrip = FlexibleStrip;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var cebu_1 = require("../data/cebu");
var tokens_1 = require("../theme/tokens");
var HighlightRing_1 = require("./HighlightRing");
var HighlightViewer_1 = require("./HighlightViewer");
var useHighlightRingState_1 = require("../hooks/useHighlightRingState");
/* avatar stack for attendees */
function AvatarStack(_a) {
    var count = _a.count;
    var faces = cebu_1.users.slice(0, Math.min(3, count));
    return (<react_native_1.View style={styles.stack}>
      {faces.map(function (u, i) { return (<react_native_1.Image key={u.id} source={{ uri: u.avatarUrl }} style={[styles.stackImg, { marginLeft: i === 0 ? 0 : -10, zIndex: 3 - i }]}/>); })}
      {count > 3 && (<react_native_1.View style={[styles.plus, { marginLeft: -10 }]}><react_native_1.Text style={styles.plusText}>+{count - 3}</react_native_1.Text></react_native_1.View>)}
    </react_native_1.View>);
}
var VIBE = {
    food: 'Food', nightlife: 'Nightlife', beach: 'Beach', adventure: 'Adventure',
    culture: 'Culture', wellness: 'Wellness', events: 'Live Music',
};
/** Host avatar with HighlightRing support. */
function HostAvatar(_a) {
    var _b, _c;
    var host = _a.host;
    var ringState = (0, useHighlightRingState_1.useHighlightRingState)(host.id);
    var _d = (0, react_1.useState)(false), viewerOpen = _d[0], setViewerOpen = _d[1];
    return (<>
      <HighlightRing_1.HighlightRing hasActive={(_b = ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) !== null && _b !== void 0 ? _b : false} allViewed={(_c = ringState === null || ringState === void 0 ? void 0 : ringState.allViewed) !== null && _c !== void 0 ? _c : false} size={20} ringWidth={1.5} gap={1.5} onPress={(ringState === null || ringState === void 0 ? void 0 : ringState.hasActive) ? function () { return setViewerOpen(true); } : undefined}>
        <react_native_1.Image source={{ uri: host.avatarUrl }} style={styles.hostAvatar}/>
      </HighlightRing_1.HighlightRing>
      {(ringState === null || ringState === void 0 ? void 0 : ringState.highlights) && (<HighlightViewer_1.HighlightViewer visible={viewerOpen} highlights={ringState.highlights} onClose={function () { return setViewerOpen(false); }}/>)}
    </>);
}
/** Rich media plan card for "Fits your time". Horizontal-scroll width. */
function FitsCard(_a) {
    var _b, _c, _d, _e, _f;
    var ev = _a.ev;
    var time = new Date(ev.startAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    var joinLabel = ((_b = ev.attendeeCount) !== null && _b !== void 0 ? _b : 0) >= ((_c = ev.capacity) !== null && _c !== void 0 ? _c : 99) ? 'Full' : ev.kind === 'meetup' ? 'Request to Join' : 'Join Plan';
    return (<react_native_1.Pressable style={styles.card} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
      <react_native_1.View style={styles.media}>
        <react_native_1.View style={styles.timePill}><react_native_1.Text style={styles.timeText}>{time}</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={styles.matchPill}><react_native_1.Text style={styles.matchText}>Great match</react_native_1.Text></react_native_1.View>
      </react_native_1.View>
      <react_native_1.View style={styles.body}>
        <react_native_1.View style={styles.locRow}>
          <lucide_react_native_1.MapPin size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.loc} numberOfLines={1}>{ev.city}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Text style={styles.title} numberOfLines={2}>{ev.title}</react_native_1.Text>
        {ev.host && (<react_native_1.View style={styles.hostRow}>
            <HostAvatar host={ev.host}/>
            <react_native_1.Text style={styles.host}>Hosted by {ev.host.name.split(' ')[0]}</react_native_1.Text>
          </react_native_1.View>)}
        <react_native_1.View style={styles.metaRow}>
          <AvatarStack count={(_d = ev.attendeeCount) !== null && _d !== void 0 ? _d : 0}/>
          <react_native_1.View style={{ flex: 1 }}/>
          <react_native_1.Text style={styles.going}>{(_e = ev.attendeeCount) !== null && _e !== void 0 ? _e : 0} going</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View style={styles.vibes}>
          <react_native_1.View style={styles.vibe}><react_native_1.Text style={styles.vibeText}>{(_f = VIBE[ev.category]) !== null && _f !== void 0 ? _f : ev.category}</react_native_1.Text></react_native_1.View>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.joinBtn}><react_native_1.Text style={styles.joinText}>{joinLabel}</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
/** Horizontal "When you're flexible" buckets (Tonight/Tomorrow/...). */
function FlexibleStrip(_a) {
    var events = _a.events;
    var _b = (0, react_1.useState)(true), open = _b[0], setOpen = _b[1];
    if (!events.length)
        return null;
    var buckets = [
        { label: 'Tonight', n: events.filter(function (e) { return e.block === 'evening' || e.block === 'late'; }).length },
        { label: 'Tomorrow', n: Math.min(2, events.length) },
        { label: 'This Week', n: events.length },
        { label: 'This Weekend', n: Math.max(1, events.length - 1) },
    ].filter(function (b) { return b.n > 0; });
    return (<react_native_1.View style={fx.wrap}>
      <react_native_1.View style={fx.head}>
        <react_native_1.Text style={fx.title}>When you're flexible</react_native_1.Text>
        <react_native_1.View style={fx.badge}><react_native_1.Text style={fx.badgeText}>Outside your availability</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }} style={fx.viewAll}>
          <react_native_1.Text style={fx.viewAllText}>View all ({events.length})</react_native_1.Text>
          <lucide_react_native_1.ChevronRight size={14} color={tokens_1.color.deep}/>
        </react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={fx.strip}>
        {buckets.map(function (b) { return (<react_native_1.Pressable key={b.label} style={fx.bucket} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
            <react_native_1.View style={fx.bucketThumb}/>
            <react_native_1.View>
              <react_native_1.Text style={fx.bucketLabel}>{b.label}</react_native_1.Text>
              <react_native_1.Text style={fx.bucketCount}>{b.n} plans</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.Pressable>); })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: __assign({ width: 240, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { height: 130, backgroundColor: tokens_1.color.deep, justifyContent: 'space-between', flexDirection: 'row', padding: tokens_1.space.sm },
    timePill: { alignSelf: 'flex-start', backgroundColor: 'rgba(17,17,15,0.6)', paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    timeText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.onInk }),
    matchPill: { alignSelf: 'flex-start', backgroundColor: tokens_1.color.success, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    matchText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    body: { padding: tokens_1.space.md, gap: 6 },
    locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    loc: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 16 }),
    hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    hostAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.haze },
    host: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    stack: { flexDirection: 'row', alignItems: 'center' },
    stackImg: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: tokens_1.color.paperRaised, backgroundColor: tokens_1.color.haze },
    plus: { width: 24, height: 24, borderRadius: 12, backgroundColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: tokens_1.color.paperRaised },
    plusText: { fontSize: 9, fontWeight: '700', color: tokens_1.color.mute },
    going: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    vibes: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
    vibe: { backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3 },
    vibeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600', fontSize: 11 }),
    joinBtn: { marginTop: 4, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm, alignItems: 'center' },
    joinText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal }),
});
var fx = react_native_1.StyleSheet.create({
    wrap: { marginTop: tokens_1.space.xl },
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.md, flexWrap: 'wrap' },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    badge: { backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3 },
    badgeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    viewAllText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '700' }),
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    bucket: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.sm, paddingRight: tokens_1.space.lg },
    bucketThumb: { width: 40, height: 40, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.deep },
    bucketLabel: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    bucketCount: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
