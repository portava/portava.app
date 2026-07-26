/**
 * mediaFeedItem — MediaFeedItem type and hydrator for the Watch mode feed.
 *
 * hydrateMediaFeedItem maps a raw DB row (post + related data) to the
 * canonical MediaFeedItem shape, enforcing private-field stripping and
 * resolving relay vs. public URLs.
 *
 * Privacy rules enforced here:
 *   1. Private-profile creator → only safe minimal fields exposed:
 *      { id, username, displayName, avatarUrl, isPrivate, relationshipStatus }
 *      No bio, follower counts, following counts, or isVerified.
 *   2. Private media (post.visibility !== 'public') → relay URL
 *      (/api/media/file/<bucket>/<path>) instead of direct public URL.
 *      The relay enforces auth + serves a short-lived signed URL.
 *   3. Private linked event/trip → only safe header fields exposed.
 *   4. Location → NEVER contains raw coordinates; only name/city/country.
 */
import { publicUrlFor } from "./mediaAccess.js";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Relationship status of the viewer towards the creator.
 * Follows the same taxonomy as the social graph.
 */
export type RelationshipStatus =
  | "self"
  | "following"
  | "pending_follow"
  | "none";

export interface MediaFeedCreator {
  id: string;
  username: string;
  /** Resolved per display-name privacy rule: @handle or real name when opted in. */
  displayName: string;
  avatarUrl: string | null;
  isPrivate: boolean;
  /**
   * Viewer's relationship towards this creator.
   * Always present so clients can render the correct CTA.
   */
  relationshipStatus: RelationshipStatus;
  /**
   * Only set when the creator has a public profile (or is the viewer).
   * Null when the creator is private and the viewer is not an approved follower.
   */
  isVerified: boolean | null;
  /**
   * Only set when the creator has a public profile (or the viewer follows them).
   * Null for private-profile creators whose details are not exposed.
   */
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
  /**
   * Gems mode only — set when the image has illustrative/AI-generated provenance.
   * Clients should render a banner: "Illustrative image — not the actual location".
   */
  provenanceLabel?: "illustrative" | null;
}

export interface MediaFeedStats {
  viewCount: number;
  likeCount: number;
  saveCount: number;
  commentCount: number;
}

/**
 * Safe location shape — NEVER contains raw coordinates.
 * Only human-readable place labels and canonical IDs are included so that
 * exact GPS positions can never be inferred from the feed response.
 */
export interface MediaFeedLocation {
  name: string | null;
  city: string | null;
  country: string | null;
  /** Gems mode only — canonical place record ID. */
  canonicalPlaceId?: string | null;
  /** Gems mode only — gem category used as place type label. */
  placeType?: string | null;
  /** Gems mode only — whether the gem has been verified. */
  isVerified?: boolean;
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
  /** Safe header image — may be null for private entities when show_header_publicly=false. */
  coverImageUrl: string | null;
  /** Host or owner display name (may be null for private entities). */
  ownerDisplayName: string | null;
  ownerUsername: string | null;
}

/**
 * Canonical shape returned by GET /api/media/feed and GET /api/media/:id.
 */
export interface MediaFeedItem {
  id: string;
  /** Source entity type — 'post', 'memory', 'story', 'gem'. */
  sourceType: "post" | "memory" | "story" | "gem";
  sourceId: string;
  /** Gems mode only — the hidden_gems record ID (same as id for gem items). */
  gemId?: string | null;
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
  /**
   * When true, private media items get relay URLs (/api/media/file/…) instead
   * of public storage URLs. Always set to true in production; public URL is
   * only returned when the post visibility is 'public'.
   *
   * @deprecated Use the relay URL path unconditionally. This flag is retained
   * for backward compat and will be removed once all callers are updated.
   */
  useSignedUrls: boolean;
  supabaseUrl: string;
  /**
   * Base URL of the API relay — used to construct /api/media/file/… URLs.
   * Defaults to "" (relative URL) when not supplied.
   */
  apiBaseUrl?: string;
  /**
   * Pre-resolved linked entity (event or trip) for this post, with privacy
   * stripping already applied by the caller.
   * When omitted or null, linkedEntity is null in the output.
   */
  linkedEntity?: MediaFeedLinkedEntity | null;
}

