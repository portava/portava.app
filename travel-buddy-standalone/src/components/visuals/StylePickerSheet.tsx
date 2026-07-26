/**
 * StylePickerSheet — bottom sheet listing the 10 AI visual styles.
 *
 * Only style IDs are exposed here; the actual style instruction text lives
 * exclusively on the server and never leaves it.
 */
import React from 'react';
import {
  Modal, View, Text, Pressable, ScrollView, StyleSheet,
} from 'react-native';
import { X, Check } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { VisualStyle } from '../../hooks/useVisualGeneration.ts';

// ── Style catalogue (IDs only — no server-side instruction text) ──────────────

interface StyleEntry {
  id: VisualStyle;
  label: string;
  desc: string;
  emoji: string;
}

export const VISUAL_STYLES: StyleEntry[] = [
  { id: 'portava_editorial',   label: 'Portava Editorial',   emoji: '📸', desc: 'Premium travel-lifestyle photography, natural light' },
  { id: 'cinematic_travel',    label: 'Cinematic Travel',    emoji: '🎬', desc: 'Dramatic lighting, wide anamorphic feel' },
  { id: 'premium_nightlife',   label: 'Premium Nightlife',   emoji: '🥂', desc: 'Warm ambient & neon accents, elegant crowd energy' },
  { id: 'tropical_social',     label: 'Tropical Social',     emoji: '🌴', desc: 'Bright coastal mood, golden-hour warmth' },
  { id: 'urban_explorer',      label: 'Urban Explorer',      emoji: '🏙️', desc: 'Modern city energy, clean architectural lines' },
  { id: 'food_and_dining',     label: 'Food & Dining',       emoji: '🍽️', desc: 'Appetizing editorial, warm interior light' },
  { id: 'outdoor_adventure',   label: 'Outdoor Adventure',   emoji: '🏔️', desc: 'Expansive landscapes, crisp natural light' },
  { id: 'minimal_illustration',label: 'Minimal Illustration',emoji: '🎨', desc: 'Clean vector-style, flat cohesive palette' },
  { id: 'passport_poster',     label: 'Passport Poster',     emoji: '🗺️', desc: 'Vintage travel-poster, bold retro palette' },
  { id: 'colorful_festival',   label: 'Colorful Festival',   emoji: '🎉', desc: 'Vibrant atmosphere, saturated celebration' },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  currentStyle?: string | null;
  onSelect: (style: VisualStyle) => void;
  onClose: () => void;
}

export function StylePickerSheet({ visible, currentStyle, onSelect, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.handle} />
        <View style={s.header}>
          <Text style={s.title}>Choose a style</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close style picker">
            <X size={20} color={color.mute} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {VISUAL_STYLES.map((style) => {
            const active = style.id === currentStyle;
            return (
              <Pressable
                key={style.id}
                style={({ pressed }) => [
                  s.row,
                  active && s.rowActive,
                  pressed && { opacity: 0.75 },
                ]}
                onPress={() => { onSelect(style.id); onClose(); }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${style.label}. ${style.desc}`}
              >
                <Text style={s.emoji}>{style.emoji}</Text>
                <View style={s.rowBody}>
                  <Text style={[s.label, active && s.labelActive]}>{style.label}</Text>
                  <Text style={s.desc} numberOfLines={1}>{style.desc}</Text>
                </View>
                {active && <Check size={16} color={color.signal} />}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
    maxHeight: '80%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.sm,
    marginBottom: space.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
    flex: 1,
  },
  list: {
    padding: space.md,
    gap: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  rowActive: {
    borderColor: color.signal,
    backgroundColor: '#F0FDF4',
  },
  emoji: {
    fontSize: 22,
    lineHeight: 28,
    width: 28,
    textAlign: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  label: {
    ...t.body,
    color: color.ink,
    fontWeight: '600',
    fontSize: 14,
  },
  labelActive: {
    color: color.signal,
  },
  desc: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
});
