/**
 * WhyShownSheet — the §9 "WHY PORTAVA SAYS THIS" panel.
 *
 * Spec §9: "Every meaningful live claim should support a Why? interaction. This
 * is critical to making Portava intelligence trustworthy and replayable."
 *
 * The panel is deliberately boring: a heading, the evidence bullets, when the
 * evidence was last updated, and the certainty band. That is the whole §9
 * example, and nothing else belongs here — an action button would turn an
 * explanation into a pitch.
 *
 * All of the wording is resolved by `buildWhyPanel` in the pure truth module,
 * so what this file renders is exactly what the node:test suite asserts. In
 * particular this component NEVER composes an evidence line itself: if the
 * object carries no evidence, the panel says so.
 *
 * Bottom sheet, dismissible by backdrop tap, hardware back and an explicit
 * close button. Dark-mode first (§4).
 */
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { color, dot, icon, radius, space, typography } from '../../theme/tokens.ts';
import { buildWhyPanel } from '../../features/map/truth/liveTruth.ts';
import { ConfidenceIndicator } from './ConfidenceIndicator.tsx';
import { FreshnessBadge } from './FreshnessBadge.tsx';
import type { MapObject } from '../../types/mapObjects.ts';

const SHEET = '#141412';
const HAIRLINE = 'rgba(250,249,246,0.12)';
const BULLET = 'rgba(250,249,246,0.38)';

export interface WhyShownSheetProps {
  visible: boolean;
  /** The object whose claim is being explained. */
  object: MapObject | null | undefined;
  onClose: () => void;
  /** Injectable clock, so relative wording is deterministic in tests. */
  now?: Date | number;
}

export function WhyShownSheet({ visible, object, onClose, now }: WhyShownSheetProps) {
  const insets = useSafeAreaInsets();
  const model = buildWhyPanel(object, now);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityLabel="Dismiss explanation"
        accessibilityRole="button"
      />

      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.handle} />

        <View style={s.header}>
          <View style={s.headerText}>
            <Text style={s.eyebrow}>{model.title}</Text>
            {object?.title ? (
              <Text style={s.subject} numberOfLines={1}>{object.title}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={s.closeBtn}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <X size={icon.s16} color={color.onInkMute} />
          </Pressable>
        </View>

        {object ? (
          <View style={s.badgeRow}>
            <FreshnessBadge object={object} now={now} compact />
          </View>
        ) : null}

        <ScrollView
          style={s.list}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
        >
          {model.lines.map((line, i) => (
            <View key={line.ref ?? `${i}-${line.text}`} style={s.lineRow}>
              <View style={s.bullet} />
              <Text style={s.lineText}>{line.text}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={s.footer}>
          {model.updated ? <Text style={s.updated}>{model.updated}</Text> : null}
          <ConfidenceIndicator confidence={model.confidence} prefixLabel />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    backgroundColor: SHEET,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: HAIRLINE,
  },
  handle: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(250,249,246,0.22)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    ...typography.metadata,
    color: color.onInkMute,
    letterSpacing: 1.1,
  },
  subject: {
    ...typography.sectionTitle,
    color: color.onInk,
    marginTop: 3,
  },
  closeBtn: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  badgeRow: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  list: {
    flexGrow: 0,
    marginTop: space.md,
  },
  listContent: {
    paddingHorizontal: space.lg,
    gap: 10,
    paddingBottom: space.md,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  bullet: {
    width: dot.s5,
    height: dot.s5,
    borderRadius: dot.s5 / 2,
    backgroundColor: BULLET,
    marginTop: 8,
    flexShrink: 0,
  },
  lineText: {
    ...typography.body,
    fontSize: 14,
    lineHeight: 20,
    color: color.onInk,
    flex: 1,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
  },
  updated: {
    ...typography.caption,
    fontSize: 12,
    color: color.onInkMute,
  },
});