// ── Private entity field strippers ────────────────────────────────────────────

/**
 * Strip a private event's fields down to the safe preview shape.
 *
 * Used when `linkedEntity.type = 'event'` and the event's privacy column
 * indicates it is private and the viewer is not a member/RSVP holder.
 *
 * Safe fields: id, type, title, isPrivate, coverImageUrl (gated by
 * show_header_publicly), ownerDisplayName, ownerUsername.
 * Stripped: exact address, coordinates, dates, venue, attendees, invite codes.
 */
export function stripPrivateEventFields(
  entity: any,
  opts: {
    viewerIsHost: boolean;
    showHeaderPublicly?: boolean;
  },
): MediaFeedLinkedEntity {
  const showHeader = opts.viewerIsHost || (opts.showHeaderPublicly !== false);
  return {
    type: "event",
    id: entity.id as string,
    title: entity.title as string,
    isPrivate: true,
    coverImageUrl: showHeader ? ((entity.cover_url ?? entity.coverUrl ?? null) as string | null) : null,
    ownerDisplayName: (entity.host_display_name ?? entity.hostDisplayName ?? null) as string | null,
    ownerUsername: (entity.host_username ?? entity.hostUsername ?? null) as string | null,
  };
}

/**
 * Strip a private trip's fields down to the safe preview shape.
 *
 * Safe fields: id, type, title, isPrivate, coverImageUrl (gated by
 * show_header_publicly), ownerDisplayName, ownerUsername.
 * Stripped: hotel, meeting point, itinerary, exact dates, members, invite codes.
 */
export function stripPrivateTripFields(
  entity: any,
  opts: {
    viewerIsOwner: boolean;
    showHeaderPublicly?: boolean;
  },
): MediaFeedLinkedEntity {
  const showHeader = opts.viewerIsOwner || (opts.showHeaderPublicly !== false);
  return {
    type: "trip",
    id: entity.id as string,
    title: entity.title as string,
    isPrivate: true,
    coverImageUrl: showHeader ? ((entity.cover_url ?? entity.coverUrl ?? null) as string | null) : null,
    ownerDisplayName: (entity.owner_display_name ?? entity.ownerDisplayName ?? null) as string | null,
    ownerUsername: (entity.owner_username ?? entity.ownerUsername ?? null) as string | null,
  };
}

// ── Relay URL helper ──────────────────────────────────────────────────────────

/**
 * Build a relay URL for private media access.
 * The relay enforces auth + issues a short-lived signed URL.
 *
 * Format: `${apiBase}/api/media/file/<bucket>/<path>`
 */
function relayUrlFor(
  bucket: string,
  storagePath: string,
  apiBaseUrl: string = "",
): string {
  return `${apiBaseUrl}/api/media/file/${bucket}/${storagePath}`;
}

// ── Gems hydration ────────────────────────────────────────────────────────────

/** Source types that indicate AI-generated or illustrative provenance. */
const ILLUSTRATIVE_SOURCE_TYPES = new Set(["ai_generated_generic", "illustrative"]);

export interface HydrateGemInput {
  /** Raw hidden_gems row from the DB. */
  gem: any;
  /** The viewing user's id. */
  viewerUserId: string;
  /** Set of author ids that have opted in to showing their real name. */
  allowedRealNameIds: Set<string>;
  /** Set of gem ids the viewer has saved. */
  savedGemIds: Set<string>;
  /** Set of creator ids the viewer follows. */
  followedCreatorIds: Set<string>;
  /** Submitter's profile row (pre-fetched). */
  submitterProfile: any;
}

/**
 * Map a raw hidden_gems DB row into a MediaFeedItem for the Gems feed.
 * The gem itself becomes the location context; image_url becomes the single media item.
 */
