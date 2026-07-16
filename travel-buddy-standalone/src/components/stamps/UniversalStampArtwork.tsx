/**
 * UniversalStampArtwork
 *
 * Renders AI-generated catalog artwork when available, or falls back to the
 * existing StampArtwork design-system visual (shape + colors + icon).
 *
 * Props:
 *   activeArtworkUrl — public URL from universal_stamp_catalog (null = pending)
 *   stamp            — legacy PassportStamp for fallback artwork
 *   size             — width/height in px
 *   rotate           — tilt in degrees (passed to fallback)
 */
import React, { useState } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { StampArtwork } from '../StampArtwork.tsx';
import type { PassportStamp } from '../../types/models.ts';

interface Props {
  activeArtworkUrl?: string | null;
  stamp: PassportStamp;
  size?: number;
  rotate?: number;
  showPendingLabel?: boolean;
}

export function UniversalStampArtwork({
  activeArtworkUrl,
  stamp,
  size = 88,
  rotate = 0,
  showPendingLabel = true,
}: Props) {
  const [imgError, setImgError] = useState(false);
  const hasArtwork = activeArtworkUrl && !activeArtworkUrl.startsWith('data:') && !imgError;

  if (hasArtwork) {
    return (
      <View style={{ width: size, height: size }}>
        <Image
          source={{ uri: activeArtworkUrl! }}
          style={{ width: size, height: size, borderRadius: size * 0.12 }}
          resizeMode="contain"
          onError={() => setImgError(true)}
        />
      </View>
    );
  }

  // Fallback: existing artwork system
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
