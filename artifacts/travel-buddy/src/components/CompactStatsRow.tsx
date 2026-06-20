import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { PassportPostcard } from '../types/models';
import type { TripRow } from '../services/trips';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  postcards: PassportPostcard[];
  stamps: number;
  trips: TripRow[];
}

function fmt(n: number): string {
  if (!Number.isFinite(n) || isNaN(n)) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function CompactStatsRow({ postcards, stamps, trips }: Props) {
  const verifiedStamps = stamps;
  const countries = new Set(postcards.map((c) => c.locationCountry).filter(Boolean)).size;
  const cities = new Set(postcards.map((c) => c.locationCity).filter(Boolean)).size;

  const items = [
    { n: postcards.length, label: 'Postcards' },
    { n: verifiedStamps, label: 'Stamps' },
    { n: countries, label: 'Countries' },
    { n: cities, label: 'Cities' },
    { n: trips.length, label: 'Trips' },
  ];

  return (
    <View style={st.row}>
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          {i > 0 && <View style={st.divider} />}
          <View style={st.cell}>
            <Text style={st.n}>{fmt(item.n)}</Text>
            <Text style={st.l}>{item.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 10,
  },
  cell: { flex: 1, alignItems: 'center', gap: 1 },
  divider: { width: 1, height: 28, backgroundColor: color.haze },
  n: { ...t.heading, color: color.ink, fontSize: 17 },
  l: { fontFamily: 'Courier', fontSize: 9, color: color.mute, letterSpacing: 0.5, fontWeight: '700' },
});
