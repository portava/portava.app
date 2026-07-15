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
exports.TravelPageShell = TravelPageShell;
exports.TravelSectionHeader = TravelSectionHeader;
exports.TravelCard = TravelCard;
exports.TravelChip = TravelChip;
exports.TravelButton = TravelButton;
exports.TravelIconButton = TravelIconButton;
exports.TravelFilterButton = TravelFilterButton;
exports.TravelEmptyState = TravelEmptyState;
exports.TravelLoadingState = TravelLoadingState;
exports.TravelErrorState = TravelErrorState;
exports.HorizontalScrollStrip = HorizontalScrollStrip;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
/**
 * Travel Buddy shared primitives. New/incomplete sections use these so every
 * surface shares the same cards, headers, chips, buttons, and states. Existing
 * stable screens migrate gradually — these don't force a refactor.
 *
 * All primitives are token-driven (radius/space/shadow/color) so the whole app
 * normalizes by editing tokens, not each screen.
 */
/* ── Page shell: safe-area top + optional desktop max-width centering ── */
function TravelPageShell(_a) {
    var children = _a.children, _b = _a.scroll, scroll = _b === void 0 ? true : _b, _c = _a.padded, padded = _c === void 0 ? false : _c, style = _a.style;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var inner = (<react_native_1.View style={[{ width: '100%', maxWidth: tokens_1.layout.maxWidth, alignSelf: 'center' }, padded && { paddingHorizontal: tokens_1.space.lg }, style]}>
      {children}
    </react_native_1.View>);
    if (!scroll) {
        return <react_native_1.View style={[shell.base, { paddingTop: insets.top }]}>{inner}</react_native_1.View>;
    }
    return (<react_native_1.ScrollView style={shell.base} contentContainerStyle={{ paddingTop: insets.top, paddingBottom: tokens_1.space.xxxl }} showsVerticalScrollIndicator={false}>
      {inner}
    </react_native_1.ScrollView>);
}
/* ── Section header: title + optional "View all" action ── */
function TravelSectionHeader(_a) {
    var title = _a.title, _b = _a.actionLabel, actionLabel = _b === void 0 ? 'View all' : _b, onAction = _a.onAction, kicker = _a.kicker;
    return (<react_native_1.View style={sh.row}>
      <react_native_1.View style={{ flex: 1 }}>
        {kicker ? <react_native_1.Text style={sh.kicker}>{kicker}</react_native_1.Text> : null}
        <react_native_1.Text style={sh.title}>{title}</react_native_1.Text>
      </react_native_1.View>
      {onAction && (<react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [sh.action, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={onAction} hitSlop={tokens_1.layout.hitSlop}>
          <react_native_1.Text style={sh.actionText}>{actionLabel}</react_native_1.Text>
          <lucide_react_native_1.ChevronRight size={tokens_1.icon.sm} color={tokens_1.color.signal}/>
        </react_native_1.Pressable>)}
    </react_native_1.View>);
}
/* ── Card: standard rounded surface with border + soft shadow ── */
function TravelCard(_a) {
    var children = _a.children, style = _a.style, onPress = _a.onPress, _b = _a.padded, padded = _b === void 0 ? true : _b;
    var body = <react_native_1.View style={[card.base, padded && { padding: tokens_1.space.lg }, style]}>{children}</react_native_1.View>;
    if (onPress) {
        return <react_native_1.Pressable onPress={onPress} style={function (_a) {
            var pressed = _a.pressed;
            return pressed && { opacity: tokens_1.layout.pressedOpacity };
        }}>{body}</react_native_1.Pressable>;
    }
    return body;
}
/* ── Chip / pill: filter + tag, with active state ── */
function TravelChip(_a) {
    var label = _a.label, active = _a.active, onPress = _a.onPress, leading = _a.icon;
    return (<react_native_1.Pressable onPress={onPress} style={function (_a) {
        var pressed = _a.pressed;
        return [chip.base, active && chip.active, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} accessibilityRole="button">
      {leading}
      <react_native_1.Text style={[chip.text, active && chip.textActive]}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
/* ── Buttons: primary (vermilion), secondary (outline), ghost ── */
function TravelButton(_a) {
    var label = _a.label, onPress = _a.onPress, _b = _a.variant, variant = _b === void 0 ? 'primary' : _b, leading = _a.icon, full = _a.full;
    var v = btn[variant];
    return (<react_native_1.Pressable onPress={onPress} style={function (_a) {
        var pressed = _a.pressed;
        return [btn.base, v.box, full && { flex: 1 }, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} accessibilityRole="button">
      {leading}
      <react_native_1.Text style={[btn.text, v.text]}>{label}</react_native_1.Text>
    </react_native_1.Pressable>);
}
/* ── Icon button: circular ── */
function TravelIconButton(_a) {
    var glyph = _a.icon, onPress = _a.onPress, accessibilityLabel = _a.accessibilityLabel;
    return (<react_native_1.Pressable onPress={onPress} style={function (_a) {
        var pressed = _a.pressed;
        return [ib.box, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} hitSlop={tokens_1.layout.hitSlop} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      {glyph}
    </react_native_1.Pressable>);
}
/* ── Filter button with active count badge ── */
function TravelFilterButton(_a) {
    var _b = _a.count, count = _b === void 0 ? 0 : _b, onPress = _a.onPress, _c = _a.label, label = _c === void 0 ? 'Filter' : _c;
    return (<react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [fb.box, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={onPress} hitSlop={tokens_1.layout.hitSlop}>
      <lucide_react_native_1.SlidersHorizontal size={tokens_1.icon.md} color={tokens_1.color.ink}/>
      <react_native_1.Text style={fb.text}>{label}</react_native_1.Text>
      {count > 0 && <react_native_1.View style={fb.badge}><react_native_1.Text style={fb.badgeText}>{count}</react_native_1.Text></react_native_1.View>}
    </react_native_1.Pressable>);
}
/* ── States: empty / loading / error ── */
function TravelEmptyState(_a) {
    var title = _a.title, sub = _a.sub, action = _a.action, onAction = _a.onAction;
    return (<react_native_1.View style={st.empty}>
      <react_native_1.Text style={st.emptyTitle}>{title}</react_native_1.Text>
      {sub ? <react_native_1.Text style={st.emptySub}>{sub}</react_native_1.Text> : null}
      {action && onAction ? (<react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [st.emptyBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={onAction}>
          <react_native_1.Text style={st.emptyBtnText}>{action}</react_native_1.Text>
        </react_native_1.Pressable>) : null}
    </react_native_1.View>);
}
function TravelLoadingState(_a) {
    var label = _a.label;
    return (<react_native_1.View style={st.center}>
      <react_native_1.ActivityIndicator color={tokens_1.color.signal}/>
      {label ? <react_native_1.Text style={st.loadingText}>{label}</react_native_1.Text> : null}
    </react_native_1.View>);
}
function TravelErrorState(_a) {
    var _b = _a.title, title = _b === void 0 ? 'Something went wrong' : _b, sub = _a.sub, onRetry = _a.onRetry;
    return (<react_native_1.View style={st.empty}>
      <lucide_react_native_1.AlertCircle size={28} color={tokens_1.color.mute}/>
      <react_native_1.Text style={st.emptyTitle}>{title}</react_native_1.Text>
      {sub ? <react_native_1.Text style={st.emptySub}>{sub}</react_native_1.Text> : null}
      {onRetry ? (<react_native_1.Pressable style={function (_a) {
            var pressed = _a.pressed;
            return [st.emptyBtn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={onRetry}>
          <lucide_react_native_1.RefreshCw size={14} color={tokens_1.color.onInk}/>
          <react_native_1.Text style={st.emptyBtnText}>Try again</react_native_1.Text>
        </react_native_1.Pressable>) : null}
    </react_native_1.View>);
}
/* ── Horizontal scroll strip ── */
function HorizontalScrollStrip(_a) {
    var children = _a.children, _b = _a.gap, gap = _b === void 0 ? tokens_1.space.md : _b;
    return (<react_native_1.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[strip.row, { gap: gap }]}>
      {children}
    </react_native_1.ScrollView>);
}
var shell = react_native_1.StyleSheet.create({
    base: { flex: 1, backgroundColor: tokens_1.color.paper },
});
var sh = react_native_1.StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, marginTop: tokens_1.space.xl, marginBottom: tokens_1.space.md },
    kicker: { fontFamily: 'Courier', fontSize: 11, color: tokens_1.color.deep, letterSpacing: 1.5, fontWeight: '700', marginBottom: 2 },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 20 }),
    action: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    actionText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
});
var card = react_native_1.StyleSheet.create({
    base: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.md, borderWidth: 1, borderColor: tokens_1.color.haze }, tokens_1.shadow.card),
});
var chip = react_native_1.StyleSheet.create({
    base: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    active: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    text: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    textActive: { color: tokens_1.color.onInk },
});
var btnBase = { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderRadius: tokens_1.radius.md };
var btn = {
    base: btnBase,
    text: __assign({}, tokens_1.type.bodyStrong),
    primary: { box: { backgroundColor: tokens_1.color.signal }, text: { color: tokens_1.color.onInk } },
    secondary: { box: { borderWidth: 1.5, borderColor: tokens_1.color.signal, backgroundColor: tokens_1.color.paperRaised }, text: { color: tokens_1.color.signal } },
    ghost: { box: { borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised }, text: { color: tokens_1.color.ink } },
};
var ib = react_native_1.StyleSheet.create({
    box: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised },
});
var fb = react_native_1.StyleSheet.create({
    box: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: tokens_1.space.md, height: 42, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    text: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    badgeText: __assign(__assign({}, tokens_1.type.stamp), { color: tokens_1.color.onInk, fontFamily: 'Courier' }),
});
var st = react_native_1.StyleSheet.create({
    empty: { marginHorizontal: tokens_1.space.lg, padding: tokens_1.space.xl, borderRadius: tokens_1.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: tokens_1.color.haze, alignItems: 'center', gap: tokens_1.space.sm },
    emptyTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, textAlign: 'center' }),
    emptySub: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, textAlign: 'center' }),
    emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: tokens_1.color.signal, borderRadius: tokens_1.radius.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm, marginTop: tokens_1.space.xs },
    emptyBtnText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '800', color: tokens_1.color.onInk }),
    center: { padding: tokens_1.space.xxl, alignItems: 'center', gap: tokens_1.space.md },
    loadingText: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute }),
});
var strip = react_native_1.StyleSheet.create({
    row: { paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.sm },
});
