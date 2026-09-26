/**
 * PerspectiveTile — one perspective within a place/experience (spec §12/§14).
 *
 * A perspective is a permitted visual contribution (Street / Entrance / Rooftop
 * …), NOT an analytics view. The tile leads with imagery, tags the perspective
 * group + freshness, and keeps creator identity secondary (§46). Tapping opens
 * the shared media viewer — this component never plays full-screen stranger
 * video on open (§46.2).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Play } from 'lucide-react-native';
import { color, radius, space, icon } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import type { MediaProjection } from '../types/media.ts';
import { OBSERVATION_COLOR } from '../state/stateColors.ts';
import { relativeAgeLabel } from '../state/freshness.ts';

export interface PerspectiveTileProps {
  media: MediaProjection;
  /** Display label for the perspective group, e.g. "Street". */
  perspectiveLabel?: string | null;
  /** Tile height (mosaic sizing). */
  height?: number;
  onOpen?: (media: MediaProjection) => void;
}

export function PerspectiveTile({ media, perspectiveLabel, height = 180, onOpen }: PerspectiveTileProps) {
  const accent = OBSERVATION_COLOR[media.observationClass];
  const age = media.freshnessLabel ?? relativeAgeLabel(media.ageMinutes);
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, { height }, pressed && styles.pressed]}
      onPress={onOpen ? () => onOpen(media) : undefined}
      accessibilityRole="button"
      accessibilityLabel={perspectiveLabel ? `${perspectiveLabel} perspective` : 'Perspective'}
    >
      {media.thumbnailUrl ? (
        <CachedImage source={{ uri: media.thumbnailUrl }} style={styles.img} resizeMode="cover" fallbackBg={color.mute} />
      ) : (
        <View style={[styles.img, styles.fallback]} />
      )}

      {/* accent edge marks the evidence class (observed vs inferred vs …) */}
      <View style={tailStyles.edgeCasing} /><View style={[styles.edge, { backgroundColor: accent }]} />

      {media.mediaType === 'video' ? (
        <View style={styles.playBadge}>
          <Play size={14} color={color.onInk} strokeWidth={2.4} fill={color.onInk} />
        </View>
      ) : null}

      <View style={styles.overlay}>
        {perspectiveLabel ? <Text style={styles.perspective}>{perspectiveLabel}</Text> : null}
        {age ? <Text style={styles.age}>{age}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#1B1B18',
  },
  pressed: { opacity: 0.85 },
  img: { width: '100%', height: '100%' },
  fallback: { backgroundColor: '#22221E' },
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  playBadge: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: icon.s26,
    height: icon.s26,
    borderRadius: icon.s26 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(17,17,15,0.5)',
  },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.sm,
    backgroundColor: 'rgba(17,17,15,0.71)', // census-media §31: the least alpha at which the age line (onInkMute) clears 4.5:1 over a white photo; was 0.55
  },
  perspective: { color: color.onInk, fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  age: { color: color.onInkMute, fontSize: 11, fontWeight: '600', marginTop: 1 },
});

// ── census-media §31.12 — appended at the TAIL so no line cited above moves ────
// The evidence-class edge is a 3 px bar in the observation colour, and it is the
// tile's only mark of the class. Drawn straight on the photo it had no floor:
// 1.00:1 over a photo of its own colour. It now sits on a 5 px ink casing, so a
// 2 px ink strip always separates it from the photo. 0.80 is the least alpha at
// which all five classes clear 3:1 over any photo (`generated` is the tightest).
const tailStyles = StyleSheet.create({
  edgeCasing: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, backgroundColor: 'rgba(17,17,15,0.80)' },
});
