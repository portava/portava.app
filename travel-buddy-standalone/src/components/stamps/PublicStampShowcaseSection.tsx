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
  View, ScrollView, Text, Pressable, StyleSheet,
} from 'react-native';
import type { ShowcaseStamp } from '../../services/stampShowcase.ts';
import type { PassportStamp } from '../../types/models.ts';
import { color, space, radius, dot } from '../../theme/tokens.ts';
import { RARITY_COLORS, normalizeRarity, hasGlowRing } from '../../lib/stampRarity.ts';
import { UniversalStampArtwork } from './UniversalStampArtwork.tsx';

const CARD_SIZE = 72;

interface Props {
  items: ShowcaseStamp[];
  onPress: (item: ShowcaseStamp) => void;
}

/**
 * Showcase items always render through the same colorful illustrated
 * UniversalStampArtwork used by the main grid (StampCard) and StampShowcaseRow —
 * no separate "old style" plain icon look is allowed here.
 */
function toLegacyShowcase(item: ShowcaseStamp): PassportStamp {
  const kind = (
    item.definition?.stampType === 'city'         ? 'city'
    : item.definition?.stampType === 'plan'       ? 'plan'
    : item.definition?.stampType === 'hidden_gem' ? 'gem'
    : item.definition?.stampType === 'safe_return'? 'safe'
    : item.definition?.stampType === 'host'       ? 'host'
    : 'city'
  ) as PassportStamp['kind'];
  return {
    id: item.userStampId,
    kind,
    label: item.titleOverride ?? item.definition?.name ?? 'Stamp',
    earnedAt: item.earnedAt,
    universalArtworkUrl: item.definition?.artworkUrl ?? undefined,
    city: item.city,
    rarity: normalizeRarity(item.definition?.rarity),
  };
}

function ShowcaseCard({ item, onPress }: { item: ShowcaseStamp; onPress: () => void }) {
  const rarity = normalizeRarity(item.definition?.rarity);
  const rarityColor = RARITY_COLORS[rarity].ring;
  const label = item.titleOverride ?? item.definition?.name ?? 'Stamp';
  const showGlow = hasGlowRing(rarity);
  const legacy = toLegacyShowcase(item);

  return (
    <Pressable
      style={styles.card}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[styles.artFrame, showGlow && { borderWidth: 1.5, borderColor: rarityColor }]}>
        <UniversalStampArtwork
          activeArtworkUrl={item.definition?.artworkUrl ?? null}
          stamp={legacy}
          size={CARD_SIZE}
          showPendingLabel={false}
        />
        <View
          style={[styles.rarityDot, { backgroundColor: rarityColor }]}
          accessibilityLabel={`${rarity} rarity`}
        />
      </View>
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  artPlaceholderLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: color.mute,
    textAlign: 'center',
  },
  rarityDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: dot.s8, height: dot.s8,
    borderRadius: dot.s8 / 2,
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
