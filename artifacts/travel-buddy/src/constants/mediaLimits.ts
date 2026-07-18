/**
 * Central source of truth for media size and duration limits.
 * Import from here instead of duplicating constants across composers.
 */

export const VIDEO_MAX_SIZE_BYTES = 50_000_000; // 50 MB
export const IMAGE_MAX_SIZE_BYTES = 10_000_000; // 10 MB

export const VIDEO_MAX_DURATION_SECONDS = {
  highlight: 10,
  memory: 30,
  postcard: 60,
  event: 120,
  trip: 120,
  message: 60,
} as const;

export type VideoSurface = keyof typeof VIDEO_MAX_DURATION_SECONDS;

export const ACCEPTED_VIDEO_TYPES = ['video/mp4'] as const;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
