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
exports.default = ActivityCenter;
/**
 * Activity Center — unified notification & activity feed.
 *
 * Tabs: All / Plans / Trips / Telegraph / Safety / Compass / Pulse / Passport / Hidden Gems / Trust / Admin
 *
 * Each ActivityCard shows:
 *   category icon, title, short body, relative time,
 *   unread dot, priority badge, deep-link action button.
 *
 * Supports: mark-all-read, pull-to-refresh, infinite scroll pagination.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../src/theme/tokens");
var useNotifications_1 = require("../src/hooks/useNotifications");
var TABS = [
    { key: 'all', label: 'All' },
    { key: 'plans', label: 'Plans', category: 'plans' },
    { key: 'trips', label: 'Trips', category: 'trips' },
    { key: 'telegraph', label: 'Telegraph', category: 'telegraph' },
    { key: 'safe_return', label: 'Safety', category: 'safe_return' },
    { key: 'compass', label: 'Compass', category: 'compass' },
    { key: 'pulse', label: 'Pulse', category: 'pulse' },
    { key: 'passport', label: 'Passport', category: 'passport' },
    { key: 'hidden_gems', label: 'Hidden Gems', category: 'hidden_gems' },
    { key: 'trust', label: 'Trust', category: 'trust' },
    { key: 'admin', label: 'Admin', category: 'admin' },
];
// ── Visual helpers ────────────────────────────────────────────────────────────
var CATEGORY_ICONS = {
    plans: '📋',
    trips: '✈️',
    telegraph: '💬',
    safe_return: '🛡️',
    location: '📍',
    trip_crew: '👥',
    compass: '🧭',
    pulse: '🌍',
    passport: '📘',
    hidden_gems: '💎',
    trust: '⭐',
    airport: '🏔️',
    admin: '⚠️',
};
var PRIORITY_BADGE = {
    urgent: { bg: '#FEE2E2', text: '#DC2626', label: 'Urgent' },
    important: { bg: '#FEF3C7', text: '#92400E', label: 'Important' },
    normal: null,
    low: null,
};
function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return "".concat(mins, "m ago");
    var hours = Math.floor(diff / 3600000);
    if (hours < 24)
        return "".concat(hours, "h ago");
    var days = Math.floor(diff / 86400000);
    if (days < 30)
        return "".concat(days, "d ago");
    return new Date(iso).toLocaleDateString();
}
// ── ActivityCard ──────────────────────────────────────────────────────────────
function ActivityCard(_a) {
    var _b;
    var notification = _a.notification, onMarkRead = _a.onMarkRead, onDismiss = _a.onDismiss;
    var isUnread = !notification.readAt;
    var badge = PRIORITY_BADGE[notification.priority];
    var icon = (_b = CATEGORY_ICONS[notification.category]) !== null && _b !== void 0 ? _b : '🔔';
    var handlePress = (0, react_1.useCallback)(function () {
        if (isUnread)
            onMarkRead(notification.id);
        if (notification.actionUrl) {
            expo_router_1.router.push(notification.actionUrl);
        }
    }, [notification, isUnread, onMarkRead]);
    return (<react_native_1.Pressable style={[styles.card, isUnread && styles.cardUnread]} onPress={handlePress}>
      {/* Unread dot */}
      {isUnread && <react_native_1.View style={styles.unreadDot}/>}

      {/* Category icon */}
      <react_native_1.View style={[styles.iconWrap, notification.category === 'safe_return' && styles.iconWrapSafety]}>
        <react_native_1.Text style={styles.catIcon}>{icon}</react_native_1.Text>
      </react_native_1.View>

      {/* Content */}
      <react_native_1.View style={{ flex: 1, gap: 3 }}>
        <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.xs, flexWrap: 'wrap' }}>
          <react_native_1.Text style={[styles.cardTitle, isUnread && styles.cardTitleUnread]} numberOfLines={1}>
            {notification.title}
          </react_native_1.Text>
          {badge && (<react_native_1.View style={[styles.priorityBadge, { backgroundColor: badge.bg }]}>
              <react_native_1.Text style={[styles.priorityBadgeText, { color: badge.text }]}>{badge.label}</react_native_1.Text>
            </react_native_1.View>)}
        </react_native_1.View>

        <react_native_1.Text style={styles.cardBody} numberOfLines={3}>{notification.body}</react_native_1.Text>

        <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          <react_native_1.Text style={styles.cardTime}>{relativeTime(notification.createdAt)}</react_native_1.Text>

          {/* Action button */}
          {notification.actionUrl && (<react_native_1.Pressable style={styles.actionBtn} onPress={handlePress} hitSlop={4}>
              <react_native_1.Text style={styles.actionBtnText}>View ›</react_native_1.Text>
            </react_native_1.Pressable>)}
        </react_native_1.View>
      </react_native_1.View>

      {/* Dismiss */}
      <react_native_1.Pressable style={styles.dismissBtn} onPress={function () { return onDismiss(notification.id); }} hitSlop={8}>
        <lucide_react_native_1.X size={14} color={tokens_1.color.faint}/>
      </react_native_1.Pressable>
    </react_native_1.Pressable>);
}
// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState(_a) {
    var label = _a.label;
    return (<react_native_1.View style={styles.empty}>
      <react_native_1.Text style={styles.emptyIcon}>🔔</react_native_1.Text>
      <react_native_1.Text style={styles.emptyTitle}>All caught up</react_native_1.Text>
      <react_native_1.Text style={styles.emptyBody}>
        No {label.toLowerCase()} notifications yet.
      </react_native_1.Text>
    </react_native_1.View>);
}
// ── Main screen ───────────────────────────────────────────────────────────────
function ActivityCenter() {
    var _a;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _b = (0, react_1.useState)('all'), activeTab = _b[0], setActiveTab = _b[1];
    var tabScrollRef = (0, react_1.useRef)(null);
    var activeTabDef = (_a = TABS.find(function (t) { return t.key === activeTab; })) !== null && _a !== void 0 ? _a : TABS[0];
    var _c = (0, useNotifications_1.useNotifications)(activeTabDef.category ? { category: activeTabDef.category } : {}), notifications = _c.notifications, loading = _c.loading, loadingMore = _c.loadingMore, unreadCount = _c.unreadCount, reload = _c.reload, loadMore = _c.loadMore, markRead = _c.markRead, markAllRead = _c.markAllRead, dismiss = _c.dismiss;
    // Mark all read on focus when Activity Center is opened
    (0, expo_router_1.useFocusEffect)((0, react_1.useCallback)(function () {
        // Slight delay so the user sees the unread state briefly
        var timer = setTimeout(function () {
            if (unreadCount > 0)
                markAllRead(activeTabDef.category);
        }, 800);
        return function () { return clearTimeout(timer); };
    }, [activeTab]));
    var handleTabPress = (0, react_1.useCallback)(function (tabKey) {
        setActiveTab(tabKey);
    }, []);
    return (<react_native_1.View style={{ flex: 1, backgroundColor: tokens_1.color.paper }}>
      {/* Header */}
      <react_native_1.View style={[styles.header, { paddingTop: insets.top + tokens_1.space.md }]}>
        <react_native_1.Text style={styles.headerTitle}>Activity Center</react_native_1.Text>
        <react_native_1.View style={{ flex: 1 }}/>
        {unreadCount > 0 && (<react_native_1.Pressable style={styles.markAllBtn} onPress={function () { return markAllRead(activeTabDef.category); }} hitSlop={8}>
            <lucide_react_native_1.CheckCheck size={16} color={tokens_1.color.deep}/>
            <react_native_1.Text style={styles.markAllBtnText}>Mark all read</react_native_1.Text>
          </react_native_1.Pressable>)}
        <react_native_1.Pressable onPress={function () { return expo_router_1.router.back(); }} hitSlop={8} style={{ marginLeft: tokens_1.space.md }}>
          <lucide_react_native_1.X size={24} color={tokens_1.color.ink}/>
        </react_native_1.Pressable>
      </react_native_1.View>

      {/* Tab bar (horizontally scrollable) */}
      <react_native_1.ScrollView ref={tabScrollRef} horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabBarContent}>
        {TABS.map(function (tab) {
            var isActive = activeTab === tab.key;
            return (<react_native_1.Pressable key={tab.key} style={[styles.tab, isActive && styles.tabActive]} onPress={function () { return handleTabPress(tab.key); }}>
              <react_native_1.Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {tab.label}
              </react_native_1.Text>
            </react_native_1.Pressable>);
        })}
      </react_native_1.ScrollView>

      {/* Content */}
      {loading && notifications.length === 0 ? (<react_native_1.View style={styles.center}>
          <react_native_1.ActivityIndicator size="large" color={tokens_1.color.signal}/>
        </react_native_1.View>) : (<react_native_1.FlatList data={notifications} keyExtractor={function (n) { return n.id; }} renderItem={function (_a) {
                var item = _a.item;
                return (<ActivityCard notification={item} onMarkRead={markRead} onDismiss={dismiss}/>);
            }} ItemSeparatorComponent={function () { return <react_native_1.View style={styles.sep}/>; }} contentContainerStyle={[
                styles.listContent,
                notifications.length === 0 && { flex: 1 },
            ]} refreshControl={<react_native_1.RefreshControl refreshing={loading} onRefresh={reload} tintColor={tokens_1.color.signal}/>} onEndReached={loadMore} onEndReachedThreshold={0.3} ListFooterComponent={loadingMore ? (<react_native_1.View style={styles.footer}>
              <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/>
            </react_native_1.View>) : null} ListEmptyComponent={<EmptyState label={activeTabDef.label}/>}/>)}
    </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: tokens_1.space.md,
        backgroundColor: tokens_1.color.paperRaised,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    headerTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    markAllBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.xs,
        borderRadius: tokens_1.radius.pill,
        backgroundColor: '#EEF6FF',
    },
    markAllBtnText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.deep, fontWeight: '600' }),
    tabBar: {
        backgroundColor: tokens_1.color.paperRaised,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
        flexGrow: 0,
    },
    tabBarContent: {
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.sm,
        gap: tokens_1.space.xs,
    },
    tab: {
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.sm,
        borderRadius: tokens_1.radius.pill,
        backgroundColor: 'transparent',
    },
    tabActive: {
        backgroundColor: tokens_1.color.ink,
    },
    tabText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontWeight: '600' }),
    tabTextActive: {
        color: tokens_1.color.onInk,
    },
    listContent: {
        paddingVertical: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
    },
    card: __assign(__assign({ flexDirection: 'row', alignItems: 'flex-start', gap: tokens_1.space.md, paddingVertical: tokens_1.space.md, paddingHorizontal: tokens_1.space.md, backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md }, tokens_1.shadow.card), { position: 'relative' }),
    cardUnread: {
        backgroundColor: '#F0F9FF',
        borderLeftWidth: 3,
        borderLeftColor: tokens_1.color.deep,
    },
    unreadDot: {
        position: 'absolute',
        top: tokens_1.space.md,
        left: -10,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: tokens_1.color.signal,
    },
    iconWrap: {
        width: 40,
        height: 40,
        borderRadius: tokens_1.radius.sm,
        backgroundColor: tokens_1.color.haze,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconWrapSafety: {
        backgroundColor: '#FEE2E2',
    },
    catIcon: {
        fontSize: 20,
        lineHeight: 24,
    },
    cardTitle: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600', color: tokens_1.color.mute, flex: 1 }),
    cardTitleUnread: {
        color: tokens_1.color.ink,
        fontWeight: '700',
    },
    priorityBadge: {
        paddingHorizontal: tokens_1.space.xs,
        paddingVertical: 2,
        borderRadius: tokens_1.radius.pill,
    },
    priorityBadgeText: {
        fontSize: 10,
        fontWeight: '700',
        lineHeight: 14,
    },
    cardBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 18 }),
    cardTime: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint }),
    actionBtn: {
        paddingHorizontal: tokens_1.space.sm,
        paddingVertical: 3,
        borderRadius: tokens_1.radius.pill,
        backgroundColor: tokens_1.color.haze,
    },
    actionBtnText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.deep, fontWeight: '700' }),
    dismissBtn: {
        padding: tokens_1.space.xs,
        marginTop: -2,
    },
    sep: {
        height: tokens_1.space.sm,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    footer: {
        padding: tokens_1.space.xl,
        alignItems: 'center',
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens_1.space.xxl,
        gap: tokens_1.space.md,
    },
    emptyIcon: {
        fontSize: 48,
    },
    emptyTitle: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptyBody: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute, textAlign: 'center' }),
});
