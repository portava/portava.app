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
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BestDaysBanner = BestDaysBanner;
/**
 * BestDaysBanner — shows up to 3 days where the most members are free.
 * Hidden when bestDays is empty or fewer than 2 members overlap.
 * Tapping a chip calls onDayPress(date) — the parent opens the day-summary modal.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function formatChipDate(date) {
    return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
    });
}
function BestDaysBanner(_a) {
    var bestDays = _a.bestDays, totalMembers = _a.totalMembers, onDayPress = _a.onDayPress;
    if (bestDays.length === 0)
        return null;
    return (<react_native_1.View style={b.wrap}>
      <react_native_1.View style={b.headerRow}>
        <lucide_react_native_1.Sparkles size={13} color={tokens_1.color.signal}/>
        <react_native_1.Text style={b.heading}>Best days to meet</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={b.chips}>
        {bestDays.map(function (d) { return (<react_native_1.Pressable key={d.date} style={b.chip} onPress={function () { return onDayPress(d.date); }}>
            <react_native_1.Text style={b.chipDate}>{formatChipDate(d.date)}</react_native_1.Text>
            <react_native_1.Text style={b.chipCount}>{d.count}/{totalMembers} free</react_native_1.Text>
          </react_native_1.Pressable>); })}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var b = react_native_1.StyleSheet.create({
    wrap: {
        backgroundColor: tokens_1.color.signal + '0D',
        borderRadius: tokens_1.radius.md,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '33',
        paddingTop: tokens_1.space.sm + 2,
        paddingBottom: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.md,
        gap: (_a = tokens_1.space.xs) !== null && _a !== void 0 ? _a : 4,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    heading: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700', fontSize: 12 }),
    chips: { flexDirection: 'row', gap: tokens_1.space.sm, paddingTop: (_b = tokens_1.space.xs) !== null && _b !== void 0 ? _b : 4 },
    chip: {
        backgroundColor: tokens_1.color.paperRaised,
        borderRadius: tokens_1.radius.pill,
        borderWidth: 1,
        borderColor: tokens_1.color.signal + '44',
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: (_c = tokens_1.space.xs) !== null && _c !== void 0 ? _c : 4,
        gap: 1,
    },
    chipDate: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 12 }),
    chipCount: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600', fontSize: 10 }),
});
