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
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { MapPin } from 'lucide-react-native';
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

  function openInMaps() {
    if (!locationLabel) return;
    const q = encodeURIComponent(locationLabel);
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
  }

  return (
    <View style={s.card}>
      {/* Destination heading */}
      {locationLabel ? (
        <Pressable style={s.headingRow} onPress={openInMaps} accessibilityRole="button">
          <MapPin size={16} color={color.deep} />
          <Text style={s.heading}>{locationLabel}</Text>
        </Pressable>
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
    </View>
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
