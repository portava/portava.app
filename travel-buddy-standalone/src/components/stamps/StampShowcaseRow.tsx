/**
 * StampShowcaseRow — horizontal strip of curated showcase stamps.
 *
 * Renders up to MAX_SHOWCASE stamp artworks in a horizontally-scrollable row
 * with a rarity-colour dot badge on each card. Entry animation is suppressed
 * when the user prefers reduced motion.
 */
import React, { useEffect, useRef } from 'react';
import {
  View, ScrollView, Image, Text, Pressable, StyleSheet, Animated,
  AccessibilityInfo,
} from 'react-native';
import type { ShowcaseStamp } from '../../services/stampShowcase.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

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
  onEdit?: () => void;
}

function ShowcaseCard({ item, onPress, anim }: {
  item: ShowcaseStamp;
  onPress: () => void;
  anim: Animated.Value;
}) {
  const rarity = item.definition?.rarity ?? 'common';
  const rarityColor = RARITY_COLORS[rarity] ?? RARITY_COLORS.common;
  const artworkUrl = item.definition?.artworkUrl ?? null;
  const label = item.titleOverride ?? item.definition?.name ?? 'Stamp';

  return (
    <Animated.View style={{ opacity: anim, transform: [{ scale: anim }] }}>
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
          {/* Rarity badge dot */}
          <View
            style={[styles.rarityDot, { backgroundColor: rarityColor }]}
            accessibilityLabel={`${rarity} rarity`}
          />
        </View>
        <Text style={styles.cardLabel} numberOfLines={1}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

interface EmptyCardProps {
  onEdit: () => void;
}

/**
 * StampShowcaseEmptyCard — shown when the showcase feature flag is on but
 * no stamps have been curated yet. Tapping opens the curation editor.
 */
export function StampShowcaseEmptyCard({ onEdit }: EmptyCardProps) {
  return (
    <View style={styles.emptyWrap}>
      <Pressable
        style={styles.emptyCard}
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel="Feature your favorite stamps"
      >
        <Text style={styles.emptyIcon}>✦</Text>
        <Text style={styles.emptyText}>Feature your favorite stamps</Text>
        <Text style={styles.emptyHint}>Tap to choose up to {8} stamps to showcase</Text>
      </Pressable>
    </View>
  );
}

export function StampShowcaseRow({ items, onPress, onEdit }: Props) {
  const anims = useRef<Animated.Value[]>([]);

  // Ensure we have an Animated.Value for each item.
  while (anims.current.length < items.length) {
    anims.current.push(new Animated.Value(0));
  }

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return;
      if (reduced) {
        // Skip animation — set all to 1 immediately.
        anims.current.forEach((a) => a.setValue(1));
      } else {
        Animated.stagger(
          40,
          anims.current.slice(0, items.length).map((a) =>
            Animated.spring(a, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 220 }),
          ),
        ).start();
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionKicker}>SHOWCASE</Text>
        {onEdit && (
          <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel="Edit showcase">
            <Text style={styles.editLink}>Edit</Text>
          </Pressable>
        )}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        accessibilityRole="scrollbar"
      >
        {items.map((item, i) => (
          <ShowcaseCard
            key={item.userStampId}
            item={item}
            onPress={() => onPress(item)}
            anim={anims.current[i] ?? new Animated.Value(1)}
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
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    marginBottom: space.xs,
  },
  sectionKicker: {
    fontSize: 9, fontWeight: '700', letterSpacing: 1.1,
    color: color.mute, fontFamily: 'Courier',
  },
  editLink: {
    fontSize: 12, fontWeight: '600', color: color.signal,
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
  /* Empty card */
  emptyWrap: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
  },
  emptyCard: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.haze,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: color.paper,
  },
  emptyIcon: {
    fontSize: 18,
    color: color.faint,
  },
  emptyText: {
    ...t.bodyStrong,
    color: color.mute,
    fontSize: 14,
  },
  emptyHint: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
});
