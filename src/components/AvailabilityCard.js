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
exports.AvailabilityCard = AvailabilityCard;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var availability_1 = require("../lib/availability");
var tokens_1 = require("../theme/tokens");
/**
 * Compact availability status card. Display-only this pass.
 * Edit routes to a safe placeholder until the editor screen exists.
 */
function AvailabilityCard(_a) {
    var status = _a.status;
    var notSet = status === 'not_set';
    var live = status === 'open_tonight' || status === 'trip_active';
    return (<react_native_1.Pressable style={styles.card} onPress={function () { return expo_router_1.router.push('/availability'); }}>
      <react_native_1.View style={[styles.dot, { backgroundColor: live ? tokens_1.color.signal : notSet ? tokens_1.color.faint : tokens_1.color.deep }]}/>
      <lucide_react_native_1.CalendarClock size={16} color={tokens_1.color.ink}/>
      <react_native_1.View style={{ flex: 1 }}>
        <react_native_1.Text style={styles.label}>{availability_1.STATUS_LABEL[status]}</react_native_1.Text>
        <react_native_1.Text style={styles.cta}>{notSet ? 'Set your availability' : 'Edit availability'}</react_native_1.Text>
      </react_native_1.View>
      <lucide_react_native_1.ChevronRight size={16} color={tokens_1.color.mute}/>
    </react_native_1.Pressable>);
}
var styles = react_native_1.StyleSheet.create({
    card: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md,
        borderWidth: 1, borderColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.md,
        marginTop: tokens_1.space.sm,
    },
    dot: { width: 9, height: 9, borderRadius: 5 },
    label: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    cta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 1 }),
});
