/**
 * useMediaComposer — shared media lifecycle hook used by all composers.
 *
 * Manages:
 *   - An `items` array with per-item upload state (idle/uploading/done/error)
 *   - Reorder, remove, cover-pick, alt-text setters
 *   - Upload per item, retry, cancel
 *
 * Sheet visibility is managed by MediaPickerButton internally; this hook no
 * longer exposes openSheet / closeSheet / sheetVisible.
 *
 * Usage:
 *   const composer = useMediaComposer('memory');
 *   // Open the source sheet
 *   <MediaPickerButton composer={composer} />
 *   // Render thumbnails
 *   <MediaAttachmentTray composer={composer} />
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { ContentPolicyKey, ContentMediaPolicy } from '../lib/contentMediaPolicy.ts';
import { getPolicy, policyAllowsVideo } from '../lib/contentMediaPolicy.ts';
import { validateMedia, uploadMedia } from '../services/media.ts';
import type { MediaUploadResult } from '../services/media.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaItemUploadState = 'idle' | 'uploading' | 'done' | 'error';

export interface MediaItem {
  /** Stable React key (random ID). */
  id: string;
  uri: string;
  mimeType: string;
  fileName?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  /** 'image' | 'video' */
  type: 'image' | 'video';
  /** Video duration in seconds; null for images. */
  duration?: number | null;
  /** Alt-text for accessibility (shown when policy.supportsAltText). */
  altText: string;
  /** True for the item designated as the gallery cover. */
  isCover: boolean;
  uploadState: MediaItemUploadState;
  /** 0–1 fraction; only meaningful while uploadState === 'uploading'. */
  uploadProgress: number;
  /** Public URL after a successful upload. */
  uploadedUrl: string | null;
  /** Human-readable error set when uploadState === 'error'. */
  uploadError: string | null;
  /**
   * Set to 'format_unsupported' when the server rejected the image because it
   * could not decode the format (e.g. HEIC without libvips HEIF support).
   * Retrying the same file will always produce the same failure — the tray
   * shows a Remove action instead of a generic Retry for these items.
   */
  uploadErrorKind: 'format_unsupported' | null;
}

