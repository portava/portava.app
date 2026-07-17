/**
 * LayoverMapCard — the layover at a glance on the Discovery map: airport
 * pin plus any plan stops that carry coordinates.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Map as MapIcon } from 'lucide-react-native';
import { DiscoveryMapView } from '../discovery/DiscoveryMapView';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { PlanStop, PublicAirport } from '../../services/layover.ts';

interface Props {
  airport: PublicAirport;
  stops: PlanStop[];
}

function toPlace(partial: Partial<DiscoveryPlace> & { id: string; name: string; category: string }): DiscoveryPlace {
  return {
    type: null, description: null, distanceKm: null, lat: null, lng: null,
    tags: [], address: null, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null,
    ...partial,
  };
}

export function LayoverMapCard({ airport, stops }: Props) {
  const hasAirportCoords =
    airport.lat != null && airport.lng != null && !(airport.lat === 0 && airport.lng === 0);

  const places = useMemo(() => {
    const list: DiscoveryPlace[] = [];
    if (hasAirportCoords) {
      list.push(toPlace({
        id: `airport-${airport.iataCode}`,
        name: `${airport.iataCode} — ${airport.name}`,
        category: 'transport',
        lat: airport.lat, lng: airport.lng,
        address: airport.city,
      }));
    }
    for (const s of stops) {
      if (s.lat != null && s.lng != null && !s.insideAirport) {
        list.push(toPlace({
          id: `stop-${s.id}`,
          name: s.title,
          category: 'activity',
          lat: s.lat, lng: s.lng,
          address: s.locationLabel,
        }));
      }
    }
    return list;
  }, [airport, stops, hasAirportCoords]);

  if (!hasAirportCoords) return null;

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <MapIcon size={18} color={color.ink} />
        <Text style={styles.heading}>Around {airport.city}</Text>
      </View>
      <View style={styles.mapWrap}>
        <DiscoveryMapView
          places={places}
          onSelectPlace={() => {}}
          fallbackLat={airport.lat}
          fallbackLng={airport.lng}
          fallbackZoom={11}
        />
      </View>
      <Text style={styles.note}>Airport and any plan stops with a location.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card:    { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.heading, color: color.ink },
  mapWrap: { height: 220, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.haze },
  note:    { ...t.small, color: color.faint },
});
