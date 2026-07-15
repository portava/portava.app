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
exports.TripHero = TripHero;
exports.TodayNextUp = TodayNextUp;
exports.TripTimeline = TripTimeline;
exports.SavedIdeas = SavedIdeas;
exports.SectionHead = SectionHead;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_svg_1 = require("react-native-svg");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var AttachController_1 = require("./AttachController");
var AttachmentStore_1 = require("../context/AttachmentStore");
var tripDetail_1 = require("../data/tripDetail");
/* ── Progress ring (semicircle arc) ── */
function ProgressRing(_a) {
    var pct = _a.pct;
    var r = 46, cx = 60, cy = 60;
    // semicircle from 180° to 0°, filled by pct
    var start = Math.PI; // 180deg
    var end = Math.PI - (pct / 100) * Math.PI;
    var x1 = cx + r * Math.cos(start), y1 = cy - r * Math.sin(start);
    var x2 = cx + r * Math.cos(end), y2 = cy - r * Math.sin(end);
    var bgX = cx + r * Math.cos(0), bgY = cy - r * Math.sin(0);
    return (<react_native_1.View style={{ alignItems: 'center' }}>
      <react_native_svg_1.default width={120} height={70} viewBox="0 0 120 70">
        <react_native_svg_1.Path d={"M ".concat(x1, " ").concat(y1, " A ").concat(r, " ").concat(r, " 0 0 1 ").concat(bgX, " ").concat(bgY)} stroke={tokens_1.color.haze} strokeWidth="9" fill="none" strokeLinecap="round"/>
        <react_native_svg_1.Path d={"M ".concat(x1, " ").concat(y1, " A ").concat(r, " ").concat(r, " 0 0 1 ").concat(x2, " ").concat(y2)} stroke={tokens_1.color.signal} strokeWidth="9" fill="none" strokeLinecap="round"/>
      </react_native_svg_1.default>
      <react_native_1.Text style={ring.pct}>{pct}%</react_native_1.Text>
    </react_native_1.View>);
}
/* ── Trip hero header ── */
function TripHero(_a) {
    var trip = _a.trip;
    var dates = "".concat(fmt(trip.startDate), " \u2013 ").concat(fmt(trip.endDate), ", ").concat(new Date(trip.endDate).getFullYear());
    return (<react_native_1.View style={hero.wrap}>
      {/* image card with overlaid identity */}
      <react_native_1.View style={hero.imageCard}>
        <react_native_1.View style={hero.imageBg}>
          {/* passport stamp motif corner */}
          <react_native_1.View style={hero.stampMark}><lucide_react_native_1.Plane size={16} color={tokens_1.color.onInk}/><react_native_1.Text style={hero.stampText}>CEBU</react_native_1.Text></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View style={hero.identity}>
          <react_native_1.View style={hero.titleRow}>
            <react_native_1.Text style={hero.title}>{trip.title}</react_native_1.Text>
            <react_native_1.View style={hero.activeChip}><react_native_1.Text style={hero.activeText}>{cap(trip.status)}</react_native_1.Text></react_native_1.View>
          </react_native_1.View>
          <react_native_1.Text style={hero.dest}>{trip.destinationCity}, {trip.destinationCountry}</react_native_1.Text>
          <react_native_1.View style={hero.metaRow}><lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.onInk}/><react_native_1.Text style={hero.meta}>{dates} ({trip.nights} nights)</react_native_1.Text></react_native_1.View>
          <react_native_1.View style={hero.metaRow}>
            <lucide_react_native_1.User size={14} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={hero.meta}>{trip.travelStyle} · {trip.openToMeet ? 'Open to Meet' : 'Private'}</react_native_1.Text>
            {trip.openToMeet && <react_native_1.View style={hero.openChip}><react_native_1.Text style={hero.openText}>Open</react_native_1.Text></react_native_1.View>}
          </react_native_1.View>
          {trip.availabilityLabel ? (<react_native_1.View style={hero.availChip}><lucide_react_native_1.Clock size={13} color={tokens_1.color.onInk}/><react_native_1.Text style={hero.availText}>{trip.availabilityLabel}</react_native_1.Text></react_native_1.View>) : null}
        </react_native_1.View>
      </react_native_1.View>

      {/* quick actions */}
      <react_native_1.View style={hero.actions}>
        <Action icon={<lucide_react_native_1.CalendarPlus size={18} color={tokens_1.color.signal}/>} label="Add Plan" onPress={function () { return expo_router_1.router.push('/create'); }}/>
        <Action icon={<lucide_react_native_1.UserPlus size={18} color={tokens_1.color.ink}/>} label="Invite Buddy" onPress={function () { return expo_router_1.router.push('/circle'); }}/>
        <Action icon={<lucide_react_native_1.Sparkles size={18} color={tokens_1.color.signal}/>} label="Ask Compass" onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}/>
        <Action icon={<lucide_react_native_1.Settings size={18} color={tokens_1.color.ink}/>} label="Trip Settings" onPress={function () { return expo_router_1.router.push('/settings'); }}/>
      </react_native_1.View>

      {/* progress card */}
      <react_native_1.View style={hero.progressCard}>
        <react_native_1.Text style={hero.progressTitle}>Trip Progress</react_native_1.Text>
        <ProgressRing pct={trip.progress}/>
        <react_native_1.Text style={hero.progressSub}>Your trip is coming together!</react_native_1.Text>
        <react_native_1.View style={{ gap: tokens_1.space.sm, marginTop: tokens_1.space.md, alignSelf: 'stretch' }}>
          {trip.progressSteps.map(function (s) { return (<react_native_1.View key={s.label} style={hero.stepRow}>
              {s.done ? <lucide_react_native_1.CheckCircle2 size={18} color={tokens_1.color.success}/> : <lucide_react_native_1.Circle size={18} color={tokens_1.color.faint}/>}
              <react_native_1.Text style={[hero.stepText, s.done && hero.stepDone]}>{s.label}</react_native_1.Text>
            </react_native_1.View>); })}
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.View>);
}
function Action(_a) {
    var icon = _a.icon, label = _a.label, onPress = _a.onPress;
    return (<react_native_1.Pressable style={hero.action} onPress={onPress}>
      {icon}
      <react_native_1.Text style={hero.actionText}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
/* ── Today / Next Up ── */
function TodayNextUp(_a) {
    var nextUp = _a.nextUp;
    return (<react_native_1.View style={section.wrap}>
      <SectionHead title="Today / Next Up" onViewAll={nextUp ? function () { return expo_router_1.router.push('/(tabs)/trips'); } : undefined}/>
      {!nextUp ? (<react_native_1.View style={nx.empty}>
          <react_native_1.Text style={nx.emptyText}>Nothing planned yet. Add a plan or ask Compass to build your first night.</react_native_1.Text>
          <react_native_1.Pressable style={nx.emptyBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/ai'); }}><react_native_1.Text style={nx.emptyBtnText}>Ask Compass</react_native_1.Text></react_native_1.Pressable>
        </react_native_1.View>) : (<react_native_1.View style={nx.card}>
          <react_native_1.View style={nx.media}/>
          <react_native_1.View style={nx.body}>
            <react_native_1.View style={nx.badgeRow}>
              <react_native_1.View style={nx.badge}><react_native_1.Text style={nx.badgeText}>{nextUp.badge}</react_native_1.Text></react_native_1.View>
              <react_native_1.Text style={nx.time}>{nextUp.time}</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.Text style={nx.title}>{nextUp.title}</react_native_1.Text>
            <react_native_1.View style={nx.metaRow}><lucide_react_native_1.MapPin size={13} color={tokens_1.color.mute}/><react_native_1.Text style={nx.meta}>{nextUp.place}</react_native_1.Text></react_native_1.View>
            <react_native_1.View style={nx.hostRow}>
              <react_native_1.Image source={{ uri: nextUp.host.avatarUrl }} style={nx.hostAvatar}/>
              <react_native_1.Text style={nx.host}>Hosted by {nextUp.host.name.split(' ')[0]}</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.View style={nx.attRow}>
              <AvatarRow people={nextUp.attendees}/>
              <react_native_1.Text style={nx.going}>{nextUp.attendeeCount} going</react_native_1.Text>
            </react_native_1.View>
            <react_native_1.View style={nx.btns}>
              <react_native_1.Pressable style={nx.primary} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}><react_native_1.Text style={nx.primaryText}>View Plan</react_native_1.Text></react_native_1.Pressable>
              <react_native_1.Pressable style={nx.ghost} onPress={function () { return expo_router_1.router.push('/messages'); }}><react_native_1.Text style={nx.ghostText}>Message Group</react_native_1.Text></react_native_1.Pressable>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.View>)}
    </react_native_1.View>);
}
function AvatarRow(_a) {
    var people = _a.people;
    return (<react_native_1.View style={{ flexDirection: 'row' }}>
      {people.slice(0, 4).map(function (u, i) { return (<react_native_1.Image key={u.id} source={{ uri: u.avatarUrl }} style={[nx.attAvatar, { marginLeft: i === 0 ? 0 : -9, zIndex: 4 - i }]}/>); })}
    </react_native_1.View>);
}
/* ── Trip Timeline ── */
function TripTimeline(_a) {
    var _b;
    var days = _a.days;
    var _c = (0, react_1.useState)(0), active = _c[0], setActive = _c[1];
    var day = (_b = days[active]) !== null && _b !== void 0 ? _b : days[0];
    return (<react_native_1.View style={section.wrap}>
      <SectionHead title="Trip Timeline"/>
      {/* day tabs */}
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tl.dayRow}>
        {days.map(function (d, i) { return (<react_native_1.Pressable key={d.iso} style={[tl.dayTab, i === active && tl.dayTabOn]} onPress={function () { return setActive(i); }}>
            <react_native_1.Text style={[tl.dayLabel, i === active && tl.dayLabelOn]}>{d.dateLabel}</react_native_1.Text>
            <react_native_1.Text style={[tl.daySub, i === active && tl.dayLabelOn]}>{d.dateSub}</react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.ScrollView>
      {/* items */}
      <react_native_1.View style={tl.items}>
        {day.items.length === 0 ? (<react_native_1.Text style={tl.empty}>No plans this day yet. Add one or ask Compass.</react_native_1.Text>) : day.items.map(function (it) { return (<react_native_1.View key={it.id} style={tl.item}>
            <react_native_1.View style={tl.timeCol}>
              <react_native_1.Text style={tl.itemTime}>{it.time}</react_native_1.Text>
              <react_native_1.View style={[tl.dot, it.kind === 'free' && tl.dotOpen]}/>
            </react_native_1.View>
            <react_native_1.View style={[tl.itemCard, it.kind === 'free' && tl.itemFree]}>
              <react_native_1.Text style={tl.itemTitle}>{it.title}</react_native_1.Text>
              {it.place ? <react_native_1.Text style={tl.itemPlace}>{it.place}</react_native_1.Text> : null}
              {it.attendeeCount ? <react_native_1.Text style={tl.itemGoing}>{it.attendeeCount} going</react_native_1.Text> : null}
            </react_native_1.View>
          </react_native_1.View>); })}
      </react_native_1.View>
      <react_native_1.Pressable style={tl.viewFull} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
        <react_native_1.Text style={tl.viewFullText}>View full itinerary</react_native_1.Text>
        <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.signal}/>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
/* ── Saved Ideas ── */
function SavedIdeas(_a) {
    var ideas = _a.ideas;
    var attach = (0, AttachController_1.useAttach)();
    var listAttachmentsByTarget = (0, AttachmentStore_1.useAttachments)().listAttachmentsByTarget;
    var CAT_TONE = {
        Food: { bg: '#FCE9E4', fg: tokens_1.color.signal },
        Nightlife: { bg: '#EFE7FA', fg: '#7A4DBF' },
        Nature: { bg: '#E3F1EA', fg: tokens_1.color.success },
        Beach: { bg: '#E2EDF0', fg: tokens_1.color.deep },
    };
    // session attachments added to this trip — shown alongside seed ideas (honest, in-memory)
    var added = listAttachmentsByTarget(tripDetail_1.mockTripDetail.id);
    var hasAny = ideas.length > 0 || added.length > 0;
    return (<react_native_1.View style={section.wrap}>
      <SectionHead title="Saved Ideas" onViewAll={hasAny ? function () { return expo_router_1.router.push('/saved'); } : undefined}/>
      {!hasAny ? (<react_native_1.View style={si.empty}><react_native_1.Text style={si.emptyText}>Save places from the Discovery Wall to build this trip.</react_native_1.Text></react_native_1.View>) : (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={si.strip}>
          {added.map(function (att) {
                var _a;
                return (<react_native_1.View key={att.id} style={si.card}>
              <react_native_1.View style={si.media}>
                <react_native_1.View style={si.bookmark}><lucide_react_native_1.Bookmark size={15} color={tokens_1.color.onInk} fill={tokens_1.color.onInk}/></react_native_1.View>
              </react_native_1.View>
              <react_native_1.View style={si.body}>
                <react_native_1.Text style={si.name} numberOfLines={1}>{att.sourceTitle}</react_native_1.Text>
                <react_native_1.Text style={si.hood} numberOfLines={1}>{(_a = att.sourceCity) !== null && _a !== void 0 ? _a : 'Added this session'}</react_native_1.Text>
                <react_native_1.View style={[si.cat, { backgroundColor: '#E3F1EA' }]}><react_native_1.Text style={[si.catText, { color: tokens_1.color.success }]}>Added</react_native_1.Text></react_native_1.View>
              </react_native_1.View>
            </react_native_1.View>);
            })}
          {ideas.map(function (idea) {
                var _a;
                var tone = (_a = CAT_TONE[idea.category]) !== null && _a !== void 0 ? _a : { bg: tokens_1.color.haze, fg: tokens_1.color.mute };
                return (<react_native_1.View key={idea.id} style={si.card}>
                <react_native_1.View style={si.media}>
                  <react_native_1.View style={si.bookmark}><lucide_react_native_1.Bookmark size={15} color={tokens_1.color.onInk} fill={tokens_1.color.onInk}/></react_native_1.View>
                </react_native_1.View>
                <react_native_1.View style={si.body}>
                  <react_native_1.Text style={si.name} numberOfLines={1}>{idea.name}</react_native_1.Text>
                  <react_native_1.Text style={si.hood} numberOfLines={1}>{idea.neighborhood}</react_native_1.Text>
                  <react_native_1.View style={[si.cat, { backgroundColor: tone.bg }]}><react_native_1.Text style={[si.catText, { color: tone.fg }]}>{idea.category}</react_native_1.Text></react_native_1.View>
                  <react_native_1.Pressable style={si.addBtn} onPress={function () { return attach.open({ id: idea.id, type: 'place', title: idea.name, city: idea.neighborhood, category: idea.category }, 'plan'); }}><react_native_1.Text style={si.addText}>Add to Plan</react_native_1.Text></react_native_1.Pressable>
                </react_native_1.View>
              </react_native_1.View>);
            })}
        </react_native_1.ScrollView>)}
    </react_native_1.View>);
}
/* shared section header */
function SectionHead(_a) {
    var title = _a.title, onViewAll = _a.onViewAll;
    return (<react_native_1.View style={section.head}>
      <react_native_1.Text style={section.title}>{title}</react_native_1.Text>
      <react_native_1.View style={{ flex: 1 }}/>
      {onViewAll && (<react_native_1.Pressable style={section.viewAll} onPress={onViewAll} hitSlop={6}>
          <react_native_1.Text style={section.viewAllText}>View all</react_native_1.Text>
          <lucide_react_native_1.ChevronRight size={15} color={tokens_1.color.signal}/>
        </react_native_1.Pressable>)}
    </react_native_1.View>);
}
function fmt(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
var ring = react_native_1.StyleSheet.create({
    pct: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.ink, fontSize: 28, marginTop: -18 }),
});
var hero = react_native_1.StyleSheet.create({
    wrap: { padding: tokens_1.space.lg, gap: tokens_1.space.md },
    imageCard: __assign({ borderRadius: tokens_1.radius.lg, overflow: 'hidden', backgroundColor: tokens_1.color.ink }, tokens_1.shadow.card),
    imageBg: { height: 150, backgroundColor: tokens_1.color.deep, alignItems: 'flex-end', padding: tokens_1.space.md },
    stampMark: { alignItems: 'center', gap: 2, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', borderRadius: tokens_1.radius.sm, padding: 6 },
    stampText: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.onInk, fontWeight: '700', letterSpacing: 1 },
    identity: { padding: tokens_1.space.lg, gap: 5, backgroundColor: tokens_1.color.ink },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.hero), { color: tokens_1.color.onInk, fontSize: 30 }),
    activeChip: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.sm, paddingVertical: 3, borderRadius: tokens_1.radius.sm },
    activeText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '800', fontSize: 11 }),
    dest: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.haze }),
    openChip: { backgroundColor: tokens_1.color.success, paddingHorizontal: tokens_1.space.sm, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    openText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '700', fontSize: 10 }),
    availChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.12)', paddingHorizontal: tokens_1.space.md, paddingVertical: 6, borderRadius: tokens_1.radius.pill, marginTop: tokens_1.space.sm },
    availText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.onInk, fontWeight: '600' }),
    actions: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    action: { flexGrow: 1, flexBasis: '47%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md },
    actionText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    progressCard: { backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, alignItems: 'center' },
    progressTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18, alignSelf: 'flex-start' }),
    progressSub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600', marginTop: 4 }),
    stepRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    stepText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    stepDone: { color: tokens_1.color.ink },
});
var section = react_native_1.StyleSheet.create({
    wrap: { marginTop: tokens_1.space.lg },
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, marginBottom: tokens_1.space.md },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    viewAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    viewAllText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
});
var nx = react_native_1.StyleSheet.create({
    card: __assign({ flexDirection: 'row', marginHorizontal: tokens_1.space.lg, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { width: 120, backgroundColor: tokens_1.color.deep },
    body: { flex: 1, padding: tokens_1.space.md, gap: 4 },
    badgeRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    badge: { backgroundColor: '#EFE7FA', paddingHorizontal: tokens_1.space.sm, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    badgeText: __assign(__assign({}, tokens_1.type.small), { color: '#7A4DBF', fontWeight: '800', fontSize: 10 }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier' }),
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 16 }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    hostRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
    hostAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.haze },
    host: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    attRow: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm, marginTop: 2 },
    attAvatar: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: tokens_1.color.paperRaised, backgroundColor: tokens_1.color.haze },
    going: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    btns: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    primary: { flex: 1, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm, alignItems: 'center' },
    primaryText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    ghost: { flex: 1, borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.sm, alignItems: 'center' },
    ghostText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal }),
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze, gap: tokens_1.space.md, alignItems: 'flex-start' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    emptyBtn: { backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
    emptyBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
});
var tl = react_native_1.StyleSheet.create({
    dayRow: { gap: tokens_1.space.sm, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md },
    dayTab: { alignItems: 'center', paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised, minWidth: 56 },
    dayTabOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    dayLabel: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.ink, fontSize: 11 }),
    daySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    dayLabelOn: { color: tokens_1.color.onInk },
    items: { paddingHorizontal: tokens_1.space.lg, gap: tokens_1.space.md },
    item: { flexDirection: 'row', gap: tokens_1.space.md },
    timeCol: { width: 56, alignItems: 'flex-start' },
    itemTime: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontFamily: 'Courier', fontSize: 11 }),
    dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tokens_1.color.signal, marginTop: 4 },
    dotOpen: { backgroundColor: tokens_1.color.paper, borderWidth: 2, borderColor: tokens_1.color.faint },
    itemCard: { flex: 1, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.md, padding: tokens_1.space.md, gap: 2 },
    itemFree: { borderStyle: 'dashed', backgroundColor: tokens_1.color.paper },
    itemTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    itemPlace: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    itemGoing: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    empty: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, paddingHorizontal: tokens_1.space.lg }),
    viewFull: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: tokens_1.space.md },
    viewFullText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
});
var si = react_native_1.StyleSheet.create({
    strip: { gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.sm },
    card: __assign({ width: 150, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, overflow: 'hidden' }, tokens_1.shadow.card),
    media: { height: 100, backgroundColor: tokens_1.color.deep, alignItems: 'flex-end', padding: tokens_1.space.sm },
    bookmark: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(17,17,15,0.4)', alignItems: 'center', justifyContent: 'center' },
    body: { padding: tokens_1.space.md, gap: 4 },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    hood: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
    cat: { alignSelf: 'flex-start', paddingHorizontal: tokens_1.space.sm, paddingVertical: 2, borderRadius: tokens_1.radius.sm },
    catText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 11 }),
    addBtn: { borderWidth: 1.5, borderColor: tokens_1.color.signal, borderRadius: tokens_1.radius.sm, paddingVertical: 6, alignItems: 'center', marginTop: 2 },
    addText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.signal, fontSize: 12 }),
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
});
