/**
 * Client-side image compression pipeline for profile photos.
 *
 * Uses expo-image-manipulator to resize + compress before upload so large
 * originals (up to 25 MB) never hit the API server's size caps. Re-encoding
 * through the manipulator is also what strips EXIF metadata (including GPS)
 * from the original — so this pipeline is a privacy control, not just a
 * size control.
 *
 * Variants produced:
 *   avatar   — 512 × 512 JPEG (q 0.82) — nav chips, passport cards, feed
 *   cover    — max 1 200 px wide, aspect-preserved JPEG (q 0.80) — cover banner
 *
 * Fail-closed: if the manipulator throws, the ORIGINAL file (with its
 * untouched EXIF/GPS) must never be uploaded in its place. Callers must
 * catch ImageStripFailedError and refuse the upload with a user-visible
 * error instead of silently falling back to the original bytes.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { SaveFormat } from 'expo-image-manipulator';

/**
 * Thrown when expo-image-manipulator fails to re-encode an image. Re-encoding
 * is what strips EXIF/GPS, so a failure here means we cannot guarantee the
 * privacy-sensitive metadata has been removed. Callers MUST refuse the
 * upload on this error rather than falling back to the original file.
 */
export class ImageStripFailedError extends Error {
  constructor(cause: unknown) {
    super('Could not process this photo. Please try again or choose a different photo.');
    this.name = 'ImageStripFailedError';
    this.cause = cause;
  }
}

// ── Test seam ──────────────────────────────────────────────────────────────
// Allows unit tests (plain node:test, no RN/jest-expo harness) to simulate a
// manipulator failure without mocking the native module. Production code
// always sees null here, so the real ImageManipulator.manipulateAsync is used.
let _testManipulateAsync: typeof ImageManipulator.manipulateAsync | null = null;

/** @internal Only call from tests. Pass null to restore the real implementation. */
export function _setTestManipulateAsync(
  fn: typeof ImageManipulator.manipulateAsync | null,
): void {
  _testManipulateAsync = fn;
}

function manipulate(
  uri: string,
  actions: ImageManipulator.Action[],
  options: ImageManipulator.SaveOptions,
): Promise<ImageManipulator.ImageResult> {
  const impl = _testManipulateAsync ?? ImageManipulator.manipulateAsync;
  return impl(uri, actions, options);
}

/** 25 MB — client gate; originals larger than this are rejected before rendering */
export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

/** Target long-side for cover photos */
export const COVER_MAX_PX = 1200;

/** Square side for avatar/profile variants */
export const AVATAR_TARGET_PX = 512;

export interface RenderedImage {
  uri: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
}

/**
 * Compress an avatar to 512 × 512 JPEG (quality 0.82).
 *
 * Expects a square-cropped input: expo-image-picker with
 * `allowsEditing: true, aspect: [1, 1]` already handles the crop.
 *
 * Fail-closed: throws ImageStripFailedError if ImageManipulator fails.
 * Never falls back to the original URI — the original still carries
 * unstripped EXIF/GPS, so uploading it would silently leak that metadata.
 */
export async function renderAvatarImage(uri: string): Promise<RenderedImage> {
  try {
    const result = await manipulate(
      uri,
      [{ resize: { width: AVATAR_TARGET_PX, height: AVATAR_TARGET_PX } }],
      { compress: 0.82, format: SaveFormat.JPEG },
    );
    return { uri: result.uri, width: result.width, height: result.height, mimeType: 'image/jpeg' };
  } catch (err) {
    throw new ImageStripFailedError(err);
  }
}

/**
 * Compress a cover photo to at most 1 200 px on the longest side.
 *
 * Never upscales. Pass `originalWidth` from the expo-image-picker asset so we
 * only resize when the image is actually larger than the target.
 *
 * Fail-closed: throws ImageStripFailedError on manipulator failure. Never
 * falls back to the original URI — see module doc for why.
 */
export async function renderCoverImage(uri: string, originalWidth: number): Promise<RenderedImage> {
  try {
    const needsResize = originalWidth > COVER_MAX_PX;
    const actions: ImageManipulator.Action[] = needsResize
      ? [{ resize: { width: COVER_MAX_PX } }]
      : [];
    const result = await manipulate(
      uri,
      actions,
      { compress: 0.80, format: SaveFormat.JPEG },
    );
    return { uri: result.uri, width: result.width, height: result.height, mimeType: 'image/jpeg' };
  } catch (err) {
    throw new ImageStripFailedError(err);
  }
}
