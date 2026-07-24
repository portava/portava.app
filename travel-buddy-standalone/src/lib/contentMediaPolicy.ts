/**
 * contentMediaPolicy — central registry of per-content-type media policies.
 *
 * Every composer that handles media imports its policy key from here instead
 * of hard-coding limits inline. The registry drives:
 *   - useMediaComposer → enforces maxItems, allowedTypes, videoMaxDuration
 *   - MediaAttachmentTray → shows altText field when supportsAltText
 *   - MediaSourceSheet integration → passes allowsVideo / videoMaxDuration
 */

import type { MediaType } from 'expo-image-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentPolicyKey =
  | 'pulse'
  | 'story'
  | 'highlight'
  | 'postcard'
  | 'memory'
  | 'profileAvatar'
  | 'profileCover'
  | 'message'
  | 'event'
  | 'trip'
  | 'tripCover'
  | 'review'
  | 'buddyApplication'
  | 'hiddenGem'
  | 'communityPlace'
  | 'safetyReport';

export interface ContentMediaPolicy {
  /** Maximum number of media items allowed. */
  maxItems: number;
  /** Expo ImagePicker MediaType array. */
  allowedTypes: MediaType[];
  /**
   * Whether the first item (or an explicitly marked item) acts as a "cover".
   * Renders a ★ badge in MediaAttachmentTray; tapping changes cover.
   */
  supportsCover: boolean;
  /** Whether multiple items can be selected (gallery mode). */
  supportsGallery: boolean;
  /** Whether alt-text input is shown per item in MediaAttachmentTray. */
  supportsAltText: boolean;
  /** Fallback category tag for analytics / routing. */
  fallbackCategory?: string;
  /** Maximum video duration in seconds (undefined = no limit beyond global cap). */
  videoMaxDuration?: number;
  /** Whether to enable in-picker crop/edit (passed to launchImageLibraryAsync). */
  allowsEditing?: boolean;
  /** Aspect ratio for editing [width, height] — only meaningful when allowsEditing=true. */
  editAspect?: [number, number];
  /**
   * When true, video picks are intercepted by a post-pick 9:16 crop-preview
   * sheet (VideoStoryTrimSheet) before the asset is passed to onResult.
   * Use for story composers where iOS ignores in-picker aspect on video.
   */
  requireStoryVideoCrop?: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CONTENT_MEDIA_POLICIES: Record<ContentPolicyKey, ContentMediaPolicy> = {
  pulse: {
    maxItems: 1,
    allowedTypes: ['images', 'videos'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'post',
    videoMaxDuration: 60,
  },

  story: {
    maxItems: 1,
    allowedTypes: ['images', 'videos'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'story',
    allowsEditing: true,
    editAspect: [9, 16],
    // Video picks bypass in-picker crop (iOS ignores aspect on video).
    // VideoStoryTrimSheet handles the post-pick 9:16 preview + confirm step.
    requireStoryVideoCrop: true,
  },

  highlight: {
    maxItems: 1,
    allowedTypes: ['images', 'videos'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'highlight',
    videoMaxDuration: 10,
    allowsEditing: true,
  },

  postcard: {
    maxItems: 1,
    allowedTypes: ['images', 'videos'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'postcard',
    videoMaxDuration: 60,
  },

  memory: {
    maxItems: 10,
    allowedTypes: ['images', 'videos'],
    supportsCover: true,
    supportsGallery: true,
    supportsAltText: true,
    fallbackCategory: 'memory',
    videoMaxDuration: 30,
  },

  profileAvatar: {
    maxItems: 1,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'profile',
    allowsEditing: true,
    editAspect: [1, 1],
  },

  profileCover: {
    maxItems: 1,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'profile',
    allowsEditing: true,
    editAspect: [16, 9],
  },

  message: {
    maxItems: 1,
    allowedTypes: ['images', 'videos'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'message',
    videoMaxDuration: 60,
  },

  event: {
    maxItems: 10,
    allowedTypes: ['images', 'videos'],
    supportsCover: true,
    supportsGallery: true,
    supportsAltText: false,
    fallbackCategory: 'event',
    videoMaxDuration: 120,
  },

  trip: {
    maxItems: 20,
    allowedTypes: ['images', 'videos'],
    supportsCover: true,
    supportsGallery: true,
    supportsAltText: false,
    fallbackCategory: 'trip',
    videoMaxDuration: 120,
  },

  // ── Optional photo attachment flows ─────────────────────────────────────────

  /** Single cover image for a new trip — images only, no video. */
  tripCover: {
    maxItems: 1,
    allowedTypes: ['images'],
    supportsCover: true,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'trip_cover',
    allowsEditing: false,
  },

  /** Optional photo evidence attached to a review (max 3). */
  review: {
    maxItems: 3,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: true,
    supportsAltText: false,
    fallbackCategory: 'review',
  },

  /** Profile photos uploaded during a buddy application (max 3). */
  buddyApplication: {
    maxItems: 3,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: true,
    supportsAltText: false,
    fallbackCategory: 'buddy_application',
  },

  /** Single representative photo for a hidden gem submission. */
  hiddenGem: {
    maxItems: 1,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'gem',
    allowsEditing: false,
  },

  /**
   * Community/user place submission photo.
   * Defined for policy completeness; the current server endpoint has no
   * imageUrl column — this flow is SKIPPED and noted in the Task 6 report.
   */
  communityPlace: {
    maxItems: 3,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: true,
    supportsAltText: false,
    fallbackCategory: 'community_place',
  },

  /**
   * Safety report photo evidence.
   * Defined for policy completeness; the current server endpoint has no
   * imageUrl column — this flow is SKIPPED and noted in the Task 6 report.
   */
  safetyReport: {
    maxItems: 1,
    allowedTypes: ['images'],
    supportsCover: false,
    supportsGallery: false,
    supportsAltText: false,
    fallbackCategory: 'safety_report',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getPolicy(key: ContentPolicyKey): ContentMediaPolicy {
  return CONTENT_MEDIA_POLICIES[key];
}

/** Whether the policy allows video (has 'videos' in allowedTypes). */
export function policyAllowsVideo(policy: ContentMediaPolicy): boolean {
  return (policy.allowedTypes as string[]).includes('videos');
}