export interface UseMediaComposerReturn {
  /** Resolved policy for the given key. */
  policy: ContentMediaPolicy;
  /** All currently-selected media items. */
  items: MediaItem[];
  /**
   * Called by MediaSourceSheet's onResult. Adds the asset to items
   * (if policy allows) and handles limited-library prompt.
   */
  onPickResult: (asset: ImagePicker.ImagePickerAsset) => void;
  /** Remove an item by id. */
  removeItem: (id: string) => void;
  /** Swap two items by index (used by reorder UI). */
  reorderItems: (fromIndex: number, toIndex: number) => void;
  /** Mark item as cover (clears isCover on all others). */
  setCover: (id: string) => void;
  /** Update alt-text for an item. */
  setAltText: (id: string, text: string) => void;
  /**
   * Upload a single item by id. Returns the MediaUploadResult on success,
   * null on failure (error is set on the item).
   */
  uploadItem: (id: string) => Promise<MediaUploadResult | null>;
  /**
   * Upload all items that are in 'idle' state. Resolves when all finish.
   * Returns map of id → result (null on failure).
   */
  uploadAll: () => Promise<Map<string, MediaUploadResult | null>>;
  /** Retry a failed upload. */
  retryUpload: (id: string) => Promise<MediaUploadResult | null>;
  /** Cancel an in-flight upload (sets item back to idle). */
  cancelUpload: (id: string) => void;
  /** Remove all items and reset to empty. */
  clearAll: () => void;
  /**
   * Pre-populate the tray with existing remote URLs (e.g. gallery_urls from a
   * saved buddy profile). Each URL is added as a `done` item so the user can
   * keep, replace, or remove it without re-uploading.
   * No-ops if the tray already has items (i.e. only seeds on a fresh mount).
   */
  preSeedFromUrls: (urls: string[]) => void;
  /** True when more items can be added (items.length < policy.maxItems). */
  canAddMore: boolean;
  /** The first item with isCover=true, or items[0], or null. */
  primaryItem: MediaItem | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;
function makeId(): string {
  return `mi_${Date.now()}_${++_idCounter}`;
}

function assetToMediaItem(
  asset: ImagePicker.ImagePickerAsset,
  isCover: boolean,
): MediaItem {
  const isVideo =
    asset.type === 'video' ||
    (asset.mimeType ?? '').startsWith('video/');
  return {
    id: makeId(),
    uri: asset.uri,
    mimeType: asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    fileName: asset.fileName ?? null,
    fileSize: asset.fileSize ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    type: isVideo ? 'video' : 'image',
    duration: asset.duration != null ? asset.duration / 1000 : null,
    altText: '',
    isCover,
    uploadState: 'idle',
    uploadProgress: 0,
    uploadedUrl: null,
    uploadError: null,
    uploadErrorKind: null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaComposer(policyKey: ContentPolicyKey): UseMediaComposerReturn {
  const policy = getPolicy(policyKey);
  const [items, setItems] = useState<MediaItem[]>([]);

  // Snapshot ref kept fresh via useEffect — lets uploadItem read the current
  // items list without relying on React's eager state evaluation (which is
  // bypassed in concurrent mode when fiber.lanes !== NoLanes).
  const itemsRef = useRef<MediaItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Per-item cancel signals: id → ref (cancelled flag)
  const cancelRefs = useRef<Map<string, { cancelled: boolean }>>(new Map());

  // ── iOS limited-library prompt ───────────────────────────────────────────

  function maybeLimitedPrompt(perm: ImagePicker.MediaLibraryPermissionResponse) {
    if (Platform.OS !== 'ios') return;
    // accessPrivileges is 'limited' when user granted access to a subset
    if ((perm as any).accessPrivileges === 'limited') {
      Alert.alert(
        'Limited photo access',
        'You\'ve given access to a limited set of photos. You can expand your selection or grant full access.',
        [
          {
            text: 'Select more photos',
            onPress: () => {
              // Present the limited photo picker (iOS 14+)
              ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => {});
            },
          },
          {
            text: 'Allow full access',
            onPress: () => Linking.openSettings(),
          },
          { text: 'Continue', style: 'cancel' },
        ],
      );
    }
  }

  // ── Pick result ──────────────────────────────────────────────────────────

  const onPickResult = useCallback((asset: ImagePicker.ImagePickerAsset) => {
    setItems((prev) => {
      if (prev.length >= policy.maxItems) return prev;
      // Validate
      const isVideo = asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/');
      const durationSec = asset.duration != null ? asset.duration / 1000 : null;
      const vResult = validateMedia(
        {
          uri: asset.uri,
          mimeType: asset.mimeType,
          fileSize: asset.fileSize,
          type: isVideo ? 'video' : 'image',
          duration: durationSec,
        },
        policy.videoMaxDuration != null
          ? { maxVideoDurationSeconds: policy.videoMaxDuration }
          : undefined,
      );
      if (!vResult.ok) {
        Alert.alert('Cannot use this file', vResult.message);
        return prev;
      }
      const isCover = policy.supportsCover && prev.length === 0;
      return [...prev, assetToMediaItem(asset, isCover)];
    });
  // policy is stable per key — only depends on policyKey
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy.maxItems, policy.supportsCover, policy.videoMaxDuration]);

  // ── Item mutations ───────────────────────────────────────────────────────

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev.filter((it) => it.id !== id);
      // If we removed the cover, promote next item
      if (next.length > 0 && !next.some((it) => it.isCover)) {
        next[0] = { ...next[0], isCover: true };
      }
      return next;
    });
    cancelRefs.current.delete(id);
  }, []);

  const reorderItems = useCallback((fromIndex: number, toIndex: number) => {
    setItems((prev) => {
      if (
        fromIndex < 0 || fromIndex >= prev.length ||
        toIndex < 0 || toIndex >= prev.length ||
        fromIndex === toIndex
      ) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const setCover = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((it) => ({ ...it, isCover: it.id === id })),
    );
  }, []);

  const setAltText = useCallback((id: string, text: string) => {
    setItems((prev) =>
      prev.map((it) => it.id === id ? { ...it, altText: text } : it),
    );
  }, []);

  // ── Upload ───────────────────────────────────────────────────────────────

  const uploadItem = useCallback(async (id: string): Promise<MediaUploadResult | null> => {
    // Read the item from the ref snapshot (kept fresh via useEffect) — avoids
    // the setItems-as-reader pattern that breaks under React 19 concurrent mode
    // because eager evaluation is skipped when fiber.lanes !== NoLanes.
    const currentItem = itemsRef.current.find((it) => it.id === id);
    if (!currentItem) return null;

    cancelRefs.current.set(id, { cancelled: false });
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, uploadState: 'uploading', uploadProgress: 0.05, uploadError: null }
          : it,
      ),
    );

    const cancelRef = cancelRefs.current.get(id) ?? { cancelled: false };

    // Progress ticker
    const tick = setInterval(() => {
      if (cancelRef.cancelled) return;
      setItems((prev) =>
        prev.map((it) =>
          it.id === id && it.uploadState === 'uploading'
            ? { ...it, uploadProgress: Math.min(it.uploadProgress + 0.1, 0.85) }
            : it,
        ),
      );
    }, 400);

    let result: MediaUploadResult;
    try {
      result = await uploadMedia({
        uri: currentItem.uri,
        mimeType: currentItem.mimeType,
        fileName: currentItem.fileName,
        fileSize: currentItem.fileSize,
        width: currentItem.width,
        height: currentItem.height,
        type: currentItem.type,
        duration: currentItem.duration,
      });
    } finally {
      clearInterval(tick);
    }

    if (cancelRef.cancelled) return null;

    if (!result.ok || !result.url) {
      const msg = result.message ?? 'Upload failed. Please try again.';
      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? { ...it, uploadState: 'error', uploadProgress: 0, uploadError: msg, uploadErrorKind: null }
            : it,
        ),
      );
      return null;
    }

    // HEIC fail-soft guard — the server stored the raw bytes but could not decode
    // the image (libvips without HEIF support). It returns processed=false with
    // null width/height. The DB constraint (migration 2088) would block any
    // subsequent 'ready' write with null dims, so we surface the error here
    // instead of silently marking the item done and letting the post go through
    // with no visible media.
    // Videos always return processed=false (no server transcode) — scope to images.
    if (result.processed === false && currentItem.type === 'image') {
      const msg = "This photo format isn't supported — please remove and pick a JPEG or PNG";
      setItems((prev) =>
        prev.map((it) =>
          it.id === id
            ? {
                ...it,
                uploadState: 'error',
                uploadProgress: 0,
                uploadError: msg,
                uploadErrorKind: 'format_unsupported',
              }
            : it,
        ),
      );
      return null;
    }

    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, uploadState: 'done', uploadProgress: 1, uploadedUrl: result.url }
          : it,
      ),
    );
    return result;
  }, []);

  const uploadAll = useCallback(async (): Promise<Map<string, MediaUploadResult | null>> => {
    // Read idle IDs from the snapshot ref — avoids the setItems-as-reader race
    // under React 19 concurrent mode (same approach as uploadItem uses itemsRef.current).
    const ids = itemsRef.current
      .filter((it) => it.uploadState === 'idle')
      .map((it) => it.id);

    const results = await Promise.all(ids.map((id) => uploadItem(id)));
    const map = new Map<string, MediaUploadResult | null>();
    ids.forEach((id, i) => map.set(id, results[i]));
    return map;
  }, [uploadItem]);

  const retryUpload = useCallback(async (id: string): Promise<MediaUploadResult | null> => {
    // Format-unsupported items will always fail with the same result — retrying
    // the identical file is pointless. The tray renders a Remove action for these
    // items instead of Retry, but guard here too in case the caller bypasses the UI.
    const currentItem = itemsRef.current.find((it) => it.id === id);
    if (currentItem?.uploadErrorKind === 'format_unsupported') return null;

    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, uploadState: 'idle', uploadError: null, uploadErrorKind: null } : it,
      ),
    );
    return uploadItem(id);
  }, [uploadItem]);

  const cancelUpload = useCallback((id: string) => {
    const ref = cancelRefs.current.get(id);
    if (ref) ref.cancelled = true;
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, uploadState: 'idle', uploadProgress: 0, uploadError: null } : it,
      ),
    );
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
    cancelRefs.current.clear();
  }, []);

  const preSeedFromUrls = useCallback((urls: string[]) => {
    if (urls.length === 0) return;
    setItems((prev) => {
      // Only seed when the tray is truly empty — don't overwrite items the
      // user has already picked in the same session.
      if (prev.length > 0) return prev;
      return urls.slice(0, policy.maxItems).map((url, idx): MediaItem => ({
        id: makeId(),
        uri: url,
        mimeType: 'image/jpeg',
        fileName: null,
        fileSize: null,
        width: null,
        height: null,
        type: 'image',
        duration: null,
        altText: '',
        isCover: idx === 0,
        uploadState: 'done',
        uploadProgress: 1,
        uploadedUrl: url,
        uploadError: null,
        uploadErrorKind: null,
      }));
    });
  }, [policy.maxItems]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const canAddMore = items.length < policy.maxItems;
  const primaryItem =
    items.find((it) => it.isCover) ?? items[0] ?? null;

  return {
    policy,
    items,
    onPickResult,
    removeItem,
    reorderItems,
    setCover,
    setAltText,
    uploadItem,
    uploadAll,
    retryUpload,
    cancelUpload,
    clearAll,
    preSeedFromUrls,
    canAddMore,
    primaryItem,
  };
}
