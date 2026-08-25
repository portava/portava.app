/**
 * Types for the Living Destination Page API responses.
 * Matches the shape returned by GET /api/places/:id/living
 * and GET /api/places/:id/living/timeline.
 */

export type TimelineSlice =
  | 'today'
  | 'week'
  | 'month'
  | 'year'
  | 'dry_season'
  | 'rainy_season';

export interface LivingBucketPost {
  id: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
}

export interface LivingBucket {
  bucket: string;
  posts: LivingBucketPost[];
  postCount: number;
  isThin: boolean;
}

export interface LivingTimelinePost {
  id: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  authorId: string | null;
  createdAt: string | null;
  mediaType?: string | null;
  buckets?: string[];
  like_count?: number | null;
}

export interface LivingTimeline {
  slice: TimelineSlice;
  posts: LivingTimelinePost[];
  crowdLevel: string | null;
  weatherBrief: string | null;
}

export interface LivingDedupGroup {
  groupId: string;
  memberCount: number;
  sampleUrls: string[];
}

export interface LivingBestOfItem {
  id?: string | null;
  mediaUrl: string | null;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  caption?: string | null;
  title?: string | null;
}

/**
 * A live intelligence claim as surfaced to the place card (Intelligence
 * Gathering / IG-05 read path).
 *
 * This is the EXACT wire shape the server sends — the mirror of
 * `api-server/src/lib/liveClaimRead.ts` `LiveClaimEnvelope`. It is derived,
 * exposable decision intelligence only: canonical value, confidence + band,
 * source class, observed time, freshness (`validUntil`), the server's live/
 * typical state, and a provenance `id` for the "why" surface. It deliberately
 * carries NO contributor ids, coordinates, raw GPS evidence, visibility, or
 * k-anonymity internals — the server strips those before it ever leaves the DB.
 *
 * Keep this in lock-step with that server type; it is the one client interface
 * for a live claim, not a second guessed shape.
 */
export interface LiveClaimDTO {
  /** Snapshot id — provenance reference for the "why" surface / corroboration. */
  id: string;
  claimType: string;
  value: unknown;
  confidence: number | null;
  /** ConfidenceBand: 'unverified'|'provisional'|'likely_current'|'live'|'strong'. */
  band: string;
  /** SourceClass, e.g. 'firsthand_unverified'. */
  sourceClass: string;
  sourceCount: number;
  observedAt: string;
  /** Freshness horizon — the client degrades to "unknown" past this. */
  validUntil: string;
  /** Server-computed live-vs-typical state. */
  state: 'live' | 'typical' | 'unknown';
}

export interface LivingOfficialInfo {
  hours: unknown;
  isOpenNow: boolean | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  priceLevel: number | null;
  rating: number | null;
  reviewCount: number | null;
  bookingUrl: string | null;
  attribution: string[];
}

export interface PlaceLivingResponse {
  placeId: string;
  sparseMode: boolean;
  hero: { imageUrl: string | null; videoUrl: string | null };
  rating: { score: number | null; voteCount: number; rawLikes: number } | null;
  bestTime: string | null;
  crowdLevel: string | null;
  /**
   * Live intelligence claims for the place (IG-05). Optional — absent until the
   * read path surfaces the richer projection; the chips fall back to
   * `crowdLevel` when it is missing. Gated by `intel_live_label_crowd`.
   */
  liveClaims?: LiveClaimDTO[] | null;
  weather: { forecasts: unknown[]; briefSummary: string | null } | null;
  directionsUrl: { appleMaps: string; googleMaps: string; waze: string } | null;
  officialInfo: LivingOfficialInfo;
  aiSummary: string | null;
  buckets: LivingBucket[];
  timeline: LivingTimeline;
  bestOf: {
    videos: LivingBestOfItem[];
    photos: LivingBestOfItem[];
    viewpoints: LivingBestOfItem[];
    foodNearby: LivingBestOfItem[];
    experiences: LivingBestOfItem[];
  } | null;
  dedupGroups: LivingDedupGroup[];
  topContributor: {
    userId: string;
    displayName: string | null;
    avatarUrl: string | null;
    contributionCount: number;
  } | null;
  thinBuckets: string[];
  generatedAt: string;
}

export interface PlaceTimelineResponse {
  placeId: string;
  slice: TimelineSlice;
  posts: LivingTimelinePost[];
  total: number;
  crowdLevel: string | null;
  weatherBrief: string | null;
}

export type PlaceDayStatus = 'active' | 'closing' | 'archived';

export interface PlaceDay {
  id: string;
  placeId: string;
  placeName: string;
  localDate: string;
  timezone: string;
  status: PlaceDayStatus;
  openedAt: string;
  closingAt: string | null;
  archivedAt: string | null;
}

export interface PlaceDayLookupResponse {
  day: PlaceDay | null;
  navigation: { previousDate: string | null; nextDate: string | null };
}

export interface PlaceDayFeedItem {
  id: string;
  authorId: string;
  caption: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
  createdAt: string;
}

export interface PlaceDayFeedResponse {
  placeId: string;
  localDate: string;
  items: PlaceDayFeedItem[];
  nextCursor: string | null;
}
