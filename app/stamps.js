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
exports.default = StampsPage;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var ui_1 = require("../src/components/ui");
var PassportStamps_1 = require("../src/components/PassportStamps");
var stampMotif_1 = require("../src/lib/stampMotif");
var usePassport_1 = require("../src/hooks/usePassport");
var tokens_1 = require("../src/theme/tokens");
var FILTERS = [
    { label: 'All' },
    { label: 'Cities', kind: 'city' },
    { label: 'Plans', kind: 'plan' },
    { label: 'Gems', kind: 'gem' },
    { label: 'Trust', kind: 'safe' },
    { label: 'Hosted', kind: 'host' },
    { label: 'Perks', kind: 'perk' },
];
var REASON = {
    city: 'Visited and checked in to this city.',
    plan: 'Joined a travel plan with other buddies.',
    gem: 'Discovered and shared a hidden gem.',
    safe: 'Completed a verified safe meetup.',
    host: 'Hosted an experience for other travelers.',
    perk: 'Unlocked a Travel Buddy perk.',
};
function StampsPage() {
    var _a;
    var data = (0, usePassport_1.usePassport)().data;
    var _b = (0, react_1.useState)('All'), filter = _b[0], setFilter = _b[1];
    var _c = (0, react_1.useState)(null), selected = _c[0], setSelected = _c[1];
    var stamps = (_a = data === null || data === void 0 ? void 0 : data.stamps) !== null && _a !== void 0 ? _a : [];
    var active = FILTERS.find(function (f) { return f.label === filter; });
    var shown = (active === null || active === void 0 ? void 0 : active.kind) ? stamps.filter(function (s) { return s.kind === active.kind; }) : stamps;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Passport Stamps" back/>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: tokens_1.space.sm, padding: tokens_1.space.lg }}>
        {FILTERS.map(function (f) { return (<ui_1.Chip key={f.label} label={f.label} active={f.label === filter} onPress={function () { return setFilter(f.label); }}/>); })}
      </react_native_1.ScrollView>

      <react_native_1.ScrollView contentContainerStyle={styles.grid}>
        {shown.map(function (s, i) { return (<react_native_1.View key={s.id} style={styles.cell}>
            <PassportStamps_1.StampBadge stamp={s} size={96} rotate={((i % 3) - 1) * 4} onPress={function () { return setSelected(s); }}/>
            <react_native_1.Text style={styles.cellName} numberOfLines={1}>{s.label}</react_native_1.Text>
            {s.locked ? <react_native_1.Text style={styles.cellLocked}>Locked</react_native_1.Text> : null}
          </react_native_1.View>); })}
        {shown.length === 0 && (<react_native_1.View style={styles.empty}><react_native_1.Text style={styles.emptyText}>No stamps in this category yet.</react_native_1.Text></react_native_1.View>)}
      </react_native_1.ScrollView>

      <react_native_1.Modal visible={!!selected} transparent animationType="fade" onRequestClose={function () { return setSelected(null); }}>
        <react_native_1.Pressable style={styles.backdrop} onPress={function () { return setSelected(null); }}>
          <react_native_1.Pressable style={styles.sheet} onPress={function (e) { return e.stopPropagation(); }}>
            <react_native_1.Pressable style={styles.close} onPress={function () { return setSelected(null); }} hitSlop={8}>
              <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
            </react_native_1.Pressable>
            {selected && (<react_native_1.View style={{ alignItems: 'center', gap: tokens_1.space.md }}>
                <PassportStamps_1.StampBadge stamp={selected} size={120}/>
                <react_native_1.Text style={styles.detailName}>{selected.label}</react_native_1.Text>
                <react_native_1.View style={styles.detailStamps}>
                  <ui_1.Stamp label={selected.kind} tone="deep"/>
                  {selected.sublabel ? <ui_1.Stamp label={selected.sublabel} rotate={2}/> : null}
                  <ui_1.Stamp label={selected.locked ? 'locked' : 'earned'} tone={selected.locked ? 'ink' : 'signal'} rotate={-2}/>
                </react_native_1.View>
                <react_native_1.Text style={styles.detailReason}>{REASON[selected.kind]}</react_native_1.Text>
                {(0, stampMotif_1.motifFor)(selected).provisional && (<react_native_1.Text style={styles.provisional}>ⓘ Starter city notes — provisional, not verified</react_native_1.Text>)}
                {!selected.locked && selected.earnedAt ? (<react_native_1.Text style={styles.detailDate}>Earned {new Date(selected.earnedAt).toLocaleDateString()}</react_native_1.Text>) : (<react_native_1.Text style={styles.detailDate}>Not earned yet</react_native_1.Text>)}
              </react_native_1.View>)}
          </react_native_1.Pressable>
        </react_native_1.Pressable>
      </react_native_1.Modal>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', padding: tokens_1.space.lg, paddingTop: 0, rowGap: tokens_1.space.xl },
    cell: { width: '30%', alignItems: 'center', gap: 6 },
    cellName: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600' }),
    cellLocked: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.faint }),
    empty: { width: '100%', padding: tokens_1.space.xl, alignItems: 'center' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.55)', alignItems: 'center', justifyContent: 'center', padding: tokens_1.space.xl },
    sheet: { width: '100%', maxWidth: 360, backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.xl },
    close: { position: 'absolute', right: tokens_1.space.md, top: tokens_1.space.md, zIndex: 2 },
    detailName: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    detailStamps: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap', justifyContent: 'center' },
    detailReason: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
    provisional: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontFamily: 'Courier', textAlign: 'center', fontSize: 11 }),
    detailDate: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontFamily: 'Courier' }),
});
