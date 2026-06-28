import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { MapPin, Calendar, ChevronRight } from 'lucide-react-native';
import type { TripRow } from '../services/trips';
import { color, space, radius, type as t } from '../theme/tokens';

const STATUS_COLOR: Record<string, string> = {
  planning: color.mute,
  upcoming: color.deep,
  active: color.success,
  completed: color.signal,
  cancelled: color.faint,
};

export function TripsTab({
  trips,
  isOwner,
}: {
  trips: TripRow[];
  isOwner: boolean;
}) {
  const visible = isOwner ? trips : trips.filter((t) => t.visibility === 'public');

  if (visible.length === 0) {
    return (
      <View style={tr.empty}>
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

  return (
    <View style={tr.list}>
      {visible.map((trip) => {
        const statusColor = STATUS_COLOR[trip.status] ?? color.mute;
        const dates = [trip.startDate, trip.endDate]
          .filter(Boolean)
          .map((d) => new Date(d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
          .join(' – ');
        return (
          <Pressable key={trip.id} style={tr.card} onPress={() => router.push(`/trip/${trip.id}` as any)}>
            <View style={tr.top}>
              <View style={tr.dest}>
                <MapPin size={14} color={color.deep} />
                <Text style={tr.city} numberOfLines={1}>{trip.destinationCity}</Text>
                {trip.destinationCountry ? <Text style={tr.country}>{trip.destinationCountry}</Text> : null}
              </View>
              <View style={[tr.statusBadge, { backgroundColor: `${statusColor}18` }]}>
                <Text style={[tr.statusText, { color: statusColor }]}>{trip.status.replace('_', ' ')}</Text>
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
      })}
    </View>
  );
}

const tr = StyleSheet.create({
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
  empty: { paddingHorizontal: space.xl, paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center' },
  newBtn: { backgroundColor: color.signal, paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.pill },
  newBtnText: { ...t.bodyStrong, color: color.onInk },
});
