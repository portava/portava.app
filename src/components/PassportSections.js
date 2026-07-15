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
exports.TrustChip = TrustChip;
exports.CompactStats = CompactStats;
exports.TrustRow = TrustRow;
exports.BuddyPreview = BuddyPreview;
exports.PostcardList = PostcardList;
exports.PassportSection = PassportSection;
exports.StatsRow = StatsRow;
exports.TrustValueCard = TrustValueCard;
exports.PlanRow = PlanRow;
exports.BuddyRow = BuddyRow;
exports.PerksRow = PerksRow;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("./ui");
var tokens_1 = require("../theme/tokens");
var TIER_LABEL = {
    new: 'New Traveler', rising: 'Rising', trusted: 'Trusted', pillar: 'Community Pillar',
};
/* Small Trust credibility chip — sits beside the name in the header. */
function TrustChip(_a) {
    var score = _a.score;
    return (<react_native_1.View style={styles.trustChip}>
      <lucide_react_native_1.ShieldCheck size={12} color={tokens_1.color.success}/>
      <react_native_1.Text style={styles.trustChipText}>Trust {score}</react_native_1.Text>
    </react_native_1.View>);
}
/* Compact 4-stat row for the header area. */
function CompactStats(_a) {
    var stats = _a.stats;
    var items = [
        { n: stats.citiesVisited, label: 'Cities' },
        { n: stats.plansJoined, label: 'Plans' },
        { n: stats.buddies, label: 'Buddies' },
        { n: stats.stamps, label: 'Stamps' },
    ];
    return (<react_native_1.View style={styles.compactWrap}>
      {items.map(function (it, i) { return (<react_1.default.Fragment key={it.label}>
          {i > 0 && <react_native_1.View style={styles.compactDivider}/>}
          <react_native_1.View style={styles.compactCell}>
            <react_native_1.Text style={styles.compactN}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</react_native_1.Text>
            <react_native_1.Text style={styles.compactL}>{it.label}</react_native_1.Text>
          </react_native_1.View>
        </react_1.default.Fragment>); })}
    </react_native_1.View>);
}
/* Compact one-line trust row — denser than the full card. */
function TrustRow(_a) {
    var trust = _a.trust;
    return (<react_native_1.View style={styles.trustRow}>
      <lucide_react_native_1.ShieldCheck size={16} color={tokens_1.color.success}/>
      <react_native_1.Text style={styles.trustRowTier}>{TIER_LABEL[trust.tier]}</react_native_1.Text>
      <react_native_1.View style={styles.trustRowBar}>
        <react_native_1.View style={[styles.trustRowFill, { width: "".concat(trust.score, "%") }]}/>
      </react_native_1.View>
      <react_native_1.Text style={styles.trustRowScore}>{trust.score}</react_native_1.Text>
    </react_native_1.View>);
}
/* Compact buddy preview — avatars + count, "View Circle". */
function BuddyPreview(_a) {
    var buddies = _a.buddies;
    var shown = buddies.slice(0, 5);
    return (<react_native_1.View style={styles.buddyPrev}>
      <react_native_1.View style={styles.buddyStack}>
        {shown.map(function (u, i) { return (<react_native_1.Pressable key={u.id} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }} style={[styles.buddyStackAvatar, { marginLeft: i === 0 ? 0 : -12, zIndex: shown.length - i }]}>
            <react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.buddyStackImg}/>
          </react_native_1.Pressable>); })}
      </react_native_1.View>
      <react_native_1.Text style={styles.buddyPrevText}>{buddies.length} buddies</react_native_1.Text>
      <react_native_1.View style={{ flex: 1 }}/>
      <react_native_1.Pressable style={styles.findBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/discovery'); }}>
        <react_native_1.Text style={styles.findBtnText}>Find buddies</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
/* Postcards/Posts tab — user's posted content with media, caption, location, date. */
function PostcardList(_a) {
    var posts = _a.posts;
    if (posts.length === 0) {
        return (<react_native_1.View style={styles.pcEmpty}>
        <react_native_1.Text style={styles.pcEmptyTitle}>No postcards yet</react_native_1.Text>
        <react_native_1.Text style={styles.pcEmptySub}>Share a moment from your travels and it’ll show up here.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={{ gap: tokens_1.space.md }}>
      {posts.map(function (p) {
            var _a;
            return (<react_native_1.Pressable key={p.id} style={styles.pc} onPress={function () { return expo_router_1.router.push("/post/".concat(p.id)); }}>
          {p.media[0] ? (<react_native_1.Image source={{ uri: p.media[0].url }} style={styles.pcMedia}/>) : null}
          <react_native_1.View style={styles.pcBody}>
            <react_native_1.View style={styles.pcMetaRow}>
              <ui_1.Stamp label={p.destination.city} tone="deep"/>
              <react_native_1.Text style={styles.pcDate}>{new Date(p.createdAt).toLocaleDateString()}</react_native_1.Text>
            </react_native_1.View>
            {(p.title || p.caption) ? (<react_native_1.Text style={styles.pcCaption} numberOfLines={3}>{(_a = p.title) !== null && _a !== void 0 ? _a : p.caption}</react_native_1.Text>) : null}
            <react_native_1.Text style={styles.pcEngage}>{p.likeCount} likes · {p.commentCount} comments</react_native_1.Text>
          </react_native_1.View>
        </react_native_1.Pressable>);
        })}
    </react_native_1.View>);
}
/* Section wrapper — consistent header + optional action, used by all below. */
function PassportSection(_a) {
    var title = _a.title, action = _a.action, onAction = _a.onAction, children = _a.children;
    return (<react_native_1.View style={styles.section}>
      <react_native_1.View style={styles.sectionHead}>
        <react_native_1.Text style={styles.sectionTitle}>{title}</react_native_1.Text>
        {action ? (<react_native_1.Pressable onPress={onAction} hitSlop={8} style={styles.sectionAction}>
            <react_native_1.Text style={styles.sectionActionText}>{action}</react_native_1.Text>
            <lucide_react_native_1.ChevronRight size={14} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>) : null}
      </react_native_1.View>
      {children}
    </react_native_1.View>);
}
/* Travel stats — extends the original 3-stat row to the full six. */
function StatsRow(_a) {
    var stats = _a.stats, trustScore = _a.trustScore;
    var items = [
        { n: stats.citiesVisited, label: 'cities' },
        { n: stats.plansJoined, label: 'plans' },
        { n: stats.buddies, label: 'buddies' },
        { n: stats.stamps, label: 'stamps' },
        { n: trustScore, label: 'trust' },
        { n: stats.hostedPlans, label: 'hosted' },
    ];
    return (<react_native_1.View style={styles.statsWrap}>
      {items.map(function (it) { return (<react_native_1.View key={it.label} style={styles.statCell}>
          <react_native_1.Text style={styles.statN}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</react_native_1.Text>
          <react_native_1.Text style={styles.statL}>{it.label}</react_native_1.Text>
        </react_native_1.View>); })}
    </react_native_1.View>);
}
function TrustValueCard(_a) {
    var trust = _a.trust;
    return (<react_native_1.View style={styles.trust}>
      <react_native_1.View style={styles.trustTop}>
        <lucide_react_native_1.ShieldCheck size={20} color={tokens_1.color.success}/>
        <react_native_1.Text style={styles.trustTier}>{TIER_LABEL[trust.tier]}</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Text style={styles.trustScore}>{trust.score}</react_native_1.Text>
        <react_native_1.Text style={styles.trustOf}>/100</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.View style={styles.barTrack}>
        <react_native_1.View style={[styles.barFill, { width: "".concat(trust.score, "%") }]}/>
      </react_native_1.View>
      <react_native_1.View style={styles.trustMeta}>
        {trust.verifiedId && <ui_1.Stamp label="ID verified" tone="deep"/>}
        <ui_1.Stamp label={"".concat(trust.completedPlans, " plans done")} rotate={2}/>
        <ui_1.Stamp label={"".concat(trust.safeMeetups, " safe meetups")} tone="signal" rotate={-2}/>
      </react_native_1.View>
    </react_native_1.View>);
}
function PlanRow(_a) {
    var plans = _a.plans;
    return (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
      {plans.map(function (p) { return (<react_native_1.Pressable key={p.id} style={styles.planRow} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
          <react_native_1.View style={styles.planDot}/>
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={styles.planTitle} numberOfLines={1}>{p.title}</react_native_1.Text>
            <react_native_1.Text style={styles.planMeta}>{p.destination.city} · {p.attendeeCount}/{p.capacity} going</react_native_1.Text>
          </react_native_1.View>
          <ui_1.Stamp label={p.status.replace('_', ' ')} tone={p.status === 'joined' ? 'signal' : 'deep'} rotate={0}/>
        </react_native_1.Pressable>); })}
    </react_native_1.View>);
}
function BuddyRow(_a) {
    var buddies = _a.buddies;
    return (<react_native_1.View style={styles.buddyRow}>
      {buddies.slice(0, 6).map(function (u) { return (<react_native_1.Pressable key={u.id} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }} style={styles.buddy}>
          <react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.buddyAvatar}/>
          <react_native_1.Text style={styles.buddyName} numberOfLines={1}>{u.name.split(' ')[0]}</react_native_1.Text>
        </react_native_1.Pressable>); })}
    </react_native_1.View>);
}
function PerksRow(_a) {
    var perks = _a.perks;
    return (<react_native_1.View style={{ gap: tokens_1.space.sm }}>
      {perks.map(function (pk) { return (<react_native_1.View key={pk.id} style={[styles.perk, !pk.unlocked && styles.perkLocked]}>
          {pk.unlocked ? <Ticket /> : <lucide_react_native_1.Lock size={16} color={tokens_1.color.faint}/>}
          <react_native_1.View style={{ flex: 1 }}>
            <react_native_1.Text style={[styles.perkTitle, !pk.unlocked && { color: tokens_1.color.faint }]}>{pk.title}</react_native_1.Text>
            <react_native_1.Text style={styles.perkDetail}>{pk.unlocked ? pk.detail : pk.requirement}</react_native_1.Text>
          </react_native_1.View>
          {pk.unlocked ? <ui_1.Stamp label="ready" tone="signal"/> : <ui_1.Stamp label="locked"/>}
        </react_native_1.View>); })}
    </react_native_1.View>);
}
function Ticket() {
    return <react_native_1.View style={styles.ticketDot}/>;
}
var styles = react_native_1.StyleSheet.create({
    pc: { backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' },
    pcMedia: { width: '100%', height: 180, backgroundColor: tokens_1.color.haze },
    pcBody: { padding: tokens_1.space.md, gap: tokens_1.space.sm },
    pcMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    pcDate: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontFamily: 'Courier' }),
    pcCaption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    pcEngage: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    pcEmpty: { padding: tokens_1.space.xl, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', gap: 4 },
    pcEmptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    pcEmptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    trustChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.pill,
    },
    trustChipText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.success }),
    compactWrap: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingVertical: tokens_1.space.md, marginTop: tokens_1.space.md,
    },
    compactCell: { flex: 1, alignItems: 'center' },
    compactDivider: { width: 1, height: 24, backgroundColor: tokens_1.color.haze },
    compactN: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    compactL: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier', fontSize: 11 }),
    trustRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.md,
    },
    trustRowTier: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    trustRowBar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: tokens_1.color.haze, overflow: 'hidden' },
    trustRowFill: { height: 6, borderRadius: 3, backgroundColor: tokens_1.color.success },
    trustRowScore: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.success }),
    buddyPrev: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    buddyStack: { flexDirection: 'row' },
    buddyStackAvatar: { borderRadius: 18, borderWidth: 2, borderColor: tokens_1.color.paperRaised },
    buddyStackImg: { width: 34, height: 34, borderRadius: 17, backgroundColor: tokens_1.color.haze },
    buddyPrevText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    findBtn: { paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, backgroundColor: tokens_1.color.ink },
    findBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    section: { marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.lg },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: tokens_1.space.sm },
    sectionTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    sectionActionText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    statsWrap: {
        flexDirection: 'row', flexWrap: 'wrap',
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingVertical: tokens_1.space.lg,
    },
    statCell: { width: '33.33%', alignItems: 'center', paddingVertical: tokens_1.space.sm },
    statN: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    statL: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier' }),
    trust: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg, gap: tokens_1.space.md,
    },
    trustTop: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    trustTier: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    trustScore: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.success }),
    trustOf: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    barTrack: { height: 8, borderRadius: 4, backgroundColor: tokens_1.color.haze, overflow: 'hidden' },
    barFill: { height: 8, borderRadius: 4, backgroundColor: tokens_1.color.success },
    trustMeta: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    planRow: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    planDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens_1.color.signal },
    planTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    planMeta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    buddyRow: { flexDirection: 'row', gap: tokens_1.space.md },
    buddy: { alignItems: 'center', width: 56 },
    buddyAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: tokens_1.color.haze },
    buddyName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, marginTop: 4 }),
    perk: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    perkLocked: { backgroundColor: tokens_1.color.paper },
    perkTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    perkDetail: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    ticketDot: { width: 16, height: 16, borderRadius: 4, backgroundColor: tokens_1.color.signal },
});
