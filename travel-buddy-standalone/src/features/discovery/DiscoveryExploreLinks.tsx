/**
 * The way into Trails and Trending from the Discovery tab (owner decision
 * 2026-10-04: both are user-facing features). Two chips, carrying the city the
 * tab is showing so each screen opens on it. Renders nothing it cannot link.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Route as RouteIcon, TrendingUp } from 'lucide-react-native';

import { color, space, radius, type as t } from '../../theme/tokens.ts';

export function exploreHref(screen: 'trails' | 'trending', city: string | null | undefined): string {
  const base = screen === 'trails' ? '/trails' : '/trending';
  return city && city.trim() ? `${base}?destination=${encodeURIComponent(city.trim())}` : base;
}

export function DiscoveryExploreLinks({ city, onNavigate }: { city: string | null | undefined; onNavigate: (href: string) => void }) {
  return (
    <View style={s.row} pointerEvents="auto" testID="discovery-explore-links">
      <Pressable style={s.chip} onPress={() => onNavigate(exploreHref('trails', city))} accessibilityRole="link" accessibilityLabel="Browse Trails" testID="discovery-link-trails">
        <RouteIcon size={12} color={color.deep} />
        <Text style={s.text}>Trails</Text>
      </Pressable>
      <Pressable style={s.chip} onPress={() => onNavigate(exploreHref('trending', city))} accessibilityRole="link" accessibilityLabel="See what is trending" testID="discovery-link-trending">
        <TrendingUp size={12} color={color.deep} />
        <Text style={s.text}>Trending</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xs,
    borderRadius: radius.pill, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, minHeight: 32,
  },
  text: { ...t.small, fontWeight: '600', color: color.deep },
});
