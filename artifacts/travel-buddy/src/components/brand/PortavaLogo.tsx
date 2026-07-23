/**
 * Portava brand components — corrected P mark.
 *
 * This file replaces the previous PortavaLogoMark with a version that
 * matches the target artwork (warm outer P with a small chat-bubble
 * tail at the bottom-right of the bowl, cool left descender stroke, and
 * a cool paper-plane inside the bowl).
 *
 * Same exports as before — PortavaLogoMark and PortavaWordmark — with
 * the same size prop, so any consumer of this file keeps working.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop } from 'react-native-svg';

type Size = 'sm' | 'md' | 'lg' | 'xl';

const MARK_SIZES: Record<Size, number> = {
  sm: 32,
  md: 56,
  lg: 96,
  xl: 132,
};

const WORDMARK_HEIGHTS: Record<Size, number> = {
  sm: 16,
  md: 24,
  lg: 36,
  xl: 48,
};

const WORDMARK_LETTER_SPACING: Record<Size, number> = {
  sm: 3,
  md: 5,
  lg: 8,
  xl: 12,
};

// Warm gradient (outer P): coral-red top-left -> orange bottom-right.
const WARM_STOPS = [
  { offset: '0%', color: '#FF4D57' },
  { offset: '100%', color: '#FFA51F' },
];

// Cool gradient (descender + paper-plane): bright teal -> deeper cyan.
const COOL_STOPS = [
  { offset: '0%', color: '#20E3D7' },
  { offset: '100%', color: '#0897B7' },
];

export function PortavaLogoMark({ size = 'md' }: { size?: Size }) {
  const px = MARK_SIZES[size];

  return (
    <Svg width={px} height={px} viewBox="0 0 1024 1024" fill="none">
      <Defs>
        <LinearGradient
          id="pmark-warm"
          x1="300"
          y1="180"
          x2="820"
          y2="760"
          gradientUnits="userSpaceOnUse"
        >
          {WARM_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </LinearGradient>

        <LinearGradient
          id="pmark-cool"
          x1="340"
          y1="300"
          x2="420"
          y2="860"
          gradientUnits="userSpaceOnUse"
        >
          {COOL_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </LinearGradient>

        <LinearGradient
          id="pmark-arrow"
          x1="485"
          y1="390"
          x2="665"
          y2="610"
          gradientUnits="userSpaceOnUse"
        >
          {COOL_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </LinearGradient>
      </Defs>

      {/*
        Warm outer P. Bowl at the top opens right, sweeps around, closes
        back down with a small red curl at the bottom-right corner of the
        bowl that reads as a chat-bubble tail.
      */}
      <Path
        d="M 250 230 H 610 C 758 230 840 314 840 450 C 840 600 737 684 595 684 H 520 L 430 770 V 585 H 600 C 675 585 722 538 722 458 C 722 380 670 333 595 333 H 250 Z"
        fill="url(#pmark-warm)"
      />

      {/*
        Cool descender: the left vertical stroke of the P, ending in a
        soft angled point at the bottom-left.
      */}
      <Path
        d="M 245 360 H 355 V 765 L 245 875 Z"
        fill="url(#pmark-cool)"
      />

      {/*
        Paper-plane arrow inside the bowl. Points upper-right, suggesting
        motion and travel. Same cool gradient as the descender so they
        read as one continuous cool form.
      */}
      <Path
        d="M 480 468 L 650 392 L 600 610 L 552 520 Z"
        fill="url(#pmark-arrow)"
      />
    </Svg>
  );
}

export function PortavaWordmark({
  size = 'md',
  variant = 'light',
}: {
  size?: Size;
  /** 'light' (default) renders white letters; 'dark' renders near-black for light backgrounds. */
  variant?: 'light' | 'dark';
}) {
  const height = WORDMARK_HEIGHTS[size];
  const letterSpacing = WORDMARK_LETTER_SPACING[size];
  const finalASize = height * 1.05;
  const textColor = variant === 'dark' ? '#11110F' : '#FFFFFF';

  return (
    <View style={styles.wordmarkRow}>
      <Text
        style={[styles.wordmarkText, { fontSize: height, letterSpacing, color: textColor }]}
        accessibilityLabel="Portava"
      >
        PORTAV
      </Text>
      <Svg
        width={finalASize * 0.72}
        height={finalASize}
        viewBox="0 0 100 140"
        fill="none"
        style={{ marginLeft: letterSpacing }}
      >
        <Defs>
          <LinearGradient id="wm-a" x1="0" y1="0" x2="1" y2="1">
            {COOL_STOPS.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>
        <Path
          d="M 4 138 L 42 4 L 58 4 L 96 138 L 76 138 L 66 106 L 34 106 L 24 138 Z M 40 88 L 60 88 L 50 50 Z"
          fill="url(#wm-a)"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wordmarkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  wordmarkText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: undefined,
    includeFontPadding: false as unknown as boolean,
  },
});
