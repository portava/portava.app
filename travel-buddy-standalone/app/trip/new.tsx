import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, StyleSheet, Switch, Alert, Image } from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { CalendarDays, MapPin, X, Sparkles, ImagePlus } from 'lucide-react-native';
import { AppHeader } from '../../src/components/ui/AppHeader';
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
// Global Input Intelligence — Phase 2 (Geographic Core). Pure helpers only
// (registry + trip-destination hydration + binding type); no RN/network here.
import { registerGeographicFields, GEO_FIELD_IDS } from '../../src/platform/input-assistance/geographic/geoFields.ts';
import { hydrateTripDestination } from '../../src/platform/input-assistance/geographic/tripDestination.ts';
import type { CanonicalPlaceBinding } from '../../src/platform/input-assistance/geographic/canonicalBinding.ts';
// Global Input Intelligence — Phase 5 (Creation). Inline, NON-BLOCKING §23
// validation on the trip title (e.g. date-conflict explanation). A trip is not a
// deduped entity kind, so this surfaces validation only. Degrades to nothing when
// the (parallel-PR) endpoint is absent; never blocks or changes submit.
import { useCreationAssistance } from '../../src/hooks/useCreationAssistance.ts';
import { CreationAssist, AiWritingAssist, CREATION_FIELD_IDS } from '../../src/platform/input-assistance';
// Global Input Intelligence — Phase 7 (Compass + AI). OPT-IN, provenance-marked
// AI title suggestions (§22): nothing is requested until the traveler taps
// "Suggest with AI", nothing is auto-applied (tap-to-insert into the editable
// field), and the whole surface degrades to nothing when the AI flag is off.
import { useAiWritingAssist } from '../../src/hooks/useAiWritingAssist.ts';
import { useStampToast } from '../../src/components/stamps/StampEarnedToast';
import { uploadMedia, type PickedMedia } from '../../src/services/media.ts';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';

