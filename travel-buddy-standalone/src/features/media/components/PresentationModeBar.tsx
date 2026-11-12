/**
 * PresentationModeBar — per-lens presentation-mode selector (spec §5).
 *
 * Overview · Visual · Map · Time · Grid · Timeline — the modes vary per lens
 * (§5 table), so the bar renders only the modes the active lens supports and
 * hides itself when a lens has just one mode (e.g. PEOPLE = Visual only).
 */
import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react-native';
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
  const [expanded, setExpanded] = useState(false);
  if (modes.length <= 1) return null;
  return (
    <View style={styles.container}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Change view, currently ${MODE_LABELS[active]}`}
        accessibilityState={{expanded}} onPress={() => setExpanded(value => !value)} style={styles.trigger}>
        <Text style={styles.triggerLabel}>View · {MODE_LABELS[active]}</Text>
        <ChevronDown size={15} color={color.onInk} />
      </Pressable>
      {expanded && <View style={styles.bar}>
      {modes.map((mode) => {
        const isActive = mode === active;
        return (
          <Pressable
            key={mode}
            style={[styles.seg, isActive && styles.segActive]}
            onPress={() => { onSelect(mode); setExpanded(false); }}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={MODE_LABELS[mode]}
          >
            <Text style={[styles.segText, isActive && styles.segTextActive]}>{MODE_LABELS[mode]}</Text>
          </Pressable>
        );
      })}
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingBottom: space.xs },
  trigger: { alignSelf:'flex-end', minHeight:44, flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:space.lg },
  triggerLabel: { color:color.onInk, fontSize:14, fontWeight:'600' },
  bar: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    flexWrap: 'wrap',
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
