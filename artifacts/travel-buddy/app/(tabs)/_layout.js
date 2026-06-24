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
var useBreakpoint_1 = require("../../src/hooks/useBreakpoint");
var useMessaging_1 = require("../../src/hooks/useMessaging");
var messaging_1 = require("../../src/services/messaging");
var NAV_ITEMS = [
    { href: '/(tabs)/', label: 'Pulse', icon: lucide_react_native_1.Activity, match: ['/(tabs)', '/(tabs)/'] },
    { href: '/(tabs)/discovery', label: 'Explore', icon: lucide_react_native_1.Compass, match: ['/(tabs)/discovery'] },
    { href: '/(tabs)/trips', label: 'Trips', icon: lucide_react_native_1.Map, match: ['/(tabs)/trips'] },
    { href: '/(tabs)/passport', label: 'Passport', icon: lucide_react_native_1.User, match: ['/(tabs)/passport'] },
];
function DesktopSidebar(_a) {
    var unreadNotifications = _a.unreadNotifications, unreadMessages = _a.unreadMessages, pendingRequests = _a.pendingRequests;
    var pathname = (0, expo_router_1.usePathname)();
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    return (<react_native_1.View style={[styles.sidebar, { paddingTop: insets.top + tokens_1.space.xl, paddingBottom: insets.bottom + tokens_1.space.lg }]}>
      {/* Brand */}
      <react_native_1.View style={styles.brand}>
        <react_native_1.View style={styles.brandIcon}><lucide_react_native_1.Plane size={18} color={tokens_1.color.onInk}/></react_native_1.View>
        <react_native_1.Text style={styles.brandName}>Travel Buddy</react_native_1.Text>
      </react_native_1.View>

      {/* Nav links */}
      <react_native_1.View style={styles.navLinks}>
        {NAV_ITEMS.map(function (_a) {
            var href = _a.href, label = _a.label, Icon = _a.icon, match = _a.match;
            var active = match.some(function (m) { return pathname === m || pathname.startsWith(m + '/'); });
            return (<react_native_1.Pressable key={href} style={[styles.navItem, active && styles.navItemActive]} onPress={function () { return expo_router_1.router.push(href); }}>
              <Icon size={20} color={active ? tokens_1.color.signal : tokens_1.color.mute}/>
              <react_native_1.Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.View>

      <react_native_1.View style={{ flex: 1 }}/>

      {/* Telegraph (Messages) link */}
      <react_native_1.Pressable style={styles.notifBtn} onPress={function () { return expo_router_1.router.push('/(tabs)/messages'); }}>
        <lucide_react_native_1.MessageCircle size={18} color={tokens_1.color.mute}/>
        <react_native_1.Text style={styles.navLabel}>Telegraph</react_native_1.Text>
        {(unreadMessages + pendingRequests) > 0 && (<react_native_1.View style={styles.sidebarBadge}>
            <react_native_1.Text style={styles.sidebarBadgeText}>{(unreadMessages + pendingRequests) > 99 ? '99+' : String(unreadMessages + pendingRequests)}</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.Pressable>

      {/* Notifications link */}
      <react_native_1.Pressable style={styles.notifBtn} onPress={function () { return expo_router_1.router.push('/notifications'); }}>
        <lucide_react_native_1.Bell size={18} color={tokens_1.color.mute}/>
        <react_native_1.Text style={styles.navLabel}>Notifications</react_native_1.Text>
        {unreadNotifications > 0 && (<react_native_1.View style={styles.sidebarBadge}>
            <react_native_1.Text style={styles.sidebarBadgeText}>{unreadNotifications > 99 ? '99+' : String(unreadNotifications)}</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.Pressable>

      {/* Compose button */}
      <react_native_1.Pressable style={styles.composeBtn} onPress={function () { return expo_router_1.router.push('/create'); }}>
        <lucide_react_native_1.Plus size={18} color={tokens_1.color.onInk}/>
        <react_native_1.Text style={styles.composeBtnText}>New Post</react_native_1.Text>
      </react_native_1.Pressable>
    </react_native_1.View>);
}
/** Flat Post tab button — same size and alignment as all other nav items. */
function PostTabButton() {
    return (<react_native_1.Pressable onPress={function () { return expo_router_1.router.push('/create'); }} style={function (_a) {
        var pressed = _a.pressed;
        return [styles.postTabBtn, pressed && { opacity: 0.6 }];
    }} accessibilityRole="button" accessibilityLabel="Create a post">
      <lucide_react_native_1.Plus size={22} color={tokens_1.color.signal}/>
      <react_native_1.Text style={[styles.label, styles.postTabLabel]}>Post</react_native_1.Text>
    </react_native_1.Pressable>);
}
function TabLayout() {
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var isDesktop = (0, useBreakpoint_1.useIsDesktop)();
    var _a = (0, useMessaging_1.useUnreadCounts)(), unreadMessages = _a.messages, unreadNotifications = _a.notifications, newHighlights = _a.newHighlights, refreshUnread = _a.refresh;
    var _b = (0, react_1.useState)(0), pendingRequests = _b[0], setPendingRequests = _b[1];
    (0, react_1.useEffect)(function () {
        (0, messaging_1.getIncomingMessageRequests)().then(function (res) {
            if (res.ok && res.data)
                setPendingRequests(res.data.requests.length);
        });
        var timer = setInterval(function () {
            (0, messaging_1.getIncomingMessageRequests)().then(function (res) {
                if (res.ok && res.data)
                    setPendingRequests(res.data.requests.length);
            });
        }, 60000);
        return function () { return clearInterval(timer); };
    }, []);
    var tabs = (<expo_router_1.Tabs screenOptions={{
            headerShown: false,
            tabBarShowLabel: !isDesktop,
            tabBarActiveTintColor: tokens_1.color.ink,
            tabBarInactiveTintColor: tokens_1.color.faint,
            tabBarStyle: isDesktop
                ? { display: 'none' }
                : [styles.bar, { height: 58 + insets.bottom, paddingBottom: insets.bottom }],
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
                return (<react_native_1.View>
              <lucide_react_native_1.Compass size={22} color={c}/>
              {newHighlights > 0 && (<react_native_1.View style={styles.tabBadge}>
                  <react_native_1.Text style={styles.tabBadgeText}>
                    {newHighlights > 99 ? '99+' : String(newHighlights)}
                  </react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>);
            },
        }} listeners={{ focus: refreshUnread }}/>
      <expo_router_1.Tabs.Screen name="create-tab" options={{
            title: 'Post',
            tabBarButton: function () { return (isDesktop ? <react_native_1.View style={{ width: 0 }}/> : <PostTabButton />); },
        }} listeners={{ tabPress: function (e) { e.preventDefault(); expo_router_1.router.push('/create'); } }}/>
      <expo_router_1.Tabs.Screen name="trips" options={{
            title: 'Trips',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return <lucide_react_native_1.Map size={22} color={c}/>;
            },
        }}/>
      <expo_router_1.Tabs.Screen name="messages" options={{
            title: 'Telegraph',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return (<react_native_1.View>
              <lucide_react_native_1.MessageCircle size={22} color={c}/>
              {(unreadMessages + pendingRequests) > 0 && (<react_native_1.View style={styles.tabBadge}>
                  <react_native_1.Text style={styles.tabBadgeText}>
                    {(unreadMessages + pendingRequests) > 99 ? '99+' : String(unreadMessages + pendingRequests)}
                  </react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>);
            },
        }} listeners={{ focus: refreshUnread }}/>
      <expo_router_1.Tabs.Screen name="passport" options={{
            title: 'Passport',
            tabBarIcon: function (_a) {
                var c = _a.color;
                return (<react_native_1.View>
              <lucide_react_native_1.User size={22} color={c}/>
              {unreadNotifications > 0 && (<react_native_1.View style={styles.tabBadge}>
                  <react_native_1.Text style={styles.tabBadgeText}>
                    {unreadNotifications > 99 ? '99+' : String(unreadNotifications)}
                  </react_native_1.Text>
                </react_native_1.View>)}
            </react_native_1.View>);
            },
        }} listeners={{ focus: refreshUnread, tabPress: refreshUnread }}/>
      <expo_router_1.Tabs.Screen name="ai" options={{ href: null, title: 'AI' }}/>
    </expo_router_1.Tabs>);
    if (isDesktop) {
        return (<react_native_1.View style={styles.desktopShell}>
        <DesktopSidebar unreadNotifications={unreadNotifications} unreadMessages={unreadMessages} pendingRequests={pendingRequests}/>
        <react_native_1.View style={styles.desktopContent}>{tabs}</react_native_1.View>
      </react_native_1.View>);
    }
    return tabs;
}
var SIDEBAR_WIDTH = 220;
var styles = react_native_1.StyleSheet.create({
    /* ── Desktop shell ── */
    desktopShell: {
        flex: 1,
        flexDirection: 'row',
        backgroundColor: tokens_1.color.paper,
    },
    desktopContent: {
        flex: 1,
        maxWidth: 720,
    },
    /* ── Sidebar ── */
    sidebar: {
        width: SIDEBAR_WIDTH,
        backgroundColor: tokens_1.color.paperRaised,
        borderRightWidth: 1,
        borderRightColor: tokens_1.color.haze,
        paddingHorizontal: tokens_1.space.lg,
        gap: tokens_1.space.xl,
    },
    brand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
    },
    brandIcon: {
        width: 32,
        height: 32,
        borderRadius: 10,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
    },
    brandName: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '800' }),
    navLinks: {
        gap: tokens_1.space.xs,
    },
    navItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.md,
        borderRadius: 10,
    },
    navItemActive: {
        backgroundColor: tokens_1.color.paper,
    },
    navLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, fontWeight: '500', flex: 1 }),
    navLabelActive: {
        color: tokens_1.color.ink,
        fontWeight: '700',
    },
    notifBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.md,
        borderRadius: 10,
    },
    sidebarBadge: {
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    sidebarBadgeText: {
        color: '#fff',
        fontSize: 10,
        fontWeight: '700',
        lineHeight: 12,
    },
    composeBtn: __assign({ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens_1.space.sm, backgroundColor: tokens_1.color.signal, borderRadius: 12, paddingVertical: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg }, tokens_1.shadow.card),
    composeBtnText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
    /* ── Mobile tab bar ── */
    bar: {
        backgroundColor: 'rgba(255, 255, 255, 0.30)',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 255, 255, 0.18)',
        paddingTop: 6,
    },
    label: __assign(__assign({}, tokens_1.type.stamp), { fontFamily: 'Courier', marginTop: 2 }),
    postTabBtn: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        height: 58,
        gap: 2,
    },
    postTabLabel: {
        color: tokens_1.color.signal,
    },
    /* ── Tab badge ── */
    tabBadge: {
        position: 'absolute',
        top: -4,
        right: -6,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    tabBadgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 11,
    },
});
