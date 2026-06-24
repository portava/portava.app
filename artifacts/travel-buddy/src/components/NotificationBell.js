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
exports.NotificationBell = NotificationBell;
/**
 * NotificationBell
 *
 * Bell icon with unread badge. Tapping opens a compact popover showing the
 * last 5 notifications plus a "See all" link to the Activity Center.
 * Badge clears when the Activity Center is opened.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var useNotifications_1 = require("../hooks/useNotifications");
var notifications_1 = require("../services/notifications");
function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return "".concat(mins, "m");
    var hours = Math.floor(diff / 3600000);
    if (hours < 24)
        return "".concat(hours, "h");
    return "".concat(Math.floor(diff / 86400000), "d");
}
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
var PRIORITY_COLORS = {
    urgent: '#DC2626',
    important: '#D97706',
    normal: tokens_1.color.deep,
    low: tokens_1.color.mute,
};
function PopoverItem(_a) {
    var _b, _c;
    var notification = _a.notification, onPress = _a.onPress;
    var icon = (_b = CATEGORY_ICONS[notification.category]) !== null && _b !== void 0 ? _b : '🔔';
    var isUnread = !notification.readAt;
    var priorityColor = (_c = PRIORITY_COLORS[notification.priority]) !== null && _c !== void 0 ? _c : tokens_1.color.mute;
    return (<react_native_1.Pressable style={[styles.popoverItem, isUnread && styles.popoverItemUnread]} onPress={onPress}>
      <react_native_1.Text style={styles.categoryIcon}>{icon}</react_native_1.Text>
      <react_native_1.View style={{ flex: 1, gap: 2 }}>
        <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.xs }}>
          {isUnread && <react_native_1.View style={[styles.unreadDot, { backgroundColor: priorityColor }]}/>}
          <react_native_1.Text style={[styles.popoverTitle, { color: isUnread ? tokens_1.color.ink : tokens_1.color.mute }]} numberOfLines={1}>
            {notification.title}
          </react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Text style={styles.popoverBody} numberOfLines={2}>{notification.body}</react_native_1.Text>
      </react_native_1.View>
      <react_native_1.Text style={styles.popoverTime}>{relativeTime(notification.createdAt)}</react_native_1.Text>
    </react_native_1.Pressable>);
}
function NotificationBell() {
    var _a = (0, react_1.useState)(false), open = _a[0], setOpen = _a[1];
    var bellRef = (0, react_1.useRef)(null);
    var _b = (0, react_1.useState)(null), bellLayout = _b[0], setBellLayout = _b[1];
    var _c = (0, useNotifications_1.useUnreadNotificationCount)(), count = _c.count, refreshCount = _c.refresh;
    var _d = (0, useNotifications_1.useRecentNotifications)(), notifications = _d.notifications, loading = _d.loading, reload = _d.reload;
    var handleOpen = (0, react_1.useCallback)(function () {
        var _a;
        (_a = bellRef.current) === null || _a === void 0 ? void 0 : _a.measure(function (_fx, _fy, w, h, px, py) {
            setBellLayout({ x: px, y: py, width: w, height: h });
        });
        reload();
        setOpen(true);
    }, [reload]);
    var handleClose = (0, react_1.useCallback)(function () { return setOpen(false); }, []);
    var handleSeeAll = (0, react_1.useCallback)(function () {
        handleClose();
        expo_router_1.router.push('/notifications');
        if (count > 0) {
            (0, notifications_1.markAllNotificationsRead)().then(refreshCount);
        }
    }, [handleClose, count, refreshCount]);
    var handleItemPress = (0, react_1.useCallback)(function (notification) {
        handleClose();
        if (notification.actionUrl) {
            expo_router_1.router.push(notification.actionUrl);
        }
        else {
            expo_router_1.router.push('/notifications');
        }
    }, [handleClose]);
    return (<>
      <react_native_1.Pressable ref={bellRef} style={styles.bellBtn} onPress={handleOpen} hitSlop={8} accessibilityRole="button" accessibilityLabel={count > 0 ? "".concat(count, " unread notifications") : 'Notifications'}>
        <lucide_react_native_1.Bell size={22} color={tokens_1.color.ink}/>
        {count > 0 && (<react_native_1.View style={styles.badge}>
            <react_native_1.Text style={styles.badgeText}>{count > 99 ? '99+' : String(count)}</react_native_1.Text>
          </react_native_1.View>)}
      </react_native_1.Pressable>

      <react_native_1.Modal visible={open} transparent animationType="fade" onRequestClose={handleClose} statusBarTranslucent={react_native_1.Platform.OS === 'android'}>
        <react_native_1.TouchableWithoutFeedback onPress={handleClose}>
          <react_native_1.View style={styles.overlay}>
            <react_native_1.TouchableWithoutFeedback>
              <react_native_1.View style={[styles.popover, bellLayout ? {
                position: 'absolute',
                top: (bellLayout.y + bellLayout.height + 8),
                right: 16,
            } : {}]}>
                {/* Header */}
                <react_native_1.View style={styles.popoverHeader}>
                  <react_native_1.Text style={styles.popoverHeading}>Notifications</react_native_1.Text>
                  <react_native_1.Pressable onPress={handleSeeAll} hitSlop={8}>
                    <react_native_1.Text style={styles.seeAllLink}>See all</react_native_1.Text>
                  </react_native_1.Pressable>
                </react_native_1.View>

                {/* Items */}
                {loading ? (<react_native_1.View style={styles.popoverEmpty}>
                    <react_native_1.ActivityIndicator size="small" color={tokens_1.color.mute}/>
                  </react_native_1.View>) : notifications.length === 0 ? (<react_native_1.View style={styles.popoverEmpty}>
                    <react_native_1.Text style={styles.popoverEmptyText}>No notifications yet</react_native_1.Text>
                  </react_native_1.View>) : (<react_native_1.FlatList data={notifications} keyExtractor={function (n) { return n.id; }} renderItem={function (_a) {
                var item = _a.item;
                return (<PopoverItem notification={item} onPress={function () { return handleItemPress(item); }}/>);
            }} scrollEnabled={false} ItemSeparatorComponent={function () { return <react_native_1.View style={styles.divider}/>; }}/>)}
              </react_native_1.View>
            </react_native_1.TouchableWithoutFeedback>
          </react_native_1.View>
        </react_native_1.TouchableWithoutFeedback>
      </react_native_1.Modal>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    bellBtn: {
        position: 'relative',
        padding: tokens_1.space.xs,
    },
    badge: {
        position: 'absolute',
        top: 0,
        right: 0,
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: tokens_1.color.signal,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: {
        color: '#fff',
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 11,
    },
    overlay: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    popover: __assign(__assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, width: 320, maxHeight: 420 }, tokens_1.shadow.float), { borderWidth: 1, borderColor: tokens_1.color.haze }),
    popoverHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens_1.color.haze,
    },
    popoverHeading: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    seeAllLink: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '600' }),
    popoverItem: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.md,
        paddingHorizontal: tokens_1.space.lg,
        paddingVertical: tokens_1.space.md,
    },
    popoverItemUnread: {
        backgroundColor: '#F0F9FF',
    },
    categoryIcon: {
        fontSize: 18,
        lineHeight: 22,
        marginTop: 1,
    },
    unreadDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    popoverTitle: __assign(__assign({}, tokens_1.type.small), { fontWeight: '600', flex: 1 }),
    popoverBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 17 }),
    popoverTime: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.faint, marginTop: 2 }),
    divider: {
        height: 1,
        backgroundColor: tokens_1.color.haze,
        marginLeft: tokens_1.space.lg + 18 + tokens_1.space.md,
    },
    popoverEmpty: {
        padding: tokens_1.space.xl,
        alignItems: 'center',
    },
    popoverEmptyText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
