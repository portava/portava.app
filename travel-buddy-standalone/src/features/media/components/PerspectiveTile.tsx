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
        <CachedImage source={{ uri: media.thumbnailUrl }} style={styles.img} resizeMode="cover" />
      ) : (
        <View style={[styles.img, styles.fallback]} />
      )}

      {/* accent edge marks the evidence class (observed vs inferred vs …) */}
      <View style={[styles.edge, { backgroundColor: accent }]} />

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
    backgroundColor: 'rgba(17,17,15,0.55)',
  },
  perspective: { color: color.onInk, fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  age: { color: color.onInkMute, fontSize: 11, fontWeight: '600', marginTop: 1 },
});
