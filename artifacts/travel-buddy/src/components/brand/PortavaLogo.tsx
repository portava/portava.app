/**
 * Portava brand components — corrected P mark (v2).
 *
 * The warm P is now rendered as a proper "hollow" ring so the cyan
 * behind it shows through where the paper-plane sits, matching the
 * reference artwork. The cool descender is widened to match the
 * reference weight.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, G } from 'react-native-svg';

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

// Warm gradient (outer P ring): coral-red top-left -> orange bottom-right.
const WARM_STOPS = [
  { offset: '0%', color: '#FF4D57' },
  { offset: '100%', color: '#FFA51F' },
];

// Cool gradient (descender, paper-plane, wordmark A): teal -> deep cyan.
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
          id="pmark-cool-descender"
          x1="240"
          y1="300"
          x2="360"
          y2="880"
          gradientUnits="userSpaceOnUse"
        >
          {COOL_STOPS.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
          ))}
        </LinearGradient>
        <LinearGradient
          id="pmark-cool-plane"
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
        Cool descender (drawn FIRST so it sits behind the warm ring at
        the joint on the left).
        Substantially widened from v1: now roughly the same weight as
        the warm ring, ending in an angled point at the bottom-left.
      */}
      <Path
        d="M 230 340 H 400 V 780 L 230 900 Z"
        fill="url(#pmark-cool-descender)"
      />

      {/*
        Warm outer P as a hollow ring — outer bowl silhouette with a
        paper-plane-shaped hole in the middle. Uses fillRule evenodd so
        the inner subpath (the plane) is punched out and the cool layer
        underneath shows through.

        Subpath 1: outer P bowl silhouette (same shape as v1 outer).
        Subpath 2: the paper-plane cutout, listed clockwise so evenodd
        subtracts it.
      */}
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="
          M 250 230
          H 610
          C 758 230 840 314 840 450
          C 840 600 737 684 595 684
          H 520
          L 430 770
          V 585
          H 600
          C 675 585 722 538 722 458
          C 722 380 670 333 595 333
          H 250
          Z
          M 500 460
          L 670 388
          L 612 620
          L 560 528
          Z
        "
        fill="url(#pmark-warm)"
      />

      {/*
        Cool paper-plane sits in the same location as the cutout — this
        gives the plane a slightly darker/more saturated cyan than the
        descender behind it, matching the reference where the plane
        looks like its own object rather than just a hole.
      */}
      <Path
        d="M 500 460 L 670 388 L 612 620 L 560 528 Z"
        fill="url(#pmark-cool-plane)"
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
