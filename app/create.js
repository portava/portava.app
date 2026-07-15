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
exports.default = Create;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var ui_1 = require("../src/components/ui");
var tokens_1 = require("../src/theme/tokens");
var CATS = ['hotel', 'food', 'nightlife', 'beach', 'activity', 'transport', 'airport', 'visa', 'safety', 'tip', 'question'];
var VIS = ['Public', 'Friends', 'Private'];
function Create() {
    var _a = (0, react_1.useState)('beach'), cat = _a[0], setCat = _a[1];
    var _b = (0, react_1.useState)('Public'), vis = _b[0], setVis = _b[1];
    var _c = (0, react_1.useState)(''), caption = _c[0], setCaption = _c[1];
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      <react_native_1.View style={styles.head}>
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8}><lucide_react_native_1.X size={24} color={tokens_1.color.ink}/></react_native_1.Pressable>
        <react_native_1.Text style={styles.title}>New post</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        <react_native_1.Pressable style={styles.post} onPress={function () { return expo_router_1.router.back(); }}><react_native_1.Text style={styles.postText}>Share</react_native_1.Text></react_native_1.Pressable>
      </react_native_1.View>
      <react_native_1.ScrollView contentContainerStyle={{ padding: tokens_1.space.lg, gap: tokens_1.space.lg }}>
        <react_native_1.Pressable style={styles.media}><lucide_react_native_1.Image size={28} color={tokens_1.color.mute}/><react_native_1.Text style={styles.mediaText}>Add photo or video</react_native_1.Text></react_native_1.Pressable>
        <react_native_1.TextInput style={styles.caption} placeholder="Share a tip, review, question, or moment…" placeholderTextColor={tokens_1.color.faint} multiline value={caption} onChangeText={setCaption}/>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Category</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{CATS.map(function (c) { return <ui_1.Chip key={c} label={c} active={c === cat} onPress={function () { return setCat(c); }}/>; })}</react_native_1.View>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Destination</react_native_1.Text>
          <react_native_1.View style={styles.wrap}><ui_1.Stamp label="Cebu, Philippines" tone="deep"/></react_native_1.View>
        </react_native_1.View>
        <react_native_1.View>
          <react_native_1.Text style={styles.label}>Visibility</react_native_1.Text>
          <react_native_1.View style={styles.wrap}>{VIS.map(function (v) { return <ui_1.Chip key={v} label={v} active={v === vis} onPress={function () { return setVis(v); }}/>; })}</react_native_1.View>
        </react_native_1.View>
      </react_native_1.ScrollView>
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, padding: tokens_1.space.lg, paddingTop: tokens_1.space.xxl, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    post: { backgroundColor: tokens_1.color.signal, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill },
    postText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    media: { height: 180, borderRadius: tokens_1.radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.paperRaised },
    mediaText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    caption: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, minHeight: 90, textAlignVertical: 'top' }),
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', color: tokens_1.color.mute, marginBottom: tokens_1.space.sm }),
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
});
