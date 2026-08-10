/**
 * useMessageMediaPicker — encapsulates media picking, validation, upload,
 * progress tracking, cancel, and retry for message media (images & videos).
 *
 * Picking and validation are delegated to useMediaComposer('message') so all
 * composers share the same permission-denied→Settings path, iOS limited-library
 * prompt, and policy-driven validation. The rest of the hook (upload progress,
 * cancel, retry, web fallback) is message-thread-specific and stays local.
 *
 * Usage:
 *   const picker = useMessageMediaPicker(threadId);
 *   picker.pickFromLibrary()    // photo library
 *   picker.pickFromCamera()     // camera capture
 *   picker.pickVideo()          // video library
 *   picker.cancel()             // cancel in-flight upload
 *   picker.retry()              // retry failed upload
 *   picker.clearMedia()         // discard pending attachment
 *
 * Returned `media` describes the pending attachment; null = no attachment.
 * Returned `uploadResult` is set after a successful upload; reset on clear.
 */
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform, Alert, Linking } from 'react-native';
import { uploadMedia } from '../services/media.ts';
import type { PickedMedia } from '../services/media.ts';
import { useMediaComposer } from './useMediaComposer.ts';
import { CAPTURE_QUALITY } from '../constants/mediaLimits.ts';

export type PickerUploadState = 'idle' | 'picking' | 'previewing' | 'uploading' | 'done' | 'failed';

