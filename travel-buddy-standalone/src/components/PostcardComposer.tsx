import { getPostcardUploadQueue } from '../services/media/postcardUploadQueue.ts';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { composerDraftKey } from '../services/localComposerDraft.ts';
import { usePrivateSurfaceKey } from '../hooks/usePrivateSurfaceKey.ts';
import { useSession } from '../context/SessionContext.tsx';
import { useLocalComposerDraft } from '../hooks/useLocalComposerDraft.ts';
import { useComposerOutcome } from '../hooks/useComposerOutcome.ts';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { preserveDraftAsset, discardDraftAsset, restoreDraftAsset, releaseDraftPreview } from '../services/composerDraftAsset.ts';
import { isPostcardDraft, postcardDraftNonempty, type PostcardDraft } from '../services/postcardDraft.ts';
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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet,
  ActivityIndicator, Alert, Image, ScrollView, PanResponder,
} from 'react-native';
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import { WritingAssistControl } from '../platform/input-assistance/compass/WritingAssistControl.tsx';
import { AI_WRITING_FIELD_IDS } from '../platform/input-assistance/compass/compassFields.ts';
import type { AnyMentionSuggestion } from '../services/tagging.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, ImageIcon, PlayCircle, ChevronDown, MapPin, Minus, Plus, Stamp as StampIcon } from 'lucide-react-native';
import {
  validatePostcardMedia,
  type PostcardVisibility,
} from '../services/postcards.ts';
import { validateMedia } from '../services/media.ts';
import { readFileBlob } from '../services/media/uploadHttp.ts';
import { normalizePickedAsset, prepareImageForUpload } from '../services/media/mediaProcessing.ts';
import { isResumableMediaUploadEnabled } from '../services/media/uploadTransportFlag.ts';
import { color, space, radius, type as t, shadow, avatar } from '../theme/tokens.ts';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import { useMediaPicker } from '../hooks/useMediaPicker.ts';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import type { Place } from '../lib/location/placeTypes.ts';
import { postcardLocationFields } from './postcardLocation.ts'; import { layoverPostcardPlaceLabel, type LayoverPostcardSource } from './layover/layoverPostcard.ts'; // census-layover L275 — placeToLocationFields is reached through postcardLocationFields
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
  recoveryUri?: string;
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
  { key: 'trip_only', label: 'Trip crew only' }, // offered only with a tripId — see `visibilities` below
  { key: 'private',  label: 'Only me' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void; /** census-layover L275: a postcard of this COMPLETED layover. The place comes from the layover, the picker is off, and it starts as Only me. */ layover?: LayoverPostcardSource | null; /** The trip this postcard is posted to (sent as `tripId`). Without one there is no crew to show it to, so "Trip crew only" is not offered. */ tripId?: string | null;
}

