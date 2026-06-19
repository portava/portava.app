import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Rect, Circle, Line, G } from 'react-native-svg';
import { color } from '../theme/tokens';

/**
 * Level-2 illustrated city stamps. Each city = a landmark silhouette (SVG paths)
 * inside an arched passport-stamp frame. Title/country use real RN Text layered
 * over the SVG (SVG fonts render unreliably across platforms). Palette = tokens.
 *
 * Add a city: entry in CITY_ART + a case in <Landmark/>. Unknown slug -> generic
 * skyline, so nothing crashes.
 */
type CityArt = { city: string; country: string; tint: string };

export const CITY_ART: Record<string, CityArt> = {
  cebu: { city: 'CEBU', country: 'PHILIPPINES', tint: '#0A3D4A' },
  manila: { city: 'MANILA', country: 'PHILIPPINES', tint: '#C0392B' },
  bangkok: { city: 'BANGKOK', country: 'THAILAND', tint: '#5B3A9E' },
  bali: { city: 'BALI', country: 'INDONESIA', tint: '#2E7D5B' },
  tokyo: { city: 'TOKYO', country: 'JAPAN', tint: '#C0392B' },
};

function Landmark({ slug, tint }: { slug: string; tint: string }) {
  const s = { stroke: tint, strokeWidth: 1.8, fill: 'none', strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  switch (slug) {
    case 'cebu':
      return (
        <G {...s}>
          <Line x1="18" y1="40" x2="82" y2="40" />
          <Path d="M32 40 L32 8 M68 40 L68 8" />
          <Path d="M32 8 L16 40 M32 8 L48 40 M68 8 L52 40 M68 8 L84 40" />
          <Path d="M14 46 q9 -5 18 0 t18 0 t18 0 t18 0" />
        </G>
      );
    case 'manila':
      return (
        <G {...s}>
          <Rect x="16" y="20" width="14" height="24" />
          <Rect x="34" y="12" width="10" height="32" />
          <Path d="M39 12 L39 4 M36 7 L42 7" />
          <Rect x="50" y="24" width="16" height="20" />
          <Path d="M50 24 L58 14 L66 24" />
          <Rect x="70" y="28" width="12" height="16" />
        </G>
      );
    case 'bangkok':
      return (
        <G {...s}>
          <Path d="M50 4 L50 0" />
          <Path d="M44 14 L50 4 L56 14 Z" />
          <Path d="M40 26 L50 12 L60 26 Z" />
          <Path d="M32 42 L50 22 L68 42 Z" />
          <Rect x="40" y="42" width="20" height="6" />
        </G>
      );
    case 'bali':
      return (
        <G {...s}>
          <Path d="M44 16 L56 16 L52 10 L48 10 Z" />
          <Path d="M42 26 L58 26 L55 18 L45 18 Z" />
          <Path d="M40 36 L60 36 L57 28 L43 28 Z" />
          <Rect x="47" y="36" width="6" height="10" />
          <Path d="M22 46 q3 -22 8 -26 M30 22 q-9 -3 -13 2 M30 22 q9 -3 13 2" />
        </G>
      );
    case 'tokyo':
      return (
        <G {...s}>
          <Path d="M26 16 L52 16 M28 11 L50 11" />
          <Path d="M31 11 L31 44 M47 11 L47 44" />
          <Path d="M68 44 L68 18 L64 44 M68 18 L72 44 M68 18 L68 12" />
          <Line x1="64" y1="32" x2="72" y2="32" />
        </G>
      );
    default:
      return (
        <G {...s}>
          <Rect x="22" y="24" width="12" height="20" />
          <Rect x="40" y="14" width="12" height="30" />
          <Rect x="58" y="28" width="12" height="16" />
        </G>
      );
  }
}

function ExperienceGlyph({ tint }: { tint: string }) {
  return (
    <G stroke={tint} strokeWidth="1.6" fill="none">
      <Circle cx="50" cy="24" r="16" />
      <Line x1="34" y1="24" x2="66" y2="24" />
      <Line x1="50" y1="8" x2="50" y2="40" />
      <Path d="M37 13 Q50 22 63 13 M37 35 Q50 26 63 35" />
      <Line x1="50" y1="8" x2="50" y2="2" />
    </G>
  );
}

export function IllustratedStamp({
  slug,
  size = 110,
  experienceLabel,
  locked,
}: {
  slug: string;
  size?: number;
  experienceLabel?: { title: string; sub: string; tint: string };
  locked?: boolean;
}) {
  const art = CITY_ART[slug];
  const tint = locked ? color.faint : experienceLabel?.tint ?? art?.tint ?? color.deep;
  const title = experienceLabel?.title ?? art?.city ?? slug.toUpperCase();
  const sub = experienceLabel?.sub ?? art?.country ?? '';
  const w = size;
  const h = Math.round(size * 1.3);

  return (
    <View style={{ width: w, height: h }}>
      <Svg width={w} height={h} viewBox="0 0 100 130">
        {/* arched passport frame */}
        <Path
          d="M14 34 Q14 12 50 12 Q86 12 86 34 L86 116 Q86 122 80 122 L20 122 Q14 122 14 116 Z"
          stroke={tint} strokeWidth="2.2"
          fill={locked ? '#F0EEE9' : color.paper}
        />
        <Path
          d="M18 34 Q18 16 50 16 Q82 16 82 34 L82 113 Q82 118 78 118 L22 118 Q18 118 18 113 Z"
          stroke={tint} strokeWidth="0.7" fill="none" opacity={0.45}
        />
        {/* title divider lines */}
        <Line x1="24" y1="34" x2="76" y2="34" stroke={tint} strokeWidth="0.5" opacity={0.4} />
        <Line x1="24" y1="98" x2="76" y2="98" stroke={tint} strokeWidth="0.5" opacity={0.4} />
        {/* landmark, vertically centered between dividers */}
        <G transform="translate(0, 44)">
          {experienceLabel ? <ExperienceGlyph tint={tint} /> : <Landmark slug={slug} tint={tint} />}
        </G>
      </Svg>
      {/* labels layered over the SVG */}
      <View pointerEvents="none" style={styles.labels}>
        <Text style={[styles.title, { color: tint }]} numberOfLines={1}>{title}</Text>
      </View>
      {sub ? (
        <View pointerEvents="none" style={styles.subWrap}>
          <Text style={[styles.sub, { color: tint }]} numberOfLines={1}>{sub}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  labels: { position: 'absolute', top: '14%', left: 0, right: 0, alignItems: 'center' },
  title: { fontFamily: 'Courier', fontWeight: '700', fontSize: 11, letterSpacing: 1.5 },
  subWrap: { position: 'absolute', bottom: '13%', left: 0, right: 0, alignItems: 'center' },
  sub: { fontFamily: 'Courier', fontWeight: '700', fontSize: 7.5, letterSpacing: 1 },
});
