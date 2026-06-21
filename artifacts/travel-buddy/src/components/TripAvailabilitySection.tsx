/**
 * TripAvailabilitySection — day-level availability grid for a trip's members.
 *
 * Columns = trip dates (startDate → endDate, max 30, from today onwards).
 * Rows    = accepted trip members.
 * Cells   = green (free) / grey (not set) / dim (no data).
 *
 * Tapping a column header opens a day-summary modal.
 * "Plan meetup this day" fires onPlanMeetup(date) so the parent
 * can open MeetupCreationSheet pre-filled.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CalendarClock, ChevronDown, ChevronUp, Zap } from 'lucide-react-native';
import { getTripAvailability, type MemberAvailability } from '../services/availability';
import { AvailabilityGrid } from './AvailabilityGrid';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateTripDays(startDate?: string, endDate?: string): string[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tripStart = startDate ? new Date(startDate + 'T00:00:00') : today;
  const start     = tripStart >= today ? tripStart : today;

  const tripEnd = endDate
    ? new Date(endDate + 'T00:00:00')
    : new Date(start.getTime() + 13 * 86_400_000);

  const maxEnd = new Date(start.getTime() + 29 * 86_400_000);
  const end    = tripEnd < maxEnd ? tripEnd : maxEnd;

  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

const COLLAPSE_THRESHOLD = 7;

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  tripId: string;
  currentUserId: string;
  startDate?: string;
  endDate?: string;
  onPlanMeetup?: (date: string) => void;
}

export function TripAvailabilitySection({
  tripId,
  currentUserId,
  startDate,
  endDate,
  onPlanMeetup,
}: Props) {
  const [members,   setMembers]   = useState<MemberAvailability[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTripAvailability(tripId);
    setLoading(false);
    if (res.ok && res.data) {
      const ms = res.data.members;
      setMembers(ms);
      if (ms.length > COLLAPSE_THRESHOLD) setCollapsed(true);
    } else {
      setError(res.message ?? null);
    }
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const days      = generateTripDays(startDate, endDate);
  const freeNow   = members.filter((m) => m.quickStatus?.status === 'free_now').length;
  const canToggle = members.length > COLLAPSE_THRESHOLD;

  if (loading) {
    return (
      <View style={s.wrap}>
        <View style={s.headRow}>
          <CalendarClock size={15} color={color.deep} />
          <Text style={s.heading}>Member Availability</Text>
        </View>
        <View style={s.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (error || members.length === 0) return null;

  return (
    <View style={s.wrap}>
      {/* Header — tappable to collapse if large group */}
      <Pressable
        style={s.headRow}
        onPress={canToggle ? () => setCollapsed((v) => !v) : undefined}
        hitSlop={4}
      >
        <CalendarClock size={15} color={color.deep} />
        <Text style={s.heading}>Member Availability</Text>

        {freeNow > 0 && (
          <View style={s.badge}>
            <Zap size={10} color={color.signal} fill={color.signal} />
            <Text style={s.badgeText}>{freeNow} free now</Text>
          </View>
        )}

        <View style={{ flex: 1 }} />

        {canToggle && (
          collapsed
            ? <ChevronDown size={16} color={color.mute} />
            : <ChevronUp   size={16} color={color.mute} />
        )}
      </Pressable>

      {/* Grid */}
      {!collapsed && (
        <View style={s.card}>
          {days.length > 0 ? (
            <AvailabilityGrid
              members={members}
              days={days}
              currentUserId={currentUserId}
              mode="trip"
              onEditOwn={() => router.push('/availability')}
              onPlanMeetup={onPlanMeetup}
            />
          ) : (
            <Text style={s.noDates}>
              Add trip dates to see the day-by-day availability grid.
            </Text>
          )}

          <Pressable style={s.editBtn} onPress={() => router.push('/availability')}>
            <Text style={s.editBtnText}>Update my availability →</Text>
          </Pressable>
        </View>
      )}

      {canToggle && collapsed && (
        <Pressable onPress={() => setCollapsed(false)}>
          <Text style={s.showAll}>Show all {members.length} members →</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap:    { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.title, color: color.ink, fontSize: 18 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FEF9C3',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.pill, marginLeft: space.sm,
  },
  badgeText: { ...t.small, color: '#A16207', fontWeight: '700', fontSize: 11 },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
  },
  center:      { height: 60, alignItems: 'center', justifyContent: 'center' },
  noDates:     { ...t.small, color: color.mute, textAlign: 'center', paddingVertical: space.md },
  editBtn:     { alignSelf: 'flex-start' },
  editBtnText: { ...t.small, color: color.signal, fontWeight: '700' },
  showAll:     { ...t.small, color: color.signal, fontWeight: '700' },
});
