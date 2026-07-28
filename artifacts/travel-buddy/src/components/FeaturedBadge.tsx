/**
 * FeaturedBadge — gold/amber "Featured by Portava" badge.
 *
 * Rendered on Watch overlay, post-detail header, profile grid tiles,
 * and postcard screen wherever `featuredByPortava` is set.
 *
 * Props:
 *   category — the portava_featured.category label (e.g. "Best Hidden Gem").
 *              When absent, shows the generic "Featured" label.
 *   size     — 'sm' (default, fits in feed overlays) | 'md' (post detail)
 *   dark     — true when rendered on a dark/video background (uses lighter text)
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Trophy } from 'lucide-react-native';

export type FeaturedCategory =
  | 'best_video'
  | 'best_hidden_gem'
  | 'best_nightlife'
  | 'best_restaurant'
  | 'best_adventure'
  | 'best_photo';

const CATEGORY_LABELS: Record<FeaturedCategory, string> = {
  best_video:       'Best Video',
  best_hidden_gem:  'Best Hidden Gem',
  best_nightlife:   'Best Nightlife',
  best_restaurant:  'Best Restaurant',
  best_adventure:   'Best Adventure',
  best_photo:       'Best Photo',
};

function formatCategory(category?: string | null): string {
  if (!category) return 'Featured';
  return CATEGORY_LABELS[category as FeaturedCategory] ?? category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface FeaturedBadgeProps {
  category?: string | null;
  size?: 'sm' | 'md';
  dark?: boolean;
}

export function FeaturedBadge({ category, size = 'sm', dark = false }: FeaturedBadgeProps) {
  const isSmall = size === 'sm';
  const label = formatCategory(category);

  const bg = dark ? 'rgba(212, 160, 23, 0.22)' : '#FEF3C7';
  const border = dark ? 'rgba(212, 160, 23, 0.55)' : '#F59E0B';
  const textColor = dark ? '#FDE68A' : '#92400E';
  const iconColor = dark ? '#FCD34D' : '#D97706';
  const iconSize = isSmall ? 9 : 11;
  const paddingH = isSmall ? 6 : 8;
  const paddingV = isSmall ? 3 : 4;
  const fontSize = isSmall ? 9.5 : 11;

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: bg,
          borderColor: border,
          paddingHorizontal: paddingH,
          paddingVertical: paddingV,
        },
      ]}
      accessibilityLabel={`Featured by Portava: ${label}`}
    >
      <Trophy size={iconSize} color={iconColor} strokeWidth={2.5} />
      <Text
        style={[
          styles.label,
          { color: textColor, fontSize, lineHeight: fontSize + 2 },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  label: {
    fontFamily: 'Courier',
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
