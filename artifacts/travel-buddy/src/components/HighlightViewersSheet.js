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
exports.HighlightViewersSheet = HighlightViewersSheet;
/**
 * HighlightViewersSheet — bottom sheet listing who viewed a highlight.
 * Only rendered/fetched when the current user is the highlight owner.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var tokens_1 = require("../theme/tokens");
var highlights_1 = require("../services/highlights");
function HighlightViewersSheet(_a) {
    var visible = _a.visible, highlightId = _a.highlightId, onClose = _a.onClose;
    var insets = (0, react_native_safe_area_context_1.useSafeAreaInsets)();
    var _b = (0, react_1.useState)([]), viewers = _b[0], setViewers = _b[1];
    var _c = (0, react_1.useState)(false), loading = _c[0], setLoading = _c[1];
    (0, react_1.useEffect)(function () {
        if (!visible || !highlightId)
            return;
        setLoading(true);
        (0, highlights_1.fetchHighlightViewers)(highlightId).then(function (r) {
            setViewers(r.ok && r.data ? r.data : []);
            setLoading(false);
        });
    }, [visible, highlightId]);
    return (<react_native_1.Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <react_native_1.Pressable style={s.backdrop} onPress={onClose}/>
      <react_native_1.View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <react_native_1.View style={s.grab}/>
        <react_native_1.View style={s.head}>
          <react_native_1.Text style={s.title}>👁 {viewers.length} viewer{viewers.length !== 1 ? 's' : ''}</react_native_1.Text>
          <react_native_1.View style={{ flex: 1 }}/>
          <react_native_1.Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.ink}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        {loading ? (<react_native_1.View style={s.loading}>
            <react_native_1.ActivityIndicator size="small" color={tokens_1.color.signal}/>
          </react_native_1.View>) : viewers.length === 0 ? (<react_native_1.View style={s.empty}>
            <react_native_1.Text style={s.emptyText}>No views yet.</react_native_1.Text>
          </react_native_1.View>) : (<react_native_1.ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {viewers.map(function (v) {
                var _a, _b;
                return (<react_native_1.View key={v.userId} style={s.row}>
                <react_native_1.Image source={{ uri: (_a = v.avatarUrl) !== null && _a !== void 0 ? _a : undefined }} style={s.avatar}/>
                <react_native_1.View style={s.info}>
                  <react_native_1.Text style={s.name}>{(_b = v.name) !== null && _b !== void 0 ? _b : v.handle}</react_native_1.Text>
                  <react_native_1.Text style={s.time}>{fmtTime(v.viewedAt)}</react_native_1.Text>
                </react_native_1.View>
                {v.likedByMe && (<lucide_react_native_1.Heart size={14} color={tokens_1.color.signal} fill={tokens_1.color.signal}/>)}
              </react_native_1.View>);
            })}
          </react_native_1.ScrollView>)}
      </react_native_1.View>
    </react_native_1.Modal>);
}
function fmtTime(iso) {
    var d = new Date(iso);
    var now = Date.now();
    var diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60)
        return 'just now';
    if (diff < 3600)
        return "".concat(Math.floor(diff / 60), "m ago");
    if (diff < 86400)
        return "".concat(Math.floor(diff / 3600), "h ago");
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
var s = react_native_1.StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
    sheet: __assign({ backgroundColor: tokens_1.color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%' }, tokens_1.shadow.float),
    grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: tokens_1.color.haze, marginTop: 10, marginBottom: 4 },
    head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: tokens_1.space.lg, paddingVertical: tokens_1.space.md },
    title: __assign(__assign({}, tokens_1.type.heading), { color: tokens_1.color.ink }),
    closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens_1.color.paperRaised, borderWidth: 1, borderColor: tokens_1.color.haze },
    loading: { padding: tokens_1.space.xl, alignItems: 'center' },
    empty: { padding: tokens_1.space.xl, alignItems: 'center' },
    emptyText: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.mute }),
    list: { paddingHorizontal: tokens_1.space.lg, paddingBottom: tokens_1.space.md, gap: tokens_1.space.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: tokens_1.space.md },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: tokens_1.color.haze },
    info: { flex: 1 },
    name: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontSize: 14 }),
    time: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 11 }),
});
