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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Onboarding;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ui_1 = require("../../src/components/ui");
var tokens_1 = require("../../src/theme/tokens");
var INTERESTS = ['nightlife', 'beach', 'food', 'luxury', 'backpacking', 'culture', 'adventure', 'shopping', 'photography', 'business', 'dating', 'wellness', 'events'];
var STYLES = ['solo', 'couple', 'group', 'business'];
function Onboarding() {
    var _a = (0, react_1.useState)([]), picked = _a[0], setPicked = _a[1];
    var _b = (0, react_1.useState)('solo'), style = _b[0], setStyle = _b[1];
    var toggle = function (i) { return setPicked(function (p) { return p.includes(i) ? p.filter(function (x) { return x !== i; }) : __spreadArray(__spreadArray([], p, true), [i], false); }); };
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, paddingTop: tokens_1.space.xxxl, gap: tokens_1.space.xl }}>
        <react_native_1.View>
          <ui_1.Stamp label="welcome aboard" tone="signal"/>
          <react_native_1.Text style={styles.title}>Set up your{'\n'}travel passport</react_native_1.Text>
          <react_native_1.Text style={styles.sub}>We’ll tune your feed and who you meet.</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>How do you travel?</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{STYLES.map(function (s) { return <ui_1.Chip key={s} label={s} active={s === style} onPress={function () { return setStyle(s); }}/>; })}</react_native_1.View>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>What are you into?</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{INTERESTS.map(function (i) { return <ui_1.Chip key={i} label={i} active={picked.includes(i)} onPress={function () { return toggle(i); }}/>; })}</react_native_1.View>
        </react_native_1.View>
      </react_native_1.ScrollView>
      <react_native_1.Pressable style={styles.cta} onPress={function () { return expo_router_1.router.replace('/(tabs)'); }}>
        <react_native_1.Text style={styles.ctaText}>Enter Travel Buddy</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    title: __assign(__assign({}, tokens_1.type.hero), { fontSize: 34, lineHeight: 36, color: tokens_1.color.ink, marginTop: tokens_1.space.md }),
    sub: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, marginTop: tokens_1.space.sm }),
    label: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, marginBottom: tokens_1.space.md }),
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    cta: { margin: tokens_1.space.lg, backgroundColor: tokens_1.color.signal, paddingVertical: tokens_1.space.lg, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    ctaText: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.onInk }),
});
