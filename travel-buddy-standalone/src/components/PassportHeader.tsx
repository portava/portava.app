import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Path, Defs, Pattern, Rect, Line, Circle } from 'react-native-svg';
import { Stamp as StampIcon, Users, CalendarDays, MapPin, ChevronRight } from 'lucide-react-native';
import type { TravelStats } from '../types/models.ts';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';

/**
 * Clickable info bar — icon-circle items, each routes somewhere (never dead).
 */
export function InfoBar({
  stats, onStamps, onCircle, onPlans, onCities,
}: {
  stats: TravelStats;
  onStamps: () => void;
  onCircle: () => void;
  onPlans: () => void;
  onCities: () => void;
}) {
  const items = [
    { n: stats.stamps, label: 'Stamps', Icon: StampIcon, tint: color.signal, bg: '#FCE9E4', onPress: onStamps },
    { n: stats.buddies, label: 'Circle', Icon: Users, tint: color.success, bg: '#E3F1EA', onPress: onCircle },
    { n: stats.plansJoined, label: 'Plans', Icon: CalendarDays, tint: color.deep, bg: '#E2EDF0', onPress: onPlans },
    { n: stats.citiesVisited, label: 'Cities', Icon: MapPin, tint: '#C8851A', bg: '#FBF0DD', onPress: onCities },
  ];
  return (
    <View style={styles.bar}>
      {items.map((it, i) => (
        <React.Fragment key={it.label}>
          {i > 0 && <View style={styles.divider} />}
          <Pressable
            style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
            onPress={it.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${it.n} ${it.label}`}
          >
            <View style={[styles.iconCircle, { backgroundColor: it.bg }]}>
              <it.Icon size={18} color={it.tint} />
            </View>
            <View style={styles.cellText}>
              <Text style={styles.n}>{it.n >= 1000 ? (it.n / 1000).toFixed(1) + 'k' : it.n}</Text>
              <Text style={styles.l}>{it.label}</Text>
            </View>
            <ChevronRight size={14} color={color.faint} />
          </Pressable>
        </React.Fragment>
      ))}
    </View>
  );
}

/**
 * Passport-document backdrop — guilloche security lines + faint stamp marks.
 * Used ONLY behind the Passport header. Tasteful, low-opacity, readable.
 */
export function PassportBackdrop({ height = 150 }: { height?: number }) {
  return (
    <View style={[styles.backdrop, { height }]} pointerEvents="none">
      <Svg width="100%" height="100%" viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <Pattern id="guilloche" width="40" height="40" patternUnits="userSpaceOnUse">
            <Path d="M0,20 Q10,0 20,20 T40,20" stroke={color.onInk} strokeWidth="0.5" fill="none" opacity="0.25" />
            <Path d="M0,20 Q10,40 20,20 T40,20" stroke={color.onInk} strokeWidth="0.5" fill="none" opacity="0.25" />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="400" height="150" fill={color.deep} />
        <Rect x="0" y="0" width="400" height="150" fill="url(#guilloche)" />
        {/* horizontal security lines */}
        {[30, 60, 90, 120].map((y) => (
          <Line key={y} x1="0" y1={y} x2="400" y2={y} stroke={color.onInk} strokeWidth="0.4" opacity="0.12" />
        ))}
        {/* faint stamp marks */}
        <Circle cx="330" cy="40" r="26" stroke={color.onInk} strokeWidth="1.2" fill="none" opacity="0.14" />
        <Circle cx="330" cy="40" r="20" stroke={color.onInk} strokeWidth="0.6" fill="none" opacity="0.14" />
        <Circle cx="60" cy="110" r="20" stroke={color.signal} strokeWidth="1.2" fill="none" opacity="0.18" />
      </Svg>
      {/* MRZ-style strip at the bottom edge for passport feel */}
      <View style={styles.mrz}>
        <Text style={styles.mrzText} numberOfLines={1}>
          {'P<PORTAVA<<PASSPORT<<IDENTITY<<<<<<<<<<<<<<<<'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    paddingVertical: space.md, marginHorizontal: space.lg,
  },
  cell: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4, borderRadius: radius.sm },
  cellPressed: { backgroundColor: color.haze },
  iconCircle: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, alignItems: 'center', justifyContent: 'center' },
  cellText: {},
  divider: { width: 1, height: 30, backgroundColor: color.haze },
  n: { ...t.heading, color: color.ink, fontSize: 18 },
  l: { ...t.small, color: color.mute, fontSize: 11 },

  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden', backgroundColor: color.deep },
  mrz: { position: 'absolute', bottom: 4, left: 0, right: 0, paddingHorizontal: space.md },
  mrzText: { fontFamily: 'Courier', fontSize: 9, color: color.onInk, opacity: 0.3, letterSpacing: 1 },
});
