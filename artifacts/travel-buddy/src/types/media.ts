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
}

/** A resolved location label — place ID may be absent for unstructured locations. */
export interface MediaFeedPlace {
  /** Canonical place ID when the location is linked to a structured place record. */
  id?: string;
  name: string;
  city?: string | null;
  country?: string | null;
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
}

/** Page cursor returned by the feed API. */
export interface WatchFeedPage {
  items: MediaFeedItem[];
  nextCursor: string | null;
  sessionId: string;
}
