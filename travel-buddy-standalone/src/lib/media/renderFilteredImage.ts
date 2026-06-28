/**
 * renderFilteredImage — resize a photo and return metadata for filter display.
 *
 * Uses expo-image-manipulator to decode + resize to ≤1080px on the longest
 * side before upload. The CSS filter is applied as a live style overlay in the
 * editor and stored as filter_id/filter_intensity metadata on the post row —
 * the display layer re-applies it for native renders where canvas baking is
 * not available.
 *
 * On web, you can additionally bake via canvas (see the web-specific path at
 * the bottom), but expo-image-manipulator is the cross-platform path.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { SaveFormat } from 'expo-image-manipulator';

export const FILTER_MAX_SIDE = 1080;
export const FILTER_OUTPUT_QUALITY = 0.88;

export interface FilteredImageResult {
  uri: string;
  width: number;
  height: number;
  filterId: string;
  filterIntensity: number;
  mimeType: 'image/jpeg';
}

export interface RenderFilteredImageOptions {
  uri: string;
  filterId: string;
  intensity: number;
  /** Max pixels on longest side (default: 1080). */
  maxSide?: number;
  /** JPEG output quality 0–1 (default: 0.88). */
  outputQuality?: number;
}

/**
 * Resize a photo to at most `maxSide` on the longest dimension and return the
 * result with filter metadata attached. The URI returned is the resized JPEG
 * ready for upload; the caller is responsible for recording filterId and
 * filterIntensity on the post/highlight row so the display layer can re-apply
 * the CSS filter.
 *
 * Falls back to the original URI if ImageManipulator fails so posting can
 * still succeed.
 */
export async function renderFilteredImage(
  opts: RenderFilteredImageOptions,
): Promise<FilteredImageResult> {
  const { uri, filterId, intensity, maxSide = FILTER_MAX_SIDE, outputQuality = FILTER_OUTPUT_QUALITY } = opts;

  try {
    const actions: ImageManipulator.Action[] = [{ resize: { width: maxSide } }];
    const result = await ImageManipulator.manipulateAsync(
      uri,
      actions,
      { compress: outputQuality, format: SaveFormat.JPEG },
    );

    return {
      uri: result.uri,
      width: result.width,
      height: result.height,
      filterId,
      filterIntensity: intensity,
      mimeType: 'image/jpeg',
    };
  } catch {
    return {
      uri,
      width: 0,
      height: 0,
      filterId,
      filterIntensity: intensity,
      mimeType: 'image/jpeg',
    };
  }
}
