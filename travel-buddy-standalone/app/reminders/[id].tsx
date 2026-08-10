/**
 * Reminder detail — /reminders/[id]
 *
 * View, edit, snooze, complete/reopen, and delete a single device-local
 * reminder. No auth guard is inherited from a parent layout — this screen
 * checks useSession() itself, per the reminder-system brief.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, Platform, TextInput,
} from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Trash2, CheckCircle2, RotateCcw, Clock, MapPin, Plane, CalendarClock, Bookmark, Sparkles,
} from 'lucide-react-native';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView.tsx';
import { DatePickerField } from '../../src/components/DateTimePickerField.tsx';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import {
  getReminder, editReminder, snoozeReminder, completeReminder, reopenReminder, deleteReminder,
  type Reminder, type ReminderTargetType,
} from '../../src/services/reminders.ts';

const TARGET_ICON: Record<ReminderTargetType, typeof Sparkles> = {
  custom: Sparkles,
  trip: Plane,
  plan_item: CalendarClock,
  saved_place: Bookmark,
};

const TARGET_ROUTE: Record<Exclude<ReminderTargetType, 'custom'>, (r: Reminder) => string> = {
  trip: (r) => `/trip/${r.targetId}`,
  plan_item: (r) => `/plan/${r.tripId}`,
  saved_place: (r) => `/place/${r.targetId}`,
};

const SNOOZE_OPTIONS: Array<{ label: string; minutes: number }> = [
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
];

function combineDateAndTime(date: Date, time: Date): Date {
  const combined = new Date(date);
  combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return combined;
}

export default function ReminderDetailScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    if (!configured || !isAuthed) return;
    setLoading(true);
    const r = await getReminder(id);
    setReminder(r);
    if (r) {
      setTitle(r.title);
      setNote(r.note ?? '');
      const d = new Date(r.remindAt);
      setDate(d);
      setTime(d);
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleSaveEdit() {
    if (!reminder) return;
    if (!title.trim()) {
      Alert.alert('Add a title', 'This reminder needs a title.');
      return;
    }
    if (!date || !time) {
      Alert.alert('Pick a date and time', 'Choose when this reminder should fire.');
      return;
    }
    const remindAt = combineDateAndTime(date, time);
    if (remindAt.getTime() <= Date.now() && reminder.status === 'upcoming') {
      Alert.alert('That time has passed', 'Pick a date and time in the future.');
      return;
    }
    setBusy(true);
    const updated = await editReminder(reminder.id, {
      title: title.trim(),
      note: note.trim() || null,
      remindAt: remindAt.toISOString(),
    });
    setBusy(false);
    if (updated) { setReminder(updated); setEditing(false); }
  }

  async function handleSnooze(minutes: number) {
    if (!reminder) return;
    setBusy(true);
    const newAt = new Date(Date.now() + minutes * 60_000);
    const updated = await snoozeReminder(reminder.id, newAt.toISOString());
    setBusy(false);
    if (updated) setReminder(updated);
  }

  async function handleToggleComplete() {
    if (!reminder) return;
    setBusy(true);
    const updated = reminder.status === 'upcoming'
      ? await completeReminder(reminder.id)
      : await reopenReminder(reminder.id);
    setBusy(false);
    if (updated) setReminder(updated);
  }

  function confirmDelete() {
    if (!reminder) return;
    const doDelete = async () => {
      setBusy(true);
      await deleteReminder(reminder.id);
      setBusy(false);
      router.back();
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm('Delete this reminder? This cannot be undone.')) doDelete();
      return;
    }
    Alert.alert('Delete reminder', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: doDelete },
    ]);
  }

  if (!configured || !isAuthed) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.emptyText}>Sign in to view this reminder.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (!reminder) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={22} color={color.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Reminder</Text>
        </View>
        <View style={styles.center}><Text style={styles.emptyText}>This reminder no longer exists.</Text></View>
      </View>
    );
  }

  const Icon = TARGET_ICON[reminder.targetType];
  const targetRouteFn = reminder.targetType !== 'custom' ? TARGET_ROUTE[reminder.targetType] : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{reminder.title}</Text>
        <Pressable style={styles.deleteBtn} onPress={confirmDelete} hitSlop={8}>
          <Trash2 size={20} color={color.signal} />
        </Pressable>
      </View>

      <KeyboardSafeView style={styles.kav} contentContainerStyle={styles.scrollContent}>
        {reminder.targetLabel && (
          <Pressable
            style={styles.targetRow}
            disabled={!targetRouteFn}
            onPress={() => { if (targetRouteFn) router.push(targetRouteFn(reminder) as any); }}
          >
            <Icon size={16} color={color.signal} />
            <Text style={styles.targetText} numberOfLines={1}>{reminder.targetLabel}</Text>
          </Pressable>
        )}

        {reminder.status === 'completed' && (
          <View style={styles.completedBanner}>
            <CheckCircle2 size={16} color={color.success} />
            <Text style={styles.completedBannerText}>Completed</Text>
          </View>
        )}

        {editing ? (
          <>
            <Text style={styles.label}>Title</Text>
            <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholderTextColor={color.faint} />
            <Text style={styles.label}>Note</Text>
            <TextInput
              style={[styles.input, styles.noteInput]}
              value={note}
              onChangeText={setNote}
              multiline
              placeholderTextColor={color.faint}
            />
            <Text style={styles.label}>Date</Text>
            <DatePickerField value={date} onChange={setDate} minimumDate={new Date()} placeholder="Pick a date" mode="date" />
            <Text style={styles.label}>Time</Text>
            <DatePickerField value={time} onChange={setTime} placeholder="Pick a time" mode="time" />
            <View style={styles.editActions}>
              <Pressable style={styles.secondaryBtn} onPress={() => setEditing(false)} disabled={busy}>
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={handleSaveEdit} disabled={busy}>
                {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.primaryBtnText}>Save</Text>}
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={styles.whenRow}>
              <Clock size={16} color={color.mute} />
              <Text style={styles.whenText}>
                {new Date(reminder.remindAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                {' · '}
                {new Date(reminder.remindAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
            {reminder.note ? <Text style={styles.noteText}>{reminder.note}</Text> : null}

            <Pressable style={styles.secondaryBtn} onPress={() => setEditing(true)}>
              <Text style={styles.secondaryBtnText}>Edit</Text>
            </Pressable>

            {reminder.status === 'upcoming' && (
              <View style={styles.snoozeRow}>
                {SNOOZE_OPTIONS.map((opt) => (
                  <Pressable key={opt.minutes} style={styles.snoozeChip} onPress={() => handleSnooze(opt.minutes)} disabled={busy}>
                    <Text style={styles.snoozeChipText}>Snooze {opt.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Pressable style={styles.primaryBtn} onPress={handleToggleComplete} disabled={busy}>
              {busy ? <ActivityIndicator color={color.onInk} /> : (
                <>
                  {reminder.status === 'upcoming' ? <CheckCircle2 size={16} color={color.onInk} /> : <RotateCcw size={16} color={color.onInk} />}
                  <Text style={styles.primaryBtnText}>{reminder.status === 'upcoming' ? 'Mark complete' : 'Reopen'}</Text>
                </>
              )}
            </Pressable>

            <Text style={styles.disclaimer}>Device-local reminder — not synced to your account.</Text>
          </>
        )}
      </KeyboardSafeView>
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
  deleteBtn: { padding: 4 },
  headerTitle: { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  kav: { flex: 1 },
  scrollContent: { padding: space.lg, gap: space.sm, paddingBottom: space.xxxl },
  targetRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md, marginBottom: space.sm,
  },
  targetText: { ...t.body, color: color.ink, fontWeight: '600', flex: 1 },
  completedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#DCFCE7', borderRadius: radius.md, padding: space.sm, marginBottom: space.sm,
  },
  completedBannerText: { ...t.small, color: color.success, fontWeight: '700' },
  whenRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  whenText: { ...t.body, color: color.ink, fontWeight: '600' },
  noteText: { ...t.body, color: color.mute, marginTop: space.xs },
  label: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginTop: space.md },
  input: {
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.sm + 2,
  },
  noteInput: { minHeight: 72, textAlignVertical: 'top' },
  editActions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  snoozeRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  snoozeChip: {
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  snoozeChipText: { ...t.small, color: color.ink, fontWeight: '600' },
  secondaryBtn: {
    marginTop: space.md, alignItems: 'center', paddingVertical: space.sm + 2,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  secondaryBtnText: { ...t.body, color: color.ink, fontWeight: '700' },
  primaryBtn: {
    marginTop: space.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, ...shadow.card,
  },
  primaryBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },
  disclaimer: { ...t.small, color: color.faint, marginTop: space.lg, textAlign: 'center' },
  emptyText: { ...t.body, color: color.mute },
});
