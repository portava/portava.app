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
exports.default = Trips;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var ui_1 = require("../../src/components/ui");
var cebu_1 = require("../../src/data/cebu");
var SessionContext_1 = require("../../src/context/SessionContext");
var useBackend_1 = require("../../src/hooks/useBackend");
var tokens_1 = require("../../src/theme/tokens");
function Trips() {
    var _a = (0, SessionContext_1.useSession)(), configured = _a.configured, isAuthed = _a.isAuthed;
    var live = configured && isAuthed;
    var _b = (0, useBackend_1.useMyTrips)(), realTrips = _b.data, loading = _b.loading, error = _b.error, reload = _b.reload;
    // refresh when returning to this screen
    react_1.default.useEffect(function () { if (live)
        reload(); }, [live, reload]);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Trips" right={<react_native_1.Pressable style={styles.newBtn} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
            <lucide_react_native_1.Plus size={16} color={tokens_1.color.onInk}/>
            <react_native_1.Text style={styles.newBtnText}>New trip</react_native_1.Text>
          </react_native_1.Pressable>}/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg, paddingBottom: tokens_1.space.xxxl }}>
        {live ? (<LiveTrips trips={realTrips} loading={loading} error={error}/>) : (cebu_1.trips.map(function (tr) { return (<react_native_1.Pressable key={tr.id} style={styles.card} onPress={function () { return expo_router_1.router.push("/trip/".concat(tr.id)); }}>
              <react_native_1.Image source={{ uri: tr.coverUrl }} style={styles.cover}/>
              <react_native_1.View style={styles.body}>
                <react_native_1.View style={styles.stampRow}>
                  <ui_1.Stamp label={tr.destination.city} tone="deep"/>
                  <ui_1.Stamp label={tr.isPublic ? 'public' : 'private'} rotate={2}/>
                </react_native_1.View>
                <react_native_1.Text style={styles.title}>{tr.title}</react_native_1.Text>
                <react_native_1.View style={styles.metaRow}><lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.mute}/><react_native_1.Text style={styles.meta}>{tr.startDate} – {tr.endDate} · {tr.dayCount} days</react_native_1.Text></react_native_1.View>
                <react_native_1.View style={styles.metaRow}><lucide_react_native_1.Users size={14} color={tokens_1.color.mute}/><react_native_1.Text style={styles.meta}>{tr.collaborators.length + 1} travelers · {tr.savedPostIds.length} saved</react_native_1.Text></react_native_1.View>
              </react_native_1.View>
            </react_native_1.Pressable>); }))}
        <react_native_1.Pressable style={styles.empty} onPress={function () { return expo_router_1.router.push('/trip/new'); }}>
          <lucide_react_native_1.Plus size={20} color={tokens_1.color.deep}/>
          <react_native_1.Text style={styles.emptyText}>Start a new trip</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
function LiveTrips(_a) {
    var trips = _a.trips, loading = _a.loading, error = _a.error;
    if (loading)
        return <react_native_1.View style={styles.state}><react_native_1.ActivityIndicator color={tokens_1.color.signal}/></react_native_1.View>;
    if (error)
        return <react_native_1.View style={styles.state}><react_native_1.Text style={styles.stateText}>Couldn't load your trips. Pull to retry.</react_native_1.Text></react_native_1.View>;
    if (!trips.length) {
        return (<react_native_1.View style={styles.bigEmpty}>
        <lucide_react_native_1.MapPin size={28} color={tokens_1.color.deep}/>
        <react_native_1.Text style={styles.bigEmptyTitle}>No trips yet</react_native_1.Text>
        <react_native_1.Text style={styles.bigEmptySub}>Create your first trip to start planning, saving places, and meeting travelers.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<>
      {trips.map(function (tr) {
            var _a;
            return (<react_native_1.Pressable key={tr.id} style={styles.card} onPress={function () { return expo_router_1.router.push("/trip/".concat(tr.id)); }}>
          {tr.coverUrl ? <react_native_1.Image source={{ uri: tr.coverUrl }} style={styles.cover}/> : <react_native_1.View style={[styles.cover, { backgroundColor: tokens_1.color.deep }]}/>}
          <react_native_1.View style={styles.body}>
            <react_native_1.View style={styles.stampRow}>
              <ui_1.Stamp label={tr.destinationCity} tone="deep"/>
              <ui_1.Stamp label={tr.visibility} rotate={2}/>
            </react_native_1.View>
            <react_native_1.Text style={styles.title}>{tr.title}</react_native_1.Text>
            <react_native_1.View style={styles.metaRow}>
              <lucide_react_native_1.CalendarDays size={14} color={tokens_1.color.mute}/>
              <react_native_1.Text style={styles.meta}>{(_a = tr.startDate) !== null && _a !== void 0 ? _a : 'Dates TBD'}{tr.endDate ? " \u2013 ".concat(tr.endDate) : ''} · {tr.status}</react_native_1.Text>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.Pressable>);
        })}
    </>);
}
var styles = react_native_1.StyleSheet.create({
    newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: tokens_1.color.ink, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill },
    newBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    card: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, overflow: 'hidden' }, tokens_1.shadow.card),
    cover: { width: '100%', height: 150, backgroundColor: tokens_1.color.haze },
    body: { padding: tokens_1.space.lg, gap: tokens_1.space.sm },
    stampRow: { flexDirection: 'row', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    empty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.xl, borderRadius: tokens_1.radius.lg, borderWidth: 1.5, borderColor: tokens_1.color.haze, borderStyle: 'dashed' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.deep, fontWeight: '600' }),
    state: { padding: tokens_1.space.xxl, alignItems: 'center' },
    stateText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    bigEmpty: { alignItems: 'center', gap: tokens_1.space.sm, padding: tokens_1.space.xxl, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze },
    bigEmptyTitle: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 18 }),
    bigEmptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
});
