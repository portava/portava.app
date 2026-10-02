/**
 * videoCompression — the DEVICE half of §37 "Compression/transcoding"
 * (census-media MD282).
 *
 * THE ROW. "Video bytes are re-encoded to a bounded bitrate before storage, on
 * the server or the device." The server has no decoder (artifacts/api-server
 * lib/mediaProcessing.ts). On the device, re-encoding needs a native encoder
 * — AVFoundation on iOS, MediaCodec / Media3 Transformer on Android — reached
 * through a native module, and no such module is in this app's package.json.
 * Adding one is a native-build decision (infra / owner), not a lane's.
 *
 * WHAT THIS FILE IS. The JS seam, finished, so the native half is the only
 * thing left:
 *
 *   • It looks for ONE native module, by name, with
 *     `requireOptionalNativeModule` — which returns null instead of throwing
 *     when the running binary does not contain it (Expo Go, the current dev
 *     client, every build made before the module is added, web).
 *   • ABSENT, or the switch below OFF: the picked video passes through
 *     UNCHANGED — same uri, same bytes, same size. Exactly today's behaviour.
 *   • PRESENT and ON: it asks the module for a copy bounded by
 *     VIDEO_COMPRESSION_POLICY and uses that copy ONLY if the module answered
 *     a file uri, a positive byte size SMALLER than the original, and the
 *     copy's display width and height (the postcard /complete route refuses a
 *     video without them). Any other answer — a throw, a bigger file, a missing
 *     field — falls back to the untouched original. Compression is an
 *     optimisation; it never costs the user their upload.
 *
 * THE NATIVE CONTRACT the module must implement (an Expo module, so that
 * `requireOptionalNativeModule` finds it; it may wrap a third-party library):
 *
 *   name: VIDEO_COMPRESSOR_MODULE ('PortavaVideoCompressor')
 *   compressAsync(uri: string, options: { maxBitrateBps: number; maxLongEdgePx: number })
 *     → Promise<{ uri: string; sizeBytes: number; width: number; height: number }>
 *   The output must keep the rotation the player shows (a portrait clip stays
 *   portrait), carry no location metadata (the server scrubs it anyway), and be
 *   H.264/AAC in an MP4 container, which every player in the app decodes.
 *
 * CANDIDATES for the native side — named, not chosen:
 *   • a local Expo module (like vendor/expo-openmls) over AVAssetExportSession /
 *     AVAssetWriter (iOS) and androidx.media3 Transformer (Android);
 *   • or an Expo-module wrapper over `react-native-compressor` (iOS
 *     AVFoundation, Android MediaCodec), which is not itself an Expo module;
 *   • ffmpeg-kit is NOT a candidate: it was retired and its binaries withdrawn.
 *
 * SHIPS OFF. `DEFAULT_ENABLED` is false and stays false until a device run has
 * shown a compressed clip upload, play back at the right orientation, and keep
 * its duration — even after a build that contains the module.
 */

/** The one native module name this seam looks for. */
export const VIDEO_COMPRESSOR_MODULE = 'PortavaVideoCompressor';

/**
 * OWNER DECISION, stated as a value: the bound a compressed copy must meet.
 * 4 Mbit/s at a 1920 px long edge is a 1080p-class ceiling; a 100 MB upload cap
 * then holds roughly 3 minutes 20 seconds of video.
 */
export const VIDEO_COMPRESSION_POLICY = Object.freeze({ maxBitrateBps: 4_000_000, maxLongEdgePx: 1920 });

const DEFAULT_ENABLED = false;

let _testEnabled: boolean | null = null;

/** Test seam — force the switch. Pass null to restore the shipped default. */
export function _setTestVideoCompressionFlag(value: boolean | null): void {
  _testEnabled = value;
}

export function isDeviceVideoCompressionEnabled(): boolean {
  return _testEnabled ?? DEFAULT_ENABLED;
}

