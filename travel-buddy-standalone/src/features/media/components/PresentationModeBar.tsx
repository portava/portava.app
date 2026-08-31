/**
 * PresentationModeBar — per-lens presentation-mode selector (spec §5).
 *
 * Overview · Visual · Map · Time · Grid · Timeline — the modes vary per lens
 * (§5 table), so the bar renders only the modes the active lens supports and
 * hides itself when a lens has just one mode (e.g. PEOPLE = Visual only).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { PresentationMode } from '../types/mediaContext.ts';
import { MODE_LABELS } from '../state/lens.ts';

export interface PresentationModeBarProps {
  modes: PresentationMode[];
  active: PresentationMode;
  onSelect: (mode: PresentationMode) => void;
}

export function PresentationModeBar({ modes, active, onSelect }: PresentationModeBarProps) {
  if (modes.length <= 1) return null;
  return (
    <View style={styles.bar}>
      {modes.map((mode) => {
        const isActive = mode === active;
        return (
          <Pressable
            key={mode}
            style={[styles.seg, isActive && styles.segActive]}
            onPress={() => onSelect(mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={MODE_LABELS[mode]}
          >
            <Text style={[styles.segText, isActive && styles.segTextActive]}>{MODE_LABELS[mode]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    gap: 2,
    padding: 3,
    marginHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  seg: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  segActive: { backgroundColor: color.onInk },
  segText: { color: color.onInkMute, fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
  segTextActive: { color: color.ink },
});
