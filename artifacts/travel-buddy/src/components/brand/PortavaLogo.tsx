/**
 * PortavaLogo.tsx
 *
 * Brand mark components for the Portava "P" identity.
 *
 * PortavaLogoMark  — stylised "P" in warm-to-cool gradient, scales via `size` prop.
 * PortavaWordmark  — "PORTAVA" typeset with the final "A" in teal accent.
 *
 * Both render as inline SVG / styled Text so they scale cleanly without raster
 * artefacts and work in both dark and light contexts.
 *
 * Design intent:
 *   Outer P shape  — warm gradient: deep orange → orange-red → red-orange
 *                    (#FF7A3D → #FF4D3D → #E63946)
 *   Inner element  — teal/cyan: forward-pointing teardrop in the P's bowl
 *                    (#26C6DA → #00ACC1), representing travel / forward motion
 */

import React from 'react';
import { Text, View } from 'react-native';
import Svg, {
  Path,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
} from 'react-native-svg';

// ─── Size tokens ──────────────────────────────────────────────────────────────

export type LogoSize = 'sm' | 'md' | 'lg' | 'xl';

/** Width of the mark in logical pixels. Height is proportionally taller (100/70). */
const MARK_WIDTHS: Record<LogoSize, number> = {
  sm: 28,
  md: 42,
  lg: 72,
  xl: 100,
};

const WORD_FONT_SIZES: Record<LogoSize, number> = {
  sm: 13,
  md: 20,
  lg: 30,
  xl: 44,
};

const WORD_LETTER_SPACINGS: Record<LogoSize, number> = {
  sm: 3,
  md: 5,
  lg: 8,
  xl: 12,
};

// ─── SVG geometry constants ───────────────────────────────────────────────────

const VB_W = 70;
const VB_H = 100;

/**
 * Outer P body path (viewBox 0 0 70 100).
 *
 * Traces the full P silhouette clockwise:
 *  - stem left edge up from bottom-left
 *  - across the top
 *  - arc clockwise around the bowl (center: 24,31 radius: 25 → rightmost: 49,31)
 *  - down the right side of the stem
 *  - back across the bottom
 *  - Z closes up the left edge
 */
const OUTER_P = 'M 5 6 L 24 6 A 25 25 0 0 1 24 56 L 24 94 L 5 94 Z';

/**
 * Inner teal teardrop (P counter + paper-plane / arrow motif).
 *
 * A rightward-pointing teardrop inside the bowl:
 *  - flat left edge at x≈28 (inside the stem)
 *  - top quadratic arc curving to the pointed tip at (48, 31)
 *  - bottom quadratic arc returning to the flat left edge
 * The pointed tip sits just inside the bowl's rightmost bound (49 px from center).
 */
const INNER_ARROW = 'M 28 16 Q 46 15 48 31 Q 46 47 28 46 Z';

// ─── PortavaLogoMark ──────────────────────────────────────────────────────────

interface MarkProps {
  size?: LogoSize;
  /** Override width in px — height scales proportionally. */
  width?: number;
}

export function PortavaLogoMark({ size = 'md', width }: MarkProps) {
  const w = width ?? MARK_WIDTHS[size];
  const h = (w / VB_W) * VB_H;

  return (
    <Svg
      width={w}
      height={h}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      accessibilityLabel="Portava logo mark"
    >
      <Defs>
        {/* Warm gradient: deep orange → orange-red → crimson */}
        <SvgLinearGradient id="pmWarm" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor="#FF7A3D" />
          <Stop offset="0.5" stopColor="#FF4D3D" />
          <Stop offset="1" stopColor="#E63946" />
        </SvgLinearGradient>
        {/* Teal gradient: cyan → darker cyan */}
        <SvgLinearGradient id="pmTeal" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#26C6DA" />
          <Stop offset="1" stopColor="#00ACC1" />
        </SvgLinearGradient>
      </Defs>

      {/* Outer P body — warm gradient */}
      <Path d={OUTER_P} fill="url(#pmWarm)" />

      {/* Inner teardrop — teal "counter + arrow" */}
      <Path d={INNER_ARROW} fill="url(#pmTeal)" />
    </Svg>
  );
}

// ─── PortavaWordmark ──────────────────────────────────────────────────────────

interface WordmarkProps {
  size?: LogoSize;
  /** Light variant renders letters in near-black for use on light backgrounds. */
  variant?: 'light' | 'dark';
}

export function PortavaWordmark({ size = 'md', variant = 'light' }: WordmarkProps) {
  const fontSize    = WORD_FONT_SIZES[size];
  const letterSpacing = WORD_LETTER_SPACINGS[size];
  const mainColor   = variant === 'dark' ? '#11110F' : '#FFFFFF';

  const base = {
    fontSize,
    letterSpacing,
    fontWeight: '800' as const,
    includeFontPadding: false,
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      {/* PORTAV in white / near-black */}
      <Text style={[base, { color: mainColor }]}>PORTAV</Text>
      {/* Final A in teal — the same cyan used in the mark's inner element */}
      <Text style={[base, { color: '#26C6DA' }]}>A</Text>
    </View>
  );
}
