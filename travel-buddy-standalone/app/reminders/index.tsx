/**
 * Reminders list — /reminders
 *
 * Device-local reminders, split into Upcoming / Completed sections (mirrors
 * the Upcoming/Past pattern used by app/meetups/index.tsx). This screen has
 * no auth guard from a parent layout — it checks useSession() itself.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Plus, BellOff, Plane, CalendarClock, Bookmark, Sparkles, CheckCircle2 } from 'lucide-react-native';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, avatar, type as t, shadow } from '../../src/theme/tokens';
import { loadReminders, type Reminder, type ReminderTargetType } from '../../src/services/reminders.ts';

const TARGET_ICON: Record<ReminderTargetType, typeof Sparkles> = {
  custom: Sparkles,
  trip: Plane,
  plan_item: CalendarClock,
  saved_place: Bookmark,
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart} · ${timePart}`;
}

function ReminderRow({ reminder }: { reminder: Reminder }) {
  const Icon = TARGET_ICON[reminder.targetType];
  const overdue = reminder.status === 'upcoming' && new Date(reminder.remindAt).getTime() < Date.now();
  return (
    <Pressable style={styles.row} onPress={() => router.push(`/reminders/${reminder.id}` as any)}>
      <View style={[styles.iconWrap, reminder.status === 'completed' && styles.iconWrapDone]}>
        {reminder.status === 'completed'
          ? <CheckCircle2 size={16} color={color.success} />
          : <Icon size={16} color={color.signal} />}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>{reminder.title}</Text>
        <Text style={[styles.rowMeta, overdue && styles.rowMetaOverdue]}>
          {formatWhen(reminder.remindAt)}
          {reminder.targetLabel ? ` · ${reminder.targetLabel}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCount}><Text style={styles.sectionCountText}>{count}</Text></View>
    </View>
  );
}

export default function RemindersScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!configured || !isAuthed) return;
    setLoading(true);
    const all = await loadReminders();
    all.sort((a, b) => new Date(a.remindAt).getTime() - new Date(b.remindAt).getTime());
    setReminders(all);
    setLoading(false);
  }, [configured, isAuthed]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!configured || !isAuthed) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.emptySub}>Sign in to see your reminders.</Text>
      </View>
    );
  }

  const upcoming = reminders.filter((r) => r.status === 'upcoming');
  const completed = reminders.filter((r) => r.status === 'completed');

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Reminders</Text>
        <Pressable style={styles.createBtn} onPress={() => router.push('/reminders/new' as any)}>
          <Plus size={16} color={color.onInk} />
          <Text style={styles.createBtnText}>New</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : reminders.length === 0 ? (
        <View style={styles.emptyState}>
          <BellOff size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No reminders yet</Text>
          <Text style={styles.emptySub}>
            Create a reminder for a trip, a plan item, a saved place, or anything else you don't want to forget.
          </Text>
          <Pressable style={styles.emptyBtn} onPress={() => router.push('/reminders/new' as any)}>
            <Plus size={16} color={color.onInk} />
            <Text style={styles.emptyBtnText}>Create your first reminder</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {upcoming.length > 0 && (
            <>
              <SectionHeader title="Upcoming" count={upcoming.length} />
              {upcoming.map((r) => <ReminderRow key={r.id} reminder={r} />)}
            </>
          )}
          {completed.length > 0 && (
            <>
              <SectionHeader title="Completed" count={completed.length} />
              {completed.map((r) => <ReminderRow key={r.id} reminder={r} />)}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised,
  },
  backBtn: { padding: 4 },
  headerTitle: { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
  },
  createBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  emptyTitle: { ...t.title, color: color.ink, fontSize: 20, fontWeight: '800' },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280 },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.pill, marginTop: space.sm, ...shadow.card,
  },
  emptyBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },
  list: { padding: space.lg, gap: space.sm, paddingBottom: space.xxxl },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  sectionTitle: {
    ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 13,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  sectionCount: {
    minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  sectionCountText: { ...t.stamp, color: color.mute, fontSize: 11, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, ...shadow.card,
  },
  iconWrap: {
    width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  iconWrapDone: { backgroundColor: '#DCFCE7' },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  rowMeta: { ...t.small, color: color.mute },
  rowMetaOverdue: { color: color.signal, fontWeight: '600' },
});
