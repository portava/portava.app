/**
 * PostcardComposer — full-screen modal for creating a video/photo Postcard.
 *
 * Upload flow:
 *   pick → details → uploading (XHR progress) → success → onSuccess()
 *
 * Phases:
 *   'pick'     — media picker + preview + caption/location/visibility form
 *   'uploading' — progress bar, cancel button
 */
import React, { useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet,
  ActivityIndicator, Alert, Image, ScrollView, PanResponder,
} from 'react-native';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import type { AnyMentionSuggestion } from '../services/tagging.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, ImageIcon, PlayCircle, ChevronDown, MapPin, Minus, Plus, Stamp as StampIcon } from 'lucide-react-native';
import {
  createPostcard,
  discardPostcardShell,
  getUploadUrl,
  uploadToSignedUrl,
  completeUpload,
  validatePostcardMedia,
  type PostcardVisibility,
  type UploadCancelRef,
} from '../services/postcards.ts';
import { validateMedia } from '../services/media.ts';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import { useMediaPicker } from '../hooks/useMediaPicker.ts';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import type { Place } from '../lib/location/placeTypes.ts';
import { placeToLocationFields } from '../lib/location/locationPayload.ts';
import { StampPickerSheet } from './StampPickerSheet.tsx';
import { StampOverlayBadge } from './StampOverlayBadge.tsx';
import {
  clamp,
  clampOverlayPosition,
  completePayloadFromDraft,
  draftFromOption,
  draftToRenderData,
  overlayLayout,
  STAMP_OVERLAY_CORNERS,
  STAMP_OVERLAY_MAX_SCALE,
  STAMP_OVERLAY_MIN_SCALE,
  STAMP_OVERLAY_SCALE_STEP,
  STAMP_OVERLAY_STYLES,
  type StampOverlayDraft,
} from '../lib/stampOverlay.ts';

type Phase = 'pick' | 'uploading';

interface PickedAsset {
  uri: string;
  mimeType: string;
  fileName: string;
  fileSizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  isVideo: boolean;
}

