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
exports.default = Messages;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
function Messages() {
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Messages" back/>
      <react_native_1.FlatList data={cebu_1.conversations} keyExtractor={function (c) { return c.id; }} contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }} renderItem={function (_a) {
            var item = _a.item;
            var other = item.participants.find(function (p) { return p.id !== cebu_1.me.id; });
            return (<react_native_1.Pressable style={styles.row} onPress={function () { return expo_router_1.router.push("/messages/".concat(item.id)); }}>
              <react_native_1.Image source={{ uri: other.avatarUrl }} style={styles.avatar}/>
              <react_native_1.View style={{ flex: 1 }}>
                <react_native_1.Text style={styles.name}>{other.name}</react_native_1.Text>
                <react_native_1.Text style={styles.preview} numberOfLines={1}>{item.lastMessage}</react_native_1.Text>
              </react_native_1.View>
              {item.unread > 0 && <react_native_1.View style={styles.badge}><react_native_1.Text style={styles.badgeText}>{item.unread}</react_native_1.Text></react_native_1.View>}
            </react_native_1.Pressable>);
        }}/>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: tokens_1.color.haze },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    preview: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
    badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
    badgeText: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.onInk }),
});
