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
exports.TranslationSettingsSheet = TranslationSettingsSheet;
/**
 * TranslationSettingsSheet — per-thread translation preference bottom sheet.
 *
 * Opened from the Languages icon in any thread header.
 * Settings are persisted to AsyncStorage keyed by threadId and override the
 * user's global language preferences for that specific thread.
 */
var react_1 = require("react");
var react_native_1 = require("react-native");
var lucide_react_native_1 = require("lucide-react-native");
var tokens_1 = require("../theme/tokens");
function TranslationSettingsSheet(_a) {
    var visible = _a.visible, autoTranslate = _a.autoTranslate, showOriginalFirst = _a.showOriginalFirst, onChangeAutoTranslate = _a.onChangeAutoTranslate, onChangeShowOriginalFirst = _a.onChangeShowOriginalFirst, onClose = _a.onClose;
    return (<react_native_1.Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <react_native_1.Pressable style={ts.overlay} onPress={onClose}/>
      <react_native_1.View style={ts.sheet}>
        <react_native_1.View style={ts.handle}/>

        <react_native_1.View style={ts.titleRow}>
          <react_native_1.Text style={ts.title}>Translation</react_native_1.Text>
          <react_native_1.Pressable onPress={onClose} hitSlop={8}>
            <lucide_react_native_1.X size={18} color={tokens_1.color.mute}/>
          </react_native_1.Pressable>
        </react_native_1.View>

        <react_native_1.Text style={ts.subtitle}>
          These settings apply to this thread only. Your global preference is in
          Profile → Language Settings.
        </react_native_1.Text>

        {/* Auto-translate toggle */}
        <react_native_1.View style={ts.row}>
          <react_native_1.View style={ts.rowMeta}>
            <react_native_1.Text style={ts.rowLabel}>Auto-translate messages</react_native_1.Text>
            <react_native_1.Text style={ts.rowHint}>
              Display incoming messages in your preferred language
            </react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Switch value={autoTranslate} onValueChange={onChangeAutoTranslate} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal }} thumbColor={tokens_1.color.paperRaised} ios_backgroundColor={tokens_1.color.haze}/>
        </react_native_1.View>

        {/* Show original toggle — grayed out when auto-translate is off */}
        <react_native_1.View style={[ts.row, !autoTranslate && ts.rowDisabled]}>
          <react_native_1.View style={ts.rowMeta}>
            <react_native_1.Text style={[ts.rowLabel, !autoTranslate && ts.rowLabelMuted]}>
              Show original by default
            </react_native_1.Text>
            <react_native_1.Text style={ts.rowHint}>
              Show the sender's original text first, with a toggle to see the
              translation
            </react_native_1.Text>
          </react_native_1.View>
          <react_native_1.Switch value={showOriginalFirst} onValueChange={onChangeShowOriginalFirst} disabled={!autoTranslate} trackColor={{ false: tokens_1.color.haze, true: tokens_1.color.signal }} thumbColor={tokens_1.color.paperRaised} ios_backgroundColor={tokens_1.color.haze}/>
        </react_native_1.View>
      </react_native_1.View>
    </react_native_1.Modal>);
}
var ts = react_native_1.StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
        backgroundColor: tokens_1.color.paperRaised,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingHorizontal: tokens_1.space.lg,
        paddingBottom: 44,
        paddingTop: tokens_1.space.sm,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: tokens_1.color.haze,
        alignSelf: 'center',
        marginBottom: tokens_1.space.md,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    title: __assign(__assign({}, tokens_1.type.bodyStrong), { color: tokens_1.color.ink, fontWeight: '700', fontSize: 16 }),
    subtitle: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 12, lineHeight: 17, marginBottom: tokens_1.space.md }),
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens_1.space.md,
        paddingVertical: 14,
        borderTopWidth: react_native_1.StyleSheet.hairlineWidth,
        borderTopColor: tokens_1.color.haze,
    },
    rowDisabled: { opacity: 0.45 },
    rowMeta: { flex: 1 },
    rowLabel: __assign(__assign({}, tokens_1.type.body), { color: tokens_1.color.ink, fontWeight: '600' }),
    rowLabelMuted: { color: tokens_1.color.mute },
    rowHint: __assign(__assign({}, tokens_1.type.small), { color: tokens_1.color.mute, fontSize: 11, marginTop: 2, lineHeight: 15 }),
});
