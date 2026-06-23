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
exports.TripsTab = TripsTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var STATUS_COLOR = {
    planning: tokens_1.color.mute,
    upcoming: tokens_1.color.deep,
    active: tokens_1.color.success,
    completed: tokens_1.color.signal,
    cancelled: tokens_1.color.faint,
};
function TripsTab(_a) {
    var trips = _a.trips, isOwner = _a.isOwner;
    var visible = isOwner ? trips : trips.filter(function (t) { return t.visibility === 'public'; });
    if (visible.length === 0) {
        return (<react_native_1.View style={tr.empty}>
        <react_native_1.Text style={tr.emptyIcon}>✈️</react_native_1.Text>
        <react_native_1.Text style={tr.emptyTitle}>No trips shown yet</react_native_1.Text>
        <react_native_1.Text style={tr.emptySub}>
          {isOwner ? 'Create your first trip to see it here.' : 'No public trips to show.'}
        </react_native_1.Text>
        {isOwner && (<react_native_1.Pressable style={tr.newBtn} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
            <react_native_1.Text style={tr.newBtnText}>Plan a trip</react_native_1.Text>
          </react_native_1.Pressable>)}
      </react_native_1.View>);
    }
    return (<react_native_1.View style={tr.list}>
      {visible.map(function (trip) {
            var _a;
            var statusColor = (_a = STATUS_COLOR[trip.status]) !== null && _a !== void 0 ? _a : tokens_1.color.mute;
            var dates = [trip.startDate, trip.endDate]
                .filter(Boolean)
                .map(function (d) { return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); })
                .join(' – ');
            return (<react_native_1.Pressable key={trip.id} style={tr.card} onPress={function () { return expo_router_1.router.push("/trip/".concat(trip.id)); }}>
            <react_native_1.View style={tr.top}>
              <react_native_1.View style={tr.dest}>
                <lucide_react_native_1.MapPin size={14} color={tokens_1.color.deep}/>
                <react_native_1.Text style={tr.city} numberOfLines={1}>{trip.destinationCity}</react_native_1.Text>
                {trip.destinationCountry ? <react_native_1.Text style={tr.country}>{trip.destinationCountry}</react_native_1.Text> : null}
              </react_native_1.View>
              <react_native_1.View style={[tr.statusBadge, { backgroundColor: "".concat(statusColor, "18") }]}>
                <react_native_1.Text style={[tr.statusText, { color: statusColor }]}>{trip.status.replace('_', ' ')}</react_native_1.Text>
              </react_native_1.View>
            </react_native_1.View>
            <react_native_1.Text style={tr.title} numberOfLines={1}>{trip.title}</react_native_1.Text>
            {dates ? (<react_native_1.View style={tr.dateRow}>
                <lucide_react_native_1.Calendar size={12} color={tokens_1.color.faint}/>
                <react_native_1.Text style={tr.dates}>{dates}</react_native_1.Text>
              </react_native_1.View>) : null}
            <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.faint} style={tr.chevron}/>
          </react_native_1.Pressable>);
        })}
    </react_native_1.View>);
}
var tr = react_native_1.StyleSheet.create({
    list: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md, gap: tokens_1.space.md },
    card: {
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg,
        borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.lg,
    },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens_1.space.xs },
    dest: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
    city: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, flex: 1 }),
    country: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    statusBadge: { borderRadius: tokens_1.radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
    statusText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', fontSize: 11, textTransform: 'capitalize' }),
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.xs }),
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: tokens_1.space.xs },
    dates: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    chevron: { position: 'absolute', right: tokens_1.space.lg, top: '50%' },
    empty: { paddingHorizontal: tokens_1.space.xl, paddingTop: tokens_1.space.xxxl, alignItems: 'center', gap: tokens_1.space.md },
    emptyIcon: { fontSize: 48 },
    emptyTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    emptySub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    newBtn: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.xl, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill },
    newBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
