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
exports.default = TabLayout;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../src/theme/tokens");
/** Center vermilion passport-stamp create button. */
function StampButton() {
    return (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push('/create'); }} style={styles.stampBtn} accessibilityRole="button" accessibilityLabel="Share a travel post">
      <react_native_1.View style={styles.stampInner}>
        <react_native_1.Text style={styles.stampGlyph}>✛</react_native_1.Text>
        <react_native_1.Text style={styles.stampWord}>POST</react_native_1.Text>
      </react_native_1.View>
    </react_native_1.Pressable>);
}
function TabLayout() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<expo_router_1.Tabs screenOptions={{
            headerShown: false,
            tabBarShowLabel: true,
            tabBarActiveTintColor: tokens_1.color.ink,
            tabBarInactiveTintColor: tokens_1.color.faint,
            tabBarStyle: [styles.bar, { height: 58 + insets.bottom, paddingBottom: insets.bottom }],
            tabBarLabelStyle: styles.label,
        }}>
      <expo_router_1.Tabs.Screen name="index" options={{
            title: 'Pulse',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return <lucide_react_native_1.Activity size={22} color={c}/>;
            },
        }}/>
      <expo_router_1.Tabs.Screen name="discovery" options={{
            title: 'Explore',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return <lucide_react_native_1.Compass size={22} color={c}/>;
            },
        }}/>
      <expo_router_1.Tabs.Screen name="create-tab" options={{
            title: '',
            tabBarButton: function () { return <StampButton />; },
        }} listeners={{ tabPress: function (e) { e.preventDefault(); expo_router_1.router.push('/create'); } }}/>
      <expo_router_1.Tabs.Screen name="trips" options={{
            title: 'Trips',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return <lucide_react_native_1.Map size={22} color={c}/>;
            },
        }}/>
      <expo_router_1.Tabs.Screen name="passport" options={{
            title: 'Passport',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return <lucide_react_native_1.User size={22} color={c}/>;
            },
        }}/>
      {/* AI chat lives off-tab, reachable from headers/cards */}
      <expo_router_1.Tabs.Screen name="ai" options={{ href: null, title: 'AI' }}/>
    </expo_router_1.Tabs>);
}
var styles = react_native_1.StyleSheet.create({
    bar: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopWidth: 1,
        borderTopColor: tokens_1.color.haze,
        paddingTop: 6,
    },
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', marginTop: 2 }),
    stampBtn: __assign({ top: -18, alignSelf: 'center', width: 62, height: 62 }, tokens_1.shadow.float),
    stampInner: {
        flex: 1,
        borderRadius: 16,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ rotate: '-6deg' }],
        borderWidth: 2,
        borderColor: tokens_1.color.signalDim,
    },
    stampGlyph: { color: tokens_1.color.onInk, fontSize: 20, lineHeight: 22, fontWeight: '900' },
    stampWord: {
        color: tokens_1.color.onInk, fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 1,
    },
});
