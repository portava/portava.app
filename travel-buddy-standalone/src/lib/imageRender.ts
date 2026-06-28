/**
 * Client-side image compression pipeline for profile photos.
 *
 * Uses expo-image-manipulator to resize + compress before upload so large
 * originals (up to 25 MB) never hit the API server's size caps.
 *
 * Variants produced:
 *   avatar   — 512 × 512 JPEG (q 0.82) — nav chips, passport cards, feed
 *   cover    — max 1 200 px wide, aspect-preserved JPEG (q 0.80) — cover banner
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { SaveFormat } from 'expo-image-manipulator';

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
 * Falls back to the original URI if ImageManipulator fails so the upload
 * can still succeed (server's 5 MB cap is the final safety net).
 */
export async function renderAvatarImage(uri: string): Promise<RenderedImage> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: AVATAR_TARGET_PX, height: AVATAR_TARGET_PX } }],
      { compress: 0.82, format: SaveFormat.JPEG },
    );
    return { uri: result.uri, width: result.width, height: result.height, mimeType: 'image/jpeg' };
  } catch {
    return { uri, width: AVATAR_TARGET_PX, height: AVATAR_TARGET_PX, mimeType: 'image/jpeg' };
  }
}

/**
 * Compress a cover photo to at most 1 200 px on the longest side.
 *
 * Never upscales. Pass `originalWidth` from the expo-image-picker asset so we
 * only resize when the image is actually larger than the target.
 *
 * Falls back to the original URI on manipulator failure.
 */
export async function renderCoverImage(uri: string, originalWidth: number): Promise<RenderedImage> {
  try {
    const needsResize = originalWidth > COVER_MAX_PX;
    const actions: ImageManipulator.Action[] = needsResize
      ? [{ resize: { width: COVER_MAX_PX } }]
      : [];
    const result = await ImageManipulator.manipulateAsync(
      uri,
      actions,
      { compress: 0.80, format: SaveFormat.JPEG },
    );
    return { uri: result.uri, width: result.width, height: result.height, mimeType: 'image/jpeg' };
  } catch {
    return { uri, width: originalWidth, height: 0, mimeType: 'image/jpeg' };
  }
}
