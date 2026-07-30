/**
 * Travel History — past trips and distinct visited places (from passport stamps).
 * Read-only screen; shows completed/past-dated trips and a deduplicated place list
 * derived from the user's passport stamps.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, StyleSheet, Pressable,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin, CalendarDays, Globe, ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { listMyTrips, type TripRow } from '../../src/services/trips';
import { getMyPassportStamps } from '../../src/services/passportStamps';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';
import { space, color } from '../../src/theme/tokens';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPastTrip(trip: TripRow): boolean {
  if (trip.status === 'completed' || trip.status === 'cancelled') return true;
  // Also include trips whose end date has passed
  if (trip.endDate) {
    return new Date(trip.endDate) < new Date();
  }
  return false;
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return 'Dates unknown';
  if (startDate && endDate) {
    const s = new Date(startDate).getFullYear();
    const e = new Date(endDate).getFullYear();
    if (s === e) {
      return `${fmtDate(startDate)} – ${fmtDate(endDate)}`;
    }
    return `${fmtDate(startDate)} – ${fmtDate(endDate)}`;
  }
  if (startDate) return fmtDate(startDate);
  if (endDate) return fmtDate(endDate);
  return '';
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

interface VisitedPlace {
  city: string | null;
  country: string | null;
  stampCount: number;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function TripHistoryRow({ trip }: { trip: TripRow }) {
  const dest = trip.destinationCountry
    ? `${trip.destinationCity}, ${trip.destinationCountry}`
    : trip.destinationCity;
  return (
    <Pressable
      style={r.tripRow}
      onPress={() => router.push(`/trip/${trip.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Open trip ${trip.title}`}
    >
      <View style={r.tripIcon}>
        <MapPin size={16} color={PP.inkMuted} />
      </View>
      <View style={r.tripBody}>
        <Text style={r.tripTitle} numberOfLines={1}>{trip.title}</Text>
        <Text style={r.tripDest} numberOfLines={1}>{dest}</Text>
        <View style={r.tripMeta}>
          <CalendarDays size={11} color={PP.inkMuted} />
          <Text style={r.tripMetaText}>{formatDateRange(trip.startDate, trip.endDate)}</Text>
        </View>
      </View>
      <ChevronRight size={16} color={PP.inkMuted} />
    </Pressable>
  );
}

function PlaceRow({ place }: { place: VisitedPlace }) {
  const label = [place.city, place.country].filter(Boolean).join(', ') || 'Unknown';
  return (
    <View style={r.placeRow}>
      <View style={r.placeIcon}>
        <Globe size={14} color={PP.inkMuted} />
      </View>
      <Text style={r.placeLabel} numberOfLines={1}>{label}</Text>
      <Text style={r.placeCount}>{place.stampCount} stamp{place.stampCount !== 1 ? 's' : ''}</Text>
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function TravelHistoryScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [pastTrips, setPastTrips] = useState<TripRow[]>([]);
  const [visitedPlaces, setVisitedPlaces] = useState<VisitedPlace[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tripsRes, stampsRes] = await Promise.allSettled([
          listMyTrips(),
          getMyPassportStamps(),
        ]);

        if (!alive) return;

        if (tripsRes.status === 'fulfilled') {
          setPastTrips(tripsRes.value.filter(isPastTrip));
        }

        if (stampsRes.status === 'fulfilled' && stampsRes.value.ok) {
          // Deduplicate by city+country, count stamps per place
          const placeMap = new Map<string, VisitedPlace>();
          for (const stamp of stampsRes.value.data) {
            const key = `${stamp.city ?? ''}||${stamp.country ?? ''}`;
            const existing = placeMap.get(key);
            if (existing) {
              existing.stampCount += 1;
            } else {
              placeMap.set(key, {
                city: stamp.city,
                country: stamp.country,
                stampCount: 1,
              });
            }
          }
          // Sort by stamp count descending
          const places = Array.from(placeMap.values()).sort((a, b) => b.stampCount - a.stampCount);
          setVisitedPlaces(places);
        }
      } catch (e) {
        if (alive) setError('Could not load travel history.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <View style={[r.root, { backgroundColor: PP.paper }]}>
      {/* Header */}
      <View style={[r.header, { paddingTop: Math.max(insets.top + space.sm, 54) }]}>
        <Pressable
          style={r.backBtn}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/passport' as any))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={22} color={PP.ink} />
        </Pressable>
        <Text style={r.headerTitle}>Travel History</Text>
        <View style={r.headerRight} />
      </View>

      {loading ? (
        <View style={r.center}>
          <ActivityIndicator color={PP.ink} size="large" />
        </View>
      ) : error ? (
        <View style={r.center}>
          <Text style={r.errorText}>{error}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={r.content}>
          {/* Past Trips */}
          <View style={r.section}>
            <View style={r.sectionHeader}>
              <Text style={r.sectionTitle}>PAST TRIPS</Text>
              {pastTrips.length > 0 && (
                <Text style={r.sectionCount}>{pastTrips.length}</Text>
              )}
            </View>
            {pastTrips.length === 0 ? (
              <View style={r.emptyCard}>
                <Text style={r.emptyText}>No completed trips yet.</Text>
                <Text style={r.emptyHint}>Trips you finish will appear here.</Text>
              </View>
            ) : (
              <View style={r.card}>
                {pastTrips.map((trip, i) => (
                  <View key={trip.id}>
                    <TripHistoryRow trip={trip} />
                    {i < pastTrips.length - 1 && <View style={r.divider} />}
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Visited Places */}
          <View style={r.section}>
            <View style={r.sectionHeader}>
              <Text style={r.sectionTitle}>VISITED PLACES</Text>
              {visitedPlaces.length > 0 && (
                <Text style={r.sectionCount}>{visitedPlaces.length}</Text>
              )}
            </View>
            {visitedPlaces.length === 0 ? (
              <View style={r.emptyCard}>
                <Text style={r.emptyText}>No stamps collected yet.</Text>
                <Text style={r.emptyHint}>Places you stamp will appear here.</Text>
              </View>
            ) : (
              <View style={r.card}>
                {visitedPlaces.map((place, i) => (
                  <View key={`${place.city}||${place.country}`}>
                    <PlaceRow place={place} />
                    {i < visitedPlaces.length - 1 && <View style={r.divider} />}
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const r = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: space.md,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
    backgroundColor: PP.paper,
  },
  backBtn: { padding: 4 },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontFamily: 'Courier', fontWeight: '700',
    fontSize: 17, color: PP.ink, letterSpacing: 0.5,
  },
  headerRight: { width: 30 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 15, color: PP.seal, textAlign: 'center', padding: space.xl },
  content: { padding: space.lg, gap: space.xl, paddingBottom: 60 },
  section: { gap: space.sm },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
  },
  sectionTitle: {
    ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 2,
  },
  sectionCount: {
    fontFamily: 'Courier', fontSize: 10, fontWeight: '700',
    color: PP.inkMuted, backgroundColor: PP.borderLight,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
  },
  card: {
    backgroundColor: PP.paper,
    borderRadius: 12, borderWidth: 1, borderColor: PP.borderLight,
    overflow: 'hidden',
  },
  emptyCard: {
    backgroundColor: PP.paper,
    borderRadius: 12, borderWidth: 1, borderColor: PP.borderLight,
    padding: space.xl, alignItems: 'center', gap: space.xs,
  },
  emptyText: { fontFamily: 'Courier', fontSize: 14, color: PP.inkMuted, fontWeight: '600' },
  emptyHint: { fontSize: 13, color: PP.inkMuted, textAlign: 'center' },
  divider: { height: 1, backgroundColor: PP.borderLight, marginLeft: 48 },
  tripRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm, minHeight: 64,
  },
  tripIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: PP.borderLight, alignItems: 'center', justifyContent: 'center',
  },
  tripBody: { flex: 1, gap: 2 },
  tripTitle: { fontFamily: 'Courier', fontSize: 14, fontWeight: '700', color: PP.ink },
  tripDest: { fontSize: 13, color: PP.inkMuted },
  tripMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  tripMetaText: { fontSize: 11, color: PP.inkMuted },
  placeRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.md, paddingVertical: 12, gap: space.sm, minHeight: 44,
  },
  placeIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: PP.borderLight, alignItems: 'center', justifyContent: 'center',
  },
  placeLabel: { flex: 1, fontFamily: 'Courier', fontSize: 13, color: PP.ink },
  placeCount: { fontSize: 12, color: PP.inkMuted, fontWeight: '600' },
});
