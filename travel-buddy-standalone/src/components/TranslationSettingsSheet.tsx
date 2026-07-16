/**
 * TranslationSettingsSheet — per-thread translation preference bottom sheet.
 *
 * Opened from the Languages icon in any thread header.
 * Settings are persisted to AsyncStorage keyed by threadId and override the
 * user's global language preferences for that specific thread.
 */
import React from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Switch,
} from 'react-native';
import { X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  visible: boolean;
  autoTranslate: boolean;
  showOriginalFirst: boolean;
  onChangeAutoTranslate: (v: boolean) => void;
  onChangeShowOriginalFirst: (v: boolean) => void;
  onClose: () => void;
}

export function TranslationSettingsSheet({
  visible,
  autoTranslate,
  showOriginalFirst,
  onChangeAutoTranslate,
  onChangeShowOriginalFirst,
  onClose,
}: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={ts.overlay} onPress={onClose} />
      <View style={ts.sheet}>
        <View style={ts.handle} />

        <View style={ts.titleRow}>
          <Text style={ts.title}>Translation</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        <Text style={ts.subtitle}>
          These settings apply to this thread only. Your global preference is in
          Profile → Language Settings.
        </Text>

        {/* Auto-translate toggle */}
        <View style={ts.row}>
          <View style={ts.rowMeta}>
            <Text style={ts.rowLabel}>Auto-translate messages</Text>
            <Text style={ts.rowHint}>
              Display incoming messages in your preferred language
            </Text>
          </View>
          <Switch
            value={autoTranslate}
            onValueChange={onChangeAutoTranslate}
            trackColor={{ false: color.haze, true: color.signal }}
            thumbColor={color.paperRaised}
            ios_backgroundColor={color.haze}
          />
        </View>

        {/* Show original toggle — grayed out when auto-translate is off */}
        <View style={[ts.row, !autoTranslate && ts.rowDisabled]}>
          <View style={ts.rowMeta}>
            <Text style={[ts.rowLabel, !autoTranslate && ts.rowLabelMuted]}>
              Show original by default
            </Text>
            <Text style={ts.rowHint}>
              Show the sender's original text first, with a toggle to see the
              translation
            </Text>
          </View>
          <Switch
            value={showOriginalFirst}
            onValueChange={onChangeShowOriginalFirst}
            disabled={!autoTranslate}
            trackColor={{ false: color.haze, true: color.signal }}
            thumbColor={color.paperRaised}
            ios_backgroundColor={color.haze}
          />
        </View>
      </View>
    </Modal>
  );
}

const ts = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 44,
    paddingTop: space.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },
  subtitle: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  rowDisabled: { opacity: 0.45 },
  rowMeta: { flex: 1 },
  rowLabel: { ...t.body, color: color.ink, fontWeight: '600' },
  rowLabelMuted: { color: color.mute },
  rowHint: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2, lineHeight: 15 },
});
