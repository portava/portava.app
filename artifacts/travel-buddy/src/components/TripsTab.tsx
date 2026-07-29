/**
 * TripsTab — Passport "Plans" tab.
 *
 * Redesigned presentation over the same trip data:
 *  - compact All / Upcoming / Ongoing / Past filter chips
 *  - featured Ongoing/Upcoming trip card (cover photo + status pill)
 *  - trip card list (respects the active filter)
 *  - year-grouped timeline for travelers with history
 *
 * Data, routes, and permissions unchanged: trips come in via props, public
 * views only see public trips, and taps open the existing /trip/[id] screen.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { MapPin, Calendar, ChevronRight, Luggage } from 'lucide-react-native';
import type { TripRow } from '../services/trips.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { useBottomInset } from '../hooks/useBottomInset.ts';
import { VideoThumbnail } from './ui/VideoThumbnail.tsx';
import { fromISODate } from '../lib/dateTime/formatters.ts';
import { tripStatusColor, tripStatusLabel } from '../lib/tripStatus.ts';

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

function fmtDates(trip: TripRow): string {
  return [trip.startDate, trip.endDate]
    .filter(Boolean)
    .map((d) => (fromISODate(d!) ?? new Date(d!)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    .join(' – ');
}

function fmtRange(trip: TripRow): string {
  const opts = { month: 'short', year: 'numeric' } as const;
  try {
    const s = trip.startDate ? (fromISODate(trip.startDate) ?? new Date(trip.startDate)).toLocaleDateString('en-US', opts) : '';
    const e = trip.endDate ? (fromISODate(trip.endDate) ?? new Date(trip.endDate)).toLocaleDateString('en-US', opts) : '';
    if (s && e && s !== e) return `${s} – ${e}`;
    return s || e || '';
  } catch {
    return '';
  }
}

function TripCard({ trip }: { trip: TripRow }) {
  const statusColor = tripStatusColor(trip.status);
  const dates = fmtDates(trip);
  return (
    <Pressable key={trip.id} style={tr.card} onPress={() => router.push(`/trip/${trip.id}` as any)}>
      <View style={tr.top}>
        <View style={tr.dest}>
          <MapPin size={14} color={color.deep} />
          <Text style={tr.city} numberOfLines={1}>{trip.destinationCity}</Text>
          {trip.destinationCountry ? <Text style={tr.country}>{trip.destinationCountry}</Text> : null}
        </View>
        <View style={[tr.statusBadge, { backgroundColor: `${statusColor}18` }]}>
          <Text style={[tr.statusText, { color: statusColor }]}>{tripStatusLabel(trip.status)}</Text>
        </View>
      </View>
      <Text style={tr.title} numberOfLines={1}>{trip.title}</Text>
      {dates ? (
        <View style={tr.dateRow}>
          <Calendar size={12} color={color.faint} />
          <Text style={tr.dates}>{dates}</Text>
        </View>
      ) : null}
      <ChevronRight size={16} color={color.faint} style={tr.chevron} />
    </Pressable>
  );
}

export function TripsTab({
  trips,
  isOwner,
  loading = false,
}: {
  trips: TripRow[];
  isOwner: boolean;
  loading?: boolean;
}) {
  const visible = isOwner ? trips : trips.filter((t) => t.visibility === 'public');
  const [filter, setFilter] = useState<Filter>('all');
  const bottomInset = useBottomInset();

  // Featured: the ongoing trip, else the soonest upcoming trip.
  const featured = useMemo(() => {
    const ongoing = visible.find((t) => bucket(t) === 'ongoing');
    if (ongoing) return ongoing;
    return visible
      .filter((t) => bucket(t) === 'upcoming' && t.startDate)
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))[0] ?? null;
  }, [visible]);

  const filtered = useMemo(() => {
    const list = filter === 'all' ? visible : visible.filter((t) => bucket(t) === filter);
    // Featured trip is rendered above the list — avoid showing it twice.
    return featured ? list.filter((t) => t.id !== featured.id) : list;
  }, [visible, filter, featured]);

  const timeline = useMemo(() => {
    const byYear = new Map<string, TripRow[]>();
    for (const trip of visible) {
      if (!trip.startDate) continue;
      const year = trip.startDate.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)!.push(trip);
    }
    return [...byYear.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, rows]) => ({
        year,
        rows: rows.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '')),
      }));
  }, [visible]);

  if (loading && visible.length === 0) {
    return (
      <View style={[tr.empty, { paddingBottom: bottomInset }]}>
        <ActivityIndicator size="small" color={color.deep} />
      </View>
    );
  }

  if (visible.length === 0) {
    return (
      <View style={[tr.empty, { paddingBottom: bottomInset }]}>
        <Text style={tr.emptyIcon}>✈️</Text>
        <Text style={tr.emptyTitle}>No trips shown yet</Text>
        <Text style={tr.emptySub}>
          {isOwner ? 'Create your first trip to see it here.' : 'No public trips to show.'}
        </Text>
        {isOwner && (
          <Pressable style={tr.newBtn} onPress={() => router.push('/trip/new' as any)}>
            <Text style={tr.newBtnText}>Plan a trip</Text>
          </Pressable>
        )}
      </View>
    );
  }

  const featuredBucket = featured ? bucket(featured) : null;
  const showFeatured = featured && (filter === 'all' || featuredBucket === filter);

  return (
    <View style={{ paddingBottom: bottomInset }}>
      {/* compact filters */}
      <View style={tr.filters}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <Pressable
              key={f.key}
              style={[tr.filterChip, on && tr.filterChipOn]}
              onPress={() => setFilter(f.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${f.label} trips`}
            >
              <Text style={[tr.filterText, on && tr.filterTextOn]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* featured current / upcoming trip */}
      {showFeatured ? (
        <>
          <Text style={tr.featuredHeader}>
            {featuredBucket === 'ongoing' ? 'Ongoing Trip' : 'Upcoming Trip'}
          </Text>
          <Pressable
            style={tr.featured}
            onPress={() => router.push(`/trip/${featured!.id}` as any)}
            accessibilityRole="button"
            accessibilityLabel={`${featuredBucket === 'ongoing' ? 'Ongoing' : 'Upcoming'} trip: ${featured!.title || featured!.destinationCity}`}
          >
            {featured!.coverMediaType === 'video' && featured!.coverUrl ? (
              <VideoThumbnail posterUri={featured!.coverUrl} style={tr.featuredImg} />
            ) : featured!.coverUrl ? (
              <Image source={{ uri: featured!.coverUrl }} style={tr.featuredImg} resizeMode="cover" />
            ) : (
              <View style={[tr.featuredImg, tr.featuredFallback]}>
                <Luggage size={30} color={color.mute} strokeWidth={1.5} />
              </View>
            )}
            <View style={[tr.statusPill, featuredBucket === 'ongoing' ? tr.pillOngoing : tr.pillUpcoming]}>
              <Text style={[tr.statusPillText, featuredBucket !== 'ongoing' && tr.statusPillTextUpcoming]}>
                {featuredBucket === 'ongoing' ? 'Ongoing' : 'Upcoming'}
              </Text>
            </View>
            <View style={tr.featuredInfo}>
              <Text style={tr.featuredTitle} numberOfLines={1}>
                {featured!.title || [featured!.destinationCity, featured!.destinationCountry].filter(Boolean).join(', ')}
              </Text>
              {fmtRange(featured!) ? <Text style={tr.featuredMeta}>{fmtRange(featured!)}</Text> : null}
            </View>
          </Pressable>
        </>
      ) : null}

      {/* trip cards (respect filter) */}
      {filtered.length > 0 ? (
        <View style={tr.list}>
          {filtered.map((trip) => <TripCard key={trip.id} trip={trip} />)}
        </View>
      ) : !showFeatured ? (
        <View style={tr.filterEmpty}>
          <Text style={tr.filterEmptyText}>No {filter} trips.</Text>
        </View>
      ) : null}

      {/* timeline for travelers with history */}
      {filter === 'all' && timeline.length > 1 ? (
        <View style={tr.timeline}>
          <Text style={tr.timelineHeader}>Trip Timeline</Text>
          {timeline.map(({ year, rows }) => (
            <View key={year} style={tr.timelineYear}>
              <Text style={tr.yearLabel}>{year}</Text>
              {rows.map((trip) => (
                <Pressable
                  key={trip.id}
                  style={tr.timelineRow}
                  onPress={() => router.push(`/trip/${trip.id}` as any)}
                  accessibilityRole="button"
                  accessibilityLabel={`Trip: ${trip.title || trip.destinationCity}`}
                >
                  <View style={tr.timelineDot} />
                  <Text style={tr.timelineText} numberOfLines={1}>
                    {trip.title || [trip.destinationCity, trip.destinationCountry].filter(Boolean).join(', ')}
                  </Text>
                  {fmtRange(trip) ? <Text style={tr.timelineDate}>{fmtRange(trip)}</Text> : null}
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const tr = StyleSheet.create({
  filters: {
    flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md,
  },
  filterChip: {
    minHeight: 32, paddingHorizontal: 12, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  filterChipOn: { backgroundColor: color.signal, borderColor: color.signal },
  filterText: { ...t.small, fontSize: 12.5, fontWeight: '600', color: color.mute },
  filterTextOn: { color: color.onInk },

  featuredHeader: {
    ...t.heading, color: color.ink, fontSize: 18,
    paddingHorizontal: space.lg, paddingTop: space.lg,
  },
  featured: {
    marginHorizontal: space.lg, marginTop: space.md, borderRadius: radius.lg, overflow: 'hidden',
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  featuredImg: { width: '100%', height: 170 },
  featuredFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.haze },
  statusPill: {
    position: 'absolute', top: 10, left: 10, minHeight: 24,
    paddingHorizontal: 10, borderRadius: radius.pill, justifyContent: 'center',
  },
  pillOngoing: { backgroundColor: color.success },
  pillUpcoming: { backgroundColor: '#E7F6EC' },
  statusPillText: { fontSize: 11, fontWeight: '700', color: color.onInk, letterSpacing: 0.3 },
  statusPillTextUpcoming: { color: color.success },
  featuredInfo: { padding: space.md },
  featuredTitle: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  featuredMeta: { ...t.small, color: color.mute, marginTop: 3 },

  list: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, padding: space.lg,
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.xs },
  dest: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  city: { ...t.bodyStrong, color: color.ink, flex: 1 },
  country: { ...t.small, color: color.mute },
  statusBadge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { ...t.small, fontWeight: '700', fontSize: 11, textTransform: 'capitalize' },
  title: { ...t.heading, color: color.ink, marginBottom: space.xs },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.xs },
  dates: { ...t.small, color: color.mute },
  chevron: { position: 'absolute', right: space.lg, top: '50%' },

  filterEmpty: { paddingHorizontal: space.lg, paddingTop: space.xl, alignItems: 'center' },
  filterEmptyText: { ...t.body, color: color.mute },

  timeline: { paddingHorizontal: space.lg, paddingTop: space.xl },
  timelineHeader: { ...t.heading, color: color.ink, fontSize: 18, marginBottom: space.sm },
  timelineYear: { marginBottom: space.md },
  yearLabel: {
    ...t.small, fontWeight: '700', color: color.deep,
    letterSpacing: 0.5, marginBottom: 4, fontFamily: 'Courier',
  },
  timelineRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32,
  },
  timelineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.haze },
  timelineText: { ...t.body, flex: 1, color: color.ink },
  timelineDate: { ...t.small, color: color.faint, fontSize: 12 },

  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
  newBtn: { backgroundColor: color.signal, paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.pill },
  newBtnText: { ...t.bodyStrong, color: color.onInk },
});
