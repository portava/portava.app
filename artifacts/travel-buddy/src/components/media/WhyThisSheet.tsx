/**
 * WhyThisSheet — "Why am I seeing this?" bottom sheet for Watch/Gems items.
 *
 * Reads `item.compassExplanation` (a pre-computed label baked into the
 * feed item at delivery time) when available. Falls back to a simplified
 * human-readable message if the field is absent.
 *
 * The sheet is purely informational — no actions beyond dismissal.
 */
import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Compass } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WhyThisSheetProps {
  visible: boolean;
  /** Human-readable explanation string from the feed item. */
  explanation: string | null | undefined;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WhyThisSheet({ visible, explanation, onClose }: WhyThisSheetProps) {
  const insets = useSafeAreaInsets();

  const displayText =
    explanation?.trim() ||
    'This appeared because it matches your travel preferences and recent activity.';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <Pressable style={s.backdrop} onPress={onClose} />

      {/* Sheet */}
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        {/* Handle */}
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <Compass size={20} color={color.deep} strokeWidth={1.8} />
            <Text style={s.title}>Why am I seeing this?</Text>
          </View>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={8} accessibilityLabel="Close">
            <X size={20} color={color.mute} strokeWidth={1.8} />
          </Pressable>
        </View>

        {/* Content */}
        <ScrollView
          style={s.scrollArea}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <Text style={s.body}>{displayText}</Text>

          <View style={s.divider} />

          <Text style={s.footnote}>
            Your feed is shaped by your travel interests, the places you've explored, and creators you engage with. We never use your exact location to rank content.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SHEET_RADIUS = 20;

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
      android: { elevation: 12 },
    }),
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  closeBtn: {
    padding: 4,
  },
  scrollArea: {
    maxHeight: 320,
  },
  scrollContent: {
    paddingBottom: space.md,
  },
  body: {
    ...t.body,
    color: color.ink,
    lineHeight: 22,
  },
  divider: {
    height: 1,
    backgroundColor: color.haze,
    marginVertical: space.lg,
  },
  footnote: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
});
