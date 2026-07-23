/**
 * PublicStampShowcaseSection — read-only Featured Stamps strip for a public passport.
 *
 * Accepts a non-empty list of ShowcaseStamp items (caller filters before passing).
 * Renders a "FEATURED STAMPS" kicker and a horizontal scrollable row of stamp
 * artwork cards matching the StampShowcaseRow visual — size 72, rarity-colour dot.
 * No edit affordance.
 */
import React from 'react';
import {
  View, ScrollView, Image, Text, Pressable, StyleSheet,
} from 'react-native';
import type { ShowcaseStamp } from '../../services/stampShowcase.ts';
import { color, space, radius } from '../../theme/tokens.ts';

const CARD_SIZE = 72;

const RARITY_COLORS: Record<string, string> = {
  common:    '#6B7280',
  uncommon:  '#16A34A',
  rare:      '#2563EB',
  epic:      '#7C3AED',
  legendary: '#D97706',
};

interface Props {
  items: ShowcaseStamp[];
  onPress: (item: ShowcaseStamp) => void;
}

function ShowcaseCard({ item, onPress }: { item: ShowcaseStamp; onPress: () => void }) {
  const rarity = item.definition?.rarity ?? 'common';
  const rarityColor = RARITY_COLORS[rarity] ?? RARITY_COLORS.common;
  const artworkUrl = item.definition?.artworkUrl ?? null;
  const label = item.titleOverride ?? item.definition?.name ?? 'Stamp';

  return (
    <Pressable
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.artFrame}>
        {artworkUrl ? (
          <Image
            source={{ uri: artworkUrl }}
            style={styles.artImage}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={styles.artPlaceholder} />
        )}
        <View
          style={[styles.rarityDot, { backgroundColor: rarityColor }]}
          accessibilityLabel={`${rarity} rarity`}
        />
      </View>
      <Text style={styles.cardLabel} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

export function PublicStampShowcaseSection({ items, onPress }: Props) {
  if (!items || items.length === 0) return null;

  return (
    <View style={styles.wrap} testID="public-showcase-section">
      <View style={styles.headerRow}>
        <Text style={styles.sectionKicker}>FEATURED STAMPS</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        accessibilityRole="scrollbar"
      >
        {items.map((item) => (
          <ShowcaseCard
            key={item.userStampId}
            item={item}
            onPress={() => onPress(item)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: space.sm,
    marginBottom: space.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    marginBottom: space.xs,
  },
  sectionKicker: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.1,
    color: color.mute,
    fontFamily: 'Courier',
  },
  scrollContent: {
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  card: {
    alignItems: 'center',
    gap: 4,
    width: CARD_SIZE,
  },
  artFrame: {
    width: CARD_SIZE,
    height: CARD_SIZE,
    borderRadius: CARD_SIZE / 8,
    overflow: 'hidden',
    backgroundColor: color.haze,
    position: 'relative',
  },
  artImage: {
    width: CARD_SIZE,
    height: CARD_SIZE,
  },
  artPlaceholder: {
    width: CARD_SIZE,
    height: CARD_SIZE,
    backgroundColor: color.haze,
  },
  rarityDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: color.mute,
    textAlign: 'center',
    width: CARD_SIZE,
  },
});
