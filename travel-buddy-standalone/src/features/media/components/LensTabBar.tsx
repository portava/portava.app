/**
 * LensTabBar — the 6-lens primary navigation (spec §3).
 *
 *   [NOW] [PLACES] [EXPERIENCES] [GEMS] [PEOPLE] [MY WORLD]
 *
 * A horizontal, scrollable lens selector — the organizing hierarchy is
 * World → Experience → Place → Time → People → Media, NOT Creator → Post →
 * Engagement (spec product rule). This is the shell's IA, replacing the old
 * Watch/Grid/Gems mode selector on the new World surface (additive; the old
 * media tab is untouched).
 */
import React from 'react';
import { Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Activity, MapPin, Sparkles, Gem, Users, Globe } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { LENSES } from '../state/lens.ts';
import type { MediaLens } from '../types/mediaContext.ts';

export interface LensTabBarProps {
  active: MediaLens;
  onSelect: (lens: MediaLens) => void;
}

const LENS_ICON: Record<MediaLens, React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>> = {
  now: Activity,
  places: MapPin,
  experiences: Sparkles,
  gems: Gem,
  people: Users,
  my_world: Globe,
};

export function LensTabBar({ active, onSelect }: LensTabBarProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.bar}
    >
      {LENSES.map((lens) => {
        const isActive = lens.key === active;
        const Icon = LENS_ICON[lens.key];
        const tint = isActive ? color.ink : color.onInkMute;
        return (
          <Pressable
            key={lens.key}
            style={[styles.tab, isActive && styles.tabActive]}
            onPress={() => onSelect(lens.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={lens.label}
          >
            <Icon size={15} color={tint} strokeWidth={2.2} />
            <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
              {lens.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  tabActive: { backgroundColor: color.onInk },
  label: { fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
});
