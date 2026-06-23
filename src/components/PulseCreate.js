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
exports.PulseFilterSheet = PulseFilterSheet;
exports.PulseCreateMenu = PulseCreateMenu;
exports.PulseFAB = PulseFAB;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var lucide_react_native_1 = require("lucide-react-native");
var models_1 = require("../types/models");
var tokens_1 = require("../theme/tokens");
/* ── Filter bottom sheet ── */
function PulseFilterSheet(_a) {
    var visible = _a.visible, active = _a.active, onToggle = _a.onToggle, onClear = _a.onClear, onClose = _a.onClose;
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={fs.backdrop} onPress={onClose}/>
      <react_native_1.View style={fs.sheet}>
        <react_native_1.View style={fs.grab}/>
        <react_native_1.View style={fs.head}>
          <react_native_1.Text style={fs.title}>Filter Pulse</react_native_1.Text>
          <react_native_1.View style={{ flex: 1 }}/>
          {active.length > 0 && (<react_native_1.Pressable onPress={onClear} hitSlop={tokens_1.layout.hitSlop}><react_native_1.Text style={fs.clear}>Clear ({active.length})</react_native_1.Text></react_native_1.Pressable>)}
          <react_native_1.Pressable onPress={onClose} hitSlop={tokens_1.layout.hitSlop} style={fs.x}><lucide_react_native_1.X size={18} color={tokens_1.color.ink}/></react_native_1.Pressable>
        </react_native_1.View>
        <react_native_1.ScrollView contentContainerStyle={fs.chips}>
          {models_1.PULSE_FILTERS.map(function (f) {
            var on = active.includes(f);
            return (<react_native_1.Pressable key={f} style={[fs.chip, on && fs.chipOn]} onPress={function () { return onToggle(f); }}>
                {on ? <lucide_react_native_1.Check size={14} color={tokens_1.color.onInk}/> : null}
                <react_native_1.Text style={[fs.chipText, on && fs.chipTextOn]}>{f}</react_native_1.Text>
              </react_native_1.Pressable>);
        })}
        </react_native_1.ScrollView>
        <react_native_1.Pressable style={fs.apply} onPress={onClose}>
          <react_native_1.Text style={fs.applyText}>Show results</react_native_1.Text>
        </react_native_1.Pressable>
      </react_native_1.View>
    </react_native_1.Modal>);
}
/* ── Floating create button + menu ── */
function PulseCreateMenu(_a) {
    var visible = _a.visible, onClose = _a.onClose;
    var items = [
        { label: 'Post Update', icon: <lucide_react_native_1.PenLine size={18} color={tokens_1.color.signal}/>, go: '/create' },
        { label: 'Ask Question', icon: <lucide_react_native_1.HelpCircle size={18} color={tokens_1.color.deep}/>, go: '/create' },
        { label: 'Create Plan', icon: <lucide_react_native_1.CalendarPlus size={18} color={tokens_1.color.success}/>, go: '/trip/new' },
        { label: 'Share Hidden Gem', icon: <lucide_react_native_1.Gem size={18} color={tokens_1.color.success}/>, go: '/create' },
        { label: 'Share a Moment', icon: <lucide_react_native_1.Image size={18} color={tokens_1.color.warn}/>, go: '/create' },
    ];
    return (<react_native_1.Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <react_native_1.Pressable style={cm.backdrop} onPress={onClose}>
        <react_native_1.View style={cm.menu}>
          {items.map(function (it) { return (<react_native_1.Pressable key={it.label} style={function (_a) {
            var pressed = _a.pressed;
            return [cm.item, pressed && { opacity: tokens_1.layout.pressedOpacity }];
        }} onPress={function () { onClose(); expo_router_1.router.push(it.go); }}>
              <react_native_1.View style={cm.itemIcon}>{it.icon}</react_native_1.View>
              <react_native_1.Text style={cm.itemText}>{it.label}</react_native_1.Text>
            </react_native_1.Pressable>); })}
        </react_native_1.View>
      </react_native_1.Pressable>
    </react_native_1.Modal>);
}
function PulseFAB(_a) {
    var onPress = _a.onPress;
    return (<react_native_1.Pressable style={function (_a) {
        var pressed = _a.pressed;
        return [fab.btn, pressed && { opacity: tokens_1.layout.pressedOpacity }];
    }} onPress={onPress}>
      <lucide_react_native_1.Plus size={26} color={tokens_1.color.onInk}/>
    </react_native_1.Pressable>);
}
var fs = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
    sheet: __assign({ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens_1.color.paper, borderTopLeftRadius: tokens_1.radius.lg, borderTopRightRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, paddingBottom: tokens_1.space.xxl, gap: tokens_1.space.md }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze },
    head: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.sm },
    title: __assign(__assign({}, tokens_1.type.title), { color: tokens_1.color.ink, fontSize: 19 }),
    clear: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.signal, fontWeight: '700' }),
    x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens_1.space.sm },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: tokens_1.space.md, paddingVertical: tokens_1.space.sm, borderRadius: tokens_1.radius.pill, borderWidth: 1, borderColor: tokens_1.color.haze, backgroundColor: tokens_1.color.paperRaised },
    chipOn: { backgroundColor: tokens_1.color.signal, borderColor: tokens_1.color.signal },
    chipText: __assign(__assign({}, tokens_1.type.small), { fontWeight: '700', color: tokens_1.color.ink }),
    chipTextOn: { color: tokens_1.color.onInk },
    apply: { backgroundColor: tokens_1.color.ink, borderRadius: tokens_1.radius.md, paddingVertical: tokens_1.space.md, alignItems: 'center' },
    applyText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk }),
});
var cm = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)', justifyContent: 'flex-end', padding: tokens_1.space.lg, paddingBottom: 96 },
    menu: __assign({ backgroundColor: tokens_1.color.paper, borderRadius: tokens_1.radius.lg, overflow: 'hidden' }, tokens_1.shadow.float),
    item: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md, paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md, borderBottomWidth: 1, borderBottomColor: tokens_1.color.haze },
    itemIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze, alignItems: 'center', justifyContent: 'center' },
    itemText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
});
var fab = react_native_1.StyleSheet.create({
    btn: __assign({ position: 'absolute', right: tokens_1.space.lg, bottom: tokens_1.space.xl, width: 58, height: 58, borderRadius: 29, backgroundColor: tokens_1.color.signal, alignItems: 'center', justifyContent: 'center' }, tokens_1.shadow.float),
});
