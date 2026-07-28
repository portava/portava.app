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
