/**
 * Create reminder — /reminders/new
 *
 * Optional query params let a contextual "Remind me" entry point on another
 * screen preselect an attachment without the user re-picking it here:
 *   targetType=trip|plan_item|saved_place, targetId, tripId (plan_item only), targetLabel
 * With no params the screen defaults to a freeform "custom" reminder and lets
 * the user optionally attach it to a trip, plan item, or saved place.
 *
 * Absolute-instant semantics: the date + time fields the user picks are
 * combined into one fixed Date and stored as an ISO string. That instant
 * never recomputes later — see src/services/reminders.ts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Alert, Platform, TextInput,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MapPin, Plane, CalendarClock, Bookmark, Sparkles } from 'lucide-react-native';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView.tsx';
import { DatePickerField } from '../../src/components/DateTimePickerField.tsx';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { createReminder, type ReminderTargetType } from '../../src/services/reminders.ts';
import { listMyTrips, type TripRow } from '../../src/services/trips.ts';
import { fetchTripPlan } from '../../src/services/tripPlan.ts';
import type { TripPlanItem } from '../../src/types/models.ts';
import { listSaved, type BookmarkedPlace } from '../../src/services/discoveryBookmarks.ts';

const TARGET_TYPES: Array<{ type: ReminderTargetType; label: string; icon: typeof Sparkles }> = [
  { type: 'custom', label: 'Custom', icon: Sparkles },
  { type: 'trip', label: 'Trip', icon: Plane },
  { type: 'plan_item', label: 'Plan item', icon: CalendarClock },
  { type: 'saved_place', label: 'Saved place', icon: Bookmark },
];

function combineDateAndTime(date: Date, time: Date): Date {
  const combined = new Date(date);
  combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return combined;
}

export default function NewReminderScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, configured } = useSession();
  const params = useLocalSearchParams<{
    targetType?: string; targetId?: string; tripId?: string; targetLabel?: string;
  }>();

  const presetTargetType = (params.targetType as ReminderTargetType | undefined) ?? null;

  const [targetType, setTargetType] = useState<ReminderTargetType>(presetTargetType ?? 'custom');
  const [targetId, setTargetId] = useState<string | null>(params.targetId ?? null);
  const [tripId, setTripId] = useState<string | null>(params.tripId ?? null);
  const [targetLabel, setTargetLabel] = useState<string | null>(params.targetLabel ?? null);

  const [title, setTitle] = useState(params.targetLabel ?? '');
  const [note, setNote] = useState('');
  const [date, setDate] = useState<Date | null>(null);
  const [time, setTime] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Attachment pickers (only loaded when relevant) ────────────────────────
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [planItems, setPlanItems] = useState<TripPlanItem[]>([]);
  const [planItemsLoading, setPlanItemsLoading] = useState(false);
  const [places, setPlaces] = useState<BookmarkedPlace[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);

  const locked = !!presetTargetType; // came in preselected from a contextual entry point

  useEffect(() => {
    if (locked) return;
    if (targetType === 'trip' || targetType === 'plan_item') {
      setTripsLoading(true);
      listMyTrips().then(setTrips).catch(() => setTrips([])).finally(() => setTripsLoading(false));
    }
    if (targetType === 'saved_place') {
      setPlacesLoading(true);
      listSaved().then(setPlaces).catch(() => setPlaces([])).finally(() => setPlacesLoading(false));
    }
  }, [targetType, locked]);

  const loadPlanItems = useCallback((forTripId: string) => {
    setPlanItemsLoading(true);
    fetchTripPlan(forTripId)
      .then((res) => setPlanItems(res.items ?? []))
      .catch(() => setPlanItems([]))
      .finally(() => setPlanItemsLoading(false));
  }, []);

  function selectTargetType(newType: ReminderTargetType) {
    setTargetType(newType);
    setTargetId(null);
    setTripId(null);
    setTargetLabel(null);
    setPlanItems([]);
  }

  function selectTrip(trip: TripRow) {
    setTripId(trip.id);
    if (targetType === 'trip') {
      setTargetId(trip.id);
      setTargetLabel(trip.title);
      if (!title) setTitle(trip.title);
    } else {
      // plan_item: picking the trip just scopes the plan-item list next.
      setTargetId(null);
      loadPlanItems(trip.id);
    }
  }

  function selectPlanItem(item: TripPlanItem) {
    setTargetId(item.id);
    setTargetLabel(item.title);
    if (!title) setTitle(item.title);
  }

  function selectPlace(place: BookmarkedPlace) {
    setTargetId(place.id);
    setTargetLabel(place.name);
    if (!title) setTitle(place.name);
  }

  async function handleCreate() {
    if (!title.trim()) {
      Alert.alert('Add a title', 'Give this reminder a title first.');
      return;
    }
    if (!date || !time) {
      Alert.alert('Pick a date and time', 'Choose when this reminder should fire.');
      return;
    }
    const remindAt = combineDateAndTime(date, time);
    if (remindAt.getTime() <= Date.now()) {
      Alert.alert('That time has passed', 'Pick a date and time in the future.');
      return;
    }
    if (targetType === 'plan_item' && !tripId) {
      Alert.alert('Pick a trip', 'Plan-item reminders need a trip selected first.');
      return;
    }
    if (targetType !== 'custom' && !targetId) {
      Alert.alert('Pick a target', `Choose which ${targetType === 'trip' ? 'trip' : targetType === 'plan_item' ? 'plan item' : 'saved place'} to attach this reminder to.`);
      return;
    }

    setSaving(true);
    try {
      await createReminder({
        title: title.trim(),
        note: note.trim() || null,
        remindAt: remindAt.toISOString(),
        targetType,
        targetId,
        tripId: targetType === 'plan_item' ? tripId : null,
        targetLabel,
      });
      router.back();
    } catch (e: any) {
      Alert.alert('Could not create reminder', e?.message ?? 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  if (!configured || !isAuthed) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.emptyText}>Sign in to create reminders.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>New reminder</Text>
      </View>

      <KeyboardSafeView style={styles.kav} contentContainerStyle={styles.scrollContent}>
        {/* Target type selector */}
        <Text style={styles.label}>Attach to</Text>
        {locked ? (
          <View style={styles.lockedTarget}>
            {(() => {
              const meta = TARGET_TYPES.find((tt) => tt.type === targetType);
              const Icon = meta?.icon ?? Sparkles;
              return (
                <>
                  <Icon size={16} color={color.signal} />
                  <Text style={styles.lockedTargetText}>{meta?.label}: {targetLabel}</Text>
                </>
              );
            })()}
          </View>
        ) : (
          <View style={styles.typeRow}>
            {TARGET_TYPES.map(({ type, label, icon: Icon }) => {
              const active = targetType === type;
              return (
                <Pressable
                  key={type}
                  style={[styles.typeChip, active && styles.typeChipActive]}
                  onPress={() => selectTargetType(type)}
                >
                  <Icon size={14} color={active ? color.onInk : color.mute} />
                  <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Trip picker (trip + plan_item types) */}
        {!locked && (targetType === 'trip' || targetType === 'plan_item') && (
          <View style={styles.pickerBlock}>
            <Text style={styles.subLabel}>{targetType === 'trip' ? 'Which trip?' : 'Which trip is the plan item in?'}</Text>
            {tripsLoading ? (
              <ActivityIndicator color={color.signal} />
            ) : trips.length === 0 ? (
              <Text style={styles.emptyText}>No trips yet.</Text>
            ) : (
              <View style={styles.chipWrap}>
                {trips.map((trip) => (
                  <Pressable
                    key={trip.id}
                    style={[styles.pickChip, tripId === trip.id && styles.pickChipActive]}
                    onPress={() => selectTrip(trip)}
                  >
                    <Text style={[styles.pickChipText, tripId === trip.id && styles.pickChipTextActive]} numberOfLines={1}>
                      {trip.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Plan item picker (only once a trip is chosen) */}
        {!locked && targetType === 'plan_item' && tripId && (
          <View style={styles.pickerBlock}>
            <Text style={styles.subLabel}>Which plan item?</Text>
            {planItemsLoading ? (
              <ActivityIndicator color={color.signal} />
            ) : planItems.length === 0 ? (
              <Text style={styles.emptyText}>No plan items in this trip yet.</Text>
            ) : (
              <View style={styles.chipWrap}>
                {planItems.map((item) => (
                  <Pressable
                    key={item.id}
                    style={[styles.pickChip, targetId === item.id && styles.pickChipActive]}
                    onPress={() => selectPlanItem(item)}
                  >
                    <Text style={[styles.pickChipText, targetId === item.id && styles.pickChipTextActive]} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Saved place picker */}
        {!locked && targetType === 'saved_place' && (
          <View style={styles.pickerBlock}>
            <Text style={styles.subLabel}>Which saved place?</Text>
            {placesLoading ? (
              <ActivityIndicator color={color.signal} />
            ) : places.length === 0 ? (
              <Text style={styles.emptyText}>No saved places yet.</Text>
            ) : (
              <View style={styles.chipWrap}>
                {places.map((place) => (
                  <Pressable
                    key={place.id}
                    style={[styles.pickChip, targetId === place.id && styles.pickChipActive]}
                    onPress={() => selectPlace(place)}
                  >
                    <MapPin size={12} color={targetId === place.id ? color.onInk : color.mute} />
                    <Text style={[styles.pickChipText, targetId === place.id && styles.pickChipTextActive]} numberOfLines={1}>
                      {place.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Title */}
        <Text style={styles.label}>Title</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What's this reminder for?"
          placeholderTextColor={color.faint}
        />

        {/* Note */}
        <Text style={styles.label}>Note (optional)</Text>
        <TextInput
          style={[styles.input, styles.noteInput]}
          value={note}
          onChangeText={setNote}
          placeholder="Any extra detail"
          placeholderTextColor={color.faint}
          multiline
        />

        {/* Date + time */}
        <Text style={styles.label}>Date</Text>
        <DatePickerField value={date} onChange={setDate} minimumDate={new Date()} placeholder="Pick a date" mode="date" />

        <Text style={styles.label}>Time</Text>
        <DatePickerField value={time} onChange={setTime} placeholder="Pick a time" mode="time" />

        <Text style={styles.disclaimer}>
          This reminder lives on this device only. It won't sync to your other devices or survive a reinstall.
        </Text>

        <Pressable style={[styles.createBtn, saving && styles.createBtnDisabled]} onPress={handleCreate} disabled={saving}>
          {saving ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.createBtnText}>Create reminder</Text>}
        </Pressable>
      </KeyboardSafeView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised,
  },
  backBtn: { padding: 4 },
  headerTitle: { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  kav: { flex: 1 },
  scrollContent: { padding: space.lg, gap: space.sm, paddingBottom: space.xxxl },
  label: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginTop: space.md },
  subLabel: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.xs },
  input: {
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.sm + 2,
  },
  noteInput: { minHeight: 72, textAlignVertical: 'top' },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  typeChipActive: { backgroundColor: color.ink, borderColor: color.ink },
  typeChipText: { ...t.small, color: color.mute, fontWeight: '600' },
  typeChipTextActive: { color: color.onInk },
  lockedTarget: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  lockedTargetText: { ...t.body, color: color.ink, fontWeight: '600', flex: 1 },
  pickerBlock: { marginTop: space.xs },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pickChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 220,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  pickChipActive: { backgroundColor: color.signal, borderColor: color.signal },
  pickChipText: { ...t.small, color: color.ink, fontWeight: '600' },
  pickChipTextActive: { color: color.onInk },
  disclaimer: { ...t.small, color: color.faint, marginTop: space.lg },
  createBtn: {
    marginTop: space.lg, backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: space.md, alignItems: 'center', ...shadow.card,
  },
  createBtnDisabled: { opacity: 0.6 },
  createBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },
  emptyText: { ...t.body, color: color.mute },
});