export interface NativeVideoCompressor {
  compressAsync(
    uri: string,
    options: { maxBitrateBps: number; maxLongEdgePx: number },
  ): Promise<{ uri: string; sizeBytes: number; width: number; height: number }>;
}

/** Finds a native module by name, or null. Production: `requireOptionalNativeModule`. */
export type NativeModuleLookup = (name: string) => unknown;

let _testLookup: NativeModuleLookup | null = null;

/** Test seam — replace the native lookup. Pass null to restore the real one. */
export function _setTestVideoCompressorLookup(lookup: NativeModuleLookup | null): void {
  _testLookup = lookup;
}

function realLookup(name: string): unknown {
  try {
    // Loaded lazily so this file runs under node:test with no native runtime.
    // `requireOptionalNativeModule` returns null — it does not throw — when the
    // module is not in the running binary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as { requireOptionalNativeModule?: (n: string) => unknown };
    return core.requireOptionalNativeModule ? core.requireOptionalNativeModule(name) : null;
  } catch {
    return null;
  }
}

/** The native compressor, when the running binary has one with the contract's method; otherwise null. */
export function resolveVideoCompressor(): NativeVideoCompressor | null {
  const mod = (_testLookup ?? realLookup)(VIDEO_COMPRESSOR_MODULE) as Partial<NativeVideoCompressor> | null | undefined;
  if (!mod || typeof mod.compressAsync !== 'function') return null;
  return mod as NativeVideoCompressor;
}

export interface VideoForUpload {
  uri: string;
  fileSizeBytes: number;
  width?: number;
  height?: number;
}

export type VideoCompressionOutcome<T extends VideoForUpload> =
  | { compressed: true; video: T; originalSizeBytes: number }
  | { compressed: false; video: T; reason: 'switched_off' | 'module_absent' | 'failed' | 'not_smaller' | 'incomplete_answer' };

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The picked video, compressed when the module is present and the switch is
 * on — otherwise the SAME object, untouched. Never throws.
 */
export async function compressVideoForUpload<T extends VideoForUpload>(video: T): Promise<VideoCompressionOutcome<T>> {
  if (!isDeviceVideoCompressionEnabled()) return { compressed: false, video, reason: 'switched_off' };
  const native = resolveVideoCompressor();
  if (!native) return { compressed: false, video, reason: 'module_absent' };
  let out: Awaited<ReturnType<NativeVideoCompressor['compressAsync']>>;
  try {
    out = await native.compressAsync(video.uri, { ...VIDEO_COMPRESSION_POLICY });
  } catch {
    return { compressed: false, video, reason: 'failed' };
  }
  if (!out || typeof out.uri !== 'string' || out.uri.length === 0 || !positive(out.sizeBytes) || !positive(out.width) || !positive(out.height)) {
    return { compressed: false, video, reason: 'incomplete_answer' };
  }
  if (positive(video.fileSizeBytes) && out.sizeBytes >= video.fileSizeBytes) {
    return { compressed: false, video, reason: 'not_smaller' };
  }
  return {
    compressed: true,
    originalSizeBytes: video.fileSizeBytes,
    video: { ...video, uri: out.uri, fileSizeBytes: out.sizeBytes, width: Math.round(out.width), height: Math.round(out.height) },
  };
}

/**
 * For the three general upload helpers that read a local uri straight into a
 * body (`uploadMedia`, `uploadStoryMedia`, `uploadMemoryMedia`): the uri to
 * read. A still, a switched-off seam or an absent module → `uri` itself.
 * `fileSizeBytes` is the picker's figure when it gave one; without it a
 * compressed copy is accepted on the module's own bound. Never throws.
 */
export async function videoUriForUpload(uri: string, isVideo: boolean, fileSizeBytes?: number | null): Promise<string> {
  if (!isVideo) return uri;
  const size = typeof fileSizeBytes === 'number' && Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? fileSizeBytes : 0;
  return (await compressVideoForUpload({ uri, fileSizeBytes: size })).video.uri;
}
