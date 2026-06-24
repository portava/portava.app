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
exports.showNotificationToast = showNotificationToast;
exports.NotificationToastProvider = NotificationToastProvider;
/**
 * NotificationToast
 *
 * In-app toast banner that fires when a new notification arrives via the
 * polling refresh. Priority determines display duration and style.
 *
 * Safety-priority toasts use a distinct but non-alarming style.
 * Banner text always uses the privacy-guarded title/body from the notification
 * record — never raw metadata.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
var DISPLAY_DURATIONS = {
    urgent: 8000,
    important: 6000,
    normal: 4000,
    low: 3000,
};
var PRIORITY_STYLES = {
    urgent: { bg: '#FEF2F2', border: '#FCA5A5', titleColor: '#DC2626' },
    important: { bg: '#FFFBEB', border: '#FCD34D', titleColor: '#92400E' },
    normal: { bg: tokens_1.color.paperRaised, border: tokens_1.color.haze, titleColor: tokens_1.color.ink },
    low: { bg: tokens_1.color.paper, border: tokens_1.color.haze, titleColor: tokens_1.color.mute },
};
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
function SingleToast(_a) {
    var _b, _c;
    var notification = _a.notification, onDismiss = _a.onDismiss;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var translateY = (0, react_1.useRef)(new react_native_1.Animated.Value(-120)).current;
    var opacity = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var timerRef = (0, react_1.useRef)(null);
    var dismiss = (0, react_1.useCallback)(function () {
        react_native_1.Animated.parallel([
            react_native_1.Animated.timing(translateY, { toValue: -120, duration: 250, useNativeDriver: true }),
            react_native_1.Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
        ]).start(onDismiss);
    }, [translateY, opacity, onDismiss]);
    (0, react_1.useEffect)(function () {
        var _a;
        react_native_1.Animated.parallel([
            react_native_1.Animated.spring(translateY, { toValue: 0, tension: 120, friction: 10, useNativeDriver: true }),
            react_native_1.Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        ]).start();
        var duration = (_a = DISPLAY_DURATIONS[notification.priority]) !== null && _a !== void 0 ? _a : 4000;
        timerRef.current = setTimeout(dismiss, duration);
        return function () { if (timerRef.current)
            clearTimeout(timerRef.current); };
    }, []);
    var style = (_b = PRIORITY_STYLES[notification.priority]) !== null && _b !== void 0 ? _b : PRIORITY_STYLES.normal;
    var icon = (_c = CATEGORY_ICONS[notification.category]) !== null && _c !== void 0 ? _c : '🔔';
    var handlePress = (0, react_1.useCallback)(function () {
        dismiss();
        if (notification.actionUrl) {
            expo_router_1.router.push(notification.actionUrl);
        }
    }, [notification, dismiss]);
    return (<react_native_1.Animated.View style={[
            styles.toast,
            {
                top: insets.top + tokens_1.space.md,
                backgroundColor: style.bg,
                borderColor: style.border,
                transform: [{ translateY: translateY }],
                opacity: opacity,
            },
        ]}>
      <react_native_1.Pressable style={styles.toastInner} onPress={handlePress}>
        <react_native_1.Text style={styles.toastIcon}>{icon}</react_native_1.Text>
        <react_native_1.View style={{ flex: 1, gap: 2 }}>
          <react_native_1.Text style={[styles.toastTitle, { color: style.titleColor }]} numberOfLines={1}>
            {notification.title}
          </react_native_1.Text>
          <react_native_1.Text style={styles.toastBody} numberOfLines={2}>{notification.body}</react_native_1.Text>
        </react_native_1.View>
        <react_native_1.Pressable style={styles.closeBtn} onPress={dismiss} hitSlop={8}>
          <lucide_react_native_1.X size={14} color={tokens_1.color.mute}/>
        </react_native_1.Pressable>
      </react_native_1.Pressable>
    </react_native_1.Animated.View>);
}
// ── ToastQueue: manages up to 2 concurrent toasts ─────────────────────────────
var toastQueue = [];
var globalShowToast = null;
function showNotificationToast(notification) {
    if (globalShowToast) {
        globalShowToast(notification);
    }
    else {
        toastQueue.push(function () { return globalShowToast === null || globalShowToast === void 0 ? void 0 : globalShowToast(notification); });
    }
}
function NotificationToastProvider(_a) {
    var children = _a.children;
    var _b = (0, react_1.useState)([]), toasts = _b[0], setToasts = _b[1];
    var show = (0, react_1.useCallback)(function (notification) {
        var id = "".concat(notification.id, "_").concat(Date.now());
        setToasts(function (prev) { return __spreadArray(__spreadArray([], prev.slice(-1), true), [{ id: id, notification: notification }], false); });
    }, []);
    (0, react_1.useEffect)(function () {
        globalShowToast = show;
        // Drain any queued toasts
        var drained = toastQueue.splice(0);
        drained.forEach(function (fn) { return fn(); });
        return function () { if (globalShowToast === show)
            globalShowToast = null; };
    }, [show]);
    var dismiss = (0, react_1.useCallback)(function (id) {
        setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id; }); });
    }, []);
    return (<>
      {children}
      {toasts.map(function (item) { return (<SingleToast key={item.id} notification={item.notification} onDismiss={function () { return dismiss(item.id); }}/>); })}
    </>);
}
var styles = react_native_1.StyleSheet.create({
    toast: __assign(__assign({ position: 'absolute', left: tokens_1.space.lg, right: tokens_1.space.lg, borderRadius: tokens_1.radius.md, borderWidth: 1, zIndex: 9999 }, tokens_1.shadow.float), { elevation: 20 }),
    toastInner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: tokens_1.space.md,
        padding: tokens_1.space.md,
    },
    toastIcon: {
        fontSize: 20,
        lineHeight: 24,
    },
    toastTitle: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700' }),
    toastBody: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, lineHeight: 17 }),
    closeBtn: {
        padding: tokens_1.space.xs,
        marginTop: -2,
    },
});
