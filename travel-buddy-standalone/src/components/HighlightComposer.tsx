/**
 * HighlightComposer — bottom sheet for creating a Highlight.
 * Media picker (photo + video ≤10s), caption, location tag,
 * visibility selector, duration selector, then POST /api/highlights.
 *
 * Video picks are previewed with a native expo-av player (muted, looping).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet,
  Image, ActivityIndicator,
} from 'react-native';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import type { AnyMentionSuggestion } from '../services/tagging.ts';
import type * as ImagePickerTypes from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import { X, Video as VideoIcon, MapPin } from 'lucide-react-native';
import { useMediaComposer } from '../hooks/useMediaComposer.ts';
import { MediaPickerButton } from './ui/MediaPickerButton.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { uploadMedia, validateMedia } from '../services/media.ts';
import { createHighlight, type HighlightVisibility } from '../services/highlights.ts';
import { useSession } from '../context/SessionContext.tsx';
import { router } from 'expo-router';
import { MediaFilterEditor, type FilterApplyResult } from './MediaFilterEditor.tsx';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { VIDEO_MAX_DURATION_SECONDS } from '../constants/mediaLimits.ts';

/** Bound the highlight caption — the audit flagged it as the one unbounded
 *  caption composer. 2000 matches the Postcard composer's caption cap. */
const CAPTION_MAX = 2000;

const DURATIONS: { hours: number; label: string }[] = [
  { hours: 3,  label: '3h' },
  { hours: 6,  label: '6h' },
  { hours: 12, label: '12h' },
  { hours: 24, label: '24h' },
  { hours: 48, label: '48h' },
];

const VISIBILITIES: { value: HighlightVisibility; label: string }[] = [
  { value: 'public',           label: 'Everyone' },
  { value: 'travelers_nearby', label: 'Nearby travelers' },
  { value: 'circle_only',      label: 'My circle' },
  { value: 'trip_only',        label: 'Trip members' },
  { value: 'private',          label: 'Only me' },
];