export interface PendingMediaAttachment {
  localUri: string;
  mediaType: 'image' | 'video';
  mimeType: string;
  fileName?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface MediaUploadResult {
  url: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

export interface UseMessageMediaPickerReturn {
  state: PickerUploadState;
  media: PendingMediaAttachment | null;
  uploadResult: MediaUploadResult | null;
  uploadProgress: number;
  /** Actionable error message set when the upload fails (rate_limited / invalid_payload / generic). */
  uploadError: string | null;
  pickFromLibrary: () => Promise<void>;
  pickFromCamera: () => Promise<void>;
  pickVideo: () => Promise<void>;
  upload: () => Promise<MediaUploadResult | null>;
  cancel: () => void;
  retry: () => Promise<MediaUploadResult | null>;
  clearMedia: () => void;
}

/** User-facing messages for upload-specific error kinds in message threads. */
const MESSAGE_UPLOAD_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: 'Too many uploads — please wait a moment and try again.',
  invalid_payload: "This file couldn't be read — try a different photo.",
};

export function useMessageMediaPicker(): UseMessageMediaPickerReturn {
  // Picking and validation are handled by useMediaComposer('message').
  // The message policy: maxItems=1, allowedTypes=['images','videos'],
  // videoMaxDuration=60. All permission flows go through MediaSourceSheet
  // (used by callers via the sheet state), or through the programmatic
  // pick functions below which call ImagePicker directly for the three
  // distinct action types (library photo, camera, library video).
  const mediaComposer = useMediaComposer('message');

  const [state, setState] = useState<PickerUploadState>('idle');
  const [uploadResult, setUploadResult] = useState<MediaUploadResult | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const cancelledRef = useRef(false);

  // Derive PendingMediaAttachment from the composer's primary item so that
  // the upload / retry flow reads from one source of truth.
  const primaryItem = mediaComposer.primaryItem;
  const media = useMemo<PendingMediaAttachment | null>(
    () =>
      primaryItem
        ? {
            localUri: primaryItem.uri,
            mediaType: primaryItem.type,
            mimeType: primaryItem.mimeType,
            fileName: primaryItem.fileName,
            fileSize: primaryItem.fileSize,
            width: primaryItem.width,
            height: primaryItem.height,
            duration: primaryItem.duration,
          }
        : null,
    [primaryItem],
  );

  // Transition to 'previewing' as soon as the composer receives its first item.
  useEffect(() => {
    if (mediaComposer.items.length > 0 && state === 'idle') {
      setState('previewing');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaComposer.items.length]);

  // ── Web fallback: <input type="file"> ─────────────────────────────────────
  // Synthesises a minimal ImagePickerAsset and routes it through
  // mediaComposer.onPickResult so validation is consistent with native.

  function pickViaFileInput(accept: string): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { resolve(); return; }
        const isVideo = file.type.startsWith('video/');
        const detectedType: 'image' | 'video' = isVideo ? 'video' : 'image';
        const uri = URL.createObjectURL(file);
        // Synthesise a minimal ImagePickerAsset for onPickResult
        const synth: ImagePicker.ImagePickerAsset = {
          uri,
          mimeType: file.type,
          fileName: file.name,
          fileSize: file.size,
          type: detectedType,
          width: 0,
          height: 0,
          assetId: null,
          base64: null,
          exif: null,
          duration: null,
          pairedVideoAsset: undefined,
        } as unknown as ImagePicker.ImagePickerAsset;
        mediaComposer.onPickResult(synth);
        resolve();
      };
      input.click();
    });
  }

  // ── Public pick actions ───────────────────────────────────────────────────

  const pickFromLibrary = useCallback(async () => {
    if (Platform.OS === 'web') {
      await pickViaFileInput('image/*,video/*');
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow access to your photo library to attach images.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: CAPTURE_QUALITY,
    });
    setState((s) => (s === 'picking' ? 'idle' : s));
    if (!result.canceled && result.assets[0]) {
      mediaComposer.onPickResult(result.assets[0]);
    }
  }, [mediaComposer.onPickResult]);

  const pickFromCamera = useCallback(async () => {
    if (Platform.OS === 'web') {
      await pickViaFileInput('image/*');
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow camera access to take a photo.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: CAPTURE_QUALITY,
    });
    setState((s) => (s === 'picking' ? 'idle' : s));
    if (!result.canceled && result.assets[0]) {
      mediaComposer.onPickResult(result.assets[0]);
    }
  }, [mediaComposer.onPickResult]);

  const pickVideo = useCallback(async () => {
    if (Platform.OS === 'web') {
      await pickViaFileInput('video/*');
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow access to your photo library to attach a video.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: false,
      // Deliberately NOT CAPTURE_QUALITY: for video, expo-image-picker's
      // `quality` selects an export/re-encode preset (iOS), so anything below
      // 1 forces a second lossy re-compression of an already-encoded library
      // video. Keep at 1 to avoid compounding quality loss on top of capture.
      quality: 1,
      videoMaxDuration: 60,
    });
    setState((s) => (s === 'picking' ? 'idle' : s));
    if (!result.canceled && result.assets[0]) {
      mediaComposer.onPickResult(result.assets[0]);
    }
  }, [mediaComposer.onPickResult]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const upload = useCallback(async (): Promise<MediaUploadResult | null> => {
    if (!media) return null;
    cancelledRef.current = false;
    setState('uploading');
    setUploadProgress(0.05); // show immediate feedback

    const pickedMedia: PickedMedia = {
      uri: media.localUri,
      mimeType: media.mimeType,
      fileName: media.fileName,
      fileSize: media.fileSize,
      width: media.width,
      height: media.height,
      type: media.mediaType,
      // duration is stored in seconds in PendingMediaAttachment
      duration: media.duration ?? null,
    };

    // Simulate progress increments while upload runs (no native progress event)
    let progressTick: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (cancelledRef.current) return;
      setUploadProgress((p) => Math.min(p + 0.1, 0.85));
    }, 400);

    let result;
    try {
      result = await uploadMedia(pickedMedia, { surface: 'message' });
    } finally {
      if (progressTick) { clearInterval(progressTick); progressTick = null; }
    }

    if (cancelledRef.current) return null;

    if (!result.ok || !result.url) {
      const msg =
        MESSAGE_UPLOAD_ERROR_MESSAGES[result.errorKind ?? ''] ??
        result.message ??
        'Upload failed. Please try again.';
      setUploadError(msg);
      setState('failed');
      return null;
    }

    setUploadError(null);
    setUploadProgress(1);
    const mediaTypeNormalized: 'image' | 'video' =
      (result.mediaType ?? '').startsWith('video/') ? 'video' : 'image';

    const uploadRes: MediaUploadResult = {
      url: result.url,
      mediaType: mediaTypeNormalized,
      thumbnailUrl: result.thumbnailUrl ?? null,
      durationSeconds: media.duration != null ? Math.round(media.duration) : null,
    };
    setUploadResult(uploadRes);
    setState('done');
    return uploadRes;
  }, [media]);

  // ── Cancel ────────────────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    mediaComposer.clearAll();
    setUploadResult(null);
    setUploadProgress(0);
    setUploadError(null);
    setState('idle');
  }, [mediaComposer.clearAll]);

  // ── Retry ─────────────────────────────────────────────────────────────────

  const retry = useCallback(async (): Promise<MediaUploadResult | null> => {
    if (!media) return null;
    setState('previewing');
    return upload();
  }, [media, upload]);

  // ── Clear ─────────────────────────────────────────────────────────────────

  const clearMedia = useCallback(() => {
    cancelledRef.current = true;
    mediaComposer.clearAll();
    setUploadResult(null);
    setUploadProgress(0);
    setUploadError(null);
    setState('idle');
  }, [mediaComposer.clearAll]);

  return {
    state,
    media,
    uploadResult,
    uploadProgress,
    uploadError,
    pickFromLibrary,
    pickFromCamera,
    pickVideo,
    upload,
    cancel,
    retry,
    clearMedia,
  };
}
