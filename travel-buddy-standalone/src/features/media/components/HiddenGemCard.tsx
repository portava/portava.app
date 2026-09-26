/**
 * HiddenGemCard — one gem in the §16 Hidden Gems lens (spec §40 `HiddenGemCard.tsx`
 * · §16 / §16.2 · §46.1 Hidden Gem Visual Language; census-media §19).
 *
 * §46.1 names five things; this card carries the four that belong on a card:
 *
 *   • "Gem icon or geometric discovery marker" — the rotated-square marker,
 *     drawn in the gem accent, in place of any creator avatar;
 *   • "Subtle edge glow or contour treatment" — the card's own border and outer
 *     glow come from `gemContourTreatment(state)`: a calm glow for a confirmed or
 *     still-hidden gem, a DIMMER protective contour for a fragile one, and a
 *     quiet edge with no glow for one reported unavailable;
 *   • "Recently Confirmed / Worth the Detour / Still Hidden / Seasonal labels" —
 *     the derived §16 state label plus the "Worth the detour" OBSERVATION;
 *   • "Avoid Viral / Trending / Hot / popularity-counter language" — the card
 *     prints no number at all: no saves, no visits, no confirmation count.
 *
 * (The fifth, "map discovery contour / approximate zone", is the Media Map's —
 * see MediaMapCanvas.) There is no coordinate anywhere on the item it renders.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import type { HiddenGemLensItem } from '../types/hiddenGemMedia.ts';
import { GEM_ACCENT, gemCardCopy, gemContourTreatment } from '../state/gemLens.ts';

export interface HiddenGemCardProps {
  gem: HiddenGemLensItem;
  /** 'row' for the Overview sections, 'tile' for the Visual mosaic. */
  variant?: 'row' | 'tile';
  onOpen?: (gem: HiddenGemLensItem) => void;
}

export function HiddenGemCard({ gem, variant = 'row', onOpen }: HiddenGemCardProps) {
  const copy = gemCardCopy(gem);
  const contour = gemContourTreatment(gem.state);
  const contourStyle = {
    borderColor: contour.borderColor,
    borderWidth: contour.borderWidth,
    shadowColor: contour.glowColor,
    shadowRadius: contour.glowRadius,
    shadowOpacity: contour.glowOpacity,
    shadowOffset: { width: 0, height: 0 },
  };

  return (
    <Pressable
      testID={`hidden-gem-card-${gem.gemId}`}
      style={({ pressed }) => [
        variant === 'tile' ? styles.tile : styles.row,
        contourStyle,
        pressed && styles.pressed,
      ]}
      onPress={onOpen ? () => onOpen(gem) : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${copy.title}. ${copy.stateLabel}.`}
    >
      {variant === 'tile' ? (
        gem.imageUrl ? (
          <CachedImage source={{ uri: gem.imageUrl }} style={styles.tileImg} resizeMode="cover" />
        ) : (
          <View style={[styles.tileImg, styles.tileFallback]}>
            <View testID="hidden-gem-marker" style={[styles.marker, styles.markerLarge]} />
          </View>
        )
      ) : null}

      <View style={variant === 'tile' ? styles.tileBody : styles.rowBody}>
        <View style={styles.titleRow}>
          {variant === 'row' ? <View testID="hidden-gem-marker" style={styles.marker} /> : null}
          <Text style={styles.title} numberOfLines={1}>
            {copy.title}
          </Text>
        </View>
        {copy.area ? (
          <Text style={styles.area} numberOfLines={1}>
            {copy.area}
          </Text>
        ) : null}
        <View style={styles.labels}>
          <Text style={[styles.state, contour.kind === 'muted' && styles.stateMuted]}>{copy.stateLabel}</Text>
          {copy.observationLabel ? <Text style={styles.observation}>{copy.observationLabel}</Text> : null}
          {copy.confidenceLabel ? <Text style={styles.confidence}>{copy.confidenceLabel}</Text> : null}
        </View>
        {copy.note ? (
          <Text style={styles.note} numberOfLines={2}>
            {copy.note}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(16,185,129,0.05)',
    elevation: 2,
  },
  tile: {
    flex: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#15201C',
    elevation: 2,
  },
  pressed: { opacity: 0.85 },
  tileImg: { width: '100%', height: 132 },
  tileFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#15201C' },
  tileBody: { padding: space.sm, gap: 3 },
  rowBody: { gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // §46.1 geometric discovery marker: a small rotated square in the gem accent.
  marker: { width: 9, height: 9, transform: [{ rotate: '45deg' }], backgroundColor: GEM_ACCENT },
  markerLarge: { width: 18, height: 18 },
  title: { flex: 1, color: color.onInk, fontSize: 15, fontWeight: '800', letterSpacing: -0.3 },
  area: { color: color.onInkMute, fontSize: 12, fontWeight: '600' },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 2 },
  state: { color: GEM_ACCENT, fontSize: 12, fontWeight: '800' },
  stateMuted: { color: color.onInkMute },
  observation: { color: color.onInk, fontSize: 12, fontWeight: '700' },
  confidence: { color: color.onInkMute, fontSize: 12, fontWeight: '600' },
  note: { color: color.onInkMute, fontSize: 12, lineHeight: 17, marginTop: 2 },
});
