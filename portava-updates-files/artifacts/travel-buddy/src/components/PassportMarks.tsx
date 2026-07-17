import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Defs, Pattern, Rect, Circle, G, Line } from 'react-native-svg';
import { Navigation } from 'lucide-react-native';
import { color, radius, type as t } from '../theme/tokens';

/**
 * Passport authenticity primitives. All subtle/low-opacity by design — these are
 * security-print details, not decoration. Used ONLY inside the Passport hero.
 *
 * - PassportMonogramWatermark : large faint Portava "P" behind the photo (4–10%)
 * - PassportInkStamp          : rotated nav-arrow + PORTAVA entry stamp
 * - PassportHeroBackdrop      : guilloche + faint bg stamps + paper grain
 */

/** Large subtle Portava P monogram, sits behind the photo. opacity 4–10%. */
export function PassportMonogramWatermark({ size = 200 }: { size?: number }) {
  return (
    <View pointerEvents="none" style={[wm.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox="0 0 200 200">
        {/* guilloche rosette rings */}
        {[78, 66, 54, 42].map((r) => (
          <Circle key={r} cx="100" cy="100" r={r} stroke={color.deep} strokeWidth="0.6" fill="none" opacity={0.07} />
        ))}
        {/* Portava P monogram */}
        <G opacity={0.08}>
          <Path d="M86 74 V130 M86 74 H106 Q134 74 134 96 Q134 118 106 118 H86"
            stroke={color.deep} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* nav arrow in the counter */}
          <Path d="M104 103 L112 88 L117 101 Z" fill={color.deep} stroke="none" />
        </G>
      </Svg>
    </View>
  );
}

/** Rotated entry-stamp: nav-arrow + PORTAVA, muted ink. Top-right of hero. */
export function PassportInkStamp({ rotate = -8 }: { rotate?: number }) {
  return (
    <View pointerEvents="none" style={[ink.wrap, { transform: [{ rotate: `${rotate}deg` }] }]}>
      <View style={ink.ring}>
        <Navigation size={14} color={color.deep} />
        <Text style={ink.top}>PORTAVA</Text>
        <View style={ink.divider} />
        <Text style={ink.bottom}>★ VERIFIED ★</Text>
      </View>
    </View>
  );
}

/** Hero backdrop: guilloche security lines + 1-2 faint bg stamps + paper grain. */
export function PassportHeroBackdrop() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 360 420">
      <Defs>
        <Pattern id="hg" width="22" height="22" patternUnits="userSpaceOnUse">
          <Path d="M0,11 Q5.5,2 11,11 T22,11" stroke={color.deep} strokeWidth="0.4" fill="none" opacity="0.06" />
          <Path d="M0,11 Q5.5,20 11,11 T22,11" stroke={color.deep} strokeWidth="0.4" fill="none" opacity="0.06" />
        </Pattern>
        <Pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse">
          <Circle cx="0.5" cy="0.5" r="0.3" fill={color.ink} opacity="0.025" />
        </Pattern>
      </Defs>
      <Rect x="0" y="0" width="360" height="420" fill="url(#hg)" />
      <Rect x="0" y="0" width="360" height="420" fill="url(#grain)" />
      {/* faint background PORTAVA stamp marks (3-7%) */}
      <G opacity="0.05">
        <Circle cx="300" cy="300" r="42" stroke={color.deep} strokeWidth="1.5" fill="none" />
        <Circle cx="300" cy="300" r="33" stroke={color.deep} strokeWidth="0.6" fill="none" />
      </G>
      <G opacity="0.04">
        <Circle cx="50" cy="360" r="30" stroke={color.signal} strokeWidth="1.5" fill="none" />
      </G>
    </Svg>
  );
}

const wm = StyleSheet.create({
  wrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});

const ink = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: 78, height: 78, borderRadius: 39, borderWidth: 1.5, borderColor: color.deep,
    alignItems: 'center', justifyContent: 'center', gap: 2, opacity: 0.45,
    borderStyle: 'solid',
  },
  top: { fontFamily: 'Courier', fontSize: 7, fontWeight: '700', color: color.deep, letterSpacing: 0.5, textAlign: 'center' },
  divider: { width: 44, height: 0.6, backgroundColor: color.deep, opacity: 0.5 },
  bottom: { fontFamily: 'Courier', fontSize: 6.5, fontWeight: '700', color: color.deep, letterSpacing: 1 },
});
