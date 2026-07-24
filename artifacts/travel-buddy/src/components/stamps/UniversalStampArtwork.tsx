/**
 * UniversalStampArtwork
 *
 * Renders AI-generated catalog artwork when available, or falls back to the
 * existing StampArtwork design-system visual (shape + colors + icon).
 *
 * Props:
 *   activeArtworkUrl — full ~1024px composited stamp URL (null = not yet ready)
 *   thumbnailUrl     — 256px thumbnail URL for small render sizes (optional)
 *   stamp            — legacy PassportStamp for fallback artwork / accessibility
 *   size             — width/height in px (default 88)
 *   rotate           — tilt in degrees (passed to fallback)
 *   showPendingLabel — show "artwork being prepared" hint (default true)
 *
 * URL selection by size:
 *   size < 120  → prefer thumbnailUrl, fall back to activeArtworkUrl
 *   size >= 120 → prefer activeArtworkUrl, fall back to thumbnailUrl
 *
 * Fallback chain: preferred URL → alternate URL → procedural StampArtwork
 * Never renders blank for a stamp that has procedural artwork.
 *
 * Composited art uses contentFit="contain" — it has its own transparent
 * frame and must never be cropped.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { StampArtwork } from '../StampArtwork.tsx';
import { resolveArtwork } from '../../lib/stampArtworkResolver.ts';
import type { PassportStamp } from '../../types/models.ts';

interface Props {
  activeArtworkUrl?: string | null;
  thumbnailUrl?: string | null;
  stamp: PassportStamp;
  size?: number;
  rotate?: number;
  showPendingLabel?: boolean;
}

function isValidUrl(u: string | null | undefined): u is string {
  return Boolean(u && !u.startsWith('data:'));
}

export function UniversalStampArtwork({
  activeArtworkUrl,
  thumbnailUrl,
  stamp,
  size = 88,
  rotate = 0,
  showPendingLabel = true,
}: Props) {
  // Build the ordered list of URLs to try based on render size.
  const useThumbnailFirst = size < 120;
  const orderedUrls: string[] = useThumbnailFirst
    ? [thumbnailUrl, activeArtworkUrl].filter(isValidUrl)
    : [activeArtworkUrl, thumbnailUrl].filter(isValidUrl);

  // Remove duplicates (thumbnailUrl === activeArtworkUrl corner case)
  const uniqueUrls = [...new Set(orderedUrls)];

  // failCount tracks how many URLs have been tried and failed.
  const [failCount, setFailCount] = useState(0);

  // Reset fail count whenever the underlying URLs change.
  useEffect(() => { setFailCount(0); }, [activeArtworkUrl, thumbnailUrl]);

  const urlToRender = uniqueUrls[failCount] ?? null;
  const hasArtwork = urlToRender !== null;

  // Build accessibility label from resolved artwork descriptor.
  const art = resolveArtwork(stamp);
  const artLabel = `${stamp.label ?? art.categoryLabel} — ${art.rarity} stamp${stamp.locked ? ', locked' : ''}`;

  if (hasArtwork) {
    return (
      <View style={{ width: size, height: size }}>
        <Image
          source={{ uri: urlToRender! }}
          style={{ width: size, height: size, borderRadius: size * 0.12 }}
          contentFit="contain"
          cachePolicy="memory-disk"
          onError={() => setFailCount((c) => c + 1)}
          accessibilityLabel={artLabel}
          accessibilityIgnoresInvertColors
        />
      </View>
    );
  }

  // Procedural fallback — always renders something.
  return (
    <View style={{ alignItems: 'center' }}>
      <StampArtwork stamp={stamp} size={size} rotate={rotate} />
      {showPendingLabel && !stamp.locked && (
        <Text style={[styles.pendingLabel, { fontSize: Math.max(8, Math.round(size * 0.1)) }]}>
          ✦ artwork being prepared
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pendingLabel: {
    color: '#9CA3AF',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 2,
  },
});
