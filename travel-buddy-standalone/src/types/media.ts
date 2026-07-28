/**
 * Media tab shared types — Watch mode feed items and related shapes.
 *
 * WatchFeedType uses underscore form to match the API query param contract
 * (feedType=for_you | following).
 */

/** Must match the `feedType` query param accepted by GET /api/media/feed. */
export type WatchFeedType = 'for_you' | 'following';

export interface MediaFeedCreator {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  isFollowing?: boolean;
  /** True when the creator holds a verified traveler status. */
  verified?: boolean;
}

/** A resolved location label — place ID may be absent for unstructured locations. */
export interface MediaFeedPlace {
  /** Canonical place ID when the location is linked to a structured place record. */
  id?: string;
  name: string;
  city?: string | null;
  country?: string | null;
  /** Latitude — null when the media row has no stored coordinates. */
  lat?: number | null;
  /** Longitude — null when the media row has no stored coordinates. */
  lng?: number | null;
}

/** Linked structured entity attached to the media item. */
export type LinkedEntityKind = 'event' | 'trip' | 'place' | 'plan';

export interface MediaFeedLinkedEntity {
  kind: LinkedEntityKind;
  id: string;
  label: string;
}

/** A single item in the Watch-mode full-screen vertical feed. */
export interface MediaFeedItem {
  id: string;
  videoUrl: string;
  posterUrl: string | null;
  /** Duration in seconds (from media metadata, may be null). */
  duration?: number | null;
  creator: MediaFeedCreator;
  caption: string;
  hashtags: string[];
  place: MediaFeedPlace | null;
  linkedEntity: MediaFeedLinkedEntity | null;
  /** Shown in the audio row (original audio label, etc.). */
  audioLabel: string | null;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  likedByMe: boolean;
  savedByMe: boolean;
  /** Number of distinct viewers who stamped this video. Absent on legacy items. */
  stampItCount?: number;
  /** True when the post was GPS-verified at the tagged location at upload time. */
  locationVerified?: boolean;
}

/** Page cursor returned by the feed API. */
export interface WatchFeedPage {
  items: MediaFeedItem[];
  nextCursor: string | null;
  sessionId: string;
}

// ── Grid mode ─────────────────────────────────────────────────────────────────

/** Filter chip values for the grid feed. */
export type GridFilter = 'all' | 'videos' | 'photos' | 'following' | 'saved' | 'nearby';

/**
 * Lightweight tile item returned by GET /api/media/feed?mode=grid.
 *
 * Deliberately minimal — no captions, full profiles, event/trip objects,
 * or raw coordinates. Mirrors the server-side MediaGridItem shape.
 */
export interface MediaGridItem {
  id: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  /** Duration in milliseconds. Null for images or missing metadata. */
  durationMs: number | null;
  contentType: string | null;
  creatorId: string;
  locationLabel: string | null;
  placeId: string | null;
  viewCount: number;
  qualifiedViewCount: number;
  /** Non-null only for in-progress uploads (processing overlay). */
  processingStatus: string | null;
  /**
   * Direct URL to the video asset. Null for image items or when the asset
   * URL is not yet resolved. Used by the grid tile for muted autoplay.
   */
  videoUrl: string | null;
  /** True when the post was GPS-verified at the tagged location at upload time. */
  locationVerified?: boolean;
}

export interface GridFeedPage {
  items: MediaGridItem[];
  nextCursor: string | null;
  sessionId: string;
}
