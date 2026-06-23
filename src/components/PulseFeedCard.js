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
exports.PulseFeedCard = PulseFeedCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var AttachController_1 = require("./AttachController");
/* shared bits */
function AuthorRow(_a) {
    var item = _a.item, badge = _a.badge;
    return (<react_native_1.View style={s.authorRow}>
      {item.author ? <react_native_1.Image source={{ uri: item.author.avatarUrl }} style={s.avatar}/> : null}
      <react_native_1.View style={{ flex: 1 }}>
        {badge ? <react_native_1.View style={[s.kindBadge, { backgroundColor: badge.bg }]}><react_native_1.Text style={[s.kindText, { color: badge.fg }]}>{badge.label}</react_native_1.Text></react_native_1.View> : null}
        {item.author ? <react_native_1.Text style={s.author}>{item.author.name}</react_native_1.Text> : null}
        <react_native_1.Text style={s.meta}>{item.timeAgo}{item.neighborhood ? " \u00B7 ".concat(item.neighborhood) : item.city ? " \u00B7 ".concat(item.city) : ''}</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.MoreHorizontal size={18} color={tokens_1.color.faint}/></react_native_1.Pressable>
    </react_native_1.View>);
}
function TagRow(_a) {
    var tags = _a.tags;
    if (!tags.length)
        return null;
    return (<react_native_1.View style={s.tags}>
      {tags.map(function (tg) { return <react_native_1.View key={tg} style={s.tag}><react_native_1.Text style={s.tagText}>{tg}</react_native_1.Text></react_native_1.View>; })}
    </react_native_1.View>);
}
function FitBadge() {
    return <react_native_1.View style={s.fit}><lucide_react_native_1.Clock size={11} color={tokens_1.color.success}/><react_native_1.Text style={s.fitText}>Fits your time</react_native_1.Text></react_native_1.View>;
}
/* ── Traveler Post ── */
function PostCard(_a) {
    var _b, _c;
    var item = _a.item;
    return (<react_native_1.View style={s.card}>
      <AuthorRow item={item}/>
      {item.mediaUrl || true ? (<react_native_1.View style={s.media}>
          {item.mediaUrl ? <react_native_1.Image source={{ uri: item.mediaUrl }} style={react_native_1.StyleSheet.absoluteFill}/> : null}
          <react_native_1.View style={s.mediaTag}><react_native_1.Text style={s.mediaTagText}>POST</react_native_1.Text></react_native_1.View>
        </react_native_1.View>) : null}
      {item.caption ? <react_native_1.Text style={s.caption}>{item.caption}</react_native_1.Text> : null}
      <TagRow tags={item.tags}/>
      <react_native_1.View style={s.actions}>
        <react_native_1.View style={s.action}><lucide_react_native_1.Heart size={17} color={tokens_1.color.signal}/><react_native_1.Text style={s.actionText}>{(_b = item.likeCount) !== null && _b !== void 0 ? _b : 0}</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={s.action}><lucide_react_native_1.MessageCircle size={17} color={tokens_1.color.mute}/><react_native_1.Text style={s.actionText}>{(_c = item.commentCount) !== null && _c !== void 0 ? _c : 0}</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={17} color={tokens_1.color.mute}/></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Question ── */
function QuestionCard(_a) {
    var _b;
    var item = _a.item;
    return (<react_native_1.View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'QUESTION', bg: '#EFE7FA', fg: '#7A4DBF' }}/>
      <react_native_1.Text style={s.question}>{item.question}</react_native_1.Text>
      <TagRow tags={item.tags}/>
      <react_native_1.View style={s.actions}>
        <react_native_1.View style={s.action}><lucide_react_native_1.HelpCircle size={15} color={tokens_1.color.mute}/><react_native_1.Text style={s.actionText}>{(_b = item.replyCount) !== null && _b !== void 0 ? _b : 0} answers</react_native_1.Text></react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={s.outlineBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}><react_native_1.Text style={s.outlineText}>Answer</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Open Plan ── */
function PlanCard(_a) {
    var _b, _c;
    var item = _a.item;
    return (<react_native_1.View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'OPEN PLAN', bg: '#E3F1EA', fg: tokens_1.color.success }}/>
      <react_native_1.Text style={s.title}>{item.title}</react_native_1.Text>
      {item.time ? <react_native_1.View style={s.line}><lucide_react_native_1.Clock size={13} color={tokens_1.color.mute}/><react_native_1.Text style={s.lineText}>{item.time}</react_native_1.Text></react_native_1.View> : null}
      {item.neighborhood || item.city ? <react_native_1.View style={s.line}><lucide_react_native_1.MapPin size={13} color={tokens_1.color.mute}/><react_native_1.Text style={s.lineText}>{(_b = item.neighborhood) !== null && _b !== void 0 ? _b : item.city}</react_native_1.Text></react_native_1.View> : null}
      {item.availabilityMatch ? <FitBadge /> : null}
      <TagRow tags={item.tags}/>
      <react_native_1.View style={s.actions}>
        <react_native_1.Text style={s.going}>{(_c = item.attendeeCount) !== null && _c !== void 0 ? _c : 0} going</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={s.solidBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}><react_native_1.Text style={s.solidText}>Join Plan</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Hidden Gem Share ── */
function GemCard(_a) {
    var item = _a.item;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'HIDDEN GEM', bg: '#E3F1EA', fg: tokens_1.color.success }}/>
      <react_native_1.View style={s.media}><react_native_1.View style={s.gemIcon}><lucide_react_native_1.Gem size={15} color={tokens_1.color.onInk}/></react_native_1.View></react_native_1.View>
      <react_native_1.Text style={s.title}>{item.title}</react_native_1.Text>
      {item.blurb ? <react_native_1.Text style={s.blurb}>{item.blurb}</react_native_1.Text> : null}
      <react_native_1.View style={s.actions}>
        <react_native_1.Pressable style={s.outlineBtn} onPress={function () { var _a; return attach.open({ id: item.id, type: 'hidden_gem', title: (_a = item.title) !== null && _a !== void 0 ? _a : 'Hidden gem', city: item.city, category: 'Hidden Gem' }, 'plan'); }}><react_native_1.Text style={s.outlineText}>Add to Plan</react_native_1.Text></react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={17} color={tokens_1.color.mute}/></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Itinerary / Plan Idea ── */
function ItineraryCard(_a) {
    var _b;
    var item = _a.item;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View style={s.card}>
      <AuthorRow item={item} badge={{ label: 'ITINERARY', bg: '#E2EDF0', fg: tokens_1.color.deep }}/>
      <react_native_1.View style={s.titleRow}>
        <lucide_react_native_1.Route size={16} color={tokens_1.color.deep}/>
        <react_native_1.Text style={[s.title, { flex: 1 }]}>{item.title}</react_native_1.Text>
        {item.estimate ? <react_native_1.Text style={s.estimate}>{item.estimate}</react_native_1.Text> : null}
      </react_native_1.View>
      {(_b = item.steps) === null || _b === void 0 ? void 0 : _b.map(function (step, i) { return (<react_native_1.View key={i} style={s.step}><react_native_1.Text style={s.stepN}>{i + 1}</react_native_1.Text><react_native_1.Text style={s.stepText}>{step}</react_native_1.Text></react_native_1.View>); })}
      <TagRow tags={item.tags}/>
      <react_native_1.View style={s.actions}>
        <react_native_1.Pressable style={s.outlineBtn} onPress={function () { var _a; return attach.open({ id: item.id, type: 'itinerary', title: (_a = item.title) !== null && _a !== void 0 ? _a : 'Itinerary', city: item.city, category: 'Itinerary' }, 'trip'); }}><react_native_1.Text style={s.outlineText}>Use this plan</react_native_1.Text></react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable hitSlop={tokens_1.layout.hitSlop}><lucide_react_native_1.Bookmark size={17} color={tokens_1.color.mute}/></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Circle Activity ── */
function CircleCard(_a) {
    var _b;
    var item = _a.item;
    return (<react_native_1.View style={[s.card, s.circleCard]}>
      <react_native_1.View style={s.circleHead}>
        <react_native_1.View style={s.circleBadge}><lucide_react_native_1.Users size={13} color={tokens_1.color.onInk}/></react_native_1.View>
        <react_native_1.Text style={s.circleLabel}>CIRCLE ACTIVITY</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Text style={s.circleText}>{item.activityText}</react_native_1.Text>
      <react_native_1.View style={s.circleRow}>
        <react_native_1.View style={{ flexDirection: 'row' }}>
          {((_b = item.participants) !== null && _b !== void 0 ? _b : []).slice(0, 4).map(function (p, i) { return (<react_native_1.Image key={p.id} source={{ uri: p.avatarUrl }} style={[s.circleAvatar, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]}/>); })}
        </react_native_1.View>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={s.outlineBtn} onPress={function () { return expo_router_1.router.push('/circle'); }}><react_native_1.Text style={s.outlineText}>See Circle</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── Compass Suggestion (stub-real: only with explicit reason) ── */
function CompassCard(_a) {
    var item = _a.item;
    var attach = (0, AttachController_1.useAttach)();
    return (<react_native_1.View style={[s.card, s.compassCard]}>
      <react_native_1.View style={s.compassHead}>
        <react_native_1.View style={s.compassBadge}><lucide_react_native_1.Sparkles size={13} color={tokens_1.color.onInk}/></react_native_1.View>
        <react_native_1.Text style={s.compassLabel}>COMPASS SUGGESTION</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Text style={s.title}>{item.title}</react_native_1.Text>
      {item.reason ? <react_native_1.View style={s.reasonRow}><lucide_react_native_1.Info size={13} color={tokens_1.color.deep}/><react_native_1.Text style={s.reason}>{item.reason}</react_native_1.Text></react_native_1.View> : null}
      {item.isProvisional ? <react_native_1.Text style={s.prov}>Based on starter city notes — provisional</react_native_1.Text> : null}
      <react_native_1.View style={s.actions}>
        <react_native_1.Pressable style={s.outlineBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}><react_native_1.Text style={s.outlineText}>View Details</react_native_1.Text></react_native_1.Pressable>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={s.solidBtn} onPress={function () { var _a; return attach.open({ id: item.id, type: 'compass_suggestion', title: (_a = item.title) !== null && _a !== void 0 ? _a : 'Compass pick', city: item.city, category: 'Compass' }, 'plan'); }}><lucide_react_native_1.Plus size={14} color={tokens_1.color.onInk}/><react_native_1.Text style={s.solidText}>Add to Plan</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.View>);
}
/* ── City Note (provisional) ── */
function CityNoteCard(_a) {
    var item = _a.item;
    return (<react_native_1.View style={[s.card, s.noteCard]}>
      <react_native_1.View style={s.noteHead}><react_native_1.Text style={s.noteLabel}>STARTER CITY NOTE</react_native_1.Text></react_native_1.View>
      <react_native_1.Text style={s.title}>{item.title}</react_native_1.Text>
      {item.blurb ? <react_native_1.Text style={s.blurb}>{item.blurb}</react_native_1.Text> : null}
      <react_native_1.View style={s.provRow}><lucide_react_native_1.Info size={11} color={tokens_1.color.mute}/><react_native_1.Text style={s.provInline}>Provisional — not verified</react_native_1.Text></react_native_1.View>
    </react_native_1.View>);
}
/* ── Safety (only renders when item present) ── */
function SafetyCard(_a) {
    var item = _a.item;
    return (<react_native_1.View style={[s.card, s.safetyCard]}>
      <react_native_1.View style={s.safetyHead}><lucide_react_native_1.ShieldCheck size={16} color={tokens_1.color.success}/><react_native_1.Text style={s.safetyLabel}>HEADS-UP</react_native_1.Text></react_native_1.View>
      <react_native_1.Text style={s.blurb}>{item.blurb}</react_native_1.Text>
    </react_native_1.View>);
}
/* ── Unified renderer: switch on type ── */
function PulseFeedCard(_a) {
    var item = _a.item;
    switch (item.type) {
        case 'post': return <PostCard item={item}/>;
        case 'question': return <QuestionCard item={item}/>;
        case 'plan': return <PlanCard item={item}/>;
        case 'hidden_gem': return <GemCard item={item}/>;
        case 'itinerary': return <ItineraryCard item={item}/>;
        case 'circle_activity': return <CircleCard item={item}/>;
        case 'compass_suggestion': return item.reason ? <CompassCard item={item}/> : null; // stub: only with real reason
        case 'city_note': return item.isProvisional ? <CityNoteCard item={item}/> : null; // stub: only provisional-labeled
        case 'safety': return item.blurb ? <SafetyCard item={item}/> : null; // stub: only when condition exists
        default: return null;
    }
}
var s = react_native_1.StyleSheet.create({
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md, gap: tokens_1.space.sm }, tokens_1.shadow.card),
    authorRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: tokens_1.color.haze },
    author: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
    kindBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: tokens_1.radius.sm, marginBottom: 3 },
    kindText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
    media: { height: 150, borderRadius: tokens_1.radius.sm, backgroundColor: tokens_1.color.deep, overflow: 'hidden', justifyContent: 'flex-start', padding: tokens_1.space.sm },
    mediaTag: { alignSelf: 'flex-start', backgroundColor: 'rgba(17,17,15,0.5)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    mediaTagText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
    gemIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: tokens_1.color.success, alignItems: 'center', justifyContent: 'center' },
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    question: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 17 }),
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 16 }),
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    estimate: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier' }),
    blurb: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    line: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    lineText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    tag: { backgroundColor: tokens_1.color.paper, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3 },
    tagText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600', fontSize: 11 }),
    fit: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: '#E3F1EA', paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    fitText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.success, fontWeight: '700', fontSize: 11 }),
    actions: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, marginTop: 2 },
    action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    actionText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    going: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    outlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: 6 },
    outlineText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
    solidBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingHorizontal: tokens_1.space.md, paddingVertical: 6 },
    solidText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk, fontSize: 12 }),
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    stepN: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: tokens_1.color.deep, width: 16 },
    stepText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, flex: 1 }),
    circleCard: { backgroundColor: '#F3F0FB', borderColor: '#E0D6F5' },
    circleHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    circleBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#7A4DBF', alignItems: 'center', justifyContent: 'center' },
    circleLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: '#7A4DBF', letterSpacing: 1 },
    circleText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    circleRow: { flexDirection: 'row', alignItems: 'center' },
    circleAvatar: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#F3F0FB', backgroundColor: tokens_1.color.haze },
    compassCard: { borderColor: tokens_1.color.deep, borderWidth: 1.5 },
    compassHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    compassBadge: { width: 22, height: 22, borderRadius: 11, backgroundColor: tokens_1.color.deep, alignItems: 'center', justifyContent: 'center' },
    compassLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.deep, letterSpacing: 1 },
    reasonRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E2EDF0', alignSelf: 'flex-start', paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    reason: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontSize: 11 }),
    prov: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontStyle: 'italic', fontSize: 11 }),
    noteCard: { backgroundColor: tokens_1.color.paper, borderStyle: 'dashed' },
    noteHead: {},
    noteLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.mute, letterSpacing: 1 },
    provRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    provInline: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 10, fontStyle: 'italic' }),
    safetyCard: { backgroundColor: '#FBF6EC', borderColor: '#EAD9B5' },
    safetyHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    safetyLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: tokens_1.color.warn, letterSpacing: 1 },
});
