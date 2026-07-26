/**
 * mediaFeedItem — MediaFeedItem type and hydrator for the Watch mode feed.
 *
 * hydrateMediaFeedItem maps a raw DB row (post + related data) to the
 * canonical MediaFeedItem shape, enforcing private-field stripping and
 * resolving signed vs. public URLs through existing mediaAccess.ts logic.
 *
 * Private-profile items expose only: avatar, displayName, username, isPrivate,
 * and follow/request action — no bio, counts, trips, etc.
 *
 * Private media rows resolve to signed URLs; public rows use public URLs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicUrlFor } from "./mediaAccess.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface MediaFeedCreator {
  id: string;
  username: string;
  /** Resolved per display-name privacy rule: @handle or real name when opted in. */
  displayName: string;
  avatarUrl: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  /** Null when creator has a private profile and viewer is not a follower. */
  followersCount: number | null;
  followingCount: number | null;
  bio: string | null;
}

export interface MediaFeedMediaItem {
  id: string;
  type: "image" | "video";
  url: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sortOrder: number;
}

export interface MediaFeedStats {
  viewCount: number;
  likeCount: number;
  saveCount: number;
  commentCount: number;
}

export interface MediaFeedLocation {
  name: string | null;
  city: string | null;
  country: string | null;
}

export interface MediaFeedViewerState {
  hasLiked: boolean;
  hasSaved: boolean;
  isFollowingCreator: boolean;
  hasFollowRequestPending: boolean;
}

export interface MediaFeedPrivacy {
  isPrivate: boolean;
}

export interface MediaFeedModeration {
  status: string;
}

/** Linked entity (event or trip) — private variants expose only safe fields. */
export interface MediaFeedLinkedEntity {
  type: "event" | "trip";
  id: string;
  title: string;
  isPrivate: boolean;
  /** Safe header image — may be null for private entities. */
  coverImageUrl: string | null;
  /** Host or owner display name. */
  ownerDisplayName: string | null;
  ownerUsername: string | null;
}

/**
 * Canonical shape returned by GET /api/media/feed and GET /api/media/:id.
 */
export interface MediaFeedItem {
  id: string;
  /** Source entity type — 'post', 'memory', 'story', etc. */
  sourceType: "post" | "memory" | "story";
  sourceId: string;
  caption: string | null;
  tags: string[];
  createdAt: string;
  creator: MediaFeedCreator;
  media: MediaFeedMediaItem[];
  stats: MediaFeedStats;
  location: MediaFeedLocation | null;
  viewerState: MediaFeedViewerState;
  privacy: MediaFeedPrivacy;
  moderation: MediaFeedModeration;
  linkedEntity: MediaFeedLinkedEntity | null;
}

// ── Hydration input ───────────────────────────────────────────────────────────

export interface HydrateInput {
  /** Raw post/memory/story row (snake_case from DB). */
  row: any;
  sourceType: "post" | "memory" | "story";
  /** The viewing user's id (for display-name privacy + viewerState). */
  viewerUserId: string;
  /** Set of author ids that have opted in to showing their real name. */
  allowedRealNameIds: Set<string>;
  /** Set of post ids the viewer has saved. */
  savedPostIds: Set<string>;
  /** Set of post ids the viewer has liked (reactions). */
  likedPostIds: Set<string>;
  /** Set of creator ids the viewer follows. */
  followedCreatorIds: Set<string>;
  /** Set of creator ids the viewer has a pending follow request for. */
  pendingFollowRequestIds: Set<string>;
  /** media_assets rows pre-fetched for the post (post_media child rows). */
  postMedia: any[];
  /** Whether the media bucket is private (determines signed vs public URL). */
  useSignedUrls: boolean;
  supabaseUrl: string;
}

/**
 * Map a raw DB row to a hydrated MediaFeedItem.
 *
 * Privacy rules:
 *   - Private profile creator → strip bio, followersCount, followingCount.
 *   - Private media → URL is left as the storage path for the caller to sign.
 *     (Caller must resolve signed URLs via the /api/media/file relay.)
 */
