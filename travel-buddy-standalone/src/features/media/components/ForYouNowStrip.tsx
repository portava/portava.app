/**
 * ForYouNowStrip — the "For You Now" row on the NOW dashboard (spec §4.1).
 *
 *   Nightlife · 18 fresh perspectives
 *   Food · 9 fresh perspectives
 *   Hidden Gems · 6 recently confirmed
 *
 * Horizontally-scrolling chips — NOT an infinite vertical feed (§46.2). Counts
 * describe fresh perspectives / confirmations (contribution signals), not views.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Sparkles, Gem } from 'lucide-react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { ForYouNowItem } from '../types/mediaContext.ts';

export interface ForYouNowStripProps {
  items: ForYouNowItem[];
  onSelect?: (item: ForYouNowItem) => void;
}

function kindCopy(item: ForYouNowItem): string {
  switch (item.kind) {
    case 'recently_confirmed':
      return `${item.count} recently confirmed`;
    case 'changing':
      return `${item.count} changing now`;
    case 'seasonal':
      return `${item.count} in season`;
    case 'fresh_perspectives':
    default:
      return `${item.count} fresh ${item.count === 1 ? 'perspective' : 'perspectives'}`;
  }
}

export function ForYouNowStrip({ items, onSelect }: ForYouNowStripProps) {
  return (
    <View>
      <Text style={styles.heading}>For you now</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {items.map((item) => {
          const isGem = item.kind === 'recently_confirmed' || item.category.toLowerCase().includes('gem');
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              onPress={onSelect ? () => onSelect(item) : undefined}
              accessibilityRole="button"
              accessibilityLabel={`${item.category}, ${kindCopy(item)}`}
            >
              {isGem ? (
                <Gem size={15} color="#3DD6C4" strokeWidth={2} />
              ) : (
                <Sparkles size={15} color={color.signal} strokeWidth={2} />
              )}
              <Text style={styles.category}>{item.category}</Text>
              <Text style={styles.count}>{kindCopy(item)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },
  strip: { gap: space.sm, paddingRight: space.lg },
  chip: {
    backgroundColor: 'rgba(250,249,246,0.06)',
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
    minWidth: 140,
  },
  chipPressed: { opacity: 0.6 },
  category: { color: color.onInk, fontSize: 15, fontWeight: '800', letterSpacing: -0.3, marginTop: 4 },
  count: { color: color.onInkMute, fontSize: 12, fontWeight: '600' },
});
