import React, { useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { CalendarDays, MapPin, X } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { createTrip } from '../../src/services/trips';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import { useStampToast } from '../../src/components/stamps/StampEarnedToast';

export default function NewTrip() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { checkForNewStamps } = useStampToast();

  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [tripNotes, setTripNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [calOpen, setCalOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);

  // Synchronous guard: prevents re-entry on a rapid double-tap before the
  // setBusy(true) state update has caused a re-render and updated the
  // Pressable's `disabled` prop. Unlike the React state flag, a ref update
  // is immediate and visible within the same JS turn.
  const saveLock = useRef(false);

  const create = useCallback(async () => {
    // Synchronous guard — checked before any async work or React state update.
    // setBusy(true) below is async (deferred until next render), so a rapid
    // double-tap could bypass the `disabled={busy}` check and re-enter this
    // handler before the button has re-rendered as disabled.
    if (saveLock.current) return;
    saveLock.current = true;

    setError(null);
    if (!title.trim()) { setError('Add a trip name.'); saveLock.current = false; return; }
    if (!place) { setError('Add a destination.'); saveLock.current = false; return; }
    if (!live) { setError('Sign in to create a trip.'); saveLock.current = false; return; }
    setBusy(true);
    try {
      const trip = await createTrip({
        title: title.trim(),
        destinationCity: place.city ?? place.name,
        destinationCountry: place.country ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        status: 'planning',
        visibility: 'private',
        tripNotes: tripNotes.trim() || null,
      });
      if (!trip) { setError('Could not create the trip. Try again.'); return; }
      checkForNewStamps(2000);
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
      saveLock.current = false;
    }
  }, [title, place, live, startDate, endDate, tripNotes, checkForNewStamps]);

  const startD = startDate ? fromISODate(startDate) : null;
  const endD = endDate ? fromISODate(endDate) : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="New trip" back />

      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Trip name */}
        <Field label="Trip name" placeholder="Visayas, June" value={title} onChange={setTitle} />

        {/* Destination */}
        <View>
          <Text style={styles.label}>Destination</Text>
          <Pressable style={styles.pickerField} onPress={() => setPlaceOpen(true)}>
            <MapPin size={15} color={place ? color.signal : color.faint} />
            <Text style={[styles.pickerText, !place && styles.pickerPlaceholder]} numberOfLines={1}>
              {place ? place.displayName : 'Choose a city…'}
            </Text>
            {place && (
              <Pressable hitSlop={8} onPress={() => setPlace(null)}>
                <X size={14} color={color.mute} />
              </Pressable>
            )}
          </Pressable>
        </View>

        {/* Trip notes */}
        <View>
          <Text style={styles.label}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.notesInput]}
            placeholder="Add notes, reminders, or a description…"
            placeholderTextColor={color.faint}
            value={tripNotes}
            onChangeText={setTripNotes}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Dates */}
        <View>
          <Text style={styles.label}>Trip Dates (optional)</Text>
          <Pressable style={styles.pickerField} onPress={() => setCalOpen(true)}>
            <CalendarDays size={15} color={(startDate || endDate) ? color.signal : color.faint} />
            <Text style={[styles.pickerText, !(startDate || endDate) && styles.pickerPlaceholder]}>
              {startD && endD
                ? `${formatDisplayDate(startD)} – ${formatDisplayDate(endD)}`
                : startD
                ? `From ${formatDisplayDate(startD)}`
                : 'Add start & end dates'}
            </Text>
            {(startDate || endDate) && (
              <Pressable hitSlop={8} onPress={() => { setStartDate(null); setEndDate(null); }}>
                <X size={14} color={color.mute} />
              </Pressable>
            )}
          </Pressable>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!live ? <Text style={styles.hint}>Sign in to save trips to your account.</Text> : null}

        <Pressable style={[styles.create, busy && { opacity: 0.7 }]} onPress={create} disabled={busy}>
          {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.createText}>Create trip</Text>}
        </Pressable>
      </ScrollView>

      {/* Calendar picker — range mode */}
      <GlobalCalendarPicker
        mode="range"
        visible={calOpen}
        value={{ start: startDate, end: endDate }}
        allowPast
        onConfirm={({ start, end }) => {
          setStartDate(start);
          setEndDate(end);
          setCalOpen(false);
        }}
        onCancel={() => setCalOpen(false)}
        title="Trip Dates"
      />

      {/* Place picker */}
      <GlobalPlacePicker
        visible={placeOpen}
        title="Destination"
        allowGPS={false}
        usedFor="trip_destination"
        onSelect={(p) => setPlace(p)}
        onClose={() => setPlaceOpen(false)}
      />
    </View>
  );
}

function Field({
  label, placeholder, value, onChange,
}: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={color.faint}
        value={value}
        onChangeText={onChange}
        autoCapitalize="words"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  input: {
    ...t.body, color: color.ink,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  pickerField: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    minHeight: 50,
  },
  pickerText: { flex: 1, ...t.body, color: color.ink },
  pickerPlaceholder: { color: color.faint },
  notesInput: { height: 100, paddingTop: space.md },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  hint: { ...t.small, color: color.mute },
  create: {
    backgroundColor: color.ink, paddingVertical: space.md,
    borderRadius: radius.pill, alignItems: 'center', marginTop: space.sm,
  },
  createText: { ...t.body, fontWeight: '700', color: color.onInk },
});