export function hydrateGemFeedItem(input: HydrateGemInput): MediaFeedItem {
  const { gem, viewerUserId, allowedRealNameIds, savedGemIds, followedCreatorIds, submitterProfile } = input;

  const creatorId: string = gem.submitted_by ?? "";
  const isOwnItem = creatorId === viewerUserId;
  const isFollowing = followedCreatorIds.has(creatorId);
  const creatorIsPrivate = Boolean(submitterProfile?.is_private);

  const displayName =
    (isOwnItem || allowedRealNameIds.has(creatorId))
      ? (submitterProfile?.full_name ?? submitterProfile?.username ?? "")
      : (submitterProfile?.username ?? "");

  const relationshipStatus: RelationshipStatus = isOwnItem
    ? "self"
    : isFollowing
      ? "following"
      : "none";

  const creator: MediaFeedCreator = {
    id: creatorId,
    username: submitterProfile?.username ?? "",
    displayName,
    avatarUrl: submitterProfile?.avatar_url ?? null,
    isPrivate: creatorIsPrivate,
    relationshipStatus,
    isVerified: Boolean(submitterProfile?.is_verified),
    followersCount: (!creatorIsPrivate || isFollowing || isOwnItem)
      ? (submitterProfile?.followers_count ?? null)
      : null,
    followingCount: (!creatorIsPrivate || isFollowing || isOwnItem)
      ? (submitterProfile?.following_count ?? null)
      : null,
    bio: (!creatorIsPrivate || isFollowing || isOwnItem)
      ? (submitterProfile?.bio ?? null)
      : null,
  };

  // Determine provenance
  const sourceType: string = gem.source_type ?? "";
  const isIllustrative = ILLUSTRATIVE_SOURCE_TYPES.has(sourceType);
  const provenanceLabel: "illustrative" | null = isIllustrative ? "illustrative" : null;

  const mediaItems: MediaFeedMediaItem[] = gem.image_url
    ? [{
        id: `gem-img-${gem.id}`,
        type: "image" as const,
        url: gem.image_url,
        thumbnailUrl: null,
        durationSeconds: null,
        width: null,
        height: null,
        sortOrder: 0,
        provenanceLabel,
      }]
    : [];

  const stats: MediaFeedStats = {
    viewCount: gem.visit_count ?? 0,
    likeCount: 0,
    saveCount: gem.save_count ?? 0,
    commentCount: 0,
  };

  const location: MediaFeedLocation = {
    name: gem.name ?? null,
    city: gem.city ?? null,
    country: gem.country ?? null,
    canonicalPlaceId: gem.canonical_place_id ?? null,
    placeType: gem.category ?? null,
    isVerified: gem.verification_level !== "unverified" && gem.verification_level != null,
  };

  const viewerState: MediaFeedViewerState = {
    hasLiked: false,
    hasSaved: savedGemIds.has(gem.id),
    isFollowingCreator: isFollowing || isOwnItem,
    hasFollowRequestPending: false,
  };

  const privacy: MediaFeedPrivacy = { isPrivate: false };
  const moderation: MediaFeedModeration = { status: gem.moderation_status ?? gem.status ?? "active" };
  const tags: string[] = Array.isArray(gem.vibe_tags) ? gem.vibe_tags : [];
  const caption: string | null = gem.description ?? null;

  return {
    id: gem.id,
    sourceType: "gem",
    sourceId: gem.id,
    gemId: gem.id,
    caption,
    tags,
    createdAt: gem.created_at,
    creator,
    media: mediaItems,
    stats,
    location,
    viewerState,
    privacy,
    moderation,
    linkedEntity: null,
  };
}

// ── Post hydration ────────────────────────────────────────────────────────────

/**
 * Map a raw DB row to a hydrated MediaFeedItem.
 *
 * Privacy rules:
 *   - Private profile creator → strip bio, followersCount, followingCount,
 *     isVerified. Only expose: id, username, displayName, avatarUrl,
 *     isPrivate, relationshipStatus.
 *   - Private media (post.visibility !== 'public') → relay URL so the client
 *     always goes through the auth + signing relay. This ensures private
 *     media bytes are never world-readable via guessable public URLs.
 *   - Location → only name/city/country. No coordinates in any code path.
 */