const VISIBILITIES: { key: PostcardVisibility; label: string }[] = [
  { key: 'public',   label: 'Public' },
  { key: 'trip_only', label: 'Trip crew only' },
  { key: 'private',  label: 'Only me' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function PostcardComposer({ visible, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('pick');
  const [asset, setAsset] = useState<PickedAsset | null>(null);
  const [caption, setCaption] = useState('');
  // @mention / #hashtag tokenization in the caption (§26) — parity with the
  // Pulse/Comment composers, which the audit flagged this field lacked.
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  // Canonical location from the universal picker (replaces the old free-text
  // city field). Null = no location tagged; the postcard still posts.
  const [place, setPlace] = useState<Place | null>(null);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [visibility, setVisibility] = useState<PostcardVisibility>('public');
  const [showVis, setShowVis] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<UploadCancelRef>({});
  const abortedRef = useRef(false);
  const { pickMedia } = useMediaPicker();

  async function pickPostcardMedia() {
    const assets = await pickMedia({
      title: asset ? 'Replace media' : 'Add media',
      mediaTypes: ['images', 'videos'],
      videoMaxDuration: 60,
    });
    if (assets?.[0]) applyAsset(assets[0]);
  }


  // ── Stamp overlay editing state (images only; optional) ─────────────────
  const [stampOverlay, setStampOverlay] = useState<StampOverlayDraft | null>(null);
  const [stampPickerOpen, setStampPickerOpen] = useState(false);
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number } | null>(null);
  const stampOverlayRef = useRef<StampOverlayDraft | null>(null);
  stampOverlayRef.current = stampOverlay;
  const previewSizeRef = useRef<{ w: number; h: number } | null>(null);
  previewSizeRef.current = previewSize;
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  // Plain PanResponder (no gesture libs) — works on native AND react-native-web.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
      // Don't let the surrounding ScrollView steal an in-progress drag.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const ov = stampOverlayRef.current;
        dragStartRef.current = ov ? { x: ov.x, y: ov.y } : null;
      },
      onPanResponderMove: (_e, g) => {
        const start = dragStartRef.current;
        const ov = stampOverlayRef.current;
        const size = previewSizeRef.current;
        if (!start || !ov || !size || size.w <= 0 || size.h <= 0) return;
        const next = clampOverlayPosition(start.x + g.dx / size.w, start.y + g.dy / size.h);
        setStampOverlay({ ...ov, x: next.x, y: next.y });
      },
      onPanResponderRelease: () => { dragStartRef.current = null; },
      onPanResponderTerminate: () => { dragStartRef.current = null; },
    }),
  ).current;

  function resizeStamp(dir: 1 | -1) {
    setStampOverlay((ov) =>
      ov
        ? {
            ...ov,
            scale: clamp(
              ov.scale + dir * STAMP_OVERLAY_SCALE_STEP,
              STAMP_OVERLAY_MIN_SCALE,
              STAMP_OVERLAY_MAX_SCALE,
            ),
          }
        : ov,
    );
  }

  function reset() {
    setPhase('pick');
    setAsset(null);
    setCaption('');
    setPlace(null);
    setCityPickerOpen(false);
    setVisibility('public');
    setShowVis(false);
    setProgress(0);
    setError(null);
    setStampOverlay(null);
    setStampPickerOpen(false);
    setPreviewSize(null);
    abortedRef.current = false;
  }

  function handleClose() {
    if (phase === 'uploading') {
      Alert.alert('Cancel upload?', 'Your upload is in progress. Cancel it?', [
        { text: 'Keep uploading', style: 'cancel' },
        {
          text: 'Cancel upload',
          style: 'destructive',
          onPress: () => {
            abortedRef.current = true;
            cancelRef.current.cancel?.();
            reset();
            onClose();
          },
        },
      ]);
      return;
    }
    reset();
    onClose();
  }

  // applyAsset validates and stores the picked asset. Called directly from
  // pickPostcardMedia after the useMediaPicker chooser resolves.
  function applyAsset(picked: ImagePicker.ImagePickerAsset) {
    const mimeType =
      picked.mimeType ??
      (picked.type === 'video' ? 'video/mp4' : 'image/jpeg');

    const fileSizeBytes = picked.fileSize ?? 0;

    // Always validate MIME type — reject unsupported formats immediately.
    const mimeValidation = validatePostcardMedia(mimeType, fileSizeBytes > 0 ? fileSizeBytes : 1);
    if (!mimeValidation.ok && mimeValidation.reason === 'mime') {
      Alert.alert('Cannot use this file', mimeValidation.message);
      return;
    }

    // Validate file size when available. If the picker omits fileSize (common on
    // Android for camera captures), skip the size check and let the server enforce it.
    if (fileSizeBytes > 0) {
      const sizeValidation = validatePostcardMedia(mimeType, fileSizeBytes);
      if (!sizeValidation.ok) {
        Alert.alert('Cannot use this file', sizeValidation.message);
        return;
      }
    }

    const durationSeconds =
      picked.type === 'video' && picked.duration != null
        ? Math.round(picked.duration / 1000)
        : undefined;

    // Enforce the postcard-specific duration limit (60 s).
    if (picked.type === 'video' && durationSeconds != null) {
      const durationValidation = validateMedia(
        { uri: picked.uri, mimeType, type: 'video', duration: durationSeconds },
        { surface: 'postcard' },
      );
      if (!durationValidation.ok) {
        Alert.alert('Cannot use this video', durationValidation.message);
        return;
      }
    }

    setAsset({
      uri: picked.uri,
      mimeType,
      fileName: picked.fileName ?? `postcard.${mimeType.split('/')[1] ?? 'jpg'}`,
      fileSizeBytes,
      width: picked.width ?? undefined,
      height: picked.height ?? undefined,
      durationSeconds,
      isVideo: picked.type === 'video',
    });
    // Stamps only apply to photos — drop any draft overlay for videos.
    if (picked.type === 'video') setStampOverlay(null);
    setError(null);
  }

  async function handlePost() {
    if (!asset) return;
    setError(null);
    setPhase('uploading');
    setProgress(0);
    abortedRef.current = false;

    // Structured canonical location via the shared Place → payload mapping
    // (same one the Memory composer uses): city/country strings for display
    // and stamps, place-level coordinates, placeId for the provider
    // reference, canonicalId linking to the universal location registry.
    // All optional — posting works without one.
    const postRes = await createPostcard({
      caption: caption.trim() || undefined,
      visibility,
      ...placeToLocationFields(place),
      addToPassport: true,
    });

    if (!postRes.ok || abortedRef.current) {
      // The shell is a real, publicly-visible posts row created before any bytes
      // exist. Whenever we bail after it was created, discard it — otherwise the
      // attempt leaves an empty active post on the author's profile that nothing
      // reaps (sweep-orphans collects post_media rows only, never the posts row).
      if (postRes.ok) void discardPostcardShell(postRes.data.id);
      if (!abortedRef.current) {
        setError(postRes.ok ? 'Upload cancelled' : postRes.message);
        setPhase('pick');
      }
      return;
    }

    const postId = postRes.data.id;

    const urlRes = await getUploadUrl(postId, {
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes > 0 ? asset.fileSizeBytes : 1,
    });

    if (!urlRes.ok || abortedRef.current) {
      void discardPostcardShell(postId);
      if (!abortedRef.current) {
        setError(urlRes.ok ? 'Upload cancelled' : urlRes.message);
        setPhase('pick');
      }
      return;
    }

    const { mediaId, uploadUrl } = urlRes.data;

    const uploadRes = await uploadToSignedUrl(
      uploadUrl,
      asset.uri,
      asset.mimeType,
      (p) => setProgress(p),
      cancelRef.current,
    );

    if (!uploadRes.ok || abortedRef.current) {
      void discardPostcardShell(postId);
      if (!abortedRef.current) {
        setError(uploadRes.message ?? 'Upload failed');
        setPhase('pick');
      }
      return;
    }

    const completeRes = await completeUpload(postId, mediaId, {
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes > 0 ? asset.fileSizeBytes : 1,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      stampOverlay:
        stampOverlay && !asset.isVideo ? completePayloadFromDraft(stampOverlay) : undefined,
    });

    if (!completeRes.ok) {
      // Completion is rejected as retryable (e.g. the server's fail-closed byte
      // verification), and the composer resets to 'pick' — so a retry creates a
      // fresh shell. Discard this one rather than stranding it.
      void discardPostcardShell(postId);
      setError(completeRes.message);
      setPhase('pick');
      return;
    }

    // A stamp problem never blocks the post — surface it quietly after success.
    const overlayWarning =
      completeRes.data.stampOverlayApplied === false
        ? stampOverlayErrorMessage(completeRes.data.stampOverlayError)
        : null;

    reset();
    onSuccess();
    if (overlayWarning) {
      Alert.alert('Posted without stamp', overlayWarning);
    }
  }

  const visLabel = VISIBILITIES.find((v) => v.key === visibility)?.label ?? 'Public';
  const progressPct = Math.round(progress * 100);
  const editorLayout =
    stampOverlay && previewSize
      ? overlayLayout(previewSize.w, previewSize.h, stampOverlay)
      : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={[s.root, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={s.header}>
          <Pressable style={s.headerBtn} onPress={handleClose} hitSlop={8}>
            <X size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>New Postcard</Text>
          {phase === 'pick' && asset ? (
            <Pressable
              style={s.postBtn}
              onPress={handlePost}
              disabled={!asset}
            >
              <Text style={s.postBtnText}>Post</Text>
            </Pressable>
          ) : (
            <View style={{ width: 60 }} />
          )}
        </View>

        {phase === 'pick' && (
          <KeyboardSafeView
            offset={insets.top}
            scrollViewProps={{ style: { flex: 1 } }}
            contentContainerStyle={s.scrollContent}
          >
            {/* Error */}
            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}

            {/* Preview or picker */}
            {asset ? (
              <View
                style={s.previewWrap}
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  setPreviewSize((prev) =>
                    prev && prev.w === width && prev.h === height
                      ? prev
                      : { w: width, h: height },
                  );
                }}
              >
                <Image
                  source={{ uri: asset.uri }}
                  style={s.preview}
                  resizeMode="cover"
                />
                {asset.isVideo && (
                  <View style={s.playOverlay}>
                    <PlayCircle size={48} color="#fff" />
                  </View>
                )}
                {/* Placed stamp + invisible drag target (photos only) */}
                {!asset.isVideo && stampOverlay && previewSize && (
                  <>
                    <StampOverlayBadge
                      overlay={draftToRenderData(stampOverlay)}
                      containerWidth={previewSize.w}
                      containerHeight={previewSize.h}
                    />
                    {editorLayout && (
                      <View
                        {...panResponder.panHandlers}
                        style={{
                          position: 'absolute',
                          left: editorLayout.left - 10,
                          top: editorLayout.top - 10,
                          width: editorLayout.size + 20,
                          height: editorLayout.size + 20,
                        }}
                      />
                    )}
                  </>
                )}
                <Pressable style={s.changeBtn} onPress={pickPostcardMedia} hitSlop={8}>
                  <Text style={s.changeBtnText}>Change</Text>
                </Pressable>
              </View>
            ) : (
              <View style={s.pickerArea}>
                <Text style={s.pickerHint}>Photo or video (up to 100 MB)</Text>
                <View style={s.pickerBtns}>
                  <Pressable style={s.pickerBtn} onPress={pickPostcardMedia}>
                    <Camera size={28} color={color.signal} />
                    <Text style={s.pickerBtnText}>Camera</Text>
                  </Pressable>
                  <Pressable style={s.pickerBtn} onPress={pickPostcardMedia}>
                    <ImageIcon size={28} color={color.signal} />
                    <Text style={s.pickerBtnText}>Library</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Form — only shown after picking */}
            {asset && (
              <View style={s.form}>
                {/* Caption */}
                <Text style={s.label}>Caption</Text>
                <MentionSuggestionList
                  suggestions={mentionSuggestions}
                  loading={mentionLoading}
                  visible={mentionVisible}
                  onSelect={(sug) => mentionRef.current?.insertTag(sug)}
                />
                <MentionInput
                  ref={mentionRef}
                  style={s.captionInput}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Where did you go? What did you do?"
                  placeholderTextColor={color.faint}
                  multiline
                  maxLength={2000}
                  surface="post"
                  onSuggestionsChange={(items, isLoading, trigger) => {
                    setMentionSuggestions(items);
                    setMentionLoading(isLoading);
                    setMentionVisible(!!trigger && (items.length > 0 || isLoading));
                  }}
                />

                {/* City — universal canonical location picker */}
                <Text style={s.label}>City</Text>
                <Pressable style={s.visSelector} onPress={() => setCityPickerOpen(true)}>
                  <View style={s.cityValue}>
                    <MapPin size={16} color={place ? color.signal : color.mute} />
                    <Text
                      style={[s.visSelectorText, s.cityValueText, !place && s.cityPlaceholder]}
                      numberOfLines={1}
                    >
                      {place
                        ? place.country ? `${place.name}, ${place.country}` : place.name
                        : 'Search for a city'}
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
                    >
                      <X size={16} color={color.mute} />
                    </Pressable>
                  ) : (
                    <ChevronDown size={16} color={color.mute} />
                  )}
                </Pressable>

                {/* Passport stamp — optional overlay placed on the photo */}
                {!asset.isVideo && (
                  <>
                    <Text style={s.label}>Passport stamp</Text>
                    {!stampOverlay ? (
                      <Pressable style={s.stampAddBtn} onPress={() => setStampPickerOpen(true)}>
                        <StampIcon size={16} color={color.signal} />
                        <Text style={s.stampAddText}>Add a stamp (optional)</Text>
                      </Pressable>
                    ) : (
                      <View style={s.stampControls}>
                        <View style={s.stampMetaRow}>
                          <Text style={s.stampName} numberOfLines={1}>{stampOverlay.label}</Text>
                          <Pressable onPress={() => setStampPickerOpen(true)} hitSlop={6}>
                            <Text style={s.stampAction}>Replace</Text>
                          </Pressable>
                          <Pressable onPress={() => setStampOverlay(null)} hitSlop={6}>
                            <Text style={[s.stampAction, { color: color.mute }]}>Remove</Text>
                          </Pressable>
                        </View>
                        <View style={s.stampChipRow}>
                          {STAMP_OVERLAY_STYLES.map((st) => (
                            <Pressable
                              key={st.key}
                              style={[s.stampChip, stampOverlay.style === st.key && s.stampChipActive]}
                              onPress={() => setStampOverlay({ ...stampOverlay, style: st.key })}
                            >
                              <Text style={[s.stampChipText, stampOverlay.style === st.key && s.stampChipTextActive]}>
                                {st.label}
                              </Text>
                            </Pressable>
                          ))}
                        </View>
                        <View style={s.stampToolRow}>
                          <Pressable style={s.stampTool} onPress={() => resizeStamp(-1)} hitSlop={6}>
                            <Minus size={14} color={color.ink} />
                          </Pressable>
                          <Pressable style={s.stampTool} onPress={() => resizeStamp(1)} hitSlop={6}>
                            <Plus size={14} color={color.ink} />
                          </Pressable>
                          <View style={{ flex: 1 }} />
                          {STAMP_OVERLAY_CORNERS.map((c) => (
                            <Pressable
                              key={c.key}
                              style={s.stampCorner}
                              onPress={() => setStampOverlay({ ...stampOverlay, x: c.x, y: c.y })}
                              hitSlop={4}
                            >
                              <View style={[s.stampCornerDot, cornerDotPos(c.key)]} />
                            </Pressable>
                          ))}
                        </View>
                        <Text style={s.stampHint}>Drag the stamp on the photo to position it.</Text>
                      </View>
                    )}
                  </>
                )}

                {/* Visibility */}
                <Text style={s.label}>Visibility</Text>
                <Pressable
                  style={s.visSelector}
                  onPress={() => setShowVis((v) => !v)}
                >
                  <Text style={s.visSelectorText}>{visLabel}</Text>
                  <ChevronDown size={16} color={color.mute} />
                </Pressable>
                {showVis && (
                  <View style={s.visDropdown}>
                    {VISIBILITIES.map((v) => (
                      <Pressable
                        key={v.key}
                        style={[s.visOption, visibility === v.key && s.visOptionActive]}
                        onPress={() => { setVisibility(v.key); setShowVis(false); }}
                      >
                        <Text style={[s.visOptionText, visibility === v.key && s.visOptionTextActive]}>
                          {v.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </KeyboardSafeView>
        )}

        {phase === 'uploading' && (
          <View style={s.uploadingWrap}>
            <ActivityIndicator size="large" color={color.signal} />
            <Text style={s.uploadingTitle}>
              {progressPct < 5 ? 'Preparing upload…' : `Uploading ${progressPct}%`}
            </Text>

            {/* Progress bar */}
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${progressPct}%` }]} />
            </View>

            <Pressable
              style={s.cancelUploadBtn}
              onPress={() => {
                abortedRef.current = true;
                cancelRef.current.cancel?.();
                reset();
              }}
            >
              <Text style={s.cancelUploadText}>Cancel</Text>
            </Pressable>
          </View>
        )}
        {/* Universal location picker — canonical city search with Popular /
            Nearby / Recent suggestions. Renders its own transparent Modal. */}
        <GlobalPlacePicker
          visible={cityPickerOpen}
          title="Where was this?"
          mode="city"
          usedFor="postcard_location"
          onSelect={(selected) => {
            setPlace(selected);
            setCityPickerOpen(false);
          }}
          onClose={() => setCityPickerOpen(false)}
        />
        {/* Stamp picker — earned + location-suggested universal stamps */}
        <StampPickerSheet
          visible={stampPickerOpen}
          onClose={() => setStampPickerOpen(false)}
          onSelect={(opt) => {
            setStampOverlay((prev) =>
              prev
                ? { ...draftFromOption(opt), style: prev.style, x: prev.x, y: prev.y, scale: prev.scale }
                : draftFromOption(opt),
            );
            setStampPickerOpen(false);
          }}
          city={place ? place.city ?? place.name : null}
          country={place?.country ?? null}
        />
      </View>
    </Modal>
  );
}

/** Dot position inside the little corner-preset buttons. */
function cornerDotPos(key: string): { top?: number; bottom?: number; left?: number; right?: number } {
  switch (key) {
    case 'tl': return { top: 3, left: 3 };
    case 'tr': return { top: 3, right: 3 };
    case 'bl': return { bottom: 3, left: 3 };
    default: return { bottom: 3, right: 3 };
  }
}

/** Friendly copy for the non-blocking "posted without stamp" cases. */
function stampOverlayErrorMessage(code?: string): string {
  switch (code) {
    case 'stamp_not_eligible':
      return "You haven't earned that stamp for this location yet, so the postcard was posted without it.";
    case 'stamp_unavailable':
      return 'That stamp is no longer available, so the postcard was posted without it.';
    case 'stamp_overlay_images_only':
    case 'stamp_overlay_not_supported':
      return 'Stamps can only be placed on photos, so the postcard was posted without one.';
    default:
      return 'The stamp could not be added, so the postcard was posted without it.';
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  headerBtn: { width: 60, alignItems: 'flex-start' },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  postBtn: {
    width: 60, backgroundColor: color.signal,
    borderRadius: radius.pill, paddingVertical: 8, alignItems: 'center',
  },
  postBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  scrollContent: { paddingBottom: 40 },
  errorBanner: {
    backgroundColor: '#FEE2E2', marginHorizontal: space.lg, marginTop: space.md,
    borderRadius: radius.md, padding: space.md,
  },
  errorText: { ...t.small, color: '#B91C1C' },
  previewWrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    borderRadius: radius.lg, overflow: 'hidden',
    height: 280, backgroundColor: color.haze,
  },
  preview: { ...StyleSheet.absoluteFillObject },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  changeBtn: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6,
  },
  changeBtnText: { ...t.small, color: '#fff', fontWeight: '600' },
  pickerArea: {
    marginHorizontal: space.lg, marginTop: space.lg,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze,
    borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 48, gap: space.xl,
  },
  pickerHint: { ...t.small, color: color.mute },
  pickerBtns: { flexDirection: 'row', gap: space.xl },
  pickerBtn: { alignItems: 'center', gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.md },
  pickerBtnText: { ...t.bodyStrong, color: color.ink },
  form: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 2 },
  captionInput: {
    ...t.body, color: color.ink,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, minHeight: 96, textAlignVertical: 'top',
  },
  textInput: {
    ...t.body, color: color.ink,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, height: 48,
  },
  visSelector: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, height: 48,
  },
  visSelectorText: { ...t.body, color: color.ink },
  cityValue: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1, marginRight: space.sm },
  cityValueText: { flexShrink: 1 },
  cityPlaceholder: { color: color.faint },
  visDropdown: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    overflow: 'hidden', ...shadow.card,
  },
  visOption: { paddingVertical: 14, paddingHorizontal: space.md, backgroundColor: color.paper },
  visOptionActive: { backgroundColor: color.haze },
  visOptionText: { ...t.body, color: color.ink },
  visOptionTextActive: { fontWeight: '700', color: color.signal },
  uploadingWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.xl,
  },
  uploadingTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  progressTrack: {
    width: '100%', height: 6, backgroundColor: color.haze,
    borderRadius: 3, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: color.signal, borderRadius: 3 },
  cancelUploadBtn: {
    paddingHorizontal: space.xl, paddingVertical: space.md,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.mute,
  },
  cancelUploadText: { ...t.bodyStrong, color: color.ink },

  // ── Stamp overlay controls ────────────────────────────────────────────────
  stampAddBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze,
    borderRadius: radius.md, padding: space.md, height: 48,
  },
  stampAddText: { ...t.body, color: color.signal, fontWeight: '600' },
  stampControls: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, gap: space.sm,
  },
  stampMetaRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stampName: { ...t.bodyStrong, color: color.ink, flex: 1 },
  stampAction: { ...t.small, color: color.signal, fontWeight: '700' },
  stampChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  stampChip: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  stampChipActive: { borderColor: color.signal, backgroundColor: 'rgba(255,77,46,0.08)' },
  stampChipText: { ...t.small, color: color.ink },
  stampChipTextActive: { color: color.signal, fontWeight: '700' },
  stampToolRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stampTool: {
    width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, borderWidth: 1, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  stampCorner: {
    width: 26, height: 26, borderRadius: 6, borderWidth: 1, borderColor: color.haze,
  },
  stampCornerDot: {
    position: 'absolute', width: 7, height: 7, borderRadius: 2,
    backgroundColor: color.signal,
  },
  stampHint: { ...t.small, color: color.faint },
});