export function PostcardComposer(props: Props) {
  const scope = usePrivateSurfaceKey();
  const { userId } = useSession();
  return <PostcardComposerContent key={`${scope}:${userId ?? ''}:${props.tripId ?? ''}:${props.layover?.sessionId ?? ''}`} {...props} />;
}
function PostcardComposerContent({ visible, onClose, onSuccess, layover = null, tripId = null }: Props) {
  const { userId } = useSession();
  const [owner] = useState(captureMessagingOwnerRequest);
  const record = useComposerOutcome('postcard');
  const publicationRequested = useRef(false);
  const { isEnabled } = useFeatureFlags();
  const [initial] = useState<PostcardDraft>(() => ({ caption: '', asset: null, place: null, visibility: layover ? 'private' : 'public', stampOverlay: null }));
  const draft = useLocalComposerDraft({ accountId: owner?.ownerId === userId ? userId : null, composer: `postcard:${tripId ?? ''}:${layover?.sessionId ?? ''}`,
    initial, validate: isPostcardDraft, nonempty: postcardDraftNonempty, active: visible,
    onLeave: () => { if (!publicationRequested.current) record('left_with_unsent'); } });
  const { asset, caption, place, visibility, stampOverlay } = draft.value;
  const patch = useCallback(<K extends keyof PostcardDraft,>(field: K, value: PostcardDraft[K] | ((previous: PostcardDraft[K]) => PostcardDraft[K])) => {
    draft.setValue(previous => ({ ...previous, uploadJobId: undefined, [field]: typeof value === 'function' ? value(previous[field]) : value }));
  }, [draft.setValue]);
  const setAsset = (value: PickedAsset | null) => patch('asset', value);
  const setCaption = (value: string) => patch('caption', value);
  const setPlace = (value: Place | null) => patch('place', value);
  const setVisibility = (value: PostcardVisibility) => patch('visibility', value);
  const setStampOverlay = useCallback((value: StampOverlayDraft | null | ((previous: StampOverlayDraft | null) => StampOverlayDraft | null)) => patch('stampOverlay', value), [patch]);

  // "Trip crew only" used to be offered with no trip: the postcard was stored
  // trip_only with trip_id null, which nobody but its author could ever see.
  const visibilities = tripId ? VISIBILITIES : VISIBILITIES.filter((v) => v.key !== 'trip_only'); const tripFields = tripId ? { tripId } : {};
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('pick');
  // @mention / #hashtag tokenization in the caption (§26) — parity with the
  // Pulse/Comment composers, which the audit flagged this field lacked.
  const mentionRef = useRef<MentionInputHandle>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  // Canonical location from the universal picker (replaces the old free-text
  // city field). Null = no location tagged; the postcard still posts.
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  // // census-layover L275: a layover postcard starts private (least exposure); the traveller can change it
  const [showVis, setShowVis] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortedRef = useRef(false);
  // §37 background upload (uploadTransportFlag; ships OFF): the job id this
  // composer is watching, and its queue subscription. Closing the composer
  // unsubscribes — it does NOT cancel: the queue owns the upload.
  const queuedJobRef = useRef<string | null>(null);
  const queueUnsubRef = useRef<(() => void) | null>(null);
  useEffect(() => () => queueUnsubRef.current?.(), []);
  const { pickMedia } = useMediaPicker();
  const recoveryChecked = useRef(false);
  const [recoveringUpload, setRecoveringUpload] = useState(true);
  useEffect(() => {
    if (!visible) { recoveryChecked.current = false; return; }
    if (!draft.ready || recoveryChecked.current) return;
    recoveryChecked.current = true;
    const jobId = draft.value.uploadJobId;
    if (!jobId) { setRecoveringUpload(false); return; }
    let active = true;
    void getPostcardUploadQueue().then(async queue => {
      const job = (await queue.list()).find(value => value.id === jobId);
      if (!active || !owner?.isCurrent()) return;
      if (!job || ['failed','cancelled'].includes(job.stage)) { setRecoveringUpload(false); return; }
      if (job.stage === 'done') { await draft.clear(initial, draft.value); setRecoveringUpload(false); return; }
      publicationRequested.current = true; setPhase('uploading'); queuedJobRef.current = jobId; setRecoveringUpload(false);
      queueUnsubRef.current = queue.subscribe(event => {
        if (!active || !owner.isCurrent() || event.job.id !== jobId) return;
        if (typeof event.progress === 'number') setProgress(event.progress);
        if (event.job.stage === 'done') { void draft.clear(initial, draft.value); stopWatchingQueue(); resetUpload(); onSuccess(); }
        else if (['failed','cancelled'].includes(event.job.stage)) { publicationRequested.current = false; stopWatchingQueue(); resetUpload(); }
        else if (event.job.retryable) setError('Upload paused. Close and reopen to retry.');
      });
      await queue.resumePending();
    }).catch(() => { if (active) { setError('Saved upload could not be read. Reopen this draft to retry.'); } });
    return () => { active = false; stopWatchingQueue(); };
    // Reconcile once per visible visit; editing the recovered draft must not restart its upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.ready, visible]);

  const restoredPreview = useRef<string | null>(null);
  const assetRecoveryActive = useRef(true);
  const selectionVersion = useRef(0);
  useEffect(() => { assetRecoveryActive.current = true; return () => { assetRecoveryActive.current = false; releaseDraftPreview(restoredPreview.current); }; }, []);
  const restored = useRef(false);
  useEffect(() => { if (!visible) { selectionVersion.current++; restored.current = false; releaseDraftPreview(restoredPreview.current); restoredPreview.current = null; } }, [visible]);
  useEffect(() => {
    if (!visible || !draft.ready || restored.current) return; restored.current = true;
    const saved = draft.value.asset;
    if (saved && userId) void restoreDraftAsset(saved.recoveryUri ?? saved.uri, userId).then(uri => {
      if (!assetRecoveryActive.current || !owner?.isCurrent()) { releaseDraftPreview(uri); return; }
      restoredPreview.current = uri;
      draft.setValue(previous => previous.asset === saved ? { ...previous, asset: { ...saved, uri } } : previous);
    }).catch(() => setError('Saved media could not be restored. Your caption is kept; select the media again.'));
  }, [draft.ready, draft.value.asset, draft.setValue, userId, owner, visible]);

  async function pickPostcardMedia() {
    const version = ++selectionVersion.current;
    const assets = await pickMedia({
      title: asset ? 'Replace media' : 'Add media',
      mediaTypes: ['images', 'videos'],
      videoMaxDuration: 60,
    });
    if (assets?.[0] && version === selectionVersion.current && assetRecoveryActive.current && owner?.isCurrent()) void applyAsset(assets[0], version);
  }


  // ── Stamp overlay editing state (images only; optional) ─────────────────
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

  function resetUpload() {
    setPhase('pick'); setProgress(0); setError(null);
    // Do not reset cancellation while an async continuation may still run.
  }
  async function cancelUpload() {
    publicationRequested.current = false; abortedRef.current = true;
    const jobId = queuedJobRef.current;
    if (jobId) await cancelQueuedJob(jobId);
    resetUpload();
  }
  const discarding = useRef(false);
  async function discardDraft() {
    if (discarding.current) return; discarding.current = true;
    selectionVersion.current++;
    try {
    if (phase === 'uploading') await cancelUpload();
    const discarded = draft.value;
    if (!await draft.clear(initial, discarded)) return;
    const uploadJob = discarded.uploadJobId ? (await (await getPostcardUploadQueue()).list()).find(job => job.id === discarded.uploadJobId) : null;
    record(uploadJob?.bytesUploaded ? 'post_discarded_after_upload' : 'discarded_draft');
    if (owner) await discardDraftAsset(discarded.asset?.recoveryUri ?? discarded.asset?.uri, owner.ownerId).catch(() => {
      setError('Draft text was discarded. Its local media could not be removed yet.');
    });
    resetUpload(); onClose();
    } catch { setError('Draft could not be discarded. Your saved copy is kept; try again.'); }
    finally { discarding.current = false; }
  }
  function handleClose() {
    selectionVersion.current++;
    if (phase === 'uploading') {
      Alert.alert('Upload in progress', 'Keep your draft or continue posting.', [
        { text: 'Keep uploading', style: 'cancel' },
        ...(isResumableMediaUploadEnabled() ? [{ text: 'Continue in background', onPress: () => { draft.leave(); stopWatchingQueue(); onClose(); } }] : []),
        { text: 'Cancel upload and keep draft', onPress: () => { void cancelUpload().then(() => { draft.leave(); onClose(); }); } },
      ]);
      return;
    }
    void draft.persist().then(saved => { if (saved) { draft.leave(); onClose(); } });
  }


  // applyAsset validates and stores the picked asset. Called directly from
  // pickPostcardMedia after the useMediaPicker chooser resolves.
  async function applyAsset(picked: ImagePicker.ImagePickerAsset, version: number) {
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

    if (!owner?.isCurrent()) return;
    let localUri: string;
    try { localUri = await preserveDraftAsset(picked.uri, owner); } catch { setError('Media could not be saved on this device. Free some storage and try again.'); return; }
    if (version !== selectionVersion.current || !assetRecoveryActive.current || !owner.isCurrent()) {
      await discardDraftAsset(localUri, owner.ownerId).catch(() => {});
      return;
    }
    const previousAsset = draft.value.asset;
    setAsset({
      uri: localUri, recoveryUri: localUri,
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
    if (await draft.persist() && previousAsset && (previousAsset.recoveryUri ?? previousAsset.uri) !== localUri) {
      await discardDraftAsset(previousAsset.recoveryUri ?? previousAsset.uri, owner.ownerId).catch(() => {});
    }
    setError(null);
  }

  async function handlePost() {
    if (!asset || !draft.ready || recoveringUpload || !owner?.isCurrent() || owner.ownerId !== userId || phase === 'uploading') return;
    publicationRequested.current = true; setError(null); setPhase('uploading'); setProgress(0); abortedRef.current = false;
    try {
      const upload = await withinServerEnvelope(asset);
      if (!upload || abortedRef.current || !owner.isCurrent()) { publicationRequested.current = false; return; }
      // Encoders return cache files; queue recovery needs its own durable copy.
      const uploadUri = await preserveDraftAsset(upload.uri, owner);
      if (abortedRef.current || !owner.isCurrent()) {
        if (uploadUri !== (asset.recoveryUri ?? asset.uri)) await discardDraftAsset(uploadUri, owner.ownerId);
        return;
      }
      await postThroughQueue({ ...upload, uri: uploadUri });
    }
    catch { publicationRequested.current = false; record('upload_failed', 'storage'); setError('Your upload could not be saved on this device. Check available storage and try again.'); setPhase('pick'); }
  }

  /** The picked asset, brought inside the server's envelope — or null (error already shown). */
  async function withinServerEnvelope(picked: PickedAsset): Promise<PickedAsset | null> {
    if (picked.isVideo) return (await compressVideoForUpload(picked)).video; // §37 MD282: the SAME asset unless a compressor module is in the binary AND its switch is on (both absent today)
    const prepared = await prepareImageForUpload(
      normalizePickedAsset({
        uri: picked.uri,
        mimeType: picked.mimeType,
        fileName: picked.fileName,
        fileSize: picked.fileSizeBytes > 0 ? picked.fileSizeBytes : null,
        width: picked.width ?? null,
        height: picked.height ?? null,
        type: 'image',
      }),
    );
    if (!prepared.ok) {
      setError(prepared.message);
      setPhase('pick');
      return null;
    }
    if (!prepared.resized) return picked;
    // The re-encoded size is what the slot is reserved for — read it, never guess.
    const resizedBytes = await readFileBlob(prepared.asset.uri).then((b) => b.size, () => 0);
    return {
      ...picked,
      uri: prepared.asset.uri,
      mimeType: prepared.asset.mimeType,
      fileName: prepared.asset.fileName,
      fileSizeBytes: resizedBytes,
      width: prepared.asset.width ?? undefined,
      height: prepared.asset.height ?? undefined,
    };
  }

  function stopWatchingQueue() {
    queueUnsubRef.current?.();
    queueUnsubRef.current = null;
    queuedJobRef.current = null;
  }

  async function cancelQueuedJob(jobId: string) {
    stopWatchingQueue();
    await (await getPostcardUploadQueue()).cancel(jobId);
  }

  /**
   * §37 background upload: the upload is handed to the app-level queue, which
   * persists it before the first request and resumes it after a closed screen,
   * a backgrounded app or a relaunch. This composer only WATCHES the job.
   */
  async function postThroughQueue(upload: PickedAsset) {
    const queue = await getPostcardUploadQueue();
    const submitted = draft.value;
    const job = await queue.enqueue({
      draftKey: userId ? composerDraftKey(userId, `postcard:${tripId ?? ''}:${layover?.sessionId ?? ''}`) : undefined,
      trackOutcomes: isEnabled('MEDIA_ANALYTICS_ENABLED'),
      retainedDraftAssetUri: submitted.asset?.recoveryUri ?? submitted.asset?.uri,
      asset: normalizePickedAsset({
        uri: upload.uri,
        mimeType: upload.mimeType,
        fileName: upload.fileName,
        fileSize: upload.fileSizeBytes > 0 ? upload.fileSizeBytes : null,
        width: upload.width ?? null,
        height: upload.height ?? null,
        type: upload.isVideo ? 'video' : 'image',
        duration: upload.durationSeconds != null ? upload.durationSeconds * 1000 : null,
      }),
      caption: caption.trim() || undefined,
      visibility,
      location: { ...postcardLocationFields(place, layover), ...tripFields },
      addToPassport: true,
      stampOverlay: stampOverlay && !upload.isVideo ? completePayloadFromDraft(stampOverlay) : undefined,
    }, { start: false });
    if (!job) {
      setError('Please sign in to continue');
      setPhase('pick');
      return;
    }
    if (abortedRef.current || !owner?.isCurrent()) { await queue.cancel(job.id); return; }
    draft.setValue(previous => ({ ...previous, uploadJobId: job.id }));
    if (!await draft.persist()) { await queue.cancel(job.id); throw new Error('Draft save failed'); }
    queuedJobRef.current = job.id;
    queueUnsubRef.current?.();
    const receive = (e: import('../services/media/postcardUploadQueue.ts').QueueEvent) => {
      if (e.job.id !== job.id) return;
      if (typeof e.progress === 'number') setProgress(e.progress);
      if (e.job.stage === 'done') {
        stopWatchingQueue();
        const warning =
          e.job.result?.stampOverlayApplied === false ? stampOverlayErrorMessage(e.job.result.stampOverlayError) : null;
        void draft.clear(initial, { ...submitted, uploadJobId: job.id }).then(cleared => { if (cleared && owner) void discardDraftAsset(submitted.asset?.recoveryUri ?? submitted.asset?.uri, owner.ownerId); });
        resetUpload();
        onSuccess();
        if (warning) Alert.alert('Posted without stamp', warning);
      } else if (e.job.stage === 'failed' || e.job.stage === 'cancelled') {
        publicationRequested.current = false; stopWatchingQueue();
        setError(e.job.lastError ?? 'Upload failed');
        setPhase('pick');
      } else if (e.job.retryable) {
        setError(e.job.lastError ?? 'Waiting for a connection — your upload will continue.');
      }
    };
    queueUnsubRef.current = queue.subscribe(receive);
    // A fast job may have finished between enqueue's durable acknowledgement and subscription.
    const latest = (await queue.list()).find(row => row.id === job.id);
    if (latest) receive({ job: latest });
    void queue.resumePending().catch(() => { if (owner?.isCurrent()) setError('Upload paused. Reopen this draft to retry.'); });
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
          <Pressable accessibilityRole="button" accessibilityLabel="Close postcard composer" style={s.headerBtn} onPress={handleClose} hitSlop={8}>
            <X size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>New Postcard</Text>
          {phase === 'pick' && asset ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Publish postcard"
              style={s.postBtn}
              onPress={handlePost}
              disabled={!asset || !draft.ready || recoveringUpload}
            >
              <Text style={s.postBtnText}>Post</Text>
            </Pressable>
          ) : (
            <View style={{ width: 60 }} />
          )}
        </View>

        {draft.error ? <Text accessibilityRole="alert">{draft.error}</Text> : null}
        {phase === 'pick' && draft.ready && postcardDraftNonempty(draft.value) ? <Pressable accessibilityRole="button" accessibilityLabel="Discard postcard draft" onPress={() => void discardDraft()}><Text>Discard draft</Text></Pressable> : null}
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

                <WritingAssistControl context="caption" fieldId={AI_WRITING_FIELD_IDS.caption}
                  text={caption} onInsert={setCaption} maxLength={2000} disabled={!visible || phase !== 'pick'} />

                {/* City — universal canonical location picker */}
                <Text style={s.label}>City</Text>
                <Pressable style={s.visSelector} onPress={() => { if (!layover) setCityPickerOpen(true); }} testID={layover ? 'postcard-layover-place' : undefined}>
                  <View style={s.cityValue}>
                    <MapPin size={16} color={place ? color.signal : color.mute} />
                    <Text
                      style={[s.visSelectorText, s.cityValueText, !place && !layover && s.cityPlaceholder]}
                      numberOfLines={1}
                    >
                      {layover ? layoverPostcardPlaceLabel(layover) : place
                        ? place.country ? `${place.name}, ${place.country}` : place.name
                        : 'Search for a city'}
                    </Text>
                  </View>
                  {layover ? null : place ? (
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
                    {visibilities.map((v) => (
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
              onPress={() => { void cancelUpload(); }}
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

// §37 MD282 (census-media §37): device video compression seam. Imported at the TAIL so the
// lines census-media cites in this file do not move; ESM hoists imports.
import { compressVideoForUpload } from '../services/media/videoCompression.ts';
