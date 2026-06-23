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
exports.StampsTab = StampsTab;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var PassportStamps_1 = require("./PassportStamps");
var tokens_1 = require("../theme/tokens");
/** Shows only GPS-verified stamps (location_verified + stamp_eligible). */
function StampsTab(_a) {
    var stamps = _a.stamps;
    var verified = stamps.filter(function (s) { return !s.locked; });
    if (verified.length === 0) {
        return (<react_native_1.View style={st.empty}>
        <react_native_1.Text style={st.emptyIcon}>🔖</react_native_1.Text>
        <react_native_1.Text style={st.emptyTitle}>No verified stamps yet</react_native_1.Text>
        <react_native_1.Text style={st.emptySub}>GPS-verified posts can earn stamps when you check in at your tagged location.</react_native_1.Text>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={st.wrap}>
      <react_native_1.View style={st.grid}>
        {verified.map(function (s, i) { return (<react_native_1.View key={s.id} style={st.cell}>
            <PassportStamps_1.StampBadge stamp={s} size={80} rotate={((i % 3) - 1) * 4} onPress={function () { return expo_router_1.router.push('/stamps'); }}/>
          </react_native_1.View>); })}
      </react_native_1.View>
      <react_native_1.Pressable style={st.viewAll} onPress={function () { return expo_router_1.router.push('/stamps'); }}>
        <react_native_1.Text style={st.viewAllText}>View full stamp collection</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
var st = react_native_1.StyleSheet.create({
    wrap: { paddingHorizontal: tokens_1.space.lg, paddingTop: tokens_1.space.md },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.md, justifyContent: 'flex-start' },
    cell: { alignItems: 'center' },
    viewAll: { marginTop: tokens_1.space.xl, alignItems: 'center', borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill, paddingVertical: tokens_1.space.md },
    viewAllText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    empty: { paddingHorizontal: tokens_1.space.xl, paddingTop: tokens_1.space.xxxl, alignItems: 'center', gap: tokens_1.space.md },
    emptyIcon: { fontSize: 48 },
    emptyTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    emptySub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
});
