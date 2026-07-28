/**
 * VideoBlurBackdrop — blurred poster fill for letterboxed video.
 *
 * Renders a scaled, blurred copy of a poster behind a CONTAIN-mode video so
 * the letterbox bars look immersive (TikTok-style) instead of black.
 *
 * Native: React Native Image.blurRadius (no extra dep; iOS ≥28 radius, Android capped ~10).
 * Web:    Inline CSS via a raw <img> element — blurRadius is ignored on web.
 */
import React from 'react';
import { StyleSheet, Image, View, Platform } from 'react-native';

interface Props {
  /** Poster / thumbnail URL. Renders opaque black when absent. */
  uri: string | null | undefined;
}

export function VideoBlurBackdrop({ uri }: Props) {
  if (!uri) {
    return <View style={styles.fallback} />;
  }

  if (Platform.OS === 'web') {
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' } as React.CSSProperties}>
        <img
          src={uri}
          style={{
            // Scale past the container so blurred edges don't leave gaps.
            width: '116%',
            height: '116%',
            position: 'absolute',
            top: '-8%',
            left: '-8%',
            objectFit: 'cover',
            filter: 'blur(22px) brightness(0.45)',
          } as React.CSSProperties}
          alt=""
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      {/*
        Scale up 8 % so the blurRadius edge-fade (iOS) doesn't leave transparent
        slivers at the border.
      */}
      <Image
        source={{ uri }}
        style={styles.backdropImage}
        resizeMode="cover"
        blurRadius={Platform.OS === 'ios' ? 28 : 10}
      />
      {/* Dim so the backdrop doesn't compete with the main video content. */}
      <View style={styles.dimOverlay} />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  backdropImage: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.08 }],
  },
  dimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
});
