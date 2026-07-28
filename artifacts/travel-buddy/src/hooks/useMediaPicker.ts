/**
 * useMediaPicker — lightweight hook that presents a "Take Photo / Choose from
 * Library" chooser before launching expo-image-picker.
 *
 * On native:  shows a native Alert with three options.
 * On web:     "Take Photo" opens a file-input with capture="environment";
 *             "Choose from Library" opens a regular file-input.
 *
 * Usage:
 *   const { pickMedia } = useMediaPicker();
 *   const assets = await pickMedia({ title: 'Add photo' });
 *   if (assets) { ... }
 *
 * Every existing caller that previously called launchImageLibraryAsync
 * directly should switch to pickMedia() so users always get the
 * Take Photo / Library choice.
 */
import { useCallback } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseMediaPickerOptions {
  /** Alert/sheet title. Default: "Add photo" */
  title?: string;
  /** Media types to allow. Default: ['images'] */
  mediaTypes?: ImagePicker.MediaType[];
  /** Open an in-picker crop editor after selection. Default: false */
  allowsEditing?: boolean;
  /** Aspect ratio [w, h] for the crop editor (only when allowsEditing=true). */
  aspect?: [number, number];
  /** Output quality 0–1. Default: 0.85 */
  quality?: number;
  /** Allow picking multiple items from the library. Default: false */
  allowsMultipleSelection?: boolean;
  /** Max items when allowsMultipleSelection=true. */
  selectionLimit?: number;
  /** Max video duration in seconds. Default: 60 */
  videoMaxDuration?: number;
}

export interface UseMediaPickerReturn {
  /**
   * Show the Take Photo / Choose from Library chooser, then launch the
   * appropriate picker. Returns an array of assets (≥1) on success, or
   * null if the user cancelled or permission was denied.
   */
  pickMedia: (options?: UseMediaPickerOptions) => Promise<ImagePicker.ImagePickerAsset[] | null>;
}

// ---------------------------------------------------------------------------
// Web file-input fallback
// ---------------------------------------------------------------------------

function pickViaFileInputWeb(
  accept: string,
  allowsMultipleSelection: boolean,
  capture?: string,
): Promise<ImagePicker.ImagePickerAsset[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (allowsMultipleSelection) input.multiple = true;
    if (capture) input.setAttribute('capture', capture);

    let settled = false;
    const settle = (v: ImagePicker.ImagePickerAsset[] | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) { settle(null); return; }
      const assets: ImagePicker.ImagePickerAsset[] = files.map((f) => ({
        uri: URL.createObjectURL(f),
        width: 0,
        height: 0,
        mimeType: f.type || 'image/jpeg',
        fileName: f.name,
        fileSize: f.size,
        type: (f.type.startsWith('video/') ? 'video' : 'image') as 'image' | 'video',
        assetId: null,
        base64: null,
        duration: null,
        exif: null,
        pairedVideoAsset: null,
      }));
      settle(assets);
    };
    input.oncancel = () => settle(null);
    // Fallback: focus-based cancel detection for browsers that don't fire oncancel
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => { if (!settled) settle(null); }, 500);
    };
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

async function requestCamera(): Promise<boolean> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      'Camera access required',
      'Enable camera access in Settings to take photos.',
      [
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
    return false;
  }
  return true;
}

async function requestLibrary(): Promise<boolean> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      'Photo access required',
      'Enable photo library access in Settings to choose photos.',
      [
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPicker(): UseMediaPickerReturn {
  const pickMedia = useCallback(
    async (options: UseMediaPickerOptions = {}): Promise<ImagePicker.ImagePickerAsset[] | null> => {
      const {
        title = 'Add photo',
        mediaTypes = ['images'],
        allowsEditing = false,
        aspect,
        quality = 0.85,
        allowsMultipleSelection = false,
        selectionLimit,
        videoMaxDuration = 60,
      } = options;

      const hasVideo = mediaTypes.includes('videos' as ImagePicker.MediaType);
      const accept = hasVideo ? 'image/*,video/*' : 'image/*';

      // ── Web path ────────────────────────────────────────────────────────────
      if (Platform.OS === 'web') {
        return new Promise((resolve) => {
          Alert.alert(title, undefined, [
            {
              text: 'Take Photo',
              onPress: () =>
                pickViaFileInputWeb(accept, false, 'environment').then(resolve),
            },
            {
              text: 'Choose from Library',
              onPress: () =>
                pickViaFileInputWeb(accept, allowsMultipleSelection).then(resolve),
            },
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          ]);
        });
      }

      // ── Native path ─────────────────────────────────────────────────────────
      return new Promise((resolve) => {
        const launchCamera = async () => {
          const ok = await requestCamera();
          if (!ok) { resolve(null); return; }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes,
            allowsEditing,
            aspect,
            quality,
            videoMaxDuration,
          });
          resolve(result.canceled ? null : result.assets);
        };

        const launchLibrary = async () => {
          const ok = await requestLibrary();
          if (!ok) { resolve(null); return; }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes,
            allowsEditing,
            aspect,
            quality,
            allowsMultipleSelection,
            selectionLimit,
            videoMaxDuration,
          });
          resolve(result.canceled ? null : result.assets);
        };

        Alert.alert(title, undefined, [
          { text: 'Take Photo', onPress: launchCamera },
          { text: 'Choose from Library', onPress: launchLibrary },
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        ]);
      });
    },
    [],
  );

  return { pickMedia };
}
