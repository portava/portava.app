import React, { useMemo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Luggage } from 'lucide-react-native';
import type { TripRow } from '../services/trips';
import { RecentTripsSection } from './RecentTripsSection';

/**
 * Trips tab — featured current/upcoming trip, compact filters, recent trips
 * carousel, and a chronological timeline for travelers with history.
 * Presentation over the screen's already-loaded trips; taps open the
 * existing trip detail route.
 */

type Filter = 'all' | 'upcoming' | 'ongoing' | 'past';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'ongoing', label: 'Ongoing' },
  { key: 'past', label: 'Past' },
];

function bucket(trip: TripRow): Exclude<Filter, 'all'> | 'other' {
  if (trip.status === 'active') return 'ongoing';
  if (trip.status === 'upcoming' || trip.status === 'planning') return 'upcoming';
  if (trip.status === 'completed') return 'past';
  return 'other';
}

function fmtRange(trip: TripRow): string {
  const opts = { month: 'short', year: 'numeric' } as const;
  try {
    const s = trip.startDate ? new Date(trip.startDate).toLocaleDateString('en-US', opts) : '';
    const e = trip.endDate ? new Date(trip.endDate).toLocaleDateString('en-US', opts) : '';
    if (s && e && s !== e) return `${s} – ${e}`;
    return s || e || '';
  } catch {
    return '';
  }
}

export function PassportTrips({ trips, isOwner }: { trips: TripRow[]; isOwner: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');

  const featured = useMemo(() => {
    const ongoing = trips.find((t) => bucket(t) === 'ongoing');
    if (ongoing) return ongoing;
    return trips
      .filter((t) => bucket(t) === 'upcoming' && t.startDate)
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))[0] ?? null;
  }, [trips]);

  const filtered = useMemo(() => {
    if (filter === 'all') return trips;
    return trips.filter((t) => bucket(t) === filter);
  }, [trips, filter]);

  const timeline = useMemo(() => {
    const byYear = new Map<string, TripRow[]>();
    for (const t of trips) {
      if (!t.startDate) continue;
      const year = t.startDate.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)!.push(t);
    }
    return [...byYear.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, rows]) => ({
        year,
        rows: rows.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '')),
      }));
  }, [trips]);

  return (
    <View>
      {/* compact filters */}
      {trips.length > 0 ? (
        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <Pressable
                key={f.key}
                style={[styles.filterChip, on && styles.filterChipOn]}
                onPress={() => setFilter(f.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${f.label} trips`}
              >
                <Text style={[styles.filterText, on && styles.filterTextOn]}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* featured current / upcoming trip */}
      {featured && (filter === 'all' || bucket(featured) === filter) ? (
        <>
        <Text style={styles.featuredHeader}>
          {bucket(featured) === 'ongoing' ? 'Ongoing Trip' : 'Upcoming Trip'}
        </Text>
        <Pressable
          style={styles.featured}
          onPress={() => router.push(`/trip/${featured.id}` as any)}
          accessibilityRole="button"
          accessibilityLabel={`${bucket(featured) === 'ongoing' ? 'Ongoing' : 'Upcoming'} trip: ${featured.title || featured.destinationCity}`}
        >
          {featured.coverUrl ? (
            <Image source={{ uri: featured.coverUrl }} style={styles.featuredImg} resizeMode="cover" />
          ) : (
            <View style={[styles.featuredImg, styles.featuredFallback]}>
              <Luggage size={30} color="#B08A45" strokeWidth={1.5} />
            </View>
          )}
          <View style={[styles.statusPill, bucket(featured) === 'ongoing' ? styles.pillOngoing : styles.pillUpcoming]}>
            <Text style={[styles.statusPillText, bucket(featured) !== 'ongoing' && styles.statusPillTextUpcoming]}>
              {bucket(featured) === 'ongoing' ? 'Ongoing' : 'Upcoming'}
            </Text>
          </View>
          <View style={styles.featuredInfo}>
            <Text style={styles.featuredTitle} numberOfLines={1}>
              {featured.title || [featured.destinationCity, featured.destinationCountry].filter(Boolean).join(', ')}
            </Text>
            {fmtRange(featured) ? <Text style={styles.featuredMeta}>{fmtRange(featured)}</Text> : null}
          </View>
        </Pressable>
        </>
      ) : null}

      {/* recent trips carousel (respects filter) */}
      <RecentTripsSection trips={filtered} isOwner={isOwner} />

      {/* timeline for travelers with history */}
      {filter === 'all' && timeline.length > 1 ? (
        <View style={styles.timeline}>
          <Text style={styles.timelineHeader}>Trip Timeline</Text>
          {timeline.map(({ year, rows }) => (
            <View key={year} style={styles.timelineYear}>
              <Text style={styles.yearLabel}>{year}</Text>
              {rows.map((t) => (
                <Pressable
                  key={t.id}
                  style={styles.timelineRow}
                  onPress={() => router.push(`/trip/${t.id}` as any)}
                  accessibilityRole="button"
                  accessibilityLabel={`Trip: ${t.title || t.destinationCity}`}
                >
                  <View style={styles.timelineDot} />
                  <Text style={styles.timelineText} numberOfLines={1}>
                    {t.title || [t.destinationCity, t.destinationCountry].filter(Boolean).join(', ')}
                  </Text>
                  {fmtRange(t) ? <Text style={styles.timelineDate}>{fmtRange(t)}</Text> : null}
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14,
  },
  filterChip: {
    minHeight: 32, paddingHorizontal: 12, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
  },
  filterChipOn: { backgroundColor: '#6945D8', borderColor: '#6945D8' },
  filterText: { fontSize: 12.5, fontWeight: '600', color: '#475467' },
  filterTextOn: { color: '#FFFFFF' },

  featured: {
    marginHorizontal: 16, marginTop: 14, borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
  },
  featuredImg: { width: '100%', height: 170 },
  featuredFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FCF6E8' },
  statusPill: {
    position: 'absolute', top: 10, left: 10, minHeight: 24,
    paddingHorizontal: 10, borderRadius: 999, justifyContent: 'center',
  },
  pillOngoing: { backgroundColor: '#159447' },
  pillUpcoming: { backgroundColor: '#E7F6EC' },
  statusPillText: { fontSize: 11, fontWeight: '700', color: '#FFFFFF', letterSpacing: 0.3 },
  statusPillTextUpcoming: { color: '#159447' },
  featuredHeader: {
    fontSize: 18, fontWeight: '700', color: '#101828',
    paddingHorizontal: 16, paddingTop: 16,
  },
  featuredInfo: { padding: 12 },
  featuredTitle: { fontSize: 16, fontWeight: '700', color: '#101828' },
  featuredMeta: { marginTop: 3, fontSize: 12.5, color: '#667085' },

  timeline: { paddingHorizontal: 16, paddingTop: 20 },
  timelineHeader: { fontSize: 18, fontWeight: '700', color: '#101828', marginBottom: 8 },
  timelineYear: { marginBottom: 10 },
  yearLabel: { fontSize: 13, fontWeight: '700', color: '#B08A45', letterSpacing: 0.5, marginBottom: 4 },
  timelineRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32,
  },
  timelineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#D0D5DD' },
  timelineText: { flex: 1, fontSize: 14, color: '#344054' },
  timelineDate: { fontSize: 12, color: '#98A2B3' },
});
