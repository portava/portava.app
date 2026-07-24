/**
 * Memory composer — /memory/create
 *
 * Pick photos/videos from the library or camera, add a title + caption,
 * choose visibility, then publish. Media uploads via useMediaComposer
 * (driving the per-item progress bar and retry UI) before the memory row
 * is created and items are registered with their already-uploaded URLs.
 *
 * Media state is owned entirely by useMediaComposer('memory') so that
 * canAddMore / canAddMore re-enables correctly after removes. A parallel
 * `captions` map (keyed by item.id) holds the per-item caption text
 * without duplicating the asset list.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput,
  StyleSheet, ActivityIndicator, Alert, Image,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Globe, Users, Lock, Eye, Trash2, MapPin, ChevronDown, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { createMemory, addMemoryItemFromUrl, type MemoryVisibility } from '../../src/services/memories';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { placeToLocationFields } from '../../src/lib/location/locationPayload';
import type { Place } from '../../src/lib/location/placeTypes';
import { useMediaComposer } from '../../src/hooks/useMediaComposer';
import { MediaPickerButton } from '../../src/components/ui/MediaPickerButton';

// ── Visibility options ────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS: {
  value: MemoryVisibility;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { value: 'public',       label: 'Public',      desc: 'Everyone',        icon: <Globe  size={15} color={color.success} /> },
  { value: 'friends_only', label: 'Friends',     desc: 'Mutual follows',  icon: <Users  size={15} color={color.signal} /> },
  { value: 'trip_crew',    label: 'Trip crew',   desc: 'Trip members',    icon: <Eye    size={15} color={color.deep} /> },
  { value: 'only_me',      label: 'Only me',     desc: 'Private draft',   icon: <Lock   size={15} color={color.mute} /> },
];

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CreateMemoryScreen() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();

  // ── Media state (single source of truth) ───────────────────────────────────
  // mediaComposer.items owns the asset list. A separate `captions` map holds
  // per-item caption text keyed by item.id so renders stay cheap and removes
  // automatically invalidate their caption entry.
  const mediaComposer = useMediaComposer('memory');
  const [captions, setCaptions] = useState<Record<string, string>>({});

  const removeAsset = useCallback((id: string) => {
    mediaComposer.removeItem(id);
    setCaptions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [mediaComposer.removeItem]);

  const updateCaption = useCallback((id: string, text: string) => {
    setCaptions((prev) => ({ ...prev, [id]: text }));
  }, []);

  // ── Other form state ────────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('friends_only');
  // Canonical location from the universal picker. Null = no location tagged;
  // the memory still publishes. Display-only here — the backend's existing
  // privacy rules govern when coordinates become publicly visible.
  const [place, setPlace] = useState<Place | null>(null);
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // Synchronous guard: prevents re-entry on a rapid double-tap before the
  // setUploading(true) state update has caused a re-render and updated the
  // Pressable's `disabled` prop. Unlike the React state flag, a ref update
  // is immediate and visible within the same JS turn.
  const publishLock = useRef(false);

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handlePublish = useCallback(async () => {
    // Synchronous guard — checked before any async work or React state update.
    if (publishLock.current) return;
    publishLock.current = true;

    setError('');
    setUploading(true);

    // Snapshot items at publish time so the closure is stable across awaits.
    // Items already in 'done' state (e.g. from a prior individual retry) retain
    // their uploadedUrl in this snapshot; newly idle items will be uploaded now.
    const snapshotItems = mediaComposer.items;
    const caps = captions;

    try {
      // ── Step 1: upload all idle items via the composer ──────────────────────
      // This drives the per-item progress bar and error/retry overlays.
      // Items already in 'done' state are skipped by uploadAll().
      let uploadMap = new Map<string, string | null>();

      if (snapshotItems.length > 0) {
        const raw = await mediaComposer.uploadAll();
        raw.forEach((result, id) => uploadMap.set(id, result?.url ?? null));
      }

      // Resolve the public URL for every item:
      //   • was idle → uploaded now → URL from map
      //   • was already done (prior retry) → URL from snapshot.uploadedUrl
      const urlForItem = (item: typeof snapshotItems[0]): string | null => {
        if (uploadMap.has(item.id)) return uploadMap.get(item.id) ?? null;
        return item.uploadedUrl;
      };

      const failCount = snapshotItems.filter((it) => !urlForItem(it)).length;
      if (failCount > 0) {
        setError(
          `${failCount} photo${failCount > 1 ? 's' : ''} failed to upload. ` +
          'Tap the retry button on each failed item, then publish again.',
        );
        return;
      }

      // ── Step 2: create the memory row ───────────────────────────────────────
      const createResult = await createMemory({
        title: title.trim() || null,
        caption: caption.trim() || null,
        visibility,
        state: 'published',
        ...placeToLocationFields(place),
      });

      if (!createResult.ok) {
        setError(createResult.message);
        return;
      }

      const memoryId = createResult.memory.id;

      // ── Step 3: register each item with its already-uploaded URL ────────────
      // No re-upload — the composer already holds the public URLs.
      if (snapshotItems.length > 0) {
        const results = await Promise.allSettled(
          snapshotItems.map((item, i) =>
            addMemoryItemFromUrl(
              memoryId,
              urlForItem(item)!,
              item.mimeType,
              (caps[item.id] ?? '').trim() || null,
              i,
            ),
          ),
        );

        const failures = results.filter(
          (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok),
        );
        if (failures.length > 0) {
          setError(
            `Memory created but ${failures.length} photo(s) failed to save. ` +
            'View the memory to retry.',
          );
          router.replace({ pathname: '/memory/[id]' as any, params: { id: memoryId } });
          return;
        }
      }

      router.replace({ pathname: '/memory/[id]' as any, params: { id: memoryId } });
    } finally {
      setUploading(false);
      publishLock.current = false;
    }
  }, [mediaComposer.items, mediaComposer.uploadAll, captions, title, caption, visibility, place]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const canPublish = !uploading;
  const items = mediaComposer.items;

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.headerClose}>
          <X size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>New Memory</Text>
        <Pressable
          onPress={handlePublish}
          disabled={!canPublish}
          style={[s.publishBtn, !canPublish && s.publishBtnDisabled]}
        >
          {uploading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.publishBtnText}>Publish</Text>}
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >

        {/* Media section */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Photos & Videos</Text>
          <Text style={s.sectionSub}>Up to 10 items</Text>

          {/* Asset grid — driven by mediaComposer.items (single source of truth).
              Captions are stored separately in `captions[item.id]`. */}
          {items.length > 0 && (
            <View style={s.assetGrid}>
              {items.map((item) => (
                <View key={item.id} style={s.assetCard}>
                  {/* Thumbnail wrapper — overlays are positioned inside here */}
                  <View style={s.assetThumbWrap}>
                    <Image source={{ uri: item.uri }} style={s.assetThumb} resizeMode="cover" />

                    {/* Upload progress overlay */}
                    {item.uploadState === 'uploading' && (
                      <View style={s.uploadOverlay}>
                        <ActivityIndicator size="small" color="#fff" />
                        <View style={s.uploadProgressBar}>
                          <View
                            style={[
                              s.uploadProgressFill,
                              { width: `${Math.round(item.uploadProgress * 100)}%` as any },
                            ]}
                          />
                        </View>
                      </View>
                    )}

                    {/* Error overlay with retry */}
                    {item.uploadState === 'error' && (
                      <View style={s.uploadErrorOverlay}>
                        <Pressable
                          style={s.retryBtn}
                          onPress={() => mediaComposer.retryUpload(item.id)}
                          hitSlop={8}
                          accessibilityLabel="Retry upload"
                        >
                          <RefreshCw size={14} color="#fff" />
                          <Text style={s.retryText}>Retry</Text>
                        </Pressable>
                      </View>
                    )}

                    <Pressable
                      style={s.assetRemove}
                      onPress={() => removeAsset(item.id)}
                      hitSlop={4}
                      accessibilityLabel="Remove photo"
                    >
                      <Trash2 size={14} color="#fff" />
                    </Pressable>
                  </View>

                  {/* Per-item upload error message */}
                  {item.uploadState === 'error' && item.uploadError ? (
                    <Text style={s.uploadErrorText} numberOfLines={2}>{item.uploadError}</Text>
                  ) : null}

                  <TextInput
                    style={s.assetCaption}
                    placeholder="Caption…"
                    placeholderTextColor={color.faint}
                    value={captions[item.id] ?? ''}
                    onChangeText={(text) => updateCaption(item.id, text)}
                    maxLength={200}
                  />
                </View>
              ))}
            </View>
          )}

          {/* Add media — canAddMore is derived from mediaComposer.items.length
              so it re-enables as soon as an item is removed, with no lag. */}
          <MediaPickerButton
            composer={mediaComposer}
            variant="area"
            label={items.length === 0 ? 'Add photos or videos' : 'Add more'}
          />
        </View>

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
            testID="memory-location-row"
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
                  // RN-web bubbles nested presses to the parent Pressable —
                  // without this, clearing would immediately reopen the picker.
                  e.stopPropagation();
                  setPlace(null);
                }}
                hitSlop={10}
                testID="memory-location-clear"
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

        {error ? <Text style={s.error}>{error}</Text> : null}

        <PlainBottomFiller />
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
  publishBtn: {
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    minWidth: 72,
    alignItems: 'center',
  },
  publishBtnDisabled: { opacity: 0.5 },
  publishBtnText: { ...(t.small as object), color: '#fff', fontWeight: '700' },

  body: { padding: space.lg, gap: space.xl },

  section: { gap: space.sm },
  sectionLabel: { ...(t.bodyStrong as object), color: color.ink },
  sectionSub: { ...(t.small as object), color: color.mute, marginTop: -space.xs },

  assetGrid: { gap: space.md },
  assetCard: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.haze,
  },
  // Wrapper for the thumbnail + all absolutely-positioned overlays.
  // Gives overlays a bounded context so they don't bleed into the caption.
  assetThumbWrap: {
    width: '100%',
    height: 200,
    position: 'relative',
  },
  assetThumb: { width: '100%', height: 200 },
  assetRemove: {
    position: 'absolute', top: space.sm, right: space.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    padding: 6,
  },

  // Upload progress overlay (shown while uploadState === 'uploading')
  uploadOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 12,
  },
  uploadProgressBar: {
    width: '80%',
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  uploadProgressFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
  },

  // Error overlay (shown when uploadState === 'error')
  uploadErrorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(220,40,30,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  retryText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  uploadErrorText: {
    ...(t.small as object),
    color: color.signal,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
  },

  assetCaption: {
    padding: space.md,
    ...(t.small as object),
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderColor: color.haze,
  },

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
