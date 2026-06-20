/**
 * TripAvailabilitySection — shown inside the trip detail page.
 * Loads all members' weekly availability + quick statuses and renders
 * a compact grid: avatar, name, quick status chip, and block summary.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CalendarClock, Zap } from 'lucide-react-native';
import { getTripAvailability, type MemberAvailability } from '../services/availability';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

const BLOCK_SHORT: Record<string, string> = { morning: 'AM', afternoon: 'PM', evening: 'Eve', late: 'Late' };
const DAY_ORDER = ['mon','tue','wed','thu','fri','sat','sun'] as const;
const DAY_SHORT: Record<string, string> = { mon: 'M', tue: 'T', wed: 'W', thu: 'Th', fri: 'F', sat: 'Sa', sun: 'Su' };

const QUICK_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  free_now:      { bg: '#DCFCE7', fg: '#16A34A', label: '🟢 Free now' },
  free_tonight:  { bg: '#E0F2FE', fg: '#0369A1', label: '🌙 Tonight' },
  open_to_plans: { bg: '#FEF9C3', fg: '#A16207', label: '✨ Open' },
  busy:          { bg: '#FEE2E2', fg: '#DC2626', label: '🔴 Busy' },
};

function MemberRow({ m }: { m: MemberAvailability }) {
  const q = m.quickStatus ? QUICK_STYLE[m.quickStatus.status] : null;

  const activeDays = DAY_ORDER.filter((d) => (m.weeklyDays[d]?.length ?? 0) > 0);
  const blocks = new Set(activeDays.flatMap((d) => m.weeklyDays[d] ?? []));
  const blockSummary = [...blocks].map((b) => BLOCK_SHORT[b] ?? b).join(' · ');

  return (
    <Pressable style={mr.row} onPress={() => m.handle ? router.push(`/u/${m.handle}` as any) : undefined}>
      {m.avatarUrl ? (
        <Image source={{ uri: m.avatarUrl }} style={mr.avatar} />
      ) : (
        <View style={[mr.avatar, mr.avatarFallback]}>
          <Text style={mr.avatarInitial}>{((m.name ?? m.handle ?? '?')[0]).toUpperCase()}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={mr.name} numberOfLines={1}>{m.name ?? m.handle ?? 'Traveler'}</Text>
        {q ? (
          <View style={[mr.quickChip, { backgroundColor: q.bg }]}>
            <Text style={[mr.quickText, { color: q.fg }]}>{q.label}</Text>
          </View>
        ) : null}
        {activeDays.length > 0 ? (
          <View style={mr.daysRow}>
            {DAY_ORDER.map((d) => {
              const on = (m.weeklyDays[d]?.length ?? 0) > 0;
              return (
                <View key={d} style={[mr.dayDot, on && mr.dayDotOn]}>
                  <Text style={[mr.dayLabel, on && mr.dayLabelOn]}>{DAY_SHORT[d]}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
        {blockSummary ? <Text style={mr.blockSummary}>{blockSummary}</Text> : null}
      </View>
    </Pressable>
  );
}

const mr = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: color.haze },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  avatarInitial: { ...t.bodyStrong, color: color.ink },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  quickChip: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, marginTop: 3 },
  quickText: { fontSize: 11, fontWeight: '700' },
  daysRow: { flexDirection: 'row', gap: 3, marginTop: 4 },
  dayDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  dayDotOn: { backgroundColor: color.signal },
  dayLabel: { fontSize: 9, fontWeight: '700', color: color.mute },
  dayLabelOn: { color: color.onInk },
  blockSummary: { ...t.small, color: color.mute, fontSize: 10, marginTop: 3 },
});

interface Props { tripId: string; }

export function TripAvailabilitySection({ tripId }: Props) {
  const [members, setMembers] = useState<MemberAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTripAvailability(tripId);
    setLoading(false);
    if (res.ok && res.data) setMembers(res.data.members);
    else setError(res.message ?? null);
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return (
      <View style={s.wrap}>
        <View style={s.headRow}>
          <CalendarClock size={15} color={color.deep} />
          <Text style={s.heading}>Member Availability</Text>
        </View>
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (error || members.length === 0) return null;

  const freeNow = members.filter((m) => m.quickStatus?.status === 'free_now').length;

  return (
    <View style={s.wrap}>
      <View style={s.headRow}>
        <CalendarClock size={15} color={color.deep} />
        <Text style={s.heading}>Member Availability</Text>
        {freeNow > 0 && (
          <View style={s.badge}>
            <Zap size={10} color={color.signal} fill={color.signal} />
            <Text style={s.badgeText}>{freeNow} free now</Text>
          </View>
        )}
      </View>

      <View style={s.card}>
        {members.map((m, i) => (
          <View key={m.userId}>
            {i > 0 && <View style={s.divider} />}
            <MemberRow m={m} />
          </View>
        ))}
      </View>

      <Pressable style={s.editBtn} onPress={() => router.push('/availability')}>
        <Text style={s.editBtnText}>Update my availability →</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.title, color: color.ink, fontSize: 18, flex: 1 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#FEF9C3', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  badgeText: { ...t.small, color: '#A16207', fontWeight: '700', fontSize: 11 },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, ...shadow.card },
  divider: { height: 1, backgroundColor: color.haze, marginVertical: space.sm },
  center: { height: 60, alignItems: 'center', justifyContent: 'center' },
  editBtn: { alignSelf: 'flex-start' },
  editBtnText: { ...t.small, color: color.signal, fontWeight: '700' },
});
