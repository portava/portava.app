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
exports.ScreenHeader = ScreenHeader;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function ScreenHeader(_a) {
    var title = _a.title, back = _a.back, right = _a.right;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<react_native_1.View style={[styles.wrap, { paddingTop: insets.top + tokens_1.space.sm }]}>
      {back && (<react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8} style={styles.back}>
          <lucide_react_native_1.ChevronLeft size={26} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>)}
      <react_native_1.Text style={styles.title}>{title}</react_native_1.Text>
      <react_native_1.View style={{ flex: 1 }}/>
      {right}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    wrap: {
        flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm,
        paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md,
        backgroundColor: tokens_1.color.paper, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze,
    },
    back: { marginLeft: -6 },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
});
