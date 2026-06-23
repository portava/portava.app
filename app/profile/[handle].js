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
exports.default = Profile;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ScreenHeader_1 = require("../../src/components/ScreenHeader");
var ui_1 = require("../../src/components/ui");
var cebu_1 = require("../../src/data/cebu");
var tokens_1 = require("../../src/theme/tokens");
function Profile() {
    var handle = (0, expo_router_1.useLocalSearchParams)().handle;
    var u = (0, cebu_1.userByHandle)(handle);
    if (!u)
        return <react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}><ScreenHeader_1.ScreenHeader title="Profile" back/></react_native_1.View>;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title={"@".concat(u.handle)} back/>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }}>
        <react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.avatar}/>
        <react_native_1.Text style={styles.name}>{u.name}{u.verified ? ' ✓' : ''}</react_native_1.Text>
        <react_native_1.Text style={styles.meta}>{u.homeCity}, {u.homeCountry}{u.currentCity ? " \u00B7 now in ".concat(u.currentCity) : ''}</react_native_1.Text>
        {u.bio && <react_native_1.Text style={styles.bio}>{u.bio}</react_native_1.Text>}
        <react_native_1.View style={styles.stampRow}>
          {u.openToMeet && <ui_1.Stamp label="open to meet" tone="signal"/>}
          <ui_1.Stamp label={u.travelStyle} tone="deep" rotate={2}/>
          {u.interests.slice(0, 3).map(function (i) { return <ui_1.Stamp key={i} label={i} rotate={-2}/>; })}
        </react_native_1.View>
        <react_native_1.View style={styles.actions}>
          <react_native_1.Pressable style={styles.follow}><react_native_1.Text style={styles.followText}>Follow</react_native_1.Text></react_native_1.Pressable>
          <react_native_1.Pressable style={styles.msg}><react_native_1.Text style={styles.msgText}>Message</react_native_1.Text></react_native_1.Pressable>
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: tokens_1.color.haze },
    name: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    bio: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink }),
    stampRow: { flexDirection: 'row', gap: tokens_1.space.sm, flexWrap: 'wrap' },
    actions: { flexDirection: 'row', gap: tokens_1.space.sm, marginTop: tokens_1.space.sm },
    follow: { flex: 1, backgroundColor: tokens_1.color.ink, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    followText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.onInk }),
    msg: { flex: 1, borderWidth: 1, borderColor: tokens_1.color.haze, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    msgText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
});
