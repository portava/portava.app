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
exports.CompactStatsRow = CompactStatsRow;
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
function fmt(n) {
    if (!Number.isFinite(n) || isNaN(n))
        return '0';
    if (n >= 1000)
        return (n / 1000).toFixed(1) + 'k';
    return String(n);
}
function CompactStatsRow(_a) {
    var postcards = _a.postcards, stamps = _a.stamps, trips = _a.trips;
    var verifiedStamps = stamps;
    var countries = new Set(postcards.map(function (c) { return c.locationCountry; }).filter(Boolean)).size;
    var cities = new Set(postcards.map(function (c) { return c.locationCity; }).filter(Boolean)).size;
    var items = [
        { n: postcards.length, label: 'Postcards' },
        { n: verifiedStamps, label: 'Stamps' },
        { n: countries, label: 'Countries' },
        { n: cities, label: 'Cities' },
        { n: trips.length, label: 'Trips' },
    ];
    return (<react_native_1.View style={st.row}>
      {items.map(function (item, i) { return (<react_1.default.Fragment key={item.label}>
          {i > 0 && <react_native_1.View style={st.divider}/>}
          <react_native_1.View style={st.cell}>
            <react_native_1.Text style={st.n}>{fmt(item.n)}</react_native_1.Text>
            <react_native_1.Text style={st.l}>{item.label}</react_native_1.Text>
          </react_native_1.View>
        </react_1.default.Fragment>); })}
    </react_native_1.View>);
}
var st = react_native_1.StyleSheet.create({
    row: {
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.lg, borderWidth: 1, borderColor: tokens_1.color.haze,
        marginHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.sm,
        paddingVertical: 10,
    },
    cell: { flex: 1, alignItems: 'center', gap: 1 },
    divider: { width: 1, height: 28, backgroundColor: tokens_1.color.haze },
    n: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, fontSize: 17 }),
    l: { fontFamily: 'Courier', fontSize: 9, color: tokens_1.color.mute, letterSpacing: 0.5, fontWeight: '700' },
});
