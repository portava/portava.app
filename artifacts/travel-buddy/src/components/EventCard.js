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
exports.EventCard = EventCard;
exports.FlexibleSection = FlexibleSection;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("./ui");
var tokens_1 = require("../theme/tokens");
function timeLabel(iso) {
    var d = new Date(iso);
    return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
/** Compact, utility event/plan card — visually distinct from editorial posts. */
function EventCard(_a) {
    var ev = _a.ev, dim = _a.dim;
    return (<react_native_1.Pressable style={[styles.card, dim && styles.dim]} onPress={function () { return expo_router_1.router.push('/(tabs)/trips'); }}>
      <react_native_1.View style={styles.left}>
        <ui_1.Stamp label={ev.category} tone="deep" rotate={0}/>
        <react_native_1.Text style={styles.title} numberOfLines={1}>{ev.title}</react_native_1.Text>
        <react_native_1.View style={styles.metaRow}>
          <lucide_react_native_1.Clock size={12} color={tokens_1.color.mute}/>
          <react_native_1.Text style={styles.meta}>{timeLabel(ev.startAt)} · {ev.city}</react_native_1.Text>
        </react_native_1.View>
        {ev.attendeeCount != null && (<react_native_1.View style={styles.metaRow}>
            <lucide_react_native_1.Users size={12} color={tokens_1.color.mute}/>
            <react_native_1.Text style={styles.meta}>{ev.attendeeCount}{ev.capacity ? "/".concat(ev.capacity) : ''} going</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.View>
      {ev.host && <ui_1.Avatar uri={ev.host.avatarUrl} size={36}/>}
    </react_native_1.Pressable>);
}
/** Collapsed "When you're flexible · N" — dimmed, labeled with why. */
function FlexibleSection(_a) {
    var events = _a.events;
    var _b = (0, react_1.useState)(false), open = _b[0], setOpen = _b[1];
    if (!events.length)
        return null;
    return (<react_native_1.View style={styles.flexWrap}>
      <react_native_1.Pressable style={styles.flexHead} onPress={function () { return setOpen(function (o) { return !o; }); }}>
        <lucide_react_native_1.CalendarClock size={16} color={tokens_1.color.mute}/>
        <react_native_1.Text style={styles.flexTitle}>When you’re flexible</react_native_1.Text>
        <react_native_1.Text style={styles.flexCount}>· {events.length} plans</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        {open ? <lucide_react_native_1.ChevronUp size={18} color={tokens_1.color.mute}/> : <lucide_react_native_1.ChevronDown size={18} color={tokens_1.color.mute}/>}
      </react_native_1.Pressable>
      {open && (<react_native_1.View style={styles.flexBody}>
          <react_native_1.Text style={styles.flexNote}>Outside your set availability — shown in case your plans flex.</react_native_1.Text>
          {events.map(function (e) { return <EventCard key={e.id} ev={e} dim/>; })}
        </react_native_1.View>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md,
    },
    dim: { opacity: 0.6 },
    left: { flex: 1, gap: 4 },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    flexWrap: { marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.md, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paper, overflow: 'hidden' },
    flexHead: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: tokens_1.space.md },
    flexTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute }),
    flexCount: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontFamily: 'Courier' }),
    flexBody: { padding: tokens_1.space.md, paddingTop: 0, gap: tokens_1.space.sm },
    flexNote: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, marginBottom: 4 }),
});
