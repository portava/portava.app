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
exports.default = Notifications;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var cebu_1 = require("../src/data/cebu");
var tokens_1 = require("../src/theme/tokens");
function Notifications() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={[styles.head, { paddingTop: insets.top + tokens_1.space.md }]}>
        <react_native_1.Text style={styles.title}>Notifications</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}><lucide_react_native_1.X size={24} color={tokens_1.color.ink}/></react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.FlatList data={cebu_1.notifications} keyExtractor={function (n) { return n.id; }} contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }} renderItem={function (_a) {
            var item = _a.item;
            return (<react_native_1.View style={[styles.row, !item.read && styles.unread]}>
            {item.actor && <react_native_1.Image source={{ uri: item.actor.avatarUrl }} style={styles.avatar}/>}
            <react_native_1.Text style={styles.text}>{item.text}</react_native_1.Text>
          </react_native_1.View>);
        }}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.lg, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.md, borderRadius: 12 },
    unread: { backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.haze },
    text: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1 }),
});