export function hydrateMediaFeedItem(input: HydrateInput): MediaFeedItem {
  const { row, sourceType, viewerUserId, allowedRealNameIds, savedPostIds,
    likedPostIds, followedCreatorIds, pendingFollowRequestIds,
    postMedia, supabaseUrl, apiBaseUrl = "" } = input;

  // ── Creator ────────────────────────────────────────────────────────────────
  const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  const creatorId: string = row.author_id ?? row.owner_id ?? "";
  const isOwnPost = creatorId === viewerUserId;
  const isFollowing = followedCreatorIds.has(creatorId);
  const hasPendingFollow = pendingFollowRequestIds.has(creatorId);
  const creatorIsPrivate = Boolean(profile?.is_private);

  // Relationship status
  const relationshipStatus: RelationshipStatus = isOwnPost
    ? "self"
    : isFollowing
    ? "following"
    : hasPendingFollow
    ? "pending_follow"
    : "none";

  // Display name: real name only when opted in
  const displayName =
    (isOwnPost || allowedRealNameIds.has(creatorId))
      ? (profile?.full_name ?? profile?.username ?? "")
      : (profile?.username ?? "");

  // Private profile: strip all sensitive fields when viewer is not a follower
  const viewerCanSeePrivateDetails = !creatorIsPrivate || isFollowing || isOwnPost;

  const creator: MediaFeedCreator = {
    id: creatorId,
    username: profile?.username ?? "",
    displayName,
    avatarUrl: profile?.avatar_url ?? null,
    isPrivate: creatorIsPrivate,
    relationshipStatus,
    // Strip isVerified, counts, and bio for private profiles when viewer isn't following
    isVerified: viewerCanSeePrivateDetails ? Boolean(profile?.is_verified) : null,
    followersCount: viewerCanSeePrivateDetails ? (profile?.followers_count ?? null) : null,
    followingCount: viewerCanSeePrivateDetails ? (profile?.following_count ?? null) : null,
    bio: viewerCanSeePrivateDetails ? (profile?.bio ?? null) : null,
  };

  // ── Media items ────────────────────────────────────────────────────────────
  const isPrivatePost = row.visibility !== "public";
  const mediaItems: MediaFeedMediaItem[] = (postMedia ?? [])
    .filter((m: any) =>
      m.processing_status === "ready" &&
      m.moderation_status !== "rejected" &&
      m.moderation_status !== "flagged",
    )
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m: any) => {
      const bucket = m.storage_bucket ?? "post-media";
      const storagePath: string = m.storage_path ?? "";

      let url: string;
      if (isPrivatePost && storagePath) {
        // Private post: always use the relay path so clients go through auth + signing.
        // The relay (GET /api/media/file/:bucket/*path) enforces authorization and
        // issues a short-lived signed URL (1-hour TTL) via Supabase Storage.
        // Never return a raw storage path or unsigned URL for private content.
        url = relayUrlFor(bucket, storagePath, apiBaseUrl);
      } else {
        // Public post: prefer the stored public URL; fall back to constructing one.
        url = m.public_url ?? "";
        if (!url && storagePath && supabaseUrl) {
          url = publicUrlFor(bucket, storagePath) ?? "";
        }
      }

      let thumbnailUrl: string | null = m.thumbnail_url ?? null;
      // For private posts, relay the thumbnail too when it's a storage path
      if (isPrivatePost && m.thumbnail_path && !thumbnailUrl) {
        thumbnailUrl = relayUrlFor(bucket, m.thumbnail_path, apiBaseUrl);
      }

      return {
        id: m.id,
        type: (m.media_type === "video" ? "video" : "image") as "image" | "video",
        url,
        thumbnailUrl,
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

  // ── Location — coordinates NEVER included ─────────────────────────────────
  // Only human-readable labels are exposed. Raw latitude/longitude are never
  // projected from the DB select (see FEED_POST_COLUMNS in mediaFeed.ts) and
  // are explicitly omitted here to prevent accidental leakage.
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
    hasFollowRequestPending: hasPendingFollow,
  };

  // ── Privacy & moderation ───────────────────────────────────────────────────
  const privacy: MediaFeedPrivacy = {
    isPrivate: isPrivatePost,
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
    linkedEntity: input.linkedEntity ?? null,
  };
}
