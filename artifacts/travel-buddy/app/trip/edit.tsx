import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator,
  ScrollView, StyleSheet, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarDays, MapPin, X } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { getTrip, updateTrip } from '../../src/services/trips';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import type { TripVisibility } from '../../src/types/models';

const VISIBILITY_OPTIONS: { value: TripVisibility; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'buddies', label: 'Buddies only' },
  { value: 'public', label: 'Public' },
];

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [notOwner, setNotOwner] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<TripVisibility>('private');
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

  useEffect(() => {
    if (!id || !live) { setLoading(false); return; }
    getTrip(id).then((tr) => {
      if (!tr) { setLoadError('Trip not found.'); setLoading(false); return; }
      if (tr.ownerId !== userId) { setNotOwner(true); setLoading(false); return; }
      setTitle(tr.title ?? '');
      const city = tr.destinationCity ?? '';
      const country = tr.destinationCountry ?? undefined;
      setPlace({
        name: city,
        city,
        country,
        displayName: country ? `${city}, ${country}` : city,
      } as Place);
      setStartDate(tr.startDate ?? null);
      setEndDate(tr.endDate ?? null);
      setVisibility((tr.visibility as TripVisibility) ?? 'private');
      setTripNotes(tr.tripNotes ?? '');
      setLoading(false);
    }).catch(() => { setLoadError('Could not load trip.'); setLoading(false); });
  }, [id, live, userId]);

  const save = useCallback(async () => {
    // Synchronous guard — checked before any async work or React state update.
    // setBusy(true) below is async (deferred until next render), so a rapid
    // double-tap could bypass the `disabled={busy}` check and re-enter this
    // handler before the button has re-rendered as disabled.
    if (saveLock.current) return;
    saveLock.current = true;

    setError(null);
    if (!title.trim()) { setError('Trip name is required.'); saveLock.current = false; return; }
    if (!place) { setError('Destination is required.'); saveLock.current = false; return; }
    if (!live || !id) { setError('Sign in to edit trips.'); saveLock.current = false; return; }
    setBusy(true);
    try {
      const updated = await updateTrip(id, {
        title: title.trim(),
        destinationCity: place.city ?? place.name,
        destinationCountry: place.country ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        visibility,
        tripNotes: tripNotes.trim() || null,
      });
      if (!updated) { setError('Could not save changes. Try again.'); return; }
      router.replace(`/trip/${id}` as any);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
      saveLock.current = false;
    }
  }, [title, place, live, id, startDate, endDate, visibility, tripNotes]);

  if (!live) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit trip" back />
        <View style={styles.center}>
          <Text style={styles.errorText}>Sign in to edit trips.</Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit trip" back />
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (notOwner) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit trip" back />
        <View style={styles.center}>
          <Text style={styles.errorText}>Only the trip owner can edit this trip.</Text>
        </View>
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit trip" back />
        <View style={styles.center}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      </View>
    );
  }

  const startD = startDate ? fromISODate(startDate) : null;
  const endD = endDate ? fromISODate(endDate) : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Edit trip" back />
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        <View>
          <Text style={styles.label}>Trip name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Visayas, June"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={setTitle}
            autoCapitalize="words"
          />
        </View>

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

        <View>
          <Text style={styles.label}>Trip dates (optional)</Text>
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

        <View>
          <Text style={styles.label}>Trip notes (optional)</Text>
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

        <View>
          <Text style={styles.label}>Who can see this trip</Text>
          <View style={styles.visRow}>
            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[styles.visBtn, visibility === opt.value && styles.visBtnActive]}
                onPress={() => setVisibility(opt.value)}
              >
                <Text style={[styles.visBtnText, visibility === opt.value && styles.visBtnTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Pressable style={[styles.saveBtn, busy && { opacity: 0.7 }]} onPress={save} disabled={busy}>
          {busy
            ? <ActivityIndicator color={color.onInk} />
            : <Text style={styles.saveBtnText}>Save changes</Text>}
        </Pressable>
      </ScrollView>

      <GlobalCalendarPicker
        mode="range"
        visible={calOpen}
        value={{ start: startDate, end: endDate }}
        allowPast
        onConfirm={({ start, end }) => { setStartDate(start); setEndDate(end); setCalOpen(false); }}
        onCancel={() => setCalOpen(false)}
        title="Trip Dates"
      />
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
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
  visRow: { flexDirection: 'row', gap: space.sm },
  visBtn: {
    flex: 1, paddingVertical: space.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center',
    backgroundColor: color.paperRaised,
  },
  visBtnActive: { borderColor: color.signal, backgroundColor: `${color.signal}10` },
  visBtnText: { ...t.small, color: color.mute, fontWeight: '600' },
  visBtnTextActive: { color: color.signal },
  errorText: { ...t.small, color: color.signal, fontWeight: '600' },
  saveBtn: {
    backgroundColor: color.ink, paddingVertical: space.md,
    borderRadius: radius.pill, alignItems: 'center', marginTop: space.sm,
  },
  saveBtnText: { ...t.body, fontWeight: '700', color: color.onInk },
});
