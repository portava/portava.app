/**
 * TripDestinationInfoCard
 *
 * Displays a concise overview of the trip's destination city on the trip
 * detail screen. Shows the destination city + country and any trip notes
 * that serve as a description. Tapping the card opens Google Maps for the
 * destination city.
 *
 * Renders nothing when neither city nor notes are available.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { TripDetail } from '../../types/models.ts';

interface TripDestinationInfoCardProps {
  trip: TripDetail;
}

export function TripDestinationInfoCard({ trip }: TripDestinationInfoCardProps) {
  const city    = trip.destinationCity ?? null;
  const country = trip.destinationCountry ?? null;
  const notes   = (trip as any).tripNotes as string | null ?? null;

  if (!city && !notes) return null;

  const locationLabel = [city, country].filter(Boolean).join(', ');

  // Opens Discovery already filtered to the trip's destination city, rather
  // than leaving the app for an external maps link.
  function exploreOnMap() {
    if (!city) return;
    router.push({ pathname: '/(tabs)/discovery', params: { city } } as any);
  }

  // The whole card is tappable — the placeholder line previously sat outside
  // the Pressable, so tapping it (as opposed to the heading row) did nothing.
  return (
    <Pressable style={s.card} onPress={exploreOnMap} disabled={!city} accessibilityRole="button">
      {/* Destination heading */}
      {locationLabel ? (
        <View style={s.headingRow}>
          <MapPin size={16} color={color.deep} />
          <Text style={s.heading}>{locationLabel}</Text>
        </View>
      ) : null}

      {/* Trip notes / city description */}
      {notes ? (
        <Text style={s.notes}>{notes}</Text>
      ) : (
        city ? (
          <Text style={s.placeholder}>
            Tap to explore {city} on the map.
          </Text>
        ) : null
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.md,
    marginHorizontal: space.md,
    marginBottom: space.md,
    gap: space.sm,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  heading: {
    ...t.bodyStrong,
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
    flex: 1,
  },
  notes: {
    ...t.body,
    fontSize: 14,
    color: color.mute,
    lineHeight: 20,
  },
  placeholder: {
    ...t.small,
    fontSize: 13,
    color: color.faint,
    fontStyle: 'italic',
  },
});
