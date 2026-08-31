import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ActivityIndicator,
  ScrollView, StyleSheet, Alert, Image, Switch,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarDays, MapPin, X, ImagePlus, Film } from 'lucide-react-native';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { useSession } from '../../src/context/SessionContext';
import { getTrip, updateTrip, getTripMemberRole } from '../../src/services/trips';
import { uploadMedia, type PickedMedia } from '../../src/services/media';
import { VIDEO_MAX_DURATION_SECONDS } from '../../src/constants/mediaLimits';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { DestinationListEditor, type DestinationEntry } from '../../src/components/trip/DestinationListEditor';
import { listDestinations } from '../../src/services/tripDestinations';
import { VideoThumbnail } from '../../src/components/ui/VideoThumbnail';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import { resolveCanonicalPlace } from '../../src/lib/location/resolveCanonical';
// Global Input Intelligence — Phase 2 (Geographic Core).
import { registerGeographicFields, GEO_FIELD_IDS } from '../../src/platform/input-assistance/geographic/geoFields.ts';
import {
  hydrateTripDestination,
  prepareTripDestinationForSave,
} from '../../src/platform/input-assistance/geographic/tripDestination.ts';
import type { CanonicalPlaceBinding } from '../../src/platform/input-assistance/geographic/canonicalBinding.ts';
import type { TripVisibility } from '../../src/types/models';

const VISIBILITY_OPTIONS: { value: TripVisibility; label: string }[] = [
  { value: 'private', label: 'Private' },
  { value: 'buddies', label: 'Buddies only' },
  { value: 'public', label: 'Public' },
];