export default function NewTrip() {
  const { pickMedia } = useMediaPicker();
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { checkForNewStamps } = useStampToast();

  // ── NL draft box ──────────────────────────────────────────────────────────
  const [nlText, setNlText] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);

  // Register the geographic field policies once (§5/§52 — idempotent).
  useEffect(() => { registerGeographicFields(); }, []);

  // ── Single-destination form fields ────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  // §17/§53 — canonical binding captured when the destination is picked
  // (city id + country + timezone + coordinates). Dependent fields can inherit it.
  const [destBinding, setDestBinding] = useState<CanonicalPlaceBinding | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [tripNotes, setTripNotes] = useState('');

  // §23 — inline, NON-BLOCKING validation on the trip title. A trip is not a
  // deduped entity kind (allowedKinds: [] → no duplicate rows), so this surfaces
  // validation only — e.g. a date conflict with the viewer's existing trips, using
  // the candidate window below. Degrades to nothing when the endpoint is absent.
  const titleAssist = useCreationAssistance({
    context: 'trip_title',
    fieldId: CREATION_FIELD_IDS.tripTitle,
    text: title,
    allowedKinds: [],
    sessionContext: {
      surface: 'trip_create',
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
    },
  });

  // §22 — OPT-IN AI title suggestions. Off until the traveler taps the button;
  // the coarse (city-level) draft feeds the model, never coordinates (§29).
  const [titleAiOptIn, setTitleAiOptIn] = useState(false);
  const titleAi = useAiWritingAssist({
    context: 'trip_title',
    fieldId: CREATION_FIELD_IDS.tripTitle,
    text: title,
    optedIn: titleAiOptIn,
    city: destBinding?.city ?? null,
    draft: {
      city: destBinding?.city ?? undefined,
      country: destBinding?.country ?? undefined,
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
    },
    sessionContext: { surface: 'trip_create' },
  });

  // ── Multi-city ────────────────────────────────────────────────────────────
  const [multiCity, setMultiCity] = useState(false);
  const [destinations, setDestinations] = useState<DestinationEntry[]>([]);

  // ── Cover photo ───────────────────────────────────────────────────────────
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverImageDims, setCoverImageDims] = useState<{ width: number | null; height: number | null } | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);

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

  // ── Cover photo picker ────────────────────────────────────────────────────
  const pickCover = useCallback(async () => {
    const assets = await pickMedia({ title: 'Add cover photo', mediaTypes: ['images'], quality: 0.9 });
    if (!assets || assets.length === 0) return;
    const asset = assets[0];
    const picked: PickedMedia = {
      uri: asset.uri,
      type: 'image',
      fileName: asset.fileName ?? `cover_${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileSize: asset.fileSize ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      duration: null,
    };
    setCoverUploading(true);
    try {
      const upload = await uploadMedia(picked, { surface: 'trip' });
      if (!upload.ok || !upload.url) {
        Alert.alert('Upload failed', upload.message ?? 'Could not upload the photo. Try again.');
        return;
      }
      setCoverUrl(upload.url);
      setCoverImageDims({ width: upload.width ?? null, height: upload.height ?? null });
    } finally {
      setCoverUploading(false);
    }
  }, [pickMedia]);

  // ── NL draft handler ──────────────────────────────────────────────────────
  const handleNLDraft = useCallback(async () => {
    const text = nlText.trim();
    if (!text) return;
    setNlBusy(true);
    setNlError(null);
    try {
      const result = await draftTripFromText(text);
      if (!result) {
        setNlError('Pre-fill is not available right now — fill the form manually or try again.');
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
        // Single destination from the array — stay in single mode.
        // hydrateTripDestination builds a well-formed Place (real id + fields)
        // instead of the old `{…} as Place` with null id/lat/lng, so the value
        // can be canonically resolved on save rather than persisted raw.
        const d = validDestinations[0];
        const city = d.city as string;
        const country = typeof d.country === 'string' && d.country ? d.country : undefined;
        setPlace(hydrateTripDestination(city, country));
        setDestBinding(null);
      } else if (typeof draft.destinationCity === 'string' && draft.destinationCity) {
        // Existing single-destination fallback path.
        const city = draft.destinationCity as string;
        const country = typeof draft.destinationCountry === 'string' ? draft.destinationCountry : undefined;
        setPlace(hydrateTripDestination(city, country));
        setDestBinding(null);
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
        // Prefer the canonical binding's spelling when the destination was picked
        // (§53), else the place fields, else the multi-city primary.
        destinationCity: primaryCity?.city ?? (destBinding?.city ?? place?.city ?? place?.name ?? ''),
        destinationCountry: primaryCity?.country ?? (destBinding?.country ?? place?.country ?? undefined),
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        status: 'planning',
        visibility: 'private',
        tripNotes: tripNotes.trim() || null,
        coverUrl: coverUrl ?? undefined,
        coverImageWidth:  coverImageDims?.width  ?? undefined,
        coverImageHeight: coverImageDims?.height ?? undefined,
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
  }, [title, place, destBinding, live, startDate, endDate, tripNotes, checkForNewStamps, multiCity, destinations, coverUrl]);

  const startD = startDate ? fromISODate(startDate) : null;
  const endD = endDate ? fromISODate(endDate) : null;

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="New trip" onBack={router.back} />

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
        <CreationAssist duplicates={titleAssist.duplicates} validation={titleAssist.validation} />
        {/* §22 — opt-in, tap-to-insert AI title suggestions (secondary to the
            §23 validation above; nothing auto-applied, degrades to nothing when off). */}
        {title.trim().length >= 1 ? (
          titleAiOptIn ? (
            <AiWritingAssist
              proposals={titleAi.proposals}
              loading={titleAi.loading}
              heading="AI title ideas"
              onInsert={(p) => setTitle(p.insertText)}
            />
          ) : (
            <Pressable
              onPress={() => setTitleAiOptIn(true)}
              style={styles.aiTitleBtn}
              accessibilityRole="button"
              accessibilityLabel="Suggest a trip title with AI"
            >
              <Sparkles size={13} color={color.signal} />
              <Text style={styles.aiTitleBtnText}>Suggest with AI</Text>
            </Pressable>
          )
        ) : null}

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
                <Pressable hitSlop={8} onPress={() => { setPlace(null); setDestBinding(null); }}>
                  <X size={14} color={color.mute} />
                </Pressable>
              )}
            </Pressable>
          )}
        </View>

        {/* Cover photo */}
        <View>
          <Text style={styles.label}>Cover photo (optional)</Text>
          {coverUrl ? (
            <View style={styles.coverPreview}>
              <Image source={{ uri: coverUrl }} style={styles.coverImg} resizeMode="cover" />
              <View style={styles.coverActions}>
                <Pressable
                  style={styles.coverBtn}
                  onPress={pickCover}
                  disabled={coverUploading}
                  accessibilityLabel="Change cover photo"
                >
                  {coverUploading
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : <Text style={styles.coverBtnText}>Change</Text>}
                </Pressable>
                <Pressable
                  style={[styles.coverBtn, styles.coverBtnRemove]}
                  onPress={() => setCoverUrl(null)}
                  disabled={coverUploading}
                  accessibilityLabel="Remove cover photo"
                >
                  <Text style={[styles.coverBtnText, { color: color.mute }]}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={styles.coverPicker}
              onPress={pickCover}
              disabled={coverUploading}
              accessibilityLabel="Add cover photo"
              testID="cover-photo-picker"
            >
              {coverUploading
                ? <ActivityIndicator size="small" color={color.signal} />
                : (
                  <>
                    <ImagePlus size={18} color={color.mute} />
                    <Text style={styles.coverPickerText}>Add a cover photo</Text>
                  </>
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

      {/* Place picker — single-destination mode only.
          §53 flagship: sources canonical suggestions from the P1 gateway
          (assistContext) and captures the canonical binding on select. */}
      <GlobalPlacePicker
        visible={placeOpen}
        title="Destination"
        allowGPS={false}
        usedFor="trip_destination"
        assistContext="trip_destination"
        assistFieldId={GEO_FIELD_IDS.tripDestination}
        sessionContext={{ surface: 'trip_new' }}
        onCanonicalBinding={setDestBinding}
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
  aiTitleBtn: {
    flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze, backgroundColor: color.paperRaised,
    marginTop: space.xs,
  },
  aiTitleBtnText: { ...t.small, fontWeight: '700', color: color.signal },
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
  coverPreview: { borderRadius: radius.md, overflow: 'hidden' },
  coverImg: { width: '100%', height: 160 },
  coverActions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  coverBtn: {
    flex: 1, paddingVertical: space.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center',
    backgroundColor: color.paperRaised,
  },
  coverBtnRemove: {},
  coverBtnText: { ...t.small, color: color.ink, fontWeight: '600' },
  coverPicker: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, borderWidth: 1, borderColor: color.haze, borderStyle: 'dashed',
    borderRadius: radius.md, paddingVertical: space.lg,
    backgroundColor: color.paperRaised,
  },
  coverPickerText: { ...t.small, color: color.mute },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  hint: { ...t.small, color: color.mute },
  create: {
    backgroundColor: color.ink, paddingVertical: space.md,
    borderRadius: radius.pill, alignItems: 'center', marginTop: space.sm,
  },
  createText: { ...t.body, fontWeight: '700', color: color.onInk },
});
