/**
 * New Memory screen — /memory/new
 *
 * HM-F08. The Create hub's Memory entry lands here. A person gives the Memory a
 * title (or at least one photo), an optional caption, photos, a place with the
 * §10 location precision they allow, and who can see it — then Create.
 *
 * How a create happens (Highlights/Memories spec §17 and §19):
 *   1. ONE `createMemory` call — `POST /api/memories`, the CREATE_MEMORY command
 *      (`routes/memories.ts`), which the server runs through the Memory command
 *      kernel. The service sends an Idempotency-Key derived from the payload, so
 *      tapping Try again after a failure is the same operation, not a second
 *      Memory. Nothing here writes a table.
 *   2. Each picked photo is uploaded (`/api/media/upload`) and attached to the
 *      NEW Memory's id (`POST /api/memories/:id/items`, ADD_MEDIA), in order.
 *   3. The screen is replaced by `/memory/<new id>`.
 *
 * Failure honesty: a refused or unreachable create is an error with Try again
 * and never a navigation. A photo that fails AFTER the Memory exists does not
 * undo the Memory (§19: "a failed upload does not invalidate already-saved
 * Memory facts"); the person is told how many did not upload and still lands on
 * the Memory that was created.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput, Image,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Globe, Users, Lock, MapPin, ChevronDown, ImagePlus } from 'lucide-react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  createMemory, addMemoryItem,
  type MemoryVisibility, type MemoryLocationPrecision,
} from '../../src/services/memories';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { placeToLocationFields } from '../../src/lib/location/locationPayload';
import type { Place } from '../../src/lib/location/placeTypes';

/** Same ceiling the detail screen's "add media" uses. */
const MAX_ITEMS = 10;

// ── Options ───────────────────────────────────────────────────────────────────

/**
 * Trip crew is not offered here: this screen links no trip, and the server's
 * canPublishMemory refuses a crew audience with no trip. Offering it would be
 * offering a refusal. Only me is the default — the spec's Memories are
 * private-first, and publishing wider is the person's choice.
 */
const VISIBILITY_OPTIONS: {
  value: MemoryVisibility;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { value: 'only_me',      label: 'Only me', desc: 'Private',        icon: <Lock  size={15} color={color.mute} /> },
  { value: 'friends_only', label: 'Friends', desc: 'Mutual follows', icon: <Users size={15} color={color.signal} /> },
  { value: 'public',       label: 'Public',  desc: 'Everyone',       icon: <Globe size={15} color={color.success} /> },
];

/** §10 ladder, EXACT → HIDDEN, as the server accepts it. */
const PRECISION_OPTIONS: { value: MemoryLocationPrecision; label: string }[] = [
  { value: 'exact',        label: 'Exact spot' },
  { value: 'venue',        label: 'Venue' },
  { value: 'neighborhood', label: 'Neighbourhood' },
  { value: 'city',         label: 'City only' },
  { value: 'country',      label: 'Country only' },
  { value: 'hidden',       label: 'Hidden' },
];

interface PickedMedia { uri: string; mimeType: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'photos'; done: number; total: number };

// ── Screen ────────────────────────────────────────────────────────────────────