type LocState =
  | { source: 'none' }
  | { source: 'gps'; lat: number; lng: number; name: string | null; city: string | null; country: string | null }
  | { source: 'manual'; name: string; city: string | null; country: string | null };

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function HighlightComposer({ visible, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const { signOut } = useSession();

  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('image/jpeg');
  const [isVideo, setIsVideo] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [caption, setCaption] = useState('');
  // @mention / #hashtag tokenization in the caption (§26) — parity with Pulse/
  // Comments, which the audit flagged this field lacked.
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [vis, setVis] = useState<HighlightVisibility>('public');
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [loc, setLoc] = useState<LocState>({ source: 'none' });
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [filterEditorOpen, setFilterEditorOpen] = useState(false);
  const [filterEditorAsset, setFilterEditorAsset] = useState<ImagePickerTypes.ImagePickerAsset | null>(null);
  const mediaComposer = useMediaComposer('highlight');
  const [filterId, setFilterId] = useState<string>('original');
  const [filterIntensity, setFilterIntensity] = useState<number>(100);

  // Reset non-media form fields when the composer opens so the form is fresh
  // each time. Media state (mediaUri and related) is intentionally NOT reset
  // here — that would lose picked media when the user closes and reopens the
  // sheet without submitting (the "reopen-loses-media" bug).
  // Media is reset explicitly after a successful submit or via the × remove button.
  useEffect(() => {
    if (visible) {
      setCaption('');
      setVis('public');
      setExpiresInHours(24);
      setLoc({ source: 'none' });
      setPlacePickerOpen(false);
      setError(null);
      setFilterEditorOpen(false);
      setFilterEditorAsset(null);
      setFilterId('original');
      setFilterIntensity(100);
    }
  }, [visible]);

  function handlePickedAsset(a: ImagePickerTypes.ImagePickerAsset) {
    const mime = a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
    const asVideo = mime.startsWith('video/') || a.type === 'video';
    const durationSec = a.duration ? a.duration / 1000 : null;

    if (asVideo && durationSec != null && durationSec > VIDEO_MAX_DURATION_SECONDS.highlight) {
      setError(`Highlights can be up to ${VIDEO_MAX_DURATION_SECONDS.highlight}s. Your video is ${durationSec.toFixed(1)}s.`);
      return;
    }

    const picked = {
      uri: a.uri,
      mimeType: mime,
      fileName: a.fileName ?? null,
      fileSize: a.fileSize ?? null,
      width: a.width,
      height: a.height,
      type: a.type,
    };
    const v = validateMedia(picked, { surface: 'highlight' });
    if (!v.ok) { setError(v.message); return; }

    setMimeType(mime);
    setIsVideo(asVideo);
    setVideoDuration(durationSec);
    setFileSize(a.fileSize ?? null);
    setFilterEditorAsset(a);
    setFilterEditorOpen(true);
  }

  const handleFilterApply = useCallback((result: FilterApplyResult) => {
    setFilterEditorOpen(false);
    setMediaUri(result.uri);
    setFilterId(result.filterId);
    setFilterIntensity(result.filterIntensity);
    setFilterEditorAsset(null);
  }, []);

  function applyPlace(p: import('../lib/location/placeTypes').Place) {
    if (p.source === 'gps' && p.lat != null && p.lng != null) {
      setLoc({ source: 'gps', lat: p.lat, lng: p.lng, name: p.name, city: p.city, country: p.country });
    } else {
      setLoc({ source: 'manual', name: p.name, city: p.city, country: p.country });
    }
    setPlacePickerOpen(false);
  }

  async function handleSubmit() {
    if (!mediaUri) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const up = await uploadMedia({
        uri: mediaUri,
        mimeType,
        fileSize,
        type: isVideo ? 'video' : 'image',
      });
      if (!up.ok || !up.url) {
        if (up.errorKind === 'unauthenticated') {
          await signOut();
          router.replace('/(auth)/sign-in');
          onClose();
          return;
        }
        if (up.errorKind === 'rate_limited') {
          setError('Too many uploads — please wait a moment and try again.');
          return;
        }
        if (up.errorKind === 'invalid_payload') {
          setError("This file couldn't be read — try a different photo.");
          return;
        }
        setError(up.message ?? 'Media upload failed.');
        return;
      }

      const locationCity = loc.source === 'gps' ? loc.city : null;
      const locationCountry = loc.source === 'gps' ? loc.country : null;
      const locationName = loc.source === 'none' ? null : loc.source === 'manual' ? loc.name : (loc.name ?? loc.city);

      const result = await createHighlight({
        mediaUrl: up.url,
        mediaType: mimeType,
        videoDurationSeconds: videoDuration,
        caption: caption.trim() || null,
        locationName,
        locationCity,
        locationCountry,
        visibility: vis,
        expiresInHours,
        filterId,
        filterIntensity,
      });

      if (!result.ok) {
        if (result.errorKind === 'unauthenticated') {
          await signOut();
          router.replace('/(auth)/sign-in');
          onClose();
          return;
        }
        setError(result.message ?? 'Could not post highlight.');
        return;
      }

      // Reset media so the next open session starts fresh
      // (the visible=true effect intentionally no longer resets media state).
      setMediaUri(null);
      setMimeType('image/jpeg');
      setIsVideo(false);
      setVideoDuration(null);
      setFileSize(null);
      onSuccess?.();
      onClose();
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  const locLabel =
    loc.source === 'gps' ? `${loc.name ?? loc.city ?? 'Current location'} · GPS`
    : loc.source === 'manual' ? `${loc.name} · Manual`
    : null;

  const canSubmit = !!mediaUri && !submitting;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={s.grab} />
          <View style={s.head}>
            <Text style={s.headTitle}>New Highlight</Text>
            <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
              <X size={18} color={color.ink} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Media picker */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Media <Text style={{ color: color.signal }}>*</Text></Text>
              {mediaUri ? (
                <View style={s.mediaPreviewWrap}>
                  {isVideo ? (
                    <Video
                      source={{ uri: mediaUri }}
                      style={s.mediaPreview}
                      resizeMode={ResizeMode.COVER}
                      shouldPlay
                      isLooping
                      isMuted
                      useNativeControls={false}
                    />
                  ) : (
                    <Image source={{ uri: mediaUri }} style={s.mediaPreview} resizeMode="cover" />
                  )}
                  <Pressable style={s.mediaRemove} onPress={() => setMediaUri(null)} hitSlop={8}>
                    <X size={14} color="#fff" />
                  </Pressable>
                  {isVideo && videoDuration != null && (
                    <View style={s.durationBadge}>
                      <Text style={s.durationText}>{videoDuration.toFixed(1)}s</Text>
                    </View>
                  )}
                </View>
              ) : (
                <MediaPickerButton
                  composer={{ ...mediaComposer, onPickResult: handlePickedAsset }}
                  sheetTitle="Add Highlight Media"
                />
              )}
              <Text style={s.mediaHint}>Photos or videos up to {VIDEO_MAX_DURATION_SECONDS.highlight}s</Text>
            </View>

            {/* Caption */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Caption</Text>
              <MentionSuggestionList
                suggestions={mentionSuggestions}
                loading={mentionLoading}
                visible={mentionVisible}
                onSelect={(sug) => mentionRef.current?.insertTag(sug)}
              />
              <MentionInput
                ref={mentionRef}
                style={[s.input, s.multiline]}
                placeholder="Add a caption…"
                placeholderTextColor={color.faint}
                multiline
                value={caption}
                onChangeText={setCaption}
                editable={!submitting}
                textAlignVertical="top"
                maxLength={CAPTION_MAX}
                surface="post"
                onSuggestionsChange={(items, isLoading, trigger) => {
                  setMentionSuggestions(items);
                  setMentionLoading(isLoading);
                  setMentionVisible(!!trigger && (items.length > 0 || isLoading));
                }}
              />
            </View>

            {/* Location */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Location</Text>
              <Pressable
                style={[s.locPickerBtn, loc.source !== 'none' && s.locPickerBtnActive]}
                onPress={() => setPlacePickerOpen(true)}
                disabled={submitting}
              >
                <MapPin size={14} color={loc.source !== 'none' ? color.signal : color.mute} />
                <Text style={[s.locPickerText, loc.source === 'none' && s.locPickerPlaceholder]} numberOfLines={1}>
                  {locLabel ?? 'Add a location…'}
                </Text>
                {loc.source !== 'none' && (
                  <Pressable hitSlop={8} onPress={() => setLoc({ source: 'none' })}>
                    <X size={13} color={color.mute} />
                  </Pressable>
                )}
              </Pressable>
            </View>

            {/* Visibility */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Who can see this?</Text>
              <View style={s.chipRow}>
                {VISIBILITIES.map(({ value, label }) => (
                  <Pressable
                    key={value}
                    style={[s.chip, vis === value && s.chipOn]}
                    onPress={() => setVis(value)}
                  >
                    <Text style={[s.chipText, vis === value && s.chipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Duration */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Expires in</Text>
              <View style={s.chipRow}>
                {DURATIONS.map(({ hours, label }) => (
                  <Pressable
                    key={hours}
                    style={[s.chip, expiresInHours === hours && s.chipOn]}
                    onPress={() => setExpiresInHours(hours)}
                  >
                    <Text style={[s.chipText, expiresInHours === hours && s.chipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {error && (
              <View style={s.errorBox}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={s.footer}>
            <Pressable
              style={[s.submitBtn, !canSubmit && s.submitDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={s.submitText}>Share Highlight</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardSafeScrollView>

      {/* Place picker */}
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Tag a Location"
        usedFor="highlight_location"
        onSelect={applyPlace}
        onClose={() => setPlacePickerOpen(false)}
      />

      {/* Filter editor — opens after media pick, before storing */}
      {filterEditorOpen && filterEditorAsset && (
        <MediaFilterEditor
          file={{
            uri: filterEditorAsset.uri,
            mimeType: filterEditorAsset.mimeType ?? (filterEditorAsset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
            width: filterEditorAsset.width ?? null,
            height: filterEditorAsset.height ?? null,
          }}
          mediaType={filterEditorAsset.type === 'video' || (filterEditorAsset.mimeType ?? '').startsWith('video/') ? 'video' : 'image'}
          onApply={handleFilterApply}
          onCancel={() => {
            setFilterEditorOpen(false);
            setFilterEditorAsset(null);
          }}
        />
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: 10 },
  headTitle: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  field: { gap: 6 },
  fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
  mediaBtns: { flexDirection: 'row', gap: space.md },
  mediaBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  mediaBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  mediaHint: { ...t.small, color: color.faint, fontSize: 11 },
  mediaPreviewWrap: { position: 'relative' },
  mediaPreview: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: color.haze },
  videoPlayOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  mediaRemove: { position: 'absolute', top: 8, right: 8, width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: 'rgba(17,17,15,0.6)', alignItems: 'center', justifyContent: 'center' },
  durationBadge: { position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(17,17,15,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  durationText: { fontFamily: 'Courier', fontSize: 11, color: '#fff', fontWeight: '700' },
  input: { ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10 },
  multiline: { height: 80, paddingTop: 10 },
  locLabel: { ...t.small, color: color.success, fontWeight: '600' },
  locPickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    backgroundColor: color.paperRaised, paddingHorizontal: space.md, paddingVertical: 12,
  },
  locPickerBtnActive: { borderColor: color.signal },
  locPickerText: { flex: 1, ...t.body, color: color.ink },
  locPickerPlaceholder: { color: color.faint },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  chipTextOn: { color: color.onInk },
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md },
  errorText: { ...t.small, color: color.signal, fontWeight: '600' },
  footer: { paddingHorizontal: space.lg, paddingTop: space.md },
  submitBtn: { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  submitDisabled: { opacity: 0.4 },
  submitText: { ...t.bodyStrong, color: color.onInk },
});
