/**
 * useMessageMediaPicker — encapsulates media picking, validation, upload,
 * progress tracking, cancel, and retry for message media (images & videos).
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
import { useState, useRef, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform, Alert } from 'react-native';
import { validateMedia, uploadMedia } from '../services/media.ts';
import type { PickedMedia } from '../services/media.ts';

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
  pickFromLibrary: () => Promise<void>;
  pickFromCamera: () => Promise<void>;
  pickVideo: () => Promise<void>;
  upload: () => Promise<MediaUploadResult | null>;
  cancel: () => void;
  retry: () => Promise<MediaUploadResult | null>;
  clearMedia: () => void;
}

export function useMessageMediaPicker(): UseMessageMediaPickerReturn {
  const [state, setState] = useState<PickerUploadState>('idle');
  const [media, setMedia] = useState<PendingMediaAttachment | null>(null);
  const [uploadResult, setUploadResult] = useState<MediaUploadResult | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  const cancelledRef = useRef(false);

  // ── Internal: pick helper ─────────────────────────────────────────────────

  async function handlePickResult(
    result: ImagePicker.ImagePickerResult,
    expectedType: 'image' | 'video' | 'any',
  ): Promise<void> {
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    const detectedType: 'image' | 'video' =
      asset.type === 'video' ? 'video' : 'image';

    const pickedMedia: PickedMedia = {
      uri: asset.uri,
      mimeType: asset.mimeType ?? (detectedType === 'video' ? 'video/mp4' : 'image/jpeg'),
      fileName: asset.fileName ?? null,
      fileSize: asset.fileSize ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      type: detectedType,
      duration: asset.duration != null ? asset.duration / 1000 : null,
    };

    const validation = validateMedia(pickedMedia, { surface: 'message' });
    if (!validation.ok) {
      Alert.alert('Cannot attach media', validation.message);
      return;
    }

    const mime: string = pickedMedia.mimeType ?? (detectedType === 'video' ? 'video/mp4' : 'image/jpeg');
    setMedia({
      localUri: asset.uri,
      mediaType: detectedType,
      mimeType: mime,
      fileName: asset.fileName ?? null,
      fileSize: asset.fileSize ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      duration: pickedMedia.duration,
    });
    setUploadResult(null);
    setUploadProgress(0);
    setState('previewing');
  }

  // ── Web fallback: <input type="file"> ─────────────────────────────────────

  function pickViaFileInput(accept: string): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(); return; }
        const isVideo = file.type.startsWith('video/');
        const detectedType: 'image' | 'video' = isVideo ? 'video' : 'image';
        const uri = URL.createObjectURL(file);
        const pickedMedia: PickedMedia = {
          uri,
          mimeType: file.type,
          fileName: file.name,
          fileSize: file.size,
          type: detectedType,
          duration: null,
        };
        const validation = validateMedia(pickedMedia, { surface: 'message' });
        if (!validation.ok) {
          Alert.alert('Cannot attach media', validation.message);
          resolve();
          return;
        }
        setMedia({
          localUri: uri,
          mediaType: detectedType,
          mimeType: file.type,
          fileName: file.name,
          fileSize: file.size,
          width: null,
          height: null,
          duration: null,
        });
        setUploadResult(null);
        setUploadProgress(0);
        setState('previewing');
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
      Alert.alert('Permission required', 'Please allow access to your photo library in Settings.');
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.9,
    });
    if (state === 'picking') setState('idle'); // reset if nothing selected
    await handlePickResult(result, 'image');
  }, [state]);

  const pickFromCamera = useCallback(async () => {
    if (Platform.OS === 'web') {
      await pickViaFileInput('image/*');
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Please allow camera access in Settings.');
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.9,
    });
    if (state === 'picking') setState('idle');
    await handlePickResult(result, 'image');
  }, [state]);

  const pickVideo = useCallback(async () => {
    if (Platform.OS === 'web') {
      await pickViaFileInput('video/*');
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Please allow access to your photo library in Settings.');
      return;
    }
    setState('picking');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false,
      quality: 1,
      videoMaxDuration: 60,
    });
    if (state === 'picking') setState('idle');
    await handlePickResult(result, 'video');
  }, [state]);

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
      // duration is stored in seconds in PendingMediaAttachment; PickedMedia also expects seconds
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
      setState('failed');
      return null;
    }

    setUploadProgress(1);
    const mediaTypeNormalized: 'image' | 'video' =
      (result.mediaType ?? '').startsWith('video/') ? 'video' : 'image';

    const uploadRes: MediaUploadResult = {
      url: result.url,
      mediaType: mediaTypeNormalized,
      thumbnailUrl: null, // thumbnail generation is server-side / future
      durationSeconds: media.duration != null ? Math.round(media.duration) : null,
    };
    setUploadResult(uploadRes);
    setState('done');
    return uploadRes;
  }, [media]);

  // ── Cancel ────────────────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setMedia(null);
    setUploadResult(null);
    setUploadProgress(0);
    setState('idle');
  }, []);

  // ── Retry ─────────────────────────────────────────────────────────────────

  const retry = useCallback(async (): Promise<MediaUploadResult | null> => {
    if (!media) return null;
    setState('previewing');
    return upload();
  }, [media, upload]);

  // ── Clear ─────────────────────────────────────────────────────────────────

  const clearMedia = useCallback(() => {
    cancelledRef.current = true;
    setMedia(null);
    setUploadResult(null);
    setUploadProgress(0);
    setState('idle');
  }, []);

  return {
    state,
    media,
    uploadResult,
    uploadProgress,
    pickFromLibrary,
    pickFromCamera,
    pickVideo,
    upload,
    cancel,
    retry,
    clearMedia,
  };
}
