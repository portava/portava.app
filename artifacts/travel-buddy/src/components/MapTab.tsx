import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { PassportPostcard } from '../types/models';
import { color, space, type as t } from '../theme/tokens';

/** Map tab — placeholder with city-level location grid. No exact GPS exposed. */
export function MapTab({ postcards }: { postcards: PassportPostcard[] }) {
  const withLocation = postcards.filter((c) => c.locationCity || c.locationName);
  const cities = [...new Map(withLocation.map((c) => [c.locationCity ?? c.locationName, c])).entries()];

  if (cities.length === 0) {
    return (
      <View style={mp.empty}>
        <Text style={mp.emptyIcon}>🗺️</Text>
        <Text style={mp.emptyTitle}>Map will appear when postcards have locations</Text>
        <Text style={mp.emptySub}>Tag a city when creating a post to pin it here.</Text>
      </View>
    );
  }

  return (
    <View style={mp.wrap}>
      <View style={mp.placeholder}>
        <Text style={mp.placeholderIcon}>🗺️</Text>
        <Text style={mp.placeholderText}>Interactive map coming soon</Text>
        <Text style={mp.placeholderSub}>City-level only — exact GPS is never shown</Text>
      </View>

      <Text style={mp.citiesLabel}>Postcard cities ({cities.length})</Text>
      <View style={mp.chips}>
        {cities.map(([city, card]) => (
          <View key={city} style={[mp.chip, card.locationVerified && mp.chipVerified]}>
            <Text style={mp.chipText}>{city}</Text>
            {card.locationVerified && <Text style={mp.chipBadge}>✓</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}

const mp = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  placeholder: {
    height: 200, backgroundColor: color.paperRaised, borderRadius: 12,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: 8,
    marginBottom: space.lg,
  },
  placeholderIcon: { fontSize: 48 },
  placeholderText: { ...t.bodyStrong, color: color.ink },
  placeholderSub: { ...t.small, color: color.mute },
  citiesLabel: { ...t.heading, color: color.ink, marginBottom: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.paperRaised, borderRadius: 20,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  chipVerified: { borderColor: color.success, backgroundColor: '#E3F1EA' },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  chipBadge: { fontSize: 10, color: color.success },
  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
});
