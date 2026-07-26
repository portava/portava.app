/**
 * AiRepresentationLabel — small disclosure pill shown over or beneath images
 * that are AI-generated place representations.
 *
 * Render only when `resolved.isRepresentation === true` (i.e. the resolver
 * chose an ai_generated source over every other candidate).
 *
 * Tapping opens a brief informational sheet explaining that the image is an
 * AI-generated impression, not a photograph of the actual venue.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Sparkles, X, Info } from 'lucide-react-native';
import { color, space, radius } from '../../theme/tokens.ts';

interface Props {
  /** Extra styles for positioning (e.g. absolute bottom-left corner). */
  style?: object;
  testID?: string;
}

export function AiRepresentationLabel({ style, testID }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[s.pill, style]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="AI-generated representation. Tap to learn more."
        testID={testID ?? 'ai-representation-label'}
      >
        <Sparkles size={10} color="#6D28D9" />
        <Text style={s.pillText}>AI representation</Text>
        <Info size={10} color="#6D28D9" />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={s.sheet} testID="ai-representation-sheet">
          <View style={s.sheetHead}>
            <Sparkles size={18} color="#6D28D9" />
            <Text style={s.sheetTitle}>AI-generated representation</Text>
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>
          <Text style={s.sheetBody}>
            This image is an AI-generated artistic impression of the venue based on its
            name and category — it is not a photograph of the actual location. Real
            photos may look different from this representation.
          </Text>
          <Text style={s.sheetNote}>
            Photos uploaded by hosts or sourced from venue providers are labelled
            separately and are never confused with AI representations.
          </Text>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(109,40,217,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(109,40,217,0.25)',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
    color: '#6D28D9',
  },

  // ── Modal ───────────────────────────────────────────────────────────────────
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 60,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: color.ink,
    flex: 1,
  },
  sheetBody: {
    fontSize: 14,
    lineHeight: 20,
    color: color.mute,
  },
  sheetNote: {
    fontSize: 12,
    lineHeight: 17,
    color: color.faint,
    fontStyle: 'italic',
  },
});
