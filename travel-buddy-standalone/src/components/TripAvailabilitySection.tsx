/**
 * TripAvailabilitySection — day-level availability grid for a trip's members.
 *
 * Columns = trip dates (startDate → endDate, max 30, from today onwards).
 * Rows    = accepted trip members.
 * Cells   = green (free) / grey (not set) / dim (no data).
 *
 * Above the grid: BestDaysBanner showing up to 3 days where ≥2 members overlap.
 * Tapping a column header or banner chip opens a day-summary modal.
 * "Plan meetup this day" fires onPlanMeetup(date) so the parent
 * can open MeetupCreationSheet pre-filled.
 *
 * Own-row cells are tappable — opens an inline toggle sheet (free/busy/clear).
 * Optimistic update is applied immediately; reverted on API error.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator,
  Modal, Alert, Platform,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CalendarClock, ChevronDown, ChevronUp, Zap, X } from 'lucide-react-native';
import {
  getTripAvailability, patchTripOpenDays,
  type MemberAvailability, type TimeBlock,
} from '../services/availability.ts';
import { AvailabilityGrid, type CellStatus } from './AvailabilityGrid.tsx';
import { BestDaysBanner } from './BestDaysBanner.tsx';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { localDateKey } from '../utils/localDate.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_BLOCKS: TimeBlock[] = ['morning', 'afternoon', 'evening', 'late'];

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
    days.push(localDateKey(cur)); // LOCAL day — cur is built from local midnight
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function formatShortDate(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

const COLLAPSE_THRESHOLD = 7;

// ── Cell toggle bottom sheet ──────────────────────────────────────────────────

interface CellEditSheetProps {
  date: string | null;
  currentStatus: CellStatus;
  onChoose: (choice: 'free' | 'busy' | 'clear') => void;
  onClose: () => void;
}

function CellEditSheet({ date, currentStatus, onChoose, onClose }: CellEditSheetProps) {
  if (!date) return null;

  const options: { key: 'free' | 'busy' | 'clear'; label: string; active: boolean }[] = [
    { key: 'free',  label: '🟢  Mark as Free',  active: currentStatus === 'free' },
    { key: 'busy',  label: '⚫  Mark as Busy',  active: currentStatus === 'unknown' },
    { key: 'clear', label: '✕  Clear',          active: currentStatus === 'nodata' },
  ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={ts.overlay} onPress={onClose}>
        <Pressable style={ts.sheet} onPress={() => {}}>
          <View style={ts.handle} />
          <Pressable style={ts.closeBtn} onPress={onClose} hitSlop={8}>
            <X size={18} color={color.mute} />
          </Pressable>

          <Text style={ts.sheetTitle}>{formatShortDate(date)}</Text>
          <Text style={ts.sheetSub}>Update your availability for this day</Text>

          {options.map((opt) => (
            <Pressable
              key={opt.key}
              style={[ts.optionRow, opt.active && ts.optionRowActive]}
              onPress={() => { onChoose(opt.key); onClose(); }}
            >
              <Text style={[ts.optionLabel, opt.active && ts.optionLabelActive]}>
                {opt.label}
              </Text>
              {opt.active && <Text style={ts.checkmark}>✓</Text>}
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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
  const [members,     setMembers]     = useState<MemberAvailability[]>([]);
  const [bestDays,    setBestDays]    = useState<{ date: string; count: number }[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [collapsed,   setCollapsed]   = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [editSheet,   setEditSheet]   = useState<{ date: string; status: CellStatus } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTripAvailability(tripId);
    setLoading(false);
    if (res.ok && res.data) {
      const ms = res.data.members;
      setMembers(ms);
      setBestDays(res.data.bestDays ?? []);
      if (ms.length > COLLAPSE_THRESHOLD) setCollapsed(true);
    } else {
      setError(res.message ?? null);
    }
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Own-cell tap handler ────────────────────────────────────────────────────
  const handleOwnCellPress = useCallback((date: string, status: CellStatus) => {
    setEditSheet({ date, status });
  }, []);

  // ── Toggle choice → optimistic update → API ─────────────────────────────────
  const handleToggle = useCallback(async (choice: 'free' | 'busy' | 'clear') => {
    const me = members.find((m) => m.userId === currentUserId);
    if (!me) return;

    const prevOpenDays = me.openDays ?? {};
    const date = editSheet?.date;
    if (!date) return;

    const newOpenDays: Record<string, TimeBlock[]> = { ...prevOpenDays };
    if (choice === 'free')       newOpenDays[date] = ALL_BLOCKS;
    else if (choice === 'busy')  newOpenDays[date] = [];
    else                         delete newOpenDays[date];

    setMembers((prev) =>
      prev.map((m) => m.userId === currentUserId ? { ...m, openDays: newOpenDays } : m),
    );

    const result = await patchTripOpenDays(tripId, newOpenDays);

    if (!result.ok) {
      setMembers((prev) =>
        prev.map((m) => m.userId === currentUserId ? { ...m, openDays: prevOpenDays } : m),
      );
      Alert.alert('Could not update', result.message ?? 'Please try again.');
    }
  }, [members, currentUserId, editSheet, tripId]);

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

      {/* Best days banner — above the grid */}
      {!collapsed && bestDays.length > 0 && (
        <BestDaysBanner
          bestDays={bestDays}
          totalMembers={members.length}
          onDayPress={(date) => setSelectedDay(date)}
        />
      )}

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
              onOwnCellPress={handleOwnCellPress}
              selectedDay={selectedDay}
              onSelectedDayChange={setSelectedDay}
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

      {/* Cell edit sheet */}
      <CellEditSheet
        date={editSheet?.date ?? null}
        currentStatus={editSheet?.status ?? 'nodata'}
        onChoose={handleToggle}
        onClose={() => setEditSheet(null)}
      />
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

const ts = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: space.lg,
    paddingTop: space.md,
    paddingBottom: Platform.OS === 'ios' ? 40 : space.xl,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  closeBtn: { position: 'absolute', top: space.md + 4, right: space.lg, padding: 4 },
  sheetTitle: { ...t.heading, color: color.ink, marginBottom: 2, paddingRight: 28 },
  sheetSub:   { ...t.small, color: color.mute, marginBottom: space.lg },
  optionRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: space.md, paddingHorizontal: space.sm,
    borderRadius: radius.sm, marginBottom: 2,
  },
  optionRowActive: { backgroundColor: color.signal + '12' },
  optionLabel:       { ...t.body, color: color.ink, flex: 1 },
  optionLabelActive: { color: color.signal, fontWeight: '700' },
  checkmark: { color: color.signal, fontWeight: '700', fontSize: 16 },
});
