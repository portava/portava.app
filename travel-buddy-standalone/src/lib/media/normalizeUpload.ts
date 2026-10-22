/**
 * normalizeUpload — the device half of normalizeUpload.core.ts: the picker options every library pick spreads in, and
 * `normalizeForUpload` with the real expo-image-manipulator and expo-file-system behind it. Every picker source (the
 * media source sheet, useMediaPicker, useMessageMediaPicker and the camera-first composer) runs its result through
 * `normalizeForUpload` before validateMedia sees it. See the core module for what is converted, resized and why.
 */
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { normalizeForUploadWith, type UploadAsset } from './normalizeUpload.core.ts';

export * from './normalizeUpload.core.ts';

/** Spread into every `launchImageLibraryAsync`: iOS hands over JPEG (not HEIC) and H.264 MP4 (not HEVC), ratio kept. */
// Read defensively: a test double of expo-image-picker may omit these enums (the values are the library's own).
export const COMPATIBLE_LIBRARY_OPTIONS = {
  preferredAssetRepresentationMode: (ImagePicker.UIImagePickerPreferredAssetRepresentationMode?.Compatible ?? 'compatible') as ImagePicker.UIImagePickerPreferredAssetRepresentationMode,
  videoExportPreset: (ImagePicker.VideoExportPreset?.H264_1920x1080 ?? 7) as ImagePicker.VideoExportPreset,
} as const;

async function localFileSize(uri: string): Promise<number | null> {
  try {
    // Loaded lazily (only once a photo is re-encoded); require, not import(), so a test double of the module applies.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const info = await fs.getInfoAsync(uri);
    return info.exists && typeof (info as { size?: number }).size === 'number' ? (info as { size: number }).size : null;
  } catch {
    return null;
  }
}

/** The asset as the server will take it (see normalizeUpload.core.ts). Never throws. */
export function normalizeForUpload<T extends UploadAsset>(asset: T): Promise<T & UploadAsset> {
  return normalizeForUploadWith(asset, {
    manipulate: (uri, actions, options) =>
      ImageManipulator.manipulateAsync(uri, actions, { compress: options.compress, format: options.format as ImageManipulator.SaveFormat }),
    fileSize: localFileSize,
  });
}

/** Every asset of a picker result, normalized in order. */
export function normalizeAllForUpload<T extends UploadAsset>(assets: readonly T[]): Promise<Array<T & UploadAsset>> {
  return Promise.all(assets.map((a) => normalizeForUpload(a)));
}
