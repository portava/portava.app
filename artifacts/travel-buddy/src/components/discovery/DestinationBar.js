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
exports.DestinationBar = DestinationBar;
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../../theme/tokens");
function DestinationBar(_a) {
    var destination = _a.destination, onChangeDestination = _a.onChangeDestination;
    var _b = (0, react_1.useState)(false), modalOpen = _b[0], setModalOpen = _b[1];
    var _c = (0, react_1.useState)(destination), draft = _c[0], setDraft = _c[1];
    var open = function () {
        setDraft(destination);
        setModalOpen(true);
    };
    var apply = function () {
        var trimmed = draft.trim();
        if (trimmed)
            onChangeDestination(trimmed);
        setModalOpen(false);
    };
    return (<>
      <react_native_1.Pressable style={styles.bar} onPress={open}>
        <lucide_react_native_1.MapPin size={14} color={tokens_1.color.signal}/>
        <react_native_1.Text style={styles.dest} numberOfLines={1}>
          {destination || 'Pick a destination'}
        </react_native_1.Text>
        <lucide_react_native_1.ChevronDown size={14} color={tokens_1.color.mute}/>
      </react_native_1.Pressable>

      <react_native_1.Modal visible={modalOpen} animationType="fade" transparent statusBarTranslucent onRequestClose={function () { return setModalOpen(false); }}>
        <react_native_1.Pressable style={styles.backdrop} onPress={function () { return setModalOpen(false); }}/>
        <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
          <react_native_1.View style={styles.dialog}>
            <react_native_1.View style={styles.dialogHeader}>
              <react_native_1.Text style={styles.dialogTitle}>Search destination</react_native_1.Text>
              <react_native_1.Pressable onPress={function () { return setModalOpen(false); }} hitSlop={8}>
                <lucide_react_native_1.X size={20} color={tokens_1.color.ink}/>
              </react_native_1.Pressable>
            </react_native_1.View>

            <react_native_1.View style={styles.inputRow}>
              <lucide_react_native_1.Search size={16} color={tokens_1.color.faint}/>
              <react_native_1.TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="City, island or region…" placeholderTextColor={tokens_1.color.faint} returnKeyType="search" autoFocus onSubmitEditing={apply}/>
            </react_native_1.View>

            <react_native_1.Text style={styles.hint}>
              Try "Paris", "Bali", "Palawan" or any city name.
            </react_native_1.Text>

            <react_native_1.Pressable style={styles.applyBtn} onPress={apply}>
              <react_native_1.Text style={styles.applyText}>Explore</react_native_1.Text>
            </react_native_1.Pressable>
          </react_native_1.View>
        </react_native_1.KeyboardAvoidingView>
      </react_native_1.Modal>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.xs,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.xs + 2,
        backgroundColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.pill,
        flexShrink: 1,
        maxWidth: 200,
    },
    dest: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.ink, fontWeight: '600', fontSize: 13, flex: 1 }),
    backdrop: __assign(__assign({}, react_native_1.StyleSheet.absoluteFillObject), { backgroundColor: 'rgba(0,0,0,0.4)' }),
    kav: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: tokens_1.space.lg,
    },
    dialog: __assign({ backgroundColor: tokens_1.color.paperRaised, borderRadius: tokens_1.radius.lg, padding: tokens_1.space.lg, gap: tokens_1.space.md }, tokens_1.shadow.float),
    dialogHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    dialogTitle: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink }),
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.sm,
        backgroundColor: tokens_1.color.haze,
        borderRadius: tokens_1.radius.md,
        paddingHorizontal: tokens_1.space.md,
        paddingVertical: tokens_1.space.md,
    },
    input: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, flex: 1, padding: 0 }),
    hint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.faint, fontSize: 12 }),
    applyBtn: {
        backgroundColor: tokens_1.color.signal,
        borderRadius: tokens_1.radius.md,
        paddingVertical: tokens_1.space.md,
        alignItems: 'center',
    },
    applyText: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.onInk, fontWeight: '700' }),
});
exports.default = DestinationBar;
