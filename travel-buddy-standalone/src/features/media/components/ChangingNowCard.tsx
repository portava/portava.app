/**
 * ChangingNowCard — a "Changing Now" card on the NOW dashboard (§4.1/§20/§22).
 *
 * A spatial card (hero imagery leads) describing a place/zone whose current
 * state is shifting, with a state label, a subtle trend glyph, a freshness
 * label, and a "Why this?" affordance (§47). Distinct from a feed post: no
 * creator-first stacking, no like/heart hierarchy (§46.2).
 *
 * Media is rendered through CachedImage (signed-URL hydration + designed
 * fallback) so a private-bucket reference never renders a blank box.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { TrendingUp, TrendingDown, HelpCircle } from 'lucide-react-native';
import { color, radius, space, dot } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import type { ChangingNowItem } from '../types/mediaContext.ts';
import { ZONE_COLOR } from '../state/stateColors.ts';
import { zoneStateLabel, zoneGlyph } from '../state/cityPulse.ts';
import { FreshnessBadge } from './FreshnessBadge.tsx';

export interface ChangingNowCardProps {
  item: ChangingNowItem;
  onPress?: (item: ChangingNowItem) => void;
  onWhyThis?: (item: ChangingNowItem) => void;
}

export function ChangingNowCard({ item, onPress, onWhyThis }: ChangingNowCardProps) {
  // The state chip appears ONLY when a gated live claim resolved a state; with
  // none, the card carries just its title/subtitle/freshness — never a
  // fabricated "Peak/Building" badge (§46/§46.2).
  const hasState = item.state != null;
  const accent = hasState ? ZONE_COLOR[item.state as NonNullable<typeof item.state>] : null;
  const glyph = hasState ? zoneGlyph(item.state as NonNullable<typeof item.state>, item.trend ?? 'steady') : 'dot';
  const stateText = hasState ? zoneStateLabel(item.state as NonNullable<typeof item.state>) : null;
  const hero = item.heroMedia?.[0] ?? null;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress ? () => onPress(item) : undefined}
      accessibilityRole="button"
      accessibilityLabel={stateText ? `${item.title}, ${stateText}` : item.title}
    >
      <View style={styles.hero}>
        {hero?.thumbnailUrl ? (
          <CachedImage source={{ uri: hero.thumbnailUrl }} style={styles.heroImg} resizeMode="cover" />
        ) : (
          <View style={[styles.heroImg, styles.heroFallback]} />
        )}
        {/* subtle top-right state chip — only with a real live state */}
        {stateText && accent ? (
          <View style={[styles.stateChip, { borderColor: accent }]}>
            <Text style={[styles.stateChipText, { color: accent }]}>{stateText}</Text>
            {glyph === 'arrow-up' ? (
              <TrendingUp size={12} color={accent} strokeWidth={2.6} />
            ) : glyph === 'arrow-down' ? (
              <TrendingDown size={12} color={accent} strokeWidth={2.6} />
            ) : (
              <View style={[styles.holdDot, { backgroundColor: accent }]} />
            )}
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {item.subtitle}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <FreshnessBadge freshness={item.freshness} label={item.freshnessLabel} />
          {item.whyThis && onWhyThis ? (
            <Pressable
              style={styles.whyBtn}
              onPress={() => onWhyThis(item)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Why am I seeing this?"
            >
              <HelpCircle size={13} color={color.onInkMute} strokeWidth={2} />
              <Text style={styles.whyText}>Why this?</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 260,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(250,249,246,0.05)',
    overflow: 'hidden',
  },
  cardPressed: { opacity: 0.85 },
  hero: { height: 150, backgroundColor: '#1B1B18' },
  heroImg: { width: '100%', height: '100%' },
  heroFallback: { backgroundColor: '#22221E' },
  stateChip: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    backgroundColor: 'rgba(17,17,15,0.55)',
  },
  stateChipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  holdDot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  body: { padding: space.md, gap: 4 },
  title: { color: color.onInk, fontSize: 16, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: color.onInkMute, fontSize: 13, fontWeight: '500', lineHeight: 18 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
  whyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  whyText: { color: color.onInkMute, fontSize: 12, fontWeight: '700' },
});
