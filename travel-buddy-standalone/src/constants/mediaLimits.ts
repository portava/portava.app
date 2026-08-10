/**
 * Central source of truth for media size and duration limits.
 * Import from here instead of duplicating constants across composers.
 */

export const VIDEO_MAX_SIZE_BYTES = 50_000_000; // 50 MB
export const IMAGE_MAX_SIZE_BYTES = 10_000_000; // 10 MB

/**
 * expo-image-picker `quality` (0–1) used for photo capture/pick across every
 * composer. Previously drifted to four different unexplained values
 * (0.85/0.9/0.92/1) across call sites with no stated rationale — the same
 * kind of drift the sizing tokens had. Standardised here; a call site should
 * only diverge from this constant when it documents a specific reason inline.
 */
export const CAPTURE_QUALITY = 0.92;

export const VIDEO_MAX_DURATION_SECONDS = {
  highlight: 10,
  memory: 45,
  postcard: 60,
  event: 120,
  trip: 120,
  message: 60,
} as const;

export type VideoSurface = keyof typeof VIDEO_MAX_DURATION_SECONDS;

export const ACCEPTED_VIDEO_TYPES = ['video/mp4'] as const;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