export default function EditTrip() {
  const { pickMedia } = useMediaPicker();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;

  const [loading, setLoading] = useState(true);
  const [notOwner, setNotOwner] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  // §17/§53 — canonical binding captured when the destination is re-picked.
  const [destBinding, setDestBinding] = useState<CanonicalPlaceBinding | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<TripVisibility>('private');
  const [tripNotes, setTripNotes] = useState('');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverMediaType, setCoverMediaType] = useState<'image' | 'video' | null>(null);
  const [coverImageDims, setCoverImageDims] = useState<{ width: number | null; height: number | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);
  // Whether non-members can see the cover image (only meaningful for private/buddies trips).
  const [showHeaderPublicly, setShowHeaderPublicly] = useState(false);

  // ── Multi-city ────────────────────────────────────────────────────────────
  const [multiCity, setMultiCity] = useState(false);
  const [destinations, setDestinations] = useState<DestinationEntry[]>([]);

  // Synchronous guard: prevents re-entry on a rapid double-tap before the
  // setBusy(true) state update has caused a re-render and updated the
  // Pressable's `disabled` prop. Unlike the React state flag, a ref update
  // is immediate and visible within the same JS turn.
  const saveLock = useRef(false);

  // Register the geographic field policies once (§5/§52 — idempotent).
  useEffect(() => { registerGeographicFields(); }, []);

  useEffect(() => {
    if (!id || !live) { setLoading(false); return; }
    getTrip(id).then(async (tr) => {
      if (!tr) { setLoadError('Trip not found.'); setLoading(false); return; }
      if (tr.ownerId !== userId) {
        // Co-hosts can manage trip settings too (same permission model as
        // trip/[id].tsx's isOwnerOrCohost checks) — only block true outsiders.
        const role = await getTripMemberRole(id).catch(() => null);
        if (role !== 'co_host') { setNotOwner(true); setLoading(false); return; }
      }
      setTitle(tr.title ?? '');
      // Build a well-formed Place (real id + fields) from the stored destination
      // instead of the old `{…} as Place` with null id/lat/lng. That placeholder
      // carried no canonicalId, so saving without re-picking persisted a
      // non-canonical destination (audit bug). The value is now canonically
      // resolved on save (see `save` below).
      setPlace(hydrateTripDestination(tr.destinationCity, tr.destinationCountry));
      setDestBinding(null);
      setStartDate(tr.startDate ?? null);
      setEndDate(tr.endDate ?? null);
      setVisibility((tr.visibility as TripVisibility) ?? 'private');
      setTripNotes(tr.tripNotes ?? '');
      setCoverUrl(tr.coverUrl ?? null);
      setCoverMediaType(tr.coverMediaType ?? null);
      setShowHeaderPublicly(tr.showHeaderPublicly ?? false);
      setLoading(false);
    }).catch(() => { setLoadError('Could not load trip.'); setLoading(false); });
  }, [id, live, userId]);

  // Load existing destinations when multi-city is toggled on
  useEffect(() => {
    if (!multiCity || !id || !live) return;
    listDestinations(id).then((rows) => {
      if (rows.length > 0) {
        setDestinations(rows.map((r) => ({
          key: `loaded-${r.id}`,
          id: r.id,
          city: r.city,
          country: r.country,
          lat: r.lat,
          lng: r.lng,
          placeId: r.place_id,
          arrivalDate: r.arrival_date,
          departureDate: r.departure_date,
        })));
      }
    }).catch(() => {});
  }, [multiCity, id, live]);

  const pickCover = useCallback(async () => {
    const assets = await pickMedia({
      title: 'Add cover',
      mediaTypes: ['images', 'videos'],
      quality: 0.9,
      videoMaxDuration: VIDEO_MAX_DURATION_SECONDS.trip,
    });
    if (!assets || assets.length === 0) return;
    const asset = assets[0];
    const isVideo = asset.type === 'video';
    const picked: PickedMedia = {
      uri: asset.uri,
      type: isVideo ? 'video' : 'image',
      fileName: asset.fileName ?? `cover_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`,
      mimeType: asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
      fileSize: asset.fileSize ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      duration: isVideo && asset.duration ? asset.duration / 1000 : null,
    };
    setUploading(true);
    try {
      const upload = await uploadMedia(picked, { surface: 'trip' });
      if (!upload.ok || !upload.url) {
        const uploadMsg =
          upload.errorKind === 'rate_limited' ? 'Too many uploads — please wait a moment and try again.' :
          upload.errorKind === 'invalid_payload' ? "This file couldn't be read — try a different photo." :
          (upload.message ?? 'Could not upload cover. Please try again.');
        Alert.alert('Upload failed', uploadMsg);
        return;
      }
      setCoverUrl(upload.url);
      setCoverMediaType(isVideo ? 'video' : 'image');
      setCoverImageDims({ width: upload.width ?? null, height: upload.height ?? null });
    } catch {
      Alert.alert('Upload failed', 'Could not upload cover. Please try again.');
    } finally {
      setUploading(false);
    }
  }, [pickMedia]);

  const removeCover = useCallback(() => {
    setCoverUrl(null);
    setCoverMediaType(null);
    setCoverImageDims(null);
  }, []);

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
      // Canonical-resolution fix (audit bug): a destination that was hydrated
      // from stored strings (or otherwise never picked) carries no canonicalId.
      // Resolve it through the universal location registry before persisting so
      // the saved destination is canonical — not the raw text. resolveCanonical
      // is capped (~1.3s) and returns the input unchanged on any failure, so the
      // save never blocks (§38).
      const { needsResolution } = prepareTripDestinationForSave(place);
      const dest = needsResolution ? await resolveCanonicalPlace(place) : place;
      const updated = await updateTrip(id, {
        title: title.trim(),
        // Prefer the canonical binding's spelling when the destination was
        // re-picked (§53), else the resolved place's fields.
        destinationCity: destBinding?.city ?? dest.city ?? dest.name,
        destinationCountry: destBinding?.country ?? dest.country ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        visibility,
        tripNotes: tripNotes.trim() || null,
        // Pass null explicitly when cover was removed so the API clears cover_url.
        // Coercing to undefined would silently omit the field and leave the old cover.
        coverUrl: coverUrl,
        coverMediaType: coverMediaType,
        coverImageWidth:  coverImageDims?.width  ?? null,
        coverImageHeight: coverImageDims?.height ?? null,
        // Public trips always show header; private/buddies respect the toggle.
        showHeaderPublicly: visibility === 'public' ? true : showHeaderPublicly,
      });
      if (!updated) { setError('Could not save changes. Try again.'); return; }
      router.replace(`/trip/${id}` as any);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
      saveLock.current = false;
    }
  }, [title, place, destBinding, live, id, startDate, endDate, visibility, tripNotes, coverUrl, coverMediaType, showHeaderPublicly]);

  if (!live) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <AppHeader variant="detail" title="Edit trip" onBack={router.back} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Sign in to edit trips.</Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <AppHeader variant="detail" title="Edit trip" onBack={router.back} />
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (notOwner) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <AppHeader variant="detail" title="Edit trip" onBack={router.back} />
        <View style={styles.center}>
          <Text style={styles.errorText}>Only the trip owner can edit this trip.</Text>
        </View>
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <AppHeader variant="detail" title="Edit trip" onBack={router.back} />
        <View style={styles.center}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      </View>
    );
  }

  const startD = startDate ? fromISODate(startDate) : null;
  const endD = endDate ? fromISODate(endDate) : null;

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      <AppHeader variant="detail" title="Edit trip" onBack={router.back} />
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
              />
            </View>
          </View>

          {multiCity ? (
            <DestinationListEditor
              tripId={id}
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
          <Text style={styles.label}>Cover photo or video (optional)</Text>
          {coverUrl ? (
            <View style={styles.coverPreview}>
              {coverMediaType === 'video' ? (
                <VideoThumbnail posterUri={coverUrl} style={styles.coverImg} />
              ) : (
                <Image source={{ uri: coverUrl }} style={styles.coverImg} resizeMode="cover" />
              )}
              <View style={styles.coverActions}>
                <Pressable
                  style={styles.coverBtn}
                  onPress={pickCover}
                  disabled={uploading}
                  accessibilityLabel="Change cover"
                >
                  {uploading
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : <Text style={styles.coverBtnText}>Change</Text>
                  }
                </Pressable>
                <Pressable
                  style={[styles.coverBtn, styles.coverBtnRemove]}
                  onPress={removeCover}
                  disabled={uploading}
                  accessibilityLabel="Remove cover"
                >
                  <Text style={[styles.coverBtnText, { color: color.mute }]}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              style={styles.coverPicker}
              onPress={pickCover}
              disabled={uploading}
              accessibilityRole="button"
              accessibilityLabel="Add cover photo or video"
            >
              {uploading ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <>
                  <View style={styles.coverPickerIcons}>
                    <ImagePlus size={18} color={color.mute} />
                    <Film size={18} color={color.mute} />
                  </View>
                  <Text style={styles.coverPickerText}>Add photo or video (up to 2 min)</Text>
                </>
              )}
            </Pressable>
          )}
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

        {/* Cover image privacy — only relevant for non-public trips */}
        {visibility !== 'public' && (
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Show cover image to non-members</Text>
              <Text style={styles.toggleSub}>
                When off, non-members see a generic placeholder instead of your cover photo
              </Text>
            </View>
            <Switch
              value={showHeaderPublicly}
              onValueChange={setShowHeaderPublicly}
              trackColor={{ true: color.signal, false: color.haze }}
              thumbColor={color.paperRaised}
              accessibilityLabel="Show cover image to non-members"
            />
          </View>
        )}

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
        assistContext="trip_destination"
        assistFieldId={GEO_FIELD_IDS.tripDestination}
        sessionContext={{ tripId: id, surface: 'trip_edit' }}
        onCanonicalBinding={setDestBinding}
        onSelect={(p) => setPlace(p)}
        onClose={() => setPlaceOpen(false)}
      />
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  toggleLabel: { ...t.body, color: color.ink, marginBottom: 2 },
  toggleSub: { ...t.small, color: color.mute },
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
  coverPicker: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
    borderStyle: 'dashed', borderRadius: radius.md, paddingVertical: space.xl,
    minHeight: 80,
  },
  coverPickerIcons: { flexDirection: 'row', gap: space.sm },
  coverPickerText: { ...t.body, color: color.mute },
  coverPreview: { gap: space.sm },
  coverImg: { width: '100%', height: 160, borderRadius: radius.md, overflow: 'hidden' },
  coverActions: { flexDirection: 'row', gap: space.sm },
  coverBtn: {
    flex: 1, paddingVertical: space.sm, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center',
    backgroundColor: color.paperRaised,
  },
  coverBtnRemove: { borderColor: color.haze },
  coverBtnText: { ...t.small, color: color.signal, fontWeight: '600' },
  destinationHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  multiCityRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  multiCityLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  errorText: { ...t.small, color: color.signal, fontWeight: '600' },
  saveBtn: {
    backgroundColor: color.ink, paddingVertical: space.md,
    borderRadius: radius.pill, alignItems: 'center', marginTop: space.sm,
  },
  saveBtnText: { ...t.body, fontWeight: '700', color: color.onInk },
});
