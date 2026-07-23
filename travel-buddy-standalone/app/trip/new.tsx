import React, { useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, StyleSheet, Switch } from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { CalendarDays, MapPin, X, Sparkles } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { createTrip } from '../../src/services/trips';
import { draftTripFromText } from '../../src/services/tripIntel';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { DestinationListEditor, type DestinationEntry } from '../../src/components/trip/DestinationListEditor';
import { addDestination } from '../../src/services/tripDestinations';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import { useStampToast } from '../../src/components/stamps/StampEarnedToast';

export default function NewTrip() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { checkForNewStamps } = useStampToast();

  // ── NL draft box ──────────────────────────────────────────────────────────
  const [nlText, setNlText] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);

  // ── Single-destination form fields ────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [tripNotes, setTripNotes] = useState('');

  // ── Multi-city ────────────────────────────────────────────────────────────
  const [multiCity, setMultiCity] = useState(false);
  const [destinations, setDestinations] = useState<DestinationEntry[]>([]);

  // ── Save state ────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [calOpen, setCalOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);

  // Synchronous guard: prevents re-entry on a rapid double-tap before the
  // setBusy(true) state update has caused a re-render and updated the
  // Pressable's `disabled` prop. Unlike the React state flag, a ref update
  // is immediate and visible within the same JS turn.
  const saveLock = useRef(false);

  // ── NL draft handler ──────────────────────────────────────────────────────
  const handleNLDraft = useCallback(async () => {
    const text = nlText.trim();
    if (!text) return;
    setNlBusy(true);
    setNlError(null);
    try {
      const result = await draftTripFromText(text);
      if (!result) {
        // Feature disabled or service unavailable — silently allow the user to
        // continue filling the form manually.
        return;
      }
      const draft = result.draft as Record<string, unknown>;
      if (typeof draft.title === 'string' && draft.title) setTitle(draft.title);

      // ── Destination pre-fill: multi-city takes priority over single ──────────
      const rawDestinations = Array.isArray(draft.destinations) ? draft.destinations : null;
      const validDestinations = rawDestinations
        ? (rawDestinations as Array<Record<string, unknown>>)
            .filter((d) => typeof d.city === 'string' && d.city)
        : null;

      if (validDestinations && validDestinations.length > 1) {
        // Multi-city: switch toggle on and populate DestinationListEditor
        setMultiCity(true);
        setDestinations(
          validDestinations.map((d) => ({
            key: `dest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            city: d.city as string,
            country: typeof d.country === 'string' && d.country ? d.country : undefined,
            arrivalDate: typeof d.arrivalDate === 'string' && d.arrivalDate ? d.arrivalDate : undefined,
            departureDate: typeof d.departureDate === 'string' && d.departureDate ? d.departureDate : undefined,
          })),
        );
      } else if (validDestinations && validDestinations.length === 1) {
        // Single destination from the array — stay in single mode
        const d = validDestinations[0];
        const city = d.city as string;
        const country = typeof d.country === 'string' && d.country ? d.country : undefined;
        setPlace({
          name: city,
          city,
          country,
          displayName: country ? `${city}, ${country}` : city,
        } as Place);
      } else if (typeof draft.destinationCity === 'string' && draft.destinationCity) {
        // Existing single-destination fallback path (unchanged)
        const city = draft.destinationCity as string;
        const country = typeof draft.destinationCountry === 'string' ? draft.destinationCountry : undefined;
        setPlace({
          name: city,
          city,
          country,
          displayName: country ? `${city}, ${country}` : city,
        } as Place);
      }

      if (typeof draft.startDate === 'string') setStartDate(draft.startDate);
      if (typeof draft.endDate === 'string') setEndDate(draft.endDate);
      if (typeof draft.notes === 'string') setTripNotes(draft.notes);
      if (typeof draft.tripNotes === 'string') setTripNotes(draft.tripNotes);
    } catch {
      setNlError('Could not generate a draft. Fill the form manually.');
    } finally {
      setNlBusy(false);
    }
  }, [nlText]);

  // ── Create trip ───────────────────────────────────────────────────────────
  const create = useCallback(async () => {
    // Synchronous guard — checked before any async work or React state update.
    // setBusy(true) below is async (deferred until next render), so a rapid
    // double-tap could bypass the `disabled={busy}` check and re-enter this
    // handler before the button has re-rendered as disabled.
    if (saveLock.current) return;
    saveLock.current = true;

    setError(null);
    if (!title.trim()) { setError('Add a trip name.'); saveLock.current = false; return; }

    if (multiCity) {
      const activeDestinations = destinations.filter((d) => !d.removed && d.city);
      if (activeDestinations.length === 0) {
        setError('Add at least one destination.');
        saveLock.current = false;
        return;
      }
    } else if (!place) {
      setError('Add a destination.');
      saveLock.current = false;
      return;
    }

    if (!live) { setError('Sign in to create a trip.'); saveLock.current = false; return; }
    setBusy(true);

    try {
      // Use first multi-city destination as the primary, or the single place
      const primaryCity = multiCity
        ? destinations.filter((d) => !d.removed && d.city)[0]
        : null;

      const trip = await createTrip({
        title: title.trim(),
        destinationCity: primaryCity?.city ?? (place?.city ?? place?.name ?? ''),
        destinationCountry: primaryCity?.country ?? place?.country ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        status: 'planning',
        visibility: 'private',
        tripNotes: tripNotes.trim() || null,
      });
      if (!trip) { setError('Could not create the trip. Try again.'); return; }

      // Persist ALL multi-city destinations to trip_destinations (including stop 0).
      // The primary trip fields (destination_city/country) hold a copy for legacy
      // single-destination display; the canonical ordered list lives in trip_destinations
      // so edit-screen hydration via listDestinations() returns all stops.
      if (multiCity) {
        const active = destinations.filter((d) => !d.removed && d.city);
        for (let i = 0; i < active.length; i++) {
          const d = active[i];
          await addDestination(trip.id, {
            city: d.city,
            country: d.country,
            lat: d.lat,
            lng: d.lng,
            placeId: d.placeId,
            arrivalDate: d.arrivalDate,
            departureDate: d.departureDate,
            position: i + 1,
          });
        }
      }

      checkForNewStamps(2000);
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
      saveLock.current = false;
    }
  }, [title, place, live, startDate, endDate, tripNotes, checkForNewStamps, multiCity, destinations]);

  const startD = startDate ? fromISODate(startDate) : null;
  const endD = endDate ? fromISODate(endDate) : null;

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      <ScreenHeader title="New trip" back />

      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
      >
        {/* NL draft box — hidden when draftTripFromText is unavailable (service
            returns null on 404 feature_disabled). Because draftTripFromText is
            async, we always render the box and let handleNLDraft be a no-op
            when the service is off; the box is hidden only when the feature
            flag explicitly makes the function return null (tested by mocking). */}
        <View style={styles.nlBox}>
          <Text style={styles.label}>Describe your trip (optional)</Text>
          <TextInput
            style={[styles.input, styles.nlInput]}
            placeholder="e.g. Two weeks in Japan in October, mix of Tokyo and Kyoto…"
            placeholderTextColor={color.faint}
            value={nlText}
            onChangeText={setNlText}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            testID="nl-input"
          />
          {nlError ? <Text style={styles.error}>{nlError}</Text> : null}
          <Pressable
            style={[styles.nlBtn, (!nlText.trim() || nlBusy) && { opacity: 0.5 }]}
            onPress={handleNLDraft}
            disabled={!nlText.trim() || nlBusy}
            testID="nl-submit"
            accessibilityLabel="Generate trip draft from description"
          >
            {nlBusy
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <><Sparkles size={13} color={color.onInk} /><Text style={styles.nlBtnText}>Pre-fill form</Text></>}
          </Pressable>
        </View>

        {/* Trip name */}
        <Field label="Trip name" placeholder="Visayas, June" value={title} onChange={setTitle} />

        {/* Destination — single or multi-city */}
        <View>
          <View style={styles.destinationHeader}>
            <Text style={styles.label}>Destination</Text>
            <View style={styles.multiCityRow}>
              <Text style={styles.multiCityLabel}>Multi-city</Text>
              <Switch
                value={multiCity}
                onValueChange={setMultiCity}
                trackColor={{ true: color.signal, false: color.haze }}
                thumbColor={color.paperRaised}
                accessibilityLabel="Toggle multi-city mode"
                testID="multi-city-toggle"
              />
            </View>
          </View>

          {multiCity ? (
            <DestinationListEditor
              destinations={destinations}
              onChange={setDestinations}
            />
          ) : (
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
          )}
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

      {/* Place picker — single-destination mode only */}
      <GlobalPlacePicker
        visible={placeOpen}
        title="Destination"
        allowGPS={false}
        usedFor="trip_destination"
        onSelect={(p) => setPlace(p)}
        onClose={() => setPlaceOpen(false)}
      />
    </KeyboardSafeScrollView>
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
  nlBox: { gap: space.sm },
  nlInput: { height: 80, paddingTop: space.md },
  nlBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    backgroundColor: color.ink, paddingVertical: space.sm, borderRadius: radius.md,
  },
  nlBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
  destinationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  multiCityRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  multiCityLabel: { ...t.small, color: color.mute, fontWeight: '600' },
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