export default function NewMemoryScreen() {
  const insets = useSafeAreaInsets();
  const { pickMedia } = useMediaPicker();

  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('only_me');
  const [place, setPlace] = useState<Place | null>(null);
  const [precision, setPrecision] = useState<MemoryLocationPrecision | null>(null);
  const [media, setMedia] = useState<PickedMedia[]>([]);
  const [placePickerOpen, setPlacePickerOpen] = useState(false);

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [failedOnce, setFailedOnce] = useState(false);

  // Synchronous double-tap guard: `phase` is async React state and a second tap
  // can land before it re-renders (same pattern as edit.tsx's saveLock).
  const createLock = useRef(false);
  const busy = phase.kind !== 'idle';

  // ── Photos ──────────────────────────────────────────────────────────────────

  const handleAddMedia = useCallback(async () => {
    if (busy || media.length >= MAX_ITEMS) return;
    const assets = await pickMedia({
      title: 'Add to memory',
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: Math.max(1, MAX_ITEMS - media.length),
    });
    if (!assets || assets.length === 0) return;
    const picked = assets.map((a) => ({
      uri: a.uri,
      mimeType: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    }));
    setMedia((prev) => [...prev, ...picked].slice(0, MAX_ITEMS));
    setError('');
  }, [busy, media.length, pickMedia]);

  const removeMedia = useCallback((index: number) => {
    setMedia((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Create ──────────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    if (createLock.current) return;
    if (!title.trim() && media.length === 0) {
      setError('Add a title or at least one photo.');
      return;
    }
    createLock.current = true;
    setError('');
    setPhase({ kind: 'creating' });

    try {
      const result = await createMemory({
        title: title.trim() || null,
        caption: caption.trim() || null,
        visibility,
        state: 'published',
        ...placeToLocationFields(place),
        ...(place && precision ? { locationPrecision: precision } : {}),
      });

      if (!result.ok || !result.memory?.id) {
        setFailedOnce(true);
        setError(
          !result.ok && result.kind === 'network_unreachable'
            ? "Couldn't reach Portava. Check your connection and try again."
            : !result.ok
              ? result.message
              : 'The Memory could not be confirmed. Try again.',
        );
        return;
      }

      const memoryId = result.memory.id;
      let failed = 0;
      for (let i = 0; i < media.length; i++) {
        setPhase({ kind: 'photos', done: i, total: media.length });
        const item = await addMemoryItem(memoryId, media[i].uri, media[i].mimeType, null, i);
        if (!item.ok) failed += 1;
      }

      if (failed > 0) {
        Alert.alert(
          'Memory created',
          `${failed} of ${media.length} photos didn't upload. Add them again from the Memory.`,
        );
      }
      router.replace(`/memory/${memoryId}` as any);
    } finally {
      setPhase({ kind: 'idle' });
      createLock.current = false;
    }
  }, [title, caption, visibility, place, precision, media]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const submitLabel =
    phase.kind === 'creating' ? 'Creating…'
      : phase.kind === 'photos' ? `Adding photos ${phase.done + 1} of ${phase.total}…`
        : failedOnce ? 'Try again' : 'Create memory';

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={s.headerSide}
          accessibilityRole="button"
          accessibilityLabel="Close"
          disabled={busy}
        >
          <X size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>New Memory</Text>
        <View style={s.headerSide} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Title</Text>
          <TextInput
            testID="memory-create-title"
            style={s.input}
            placeholder="Give this memory a name…"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={(v) => { setTitle(v); if (error) setError(''); }}
            maxLength={300}
            returnKeyType="next"
            editable={!busy}
          />
        </View>

        {/* Photos */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Photos</Text>
          <View style={s.photoGrid}>
            {media.map((m, i) => (
              <View key={`${m.uri}-${i}`} style={s.photoCell} testID={`memory-create-photo-${i}`}>
                <Image source={{ uri: m.uri }} style={s.photo} />
                {!busy ? (
                  <Pressable
                    onPress={() => removeMedia(i)}
                    style={s.photoRemove}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove photo ${i + 1}`}
                    testID={`memory-create-photo-remove-${i}`}
                  >
                    <X size={12} color={color.onInk} />
                  </Pressable>
                ) : null}
              </View>
            ))}
            {media.length < MAX_ITEMS ? (
              <Pressable
                onPress={handleAddMedia}
                disabled={busy}
                style={[s.photoCell, s.photoAdd]}
                accessibilityRole="button"
                accessibilityLabel="Add photos"
                testID="memory-create-add-photos"
              >
                <ImagePlus size={22} color={color.mute} />
                <Text style={s.photoAddText}>Add</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Caption */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Caption</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            placeholder="What made this moment special?"
            placeholderTextColor={color.faint}
            value={caption}
            onChangeText={setCaption}
            maxLength={2000}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            editable={!busy}
          />
        </View>

        {/* Location */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Location</Text>
          <Pressable
            style={s.locationRow}
            onPress={() => setPlacePickerOpen(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={place ? `Location: ${place.displayName}` : 'Add a location'}
            testID="memory-create-location-row"
          >
            <View style={s.locationValue}>
              <MapPin size={16} color={place ? color.signal : color.mute} />
              <Text style={[s.locationText, !place && s.locationPlaceholder]} numberOfLines={1}>
                {place ? place.displayName : 'Add a location (optional)'}
              </Text>
            </View>
            {place ? (
              <Pressable
                onPress={(e) => { e.stopPropagation(); setPlace(null); setPrecision(null); }}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Clear location"
                testID="memory-create-location-clear"
              >
                <X size={16} color={color.mute} />
              </Pressable>
            ) : (
              <ChevronDown size={16} color={color.mute} />
            )}
          </Pressable>

          {place ? (
            <View style={s.precisionBlock}>
              <Text style={s.hint}>How precisely others may see where this was</Text>
              <View style={s.chipRow}>
                {PRECISION_OPTIONS.map((opt) => {
                  const active = precision === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => setPrecision(active ? null : opt.value)}
                      disabled={busy}
                      style={[s.chip, active && s.chipActive]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      testID={`memory-create-precision-${opt.value}`}
                    >
                      <Text style={[s.chipText, active && s.chipTextActive]}>{opt.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {!precision ? (
                <Text style={s.hint}>Not chosen: the app's default precision applies.</Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Visibility */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Who can see this?</Text>
          <View style={s.visGrid}>
            {VISIBILITY_OPTIONS.map((opt) => {
              const active = visibility === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[s.visOption, active && s.visOptionActive]}
                  onPress={() => setVisibility(opt.value)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  testID={`memory-create-visibility-${opt.value}`}
                >
                  {opt.icon}
                  <Text style={[s.visLabel, active && s.visLabelActive]}>{opt.label}</Text>
                  <Text style={s.visDesc}>{opt.desc}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {error ? <Text style={s.error} accessibilityLiveRegion="polite">{error}</Text> : null}

        <Pressable
          onPress={handleCreate}
          disabled={busy}
          style={[s.submit, busy && s.submitBusy]}
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
          testID="memory-create-submit"
        >
          {busy ? <ActivityIndicator size="small" color={color.onInk} /> : null}
          <Text style={s.submitText}>{submitLabel}</Text>
        </Pressable>
      </ScrollView>

      <GlobalPlacePicker
        visible={placePickerOpen}
        onClose={() => setPlacePickerOpen(false)}
        onSelect={(p) => setPlace(p)}
        title="Tag a Location"
        mode="all"
        usedFor="memory"
      />
    </KeyboardSafeScrollView>
  );
}

const PHOTO = 88;

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  headerSide: { width: 36, alignItems: 'flex-start' },
  headerTitle: { ...(t.bodyStrong as object), color: color.ink },

  body: { padding: space.lg, gap: space.xl },

  section: { gap: space.sm },
  sectionLabel: { ...(t.bodyStrong as object), color: color.ink },
  hint: { ...(t.small as object), color: color.mute },

  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    ...(t.body as object),
    color: color.ink,
    backgroundColor: color.paperRaised,
  },
  inputMultiline: { minHeight: 100 },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  photoCell: { width: PHOTO, height: PHOTO, borderRadius: radius.md, overflow: 'hidden' },
  photo: { width: '100%', height: '100%', backgroundColor: color.haze },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoAdd: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  photoAddText: { ...(t.small as object), color: color.mute },

  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
  },
  locationValue: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  locationText: { ...(t.body as object), color: color.ink, flex: 1 },
  locationPlaceholder: { color: color.faint },

  precisionBlock: { gap: space.sm, marginTop: space.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  chipText: { ...(t.small as object), color: color.ink },
  chipTextActive: { color: color.signal, fontWeight: '700' },

  visGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  visOption: {
    flex: 1,
    minWidth: '30%',
    alignItems: 'center',
    gap: 4,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visLabel: { ...(t.small as object), color: color.ink, fontWeight: '700' },
  visLabelActive: { color: color.signal },
  visDesc: { fontSize: 10, color: color.mute, textAlign: 'center' },

  error: { ...(t.small as object), color: color.signal, textAlign: 'center' },

  submit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingVertical: space.md,
  },
  submitBusy: { opacity: 0.7 },
  submitText: { ...(t.bodyStrong as object), color: color.onInk },
});
