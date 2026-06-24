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
exports.RsvpBar = RsvpBar;
/**
 * RsvpBar — a slim, colour-segmented progress bar summarising a meetup's RSVP
 * split: Going (green), Maybe (amber), Invited/Pending (grey).
 *
 * The bar is capped at `total` (the invitee count); when no one has responded
 * yet it renders as a fully grey track. A compact legend with colour dots shows
 * the exact counts below the bar. Static render only (no animated fill).
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var tokens_1 = require("../theme/tokens");
var GOING_COLOR = tokens_1.color.success; // green
var MAYBE_COLOR = '#E0A417'; // amber
var PENDING_COLOR = tokens_1.color.haze; // grey track / invited
function RsvpBar(_a) {
    var going = _a.going, maybe = _a.maybe, pending = _a.pending, total = _a.total, style = _a.style;
    var g = Math.max(0, going);
    var m = Math.max(0, maybe);
    var p = Math.max(0, pending);
    var sum = g + m + p;
    // Bar length is capped at the invitee `total` when provided (in either
    // direction); otherwise it falls back to the sum of the counts. Segment
    // weights are clamped so the responded portions never overflow the cap.
    var cap = typeof total === 'number' && total > 0 ? total : sum;
    var goingBar = Math.min(g, cap);
    var maybeBar = Math.min(m, Math.max(0, cap - goingBar));
    var greyBar = Math.max(0, cap - goingBar - maybeBar);
    return (<react_native_1.View style={style}>
      <react_native_1.View style={styles.track}>
        {goingBar > 0 ? <react_native_1.View style={{ flex: goingBar, backgroundColor: GOING_COLOR }}/> : null}
        {maybeBar > 0 ? <react_native_1.View style={{ flex: maybeBar, backgroundColor: MAYBE_COLOR }}/> : null}
        {greyBar > 0 ? <react_native_1.View style={{ flex: greyBar, backgroundColor: PENDING_COLOR }}/> : null}
      </react_native_1.View>

      <react_native_1.View style={styles.legend}>
        <LegendItem dotColor={GOING_COLOR} count={g} label="Going"/>
        <LegendItem dotColor={MAYBE_COLOR} count={m} label="Maybe"/>
        <LegendItem dotColor={PENDING_COLOR} count={p} label="Invited"/>
      </react_native_1.View>
    </react_native_1.View>);
}
function LegendItem(_a) {
    var dotColor = _a.dotColor, count = _a.count, label = _a.label;
    return (<react_native_1.View style={styles.legendItem}>
      <react_native_1.View style={[styles.dot, { backgroundColor: dotColor }]}/>
      <react_native_1.Text style={styles.legendText}>
        {count} {label}
      </react_native_1.Text>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    track: {
        flexDirection: 'row',
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        backgroundColor: PENDING_COLOR,
    },
    legend: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        marginTop: 5,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
    },
    legendText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11 }),
});
