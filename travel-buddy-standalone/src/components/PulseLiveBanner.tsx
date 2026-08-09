/**
 * PulseLiveBanner — prominent multi-status live activity banner for the
 * Portava Pulse screen (dark-navy concept).
 *
 * Five states, all computed from REAL data:
 *   • Available Now  — the user's own availability status (→ /availability)
 *   • Upcoming       — events starting in more than an hour
 *   • Ongoing        — events that have started and are still running
 *   • Starting Soon  — events starting within the next hour
 *   • Ends Soon      — ongoing events wrapping up within ~30 minutes
 *
 * CityEvent has no endAt, so a 2-hour default duration bounds the Ongoing /
 * Ends Soon windows. Zero-count segments render dimmed rather than hidden so
 * the banner keeps its five-state shape (graceful empty state).
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import type { CityEvent } from '../types/models.ts';
import { space, radius, dot} from '../theme/tokens.ts';
import { pv } from '../theme/pulseTheme.ts';

const HOUR = 60 * 60 * 1000;
const DEFAULT_DURATION = 2 * HOUR;
const ENDS_SOON_WINDOW = 0.5 * HOUR;

/**
 * Memoized: the banner sits in the FlatList header, so without memo it would
 * re-render (and re-measure) on every list render during scroll, causing the
 * header strip to visibly resize/jitter. Callers must pass a stable `events`
 * array reference.
 */
export const PulseLiveBanner = React.memo(function PulseLiveBanner({
  city,
  events,
  availabilityLabel,
}: {
  city: string;
  events: CityEvent[];
  availabilityLabel: string;
}) {
  const now = Date.now();
  let upcoming = 0, ongoing = 0, startingSoon = 0, endsSoon = 0;
  for (const ev of events) {
    const start = new Date(ev.startAt).getTime();
    if (Number.isNaN(start)) continue;
    const end = start + DEFAULT_DURATION;
    if (start > now) {
      if (start - now <= HOUR) startingSoon += 1;
      else upcoming += 1;
    } else if (now < end) {
      ongoing += 1;
      if (end - now <= ENDS_SOON_WINDOW) endsSoon += 1;
    }
  }

  const goTrips = () => router.push('/(tabs)/trips');
  const segments: {
    key: string; label: string; dot: string; value: string; dim: boolean; onPress: () => void;
  }[] = [
    { key: 'available', label: 'Available Now', dot: pv.teal, value: availabilityLabel, dim: false, onPress: () => router.push('/availability') },
    { key: 'upcoming', label: 'Upcoming', dot: pv.orange, value: String(upcoming), dim: upcoming === 0, onPress: goTrips },
    { key: 'ongoing', label: 'Ongoing', dot: pv.coral, value: String(ongoing), dim: ongoing === 0, onPress: goTrips },
    { key: 'startingSoon', label: 'Starting Soon', dot: pv.orange, value: String(startingSoon), dim: startingSoon === 0, onPress: goTrips },
    { key: 'endsSoon', label: 'Ends Soon', dot: pv.coral, value: String(endsSoon), dim: endsSoon === 0, onPress: goTrips },
  ];

  return (
    <View style={s.card}>
      <View style={s.head}>
        <View style={s.liveDot} />
        <Text style={s.eyebrow}>LIVE PULSE</Text>
        <Text style={s.headCity} numberOfLines={1}>· {city}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
        {segments.map(({ key, label, dot, value, dim, onPress }) => (
          <Pressable
            key={key}
            style={[s.segment, dim && s.segmentDim]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${value}`}
          >
            <View style={[s.dot, { backgroundColor: dot }]} />
            <View>
              <Text style={[s.value, dim && s.valueDim]} numberOfLines={1}>{value}</Text>
              <Text style={s.label} numberOfLines={1}>{label}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
});

const s = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: pv.navyRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: pv.navyEdge,
    paddingVertical: space.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    marginBottom: space.sm,
  },
  liveDot: {
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
    backgroundColor: pv.coral,
  },
  eyebrow: {
    fontFamily: 'Courier',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: pv.textMute,
  },
  headCity: {
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '600',
    color: pv.textFaint,
    flexShrink: 1,
  },
  row: {
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: pv.navySoft,
    borderWidth: 1,
    borderColor: pv.navyEdge,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  segmentDim: {
    opacity: 0.55,
  },
  dot: {
    width: dot.s8,
    height: dot.s8,
    borderRadius: dot.s8 / 2,
  },
  value: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    color: pv.text,
    maxWidth: 140,
  },
  valueDim: {
    color: pv.textMute,
  },
  label: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '600',
    color: pv.textMute,
  },
});
