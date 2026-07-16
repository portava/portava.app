/**
 * StampOverlayBadge — renders a placed passport stamp on top of a postcard
 * photo. Used by the composer editor and every read surface (Pulse feed,
 * passport wall, post detail).
 *
 * Render styles:
 *  - 'white' / 'dark'  — procedural ink monogram (rasters can't be tinted)
 *  - 'watermark'       — white ink at translucent opacity
 *  - 'original'        — the pinned artwork raster in a circular mask, with a
 *                        procedural fallback if the image fails to load
 *
 * The badge is pointer-transparent by default so feed taps pass through.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import {
  overlayLayout,
  monogramFor,
  parseStampOverlay,
  type StampOverlayData,
  type StampOverlayStyle,
} from '../lib/stampOverlay.ts';
import { color, font } from '../theme/tokens.ts';

const INK_WHITE = '#FFFFFF';

function inkColorFor(style: StampOverlayStyle): string {
  return style === 'dark' ? color.ink : INK_WHITE;
}

interface Props {
  overlay: StampOverlayData;
  containerWidth: number;
  containerHeight: number;
  /** 'auto' only in the composer editor (drag target); feeds keep 'none'. */
  pointerEvents?: 'none' | 'auto';
}

export function StampOverlayBadge({
  overlay,
  containerWidth,
  containerHeight,
  pointerEvents = 'none',
}: Props) {
  const [rasterFailed, setRasterFailed] = useState(false);

  if (containerWidth <= 0 || containerHeight <= 0) return null;

  const { size, left, top, opacity } = overlayLayout(containerWidth, containerHeight, overlay);
  const rotate = `${overlay.rotation || 0}deg`;
  const useRaster = overlay.style === 'original' && !rasterFailed;

  return (
    <View
      pointerEvents={pointerEvents}
      style={[
        s.wrap,
        {
          width: size,
          height: size,
          left,
          top,
          opacity,
          transform: [{ rotate }],
        },
      ]}
    >
      {useRaster ? (
        <Image
          source={{ uri: overlay.artworkUrl }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
          onError={() => setRasterFailed(true)}
        />
      ) : (
        <ProceduralStamp
          size={size}
          label={overlay.label}
          ink={inkColorFor(overlay.style === 'original' ? 'white' : overlay.style)}
        />
      )}
    </View>
  );
}

/** Ink-only circular stamp: double ring + airport-code monogram + label. */
export function ProceduralStamp({
  size,
  label,
  ink,
}: {
  size: number;
  label: string;
  ink: string;
}) {
  const borderW = Math.max(1.5, size * 0.025);
  const innerInset = Math.max(3, size * 0.07);
  const showLabel = size >= 72;
  const mono = monogramFor(label);

  return (
    <View
      style={[
        s.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: borderW,
          borderColor: ink,
        },
      ]}
    >
      <View
        style={[
          s.innerRing,
          {
            top: innerInset,
            left: innerInset,
            right: innerInset,
            bottom: innerInset,
            borderRadius: size / 2,
            borderColor: ink,
          },
        ]}
      />
      <Text
        allowFontScaling={false}
        style={[
          s.mono,
          {
            color: ink,
            fontSize: Math.max(10, size * (mono.length > 2 ? 0.24 : 0.3)),
            lineHeight: Math.max(12, size * 0.34),
          },
        ]}
      >
        {mono}
      </Text>
      {showLabel && (
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[
            s.label,
            {
              color: ink,
              fontSize: Math.max(7, size * 0.085),
              maxWidth: size * 0.72,
            },
          ]}
        >
          {label.toUpperCase()}
        </Text>
      )}
    </View>
  );
}

/**
 * Self-measuring overlay for read surfaces (feed cards, tiles, post detail):
 * pass the raw stamp_overlay jsonb; it validates via parseStampOverlay,
 * measures the media frame it fills, and renders the badge. Renders nothing
 * — and costs nothing — when there is no valid overlay.
 */
export function MediaStampOverlay({ raw }: { raw: unknown }) {
  const overlay = useMemo(() => parseStampOverlay(raw), [raw]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (!overlay) return null;
  return (
    <View
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
      pointerEvents="none"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) =>
          prev && prev.w === width && prev.h === height ? prev : { w: width, h: height },
        );
      }}
    >
      {size ? (
        <StampOverlayBadge overlay={overlay} containerWidth={size.w} containerHeight={size.h} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  innerRing: {
    position: 'absolute',
    borderWidth: 1,
  },
  mono: {
    fontFamily: font.stamp,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
  },
  label: {
    fontFamily: font.stamp,
    fontWeight: '700',
    fontSize: 8,
    letterSpacing: 0.8,
    textAlign: 'center',
    marginTop: 1,
  },
});