export function hydrateMediaFeedItem(input: HydrateInput): MediaFeedItem {
  const { row, sourceType, viewerUserId, allowedRealNameIds, savedPostIds,
    likedPostIds, followedCreatorIds, pendingFollowRequestIds,
    postMedia, supabaseUrl } = input;

  // ── Creator ────────────────────────────────────────────────────────────────
  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  const creatorId: string = row.author_id ?? row.owner_id ?? "";
  const isOwnPost = creatorId === viewerUserId;
  const isFollowing = followedCreatorIds.has(creatorId);
  const creatorIsPrivate = Boolean(profile?.is_private);

  const displayName =
    (isOwnPost || allowedRealNameIds.has(creatorId))
      ? (profile?.full_name ?? profile?.username ?? "")
      : (profile?.username ?? "");

  const creator: MediaFeedCreator = {
    id: creatorId,
    username: profile?.username ?? "",
    displayName,
    avatarUrl: profile?.avatar_url ?? null,
    isPrivate: creatorIsPrivate,
    isVerified: Boolean(profile?.is_verified),
    // Strip counts for private profiles when viewer isn't following
    followersCount: (!creatorIsPrivate || isFollowing || isOwnPost)
      ? (profile?.followers_count ?? null)
      : null,
    followingCount: (!creatorIsPrivate || isFollowing || isOwnPost)
      ? (profile?.following_count ?? null)
      : null,
    // Strip bio for private profiles when viewer isn't following
    bio: (!creatorIsPrivate || isFollowing || isOwnPost)
      ? (profile?.bio ?? null)
      : null,
  };

  // ── Media items ────────────────────────────────────────────────────────────
  const mediaItems: MediaFeedMediaItem[] = (postMedia ?? [])
    .filter((m: any) =>
      m.processing_status === "ready" &&
      m.moderation_status !== "rejected" &&
      m.moderation_status !== "flagged",
    )
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m: any) => {
      // Resolve the public URL from storage path or existing public_url
      let url: string = m.public_url ?? "";
      if (!url && m.storage_path && supabaseUrl) {
        const bucket = m.storage_bucket ?? "post-media";
        url = publicUrlFor(bucket, m.storage_path) ?? "";
      }
      return {
        id: m.id,
        type: (m.media_type === "video" ? "video" : "image") as "image" | "video",
        url,
        thumbnailUrl: m.thumbnail_url ?? null,
        durationSeconds: m.duration_seconds ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        sortOrder: m.sort_order ?? 0,
      };
    });

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats: MediaFeedStats = {
    viewCount: row.view_count ?? row.qualified_view_count ?? 0,
    likeCount: row.like_count ?? row.reaction_count ?? 0,
    saveCount: row.save_count ?? 0,
    commentCount: row.comment_count ?? 0,
  };

  // ── Location ───────────────────────────────────────────────────────────────
  const hasLocation = row.location_city || row.location_name || row.location_country;
  const location: MediaFeedLocation | null = hasLocation
    ? {
        name: row.location_name ?? null,
        city: row.location_city ?? null,
        country: row.location_country ?? null,
      }
    : null;

  // ── Viewer state ───────────────────────────────────────────────────────────
  const itemId: string = row.id;
  const viewerState: MediaFeedViewerState = {
    hasLiked: likedPostIds.has(itemId),
    hasSaved: savedPostIds.has(itemId),
    isFollowingCreator: isFollowing || isOwnPost,
    hasFollowRequestPending: pendingFollowRequestIds.has(creatorId),
  };

  // ── Privacy & moderation ───────────────────────────────────────────────────
  const privacy: MediaFeedPrivacy = {
    isPrivate: row.visibility !== "public",
  };

  const moderation: MediaFeedModeration = {
    status: row.moderation_status ?? "approved",
  };

  // ── Tags ───────────────────────────────────────────────────────────────────
  const tags: string[] = Array.isArray(row.tags) ? row.tags : [];

  // ── Caption ───────────────────────────────────────────────────────────────
  const caption: string | null = row.content ?? row.caption ?? null;

  return {
    id: itemId,
    sourceType,
    sourceId: itemId,
    caption,
    tags,
    createdAt: row.created_at,
    creator,
    media: mediaItems,
    stats,
    location,
    viewerState,
    privacy,
    moderation,
    linkedEntity: null, // resolved by caller when trip/event context needed
  };
}
