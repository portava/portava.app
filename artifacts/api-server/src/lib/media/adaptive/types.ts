export const ADAPTIVE_LIMITS = Object.freeze({
  inputBytes: 128 * 1024 * 1024,
  outputBytes: 96 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  durationSeconds: 120,
  pixels: 4096 * 2160,
  files: 128,
  processMs: 180_000,
  leaseMs: 600_000,
});

export interface AdaptiveConfig {
  enabled: boolean;
  root: string;
  apiBaseUrl: string;
  storageOrigin: string;
  ffmpeg: string;
  ffprobe: string;
}

export interface AdaptiveSource {
  assetId: string;
  sourceVersion: number;
  bucket: string;
  path: string;
  sizeBytes: number;
}

export interface AdaptiveRendition {
  width: number;
  height: number;
  bitrateKbps: number;
  peakBitrateKbps: number;
  durationSeconds: number;
  playlist: string;
}

export interface AdaptiveOutput {
  directory: string;
  files: Record<string, { bytes: number; sha256: string }>;
  renditions: AdaptiveRendition[];
  probe: { width: number; height: number; duration: number; fps: number; codec: string };
  preview: { file: "preview.jpg"; width: number; height: number; atSeconds: number };
}

export function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validAssetId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function validFile(value: string): boolean {
  return /^(master\.m3u8|v[01]\.m3u8|v[01]-\d{5}\.ts|preview\.jpg)$/.test(value);
}
