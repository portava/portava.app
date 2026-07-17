import React, { useMemo } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Luggage } from 'lucide-react-native';
import type { TripRow } from '../services/trips';

/**
 * Recent Trips — horizontal trip cards for the Passport Trips tab.
 * Presentation only: consumes the screen's already-loaded trips.
 */

const MAX_CARDS = 10;

function fmtTripMeta(trip: TripRow): string {
  const parts: string[] = [];
  if (trip.startDate) {
    try {
      parts.push(new Date(trip.startDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }));
    } catch { /* skip */ }
  }
  if (trip.startDate && trip.endDate) {
    const days = Math.round(
      (new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000,
    ) + 1;
    if (Number.isFinite(days) && days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  }
  if (!parts.length && trip.status) parts.push(trip.status.charAt(0).toUpperCase() + trip.status.slice(1));
  return parts.join(' • ');
}

export function RecentTripsSection({ trips, isOwner }: { trips: TripRow[]; isOwner: boolean }) {
  const recent = useMemo(() => {
    return trips
      .slice()
      .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))
      .slice(0, MAX_CARDS);
  }, [trips]);

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Recent Trips</Text>
        <Pressable
          onPress={() => router.push('/(tabs)/trips' as any)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="View All Trips"
        >
          <Text style={styles.viewAll}>View all</Text>
        </Pressable>
      </View>

      {recent.length === 0 ? (
        <View style={styles.empty}>
          <Luggage size={22} color="#98A2B3" strokeWidth={1.7} />
          <Text style={styles.emptyTitle}>{isOwner ? 'No trips yet' : 'No public trips yet'}</Text>
          {isOwner ? (
            <Pressable
              style={styles.emptyCta}
              onPress={() => router.push('/trip/new' as any)}
              accessibilityRole="button"
              accessibilityLabel="Plan a trip"
            >
              <Text style={styles.emptyCtaText}>Plan your first adventure</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
          {recent.map((trip) => {
            const meta = fmtTripMeta(trip);
            const place = [trip.destinationCity, trip.destinationCountry].filter(Boolean).join(', ');
            return (
              <Pressable
                key={trip.id}
                style={styles.card}
                onPress={() => router.push(`/trip/${trip.id}` as any)}
                accessibilityRole="button"
                accessibilityLabel={`Trip: ${trip.title || place}`}
              >
                {trip.coverUrl ? (
                  <Image source={{ uri: trip.coverUrl }} style={styles.image} />
                ) : (
                  <View style={[styles.image, styles.imageFallback]}>
                    <Luggage size={26} color="#B08A45" strokeWidth={1.6} />
                  </View>
                )}
                <View style={styles.info}>
                  <Text style={styles.title} numberOfLines={1}>{trip.title || place || 'Trip'}</Text>
                  {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
                  {place && trip.title ? <Text style={styles.meta} numberOfLines={1}>{place}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: 16 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, marginBottom: 10,
  },
  header: { fontSize: 18, lineHeight: 23, fontWeight: '700', color: '#101828' },
  viewAll: { fontSize: 13, fontWeight: '600', color: '#6945D8' },
  rail: { paddingHorizontal: 16, gap: 12 },
  card: {
    width: 245, borderRadius: 14, overflow: 'hidden',
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EAECF0',
  },
  image: { width: '100%', height: 150 },
  imageFallback: {
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#FCF6E8',
  },
  info: { padding: 10 },
  title: { fontSize: 16, lineHeight: 20, fontWeight: '700', color: '#101828' },
  meta: { marginTop: 3, fontSize: 12, lineHeight: 16, color: '#667085' },
  empty: {
    marginHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: '#EAECF0',
    backgroundColor: '#FFFFFF', alignItems: 'center', gap: 6, paddingVertical: 22,
  },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: '#475467' },
  emptyCta: {
    marginTop: 4, minHeight: 34, paddingHorizontal: 14, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#101828',
  },
  emptyCtaText: { fontSize: 13, fontWeight: '600', color: '#FFFFFF' },
});
