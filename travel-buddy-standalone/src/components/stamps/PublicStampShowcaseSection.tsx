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
import { RARITY_COLORS, normalizeRarity, hasGlowRing } from '../../lib/stampRarity.ts';

const CARD_SIZE = 72;

interface Props {
  items: ShowcaseStamp[];
  onPress: (item: ShowcaseStamp) => void;
}

function ShowcaseCard({ item, onPress }: { item: ShowcaseStamp; onPress: () => void }) {
  const rarity = normalizeRarity(item.definition?.rarity);
  const rarityColor = RARITY_COLORS[rarity].ring;
  const artworkUrl = item.definition?.artworkUrl ?? null;
  const label = item.titleOverride ?? item.definition?.name ?? 'Stamp';
  const showGlow = hasGlowRing(rarity);

  return (
    <Pressable
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.artFrame, showGlow && { borderWidth: 1.5, borderColor: rarityColor }]}>
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
