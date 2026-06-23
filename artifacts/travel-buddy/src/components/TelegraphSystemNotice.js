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
exports.TelegraphSystemNotice = TelegraphSystemNotice;
/**
 * TelegraphSystemNotice — centered notice pill for system_notice messages.
 * Used for things like "You matched availability this weekend",
 * "Trip plan updated", or "Activity confirmed by host".
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function TelegraphSystemNotice(_a) {
    var text = _a.text;
    return (<react_native_1.View style={styles.wrap}>
      <react_native_1.View style={styles.pill}>
        <lucide_react_native_1.Info size={11} color={tokens_1.color.mute}/>
        <react_native_1.Text style={styles.text}>{text}</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrap: {
        alignItems: 'center',
        paddingVertical: tokens_1.space.sm,
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        backgroundColor: tokens_1.color.paperRaised,
        borderWidth: 1,
        borderColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.pill,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: 5,
        maxWidth: '80%',
    },
    text: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, textAlign: 'center', fontFamily: 'Courier' }),
});
