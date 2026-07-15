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
exports.default = Circle;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var ScreenHeader_1 = require("../src/components/ScreenHeader");
var ui_1 = require("../src/components/ui");
var usePassport_1 = require("../src/hooks/usePassport");
var tokens_1 = require("../src/theme/tokens");
/** Circle page — Travel Circle (buddies) + Met Travelers (crossed paths). */
function Circle() {
    var _a;
    var data = (0, usePassport_1.usePassport)().data;
    var _b = (0, react_1.useState)('circle'), tab = _b[0], setTab = _b[1];
    var buddies = (_a = data === null || data === void 0 ? void 0 : data.buddies) !== null && _a !== void 0 ? _a : [];
    var met = __spreadArray([], buddies, true).reverse();
    var list = tab === 'circle' ? buddies : met;
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <ScreenHeader_1.ScreenHeader title="Circle" back/>
      <react_native_1.View style={styles.tabBar}>
        <react_native_1.Pressable style={[styles.tab, tab === 'circle' && styles.tabActive]} onPress={function () { return setTab('circle'); }}>
          <react_native_1.Text style={[styles.tabText, tab === 'circle' && styles.tabTextActive]}>Travel Circle</react_native_1.Text>
        </react_native_1.Pressable>
        <react_native_1.Pressable style={[styles.tab, tab === 'met' && styles.tabActive]} onPress={function () { return setTab('met'); }}>
          <react_native_1.Text style={[styles.tabText, tab === 'met' && styles.tabTextActive]}>Met Travelers</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.md }}>
        <react_native_1.Text style={styles.note}>
          {tab === 'circle' ? 'Buddies you’re connected with.' : 'Travelers you’ve crossed paths with.'}
        </react_native_1.Text>
        {list.map(function (u) {
            var _a;
            return (<react_native_1.Pressable key={u.id} style={styles.row} onPress={function () { return expo_router_1.router.push("/profile/".concat(u.handle)); }}>
            <react_native_1.Image source={{ uri: u.avatarUrl }} style={styles.avatar}/>
            <react_native_1.View style={{ flex: 1 }}>
              <react_native_1.Text style={styles.name}>{u.name}{u.verified ? ' ✓' : ''}</react_native_1.Text>
              <react_native_1.Text style={styles.meta}>{u.homeCity} → {(_a = u.currentCity) !== null && _a !== void 0 ? _a : '—'}</react_native_1.Text>
            </react_native_1.View>
            {u.openToMeet && <ui_1.Stamp label="open to meet" tone="signal"/>}
          </react_native_1.Pressable>);
        })}
        {list.length === 0 && <react_native_1.Text style={styles.note}>No one here yet.</react_native_1.Text>}
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    tabBar: { flexDirection: 'row', gap: tokens_1.space.sm, margin: tokens_1.space.lg, marginBottom: 0, padding: 4, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, borderRadius: tokens_1.radius.pill },
    tab: { flex: 1, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, alignItems: 'center' },
    tabActive: { backgroundColor: tokens_1.color.ink },
    tabText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.mute, fontSize: 13 }),
    tabTextActive: { color: tokens_1.color.onInk },
    note: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze, padding: tokens_1.space.md },
    avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: tokens_1.color.haze },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    meta: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, marginTop: 2 }),
});
