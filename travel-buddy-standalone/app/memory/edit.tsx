/**
 * Memory edit screen — /memory/edit?id=<uuid>
 *
 * Lets the owner change title, caption, visibility, and location (including
 * clearing it). Navigates back to the detail screen on success.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Globe, Users, Lock, Eye, MapPin, ChevronDown } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getMemory, updateMemory, type Memory, type MemoryVisibility,
} from '../../src/services/memories';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { placeToLocationFields } from '../../src/lib/location/locationPayload';
import type { Place } from '../../src/lib/location/placeTypes';

// ── Visibility options ────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS: {
  value: MemoryVisibility;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { value: 'public',       label: 'Public',    desc: 'Everyone',       icon: <Globe  size={15} color={color.success} /> },
  { value: 'friends_only', label: 'Friends',   desc: 'Mutual follows', icon: <Users  size={15} color={color.signal} /> },
  { value: 'trip_crew',    label: 'Trip crew', desc: 'Trip members',   icon: <Eye    size={15} color={color.deep} /> },
  { value: 'only_me',      label: 'Only me',   desc: 'Private draft',  icon: <Lock   size={15} color={color.mute} /> },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Place-like object from existing memory location fields so the
 *  picker row shows the saved city name on first load. */
function memoryToPlace(memory: Memory): Place | null {
  if (!memory.locationCity && !memory.locationCountry) return null;
  return {
    id: memory.placeId ?? '',
    displayName: [memory.locationCity, memory.locationCountry].filter(Boolean).join(', '),
    name: memory.locationCity ?? memory.locationCountry ?? '',
    city: memory.locationCity ?? undefined,
    country: memory.locationCountry ?? undefined,
    lat: memory.locationLat ?? undefined,
    lng: memory.locationLng ?? undefined,
    type: 'city',
  } as Place;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function EditMemoryScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');

  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('friends_only');
  const [place, setPlace] = useState<Place | null>(null);
  const [placePickerOpen, setPlacePickerOpen] = useState(false);

  // Track whether the place was intentionally cleared (null after load).
  // We need to send explicit nulls when the user clears an existing location.
  const originalHadLocation = useRef(false);
  const saveLock = useRef(false);

  // ── Load existing memory ────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      const result = await getMemory(id);
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) { setLoadError(result.message); return; }
      const m = result.memory;
      setTitle(m.title ?? '');
      setCaption(m.caption ?? '');
      setVisibility(m.visibility as MemoryVisibility);
      const initialPlace = memoryToPlace(m);
      setPlace(initialPlace);
      originalHadLocation.current = initialPlace !== null;
    })();
    return () => { cancelled = true; };
  }, [id]);

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!id || saveLock.current) return;
    saveLock.current = true;
    setSaveError('');
    setSaving(true);

    try {
      // Derive location payload from the current place.
      // If the picker returned a full place, use placeToLocationFields.
      // If place is null and the memory originally had a location, send
      // explicit nulls so the backend clears the fields.
      const locationPayload = place
        ? placeToLocationFields(place)
        : originalHadLocation.current
          ? {
              locationCity: null as null,
              locationCountry: null as null,
              locationLat: null as null,
              locationLng: null as null,
              placeId: null as null,
              canonicalLocationId: null as null,
            }
          : {};

      const result = await updateMemory(id, {
        title: title.trim() || null,
        caption: caption.trim() || null,
        visibility,
        ...locationPayload,
      });

      if (!result.ok) {
        setSaveError(result.message);
        return;
      }

      router.back();
    } finally {
      setSaving(false);
      saveLock.current = false;
    }
  }, [id, title, caption, visibility, place]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[s.centered, { paddingTop: insets.top }]}>
        <Text style={s.errorText}>{loadError}</Text>
        <Pressable onPress={() => router.back()} style={s.backLink}>
          <Text style={s.backLinkText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.headerClose}>
          <X size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Edit Memory</Text>
        <Pressable
          onPress={handleSave}
          disabled={saving}
          testID="memory-edit-save-btn"
          style={[s.saveBtn, saving && s.saveBtnDisabled]}
        >
          {saving
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.saveBtnText}>Save</Text>}
        </Pressable>
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
            style={s.input}
            placeholder="Give this memory a name…"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={setTitle}
            maxLength={300}
            returnKeyType="next"
          />
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
          />
        </View>

        {/* Location */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Location</Text>
          <Pressable
            style={s.locationRow}
            onPress={() => setPlacePickerOpen(true)}
            testID="memory-edit-location-row"
          >
            <View style={s.locationValue}>
              <MapPin size={16} color={place ? color.signal : color.mute} />
              <Text
                style={[s.locationText, !place && s.locationPlaceholder]}
                numberOfLines={1}
              >
                {place ? place.displayName : 'Add a location (optional)'}
              </Text>
            </View>
            {place ? (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  setPlace(null);
                }}
                hitSlop={10}
                testID="memory-edit-location-clear"
              >
                <X size={16} color={color.mute} />
              </Pressable>
            ) : (
              <ChevronDown size={16} color={color.mute} />
            )}
          </Pressable>
        </View>

        {/* Visibility */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Who can see this?</Text>
          <View style={s.visGrid}>
            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[s.visOption, visibility === opt.value && s.visOptionActive]}
                onPress={() => setVisibility(opt.value)}
              >
                {opt.icon}
                <Text style={[s.visLabel, visibility === opt.value && s.visLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={s.visDesc}>{opt.desc}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {saveError ? <Text style={s.error}>{saveError}</Text> : null}

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

const s = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: color.paper },
  errorText: { ...(t.body as object), color: color.signal, textAlign: 'center', marginHorizontal: space.xl },
  backLink: { marginTop: space.md },
  backLinkText: { ...(t.body as object), color: color.signal },

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
  headerClose: { width: 36, alignItems: 'flex-start' },
  headerTitle: { ...(t.bodyStrong as object), color: color.ink },
  saveBtn: {
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    minWidth: 60,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { ...(t.small as object), color: '#fff', fontWeight: '700' },

  body: { padding: space.lg, gap: space.xl },

  section: { gap: space.sm },
  sectionLabel: { ...(t.bodyStrong as object), color: color.ink },

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

  visGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  visOption: {
    flex: 1,
    minWidth: '45%',
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
});
