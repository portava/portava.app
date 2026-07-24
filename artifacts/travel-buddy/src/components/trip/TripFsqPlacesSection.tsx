/**
 * TripFsqPlacesSection — Foursquare-powered places strip.
 *
 * Shows a grouped list of notable places for a destination city.
 * Leads with accommodation (headline value), followed by other categories.
 *
 * Returns null when:
 *   - cityKey is absent
 *   - getCityPlaces returns null (flag off or city not yet ingested)
 *
 * LEGAL: the Foursquare `attribution` string is ALWAYS rendered at the foot
 * of any FSQ-sourced list. This is a license requirement — non-negotiable.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import {
  getCityPlaces,
  type FsqPlace,
  type FsqCategory,
  type FsqPlacesResult,
} from '../../services/fsqPlaces.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

// Category display order — accommodation leads
const CATEGORY_ORDER: FsqCategory[] = [
  'accommodation', 'food', 'culture', 'nightlife', 'shopping', 'other',
];

const CATEGORY_LABELS: Record<FsqCategory, string> = {
  accommodation: 'Accommodation',
  food:          'Food & Drink',
  culture:       'Culture',
  nightlife:     'Nightlife',
  shopping:      'Shopping',
  other:         'Other',
};

interface Props {
  /** Ingestion slug for the city, e.g. 'cebu-ph'. Required — renders nothing when absent. */
  cityKey?: string | null;
  /** Optional callback when a place is tapped (e.g. open map at coordinates). */
  onPlacePress?: (place: FsqPlace) => void;
}

// ── Sub-component ─────────────────────────────────────────────────────────────

function PlaceRow({ place, onPress }: { place: FsqPlace; onPress?: () => void }) {
  const inner = (
    <View style={styles.placeRow}>
      <MapPin size={12} color={color.faint} style={{ marginTop: 2 }} />
      <View style={styles.placeText}>
        <Text style={styles.placeName} numberOfLines={1}>{place.name}</Text>
        {(place.label || place.locality) && (
          <Text style={styles.placeMeta} numberOfLines={1}>
            {[place.label, place.locality].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={place.name}>
      {inner}
    </Pressable>
  ) : inner;
}

// ── Main component ────────────────────────────────────────────────────────────

export function TripFsqPlacesSection({ cityKey, onPlacePress }: Props) {
  const [result, setResult] = useState<FsqPlacesResult | null | undefined>(undefined);

  useEffect(() => {
    if (!cityKey) { setResult(null); return; }
    let cancelled = false;
    getCityPlaces(cityKey).then((res) => {
      if (!cancelled) setResult(res);
    });
    return () => { cancelled = true; };
  }, [cityKey]);

  // Not ready, flag off, or city not ingested
  if (!result) return null;
  if (!result.places.length) return null;

  // Group by category in display order
  const groups: { category: FsqCategory; places: FsqPlace[] }[] = [];
  for (const cat of CATEGORY_ORDER) {
    const places = result.places.filter((p) => p.category === cat);
    if (places.length > 0) groups.push({ category: cat, places });
  }
  if (groups.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Places nearby</Text>

      {groups.map(({ category, places }) => (
        <View key={category} style={styles.group}>
          <Text style={styles.groupLabel}>{CATEGORY_LABELS[category]}</Text>
          {places.map((place) => (
            <PlaceRow
              key={place.fsqId}
              place={place}
              onPress={onPlacePress ? () => onPlacePress(place) : undefined}
            />
          ))}
        </View>
      ))}

      {/* ALWAYS render Foursquare attribution — license requirement */}
      <Text style={styles.attribution} accessibilityRole="text">
        {result.attribution}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    marginBottom: space.md,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
    marginBottom: space.md,
  },
  group: {
    marginBottom: space.md,
  },
  groupLabel: {
    ...t.small,
    fontWeight: '700',
    color: color.mute,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  placeText: {
    flex: 1,
    gap: 1,
  },
  placeName: {
    ...t.body,
    color: color.ink,
    fontSize: 13,
  },
  placeMeta: {
    ...t.small,
    color: color.mute,
  },
  attribution: {
    ...t.small,
    color: color.faint,
    fontStyle: 'italic',
    marginTop: space.xs,
    textAlign: 'center',
  },
});
