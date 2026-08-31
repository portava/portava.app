/**
 * FreshnessBadge — the §7 freshness pill.
 *
 * One of the four truth axes, rendered on its own so it cannot be collapsed
 * into "Busy" (§7: "The UI must distinguish observation, confidence, trend and
 * freshness rather than collapsing them into one label").
 *
 * THE PULSE IS EARNED, NOT DECORATIVE
 * ===================================
 * Only an object that passes `shouldPulse` — fresh AND confidently observed AND
 * not a forecast AND not expired — animates. §37 forbids stale claims that
 * still look live, and §4 says "Map motion and pulse are meaningful, not
 * decorative", so the animation is a claim in its own right and is gated like
 * one. Everything else is a static pill.
 *
 * `historical` and `unknown` get a deliberately DIFFERENT shape, not a dimmer
 * version of the live pill: no status dot, a dashed outline, and a glyph
 * (hourglass / question mark). A user glancing at the map must be able to tell
 * "this is old" and "we don't know" from "this is now" without reading the
 * text.
 *
 * Dark-mode first (§4): the pill is a translucent near-black chip designed to
 * sit over the map canvas, not over a paper card.
 */
import React, { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { CircleQuestionMark, Hourglass } from 'lucide-react-native';
import { color, dot, radius, typography } from '../../theme/tokens.ts';
import { freshnessLabel, shouldPulse } from '../../features/map/truth/liveTruth.ts';
import type { FreshnessState, MapObject } from '../../types/mapObjects.ts';

/**
 * Per-band colour. `live` is the one place the reserved vermilion signal is
 * spent (tokens.ts: "vermilion — primary action + live pulse only"); the rest
 * step down through green -> amber -> grey so the ladder reads without text.
 */
export const FRESHNESS_COLORS: Record<FreshnessState, string> = {
  live: color.signal,
  recent: '#4ECDA4',
  aging: '#D9A441',
  stale: '#9C988F',
  historical: '#7A7770',
  unknown: '#7A7770',
};

/** Dark-first chrome for map-canvas overlays. */
const SURFACE = 'rgba(17,17,15,0.74)';
const SURFACE_HOLLOW = 'rgba(17,17,15,0.46)';
const HAIRLINE = 'rgba(250,249,246,0.16)';

const PULSE_MS = 1200;

/** The two bands that are neither current nor a dated observation. */
const UNKNOWABLE: readonly FreshnessState[] = ['historical', 'unknown'];

export interface FreshnessBadgeProps {
  /**
   * The projected object. Read for its freshness band, observation time and —
   * because pulsing is gated on certainty too — its confidence, kind and
   * expiry.
   */
  object: Pick<MapObject, 'kind' | 'freshness' | 'confidence' | 'observedAt' | 'expiresAt'>;
  /** Injectable clock so the relative label is testable. Defaults to now. */
  now?: Date | number;
  /** Tighter padding for use inside a marker callout or a dense card row. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function FreshnessBadge({ object, now, compact = false, style }: FreshnessBadgeProps) {
  const band: FreshnessState = object.freshness ?? 'unknown';
  const label = freshnessLabel(object.freshness, object.observedAt, now);
  const tint = FRESHNESS_COLORS[band];
  const unknowable = UNKNOWABLE.includes(band);
  const pulses = shouldPulse(object, now);

  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (mounted) setReduceMotion(enabled); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    return () => { mounted = false; sub?.remove?.(); };
  }, []);

  const pulse = useSharedValue(0);
  const animating = pulses && !reduceMotion;

  useEffect(() => {
    if (!animating) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [animating, pulse]);

  // A halo that grows out of the dot and fades — the §6 "pulsing outline"
  // vocabulary, scaled down to badge size.
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 1.9 }],
  }));

  return (
    <View
      style={[
        s.pill,
        compact && s.pillCompact,
        unknowable ? s.pillUnknowable : { borderColor: withAlpha(tint) },
        style,
      ]}
      accessibilityRole="text"
      accessibilityLabel={`Freshness: ${label}`}
    >
      {unknowable ? (
        band === 'historical' ? (
          <Hourglass size={dot.s12} color={tint} />
        ) : (
          <CircleQuestionMark size={dot.s12} color={tint} />
        )
      ) : (
        <View style={s.dotWrap}>
          {animating && (
            <Animated.View
              style={[s.halo, { backgroundColor: tint }, haloStyle]}
              pointerEvents="none"
            />
          )}
          <View style={[s.dot, { backgroundColor: tint }]} />
        </View>
      )}

      <Text
        style={[
          s.label,
          compact && s.labelCompact,
          { color: unknowable ? color.onInkMute : color.onInk },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

/** A low-opacity version of a band colour, for the pill outline. */
function withAlpha(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return HAIRLINE;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return HAIRLINE;
  return `rgba(${r},${g},${b},0.45)`;
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: HAIRLINE,
    backgroundColor: SURFACE,
  },
  pillCompact: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 4,
  },
  // Historical / unknown: hollow and dashed, so it never reads as a live chip.
  pillUnknowable: {
    backgroundColor: SURFACE_HOLLOW,
    borderStyle: 'dashed',
  },
  dotWrap: {
    width: dot.s8,
    height: dot.s8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
  },
  halo: {
    position: 'absolute',
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
  },
  label: {
    ...typography.metadata,
    color: color.onInk,
  },
  labelCompact: {
    fontSize: 10,
    lineHeight: 13,
  },
});
