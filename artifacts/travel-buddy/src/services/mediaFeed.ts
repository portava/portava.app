/**
 * mediaFeed service — authenticated client for the Watch-mode feed API.
 *
 * All requests use EXPO_PUBLIC_API_BASE_URL + a fresh Supabase bearer token,
 * matching the pattern used by follows.ts and other service modules.
 *
 * Adapts the server's canonical MediaFeedItem shape to the UI MediaFeedItem
 * type (videoUrl / posterUrl / likeCount / likedByMe / etc.).
 */

import { freshToken } from './apiToken.ts';
import type {
  MediaFeedItem,
  WatchFeedPage,
  WatchFeedType,
  MediaFeedPlace,
  MediaFeedLinkedEntity,
  MediaGridItem,
  GridFeedPage,
  GridFilter,
} from '../types/media.ts';

// ── API base URL ──────────────────────────────────────────────────────────────

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

// ── Server-side types (subset we care about) ──────────────────────────────────

interface ServerMediaItem {
  id: string;
  type: 'image' | 'video';
  url: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sortOrder: number;
}

interface ServerCreator {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  followersCount: number | null;
  followingCount: number | null;
  bio: string | null;
}

interface ServerStats {
  viewCount: number;
  likeCount: number;
  saveCount: number;
  commentCount: number;
}

interface ServerLocation {
  name: string | null;
  city: string | null;
  country: string | null;
}

interface ServerViewerState {
  hasLiked: boolean;
  hasSaved: boolean;
  isFollowingCreator: boolean;
  hasFollowRequestPending: boolean;
}

interface ServerLinkedEntity {
  type: 'event' | 'trip';
  id: string;
  title: string;
  isPrivate: boolean;
  coverImageUrl: string | null;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
}

interface ServerFeedItem {
  id: string;
  sourceType: 'post' | 'memory' | 'story';
  sourceId: string;
  caption: string | null;
  tags: string[];
  createdAt: string;
  creator: ServerCreator;
  media: ServerMediaItem[];
  stats: ServerStats;
  location: ServerLocation | null;
  viewerState: ServerViewerState;
  privacy: { isPrivate: boolean };
  moderation: { status: string };
  linkedEntity: ServerLinkedEntity | null;
}

interface ServerFeedPage {
  items: ServerFeedItem[];
  nextCursor: string | null;
  sessionId: string;
}

// ── Response adapter ──────────────────────────────────────────────────────────

function adaptLocation(loc: ServerLocation | null): MediaFeedPlace | null {
  if (!loc) return null;
  const name = loc.name ?? loc.city ?? loc.country;
  if (!name) return null;
  return {
    // No structured place ID from the feed API; navigation uses name-based lookup.
    name,
    city: loc.city,
    country: loc.country,
  };
}

function adaptLinkedEntity(ent: ServerLinkedEntity | null): MediaFeedLinkedEntity | null {
  if (!ent) return null;
  return {
    kind: ent.type, // 'event' | 'trip' — both valid LinkedEntityKind values
    id: ent.id,
    label: ent.title,
  };
}

/**
 * Maps a server-side MediaFeedItem to the UI MediaFeedItem shape.
 *
 * Video selection: first `video` media item by sortOrder.
 * Poster: video thumbnailUrl → first image url → null.
 */
export function mapServerFeedItem(raw: ServerFeedItem): MediaFeedItem {
  const sorted = [...raw.media].sort((a, b) => a.sortOrder - b.sortOrder);
  const firstVideo = sorted.find((m) => m.type === 'video');
  const firstImage = sorted.find((m) => m.type === 'image');

  // Items without a video URL are filtered before this point by the server,
  // but guard anyway so the UI never receives an empty string.
  const videoUrl = firstVideo?.url ?? '';
  const posterUrl = firstVideo?.thumbnailUrl ?? firstImage?.url ?? null;

  return {
    id: raw.id,
    videoUrl,
    posterUrl,
    duration: firstVideo?.durationSeconds ?? null,
    creator: {
      id: raw.creator.id,
      displayName: raw.creator.displayName,
      username: raw.creator.username,
      avatarUrl: raw.creator.avatarUrl,
      isFollowing: raw.viewerState.isFollowingCreator,
    },
    caption: raw.caption ?? '',
    hashtags: raw.tags ?? [],
    place: adaptLocation(raw.location),
    linkedEntity: adaptLinkedEntity(raw.linkedEntity),
    // Audio label: not yet in the server shape; placeholder for future field.
    audioLabel: null,
    likeCount: raw.stats.likeCount,
    commentCount: raw.stats.commentCount,
    saveCount: raw.stats.saveCount,
    likedByMe: raw.viewerState.hasLiked,
    savedByMe: raw.viewerState.hasSaved,
  };
}

// ── Network error helper ──────────────────────────────────────────────────────

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FeedServiceResult {
  ok: boolean;
  data: WatchFeedPage | null;
  errorKind?: 'network' | 'auth' | 'server' | 'unknown';
  message?: string;
}

// ── Grid feed service ─────────────────────────────────────────────────────────

export interface GridFeedServiceResult {
  ok: boolean;
  data: GridFeedPage | null;
  errorKind?: 'network' | 'auth' | 'server' | 'unknown';
  message?: string;
}

export interface FetchGridFeedParams {
  filter?: GridFilter;
  cursor?: string;
  sessionId?: string;
  limit?: number;
  /** Viewer latitude — passed when filter=nearby so the API can radius-filter. */
  lat?: number;
  /** Viewer longitude — passed when filter=nearby so the API can radius-filter. */
  lng?: number;
}

/**
 * Fetch one page of the Grid feed.
 *
 * The server returns lightweight MediaGridItem objects — no captions, full
 * profiles, event/trip objects, or raw coordinates. This service passes them
 * through as-is since no adaptation is required (they already match the
 * UI type shape).
 *
 * Returns a typed result; never throws.
 */
export async function fetchGridFeed(params: FetchGridFeedParams): Promise<GridFeedServiceResult> {
  const token = await freshToken();
  if (!token) {
    return { ok: false, data: null, errorKind: 'auth', message: 'Not authenticated' };
  }

  try {
    const qs = new URLSearchParams({
      mode: 'grid',
      filter: params.filter ?? 'all',
      sessionId: params.sessionId ?? '',
      limit: String(params.limit ?? 20),
    });
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.lat != null) qs.set('lat', String(params.lat));
    if (params.lng != null) qs.set('lng', String(params.lng));

    const res = await fetch(`${apiBase()}/api/media/feed?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, data: null, errorKind: 'auth', message: 'Unauthorized' };
    }

    if (!res.ok) {
      return {
        ok: false,
        data: null,
        errorKind: 'server',
        message: `HTTP ${res.status}`,
      };
    }

    const body: { items: MediaGridItem[]; nextCursor: string | null; sessionId: string } =
      await res.json();

    const page: GridFeedPage = {
      items: body.items,
      nextCursor: body.nextCursor,
      sessionId: body.sessionId,
    };

    return { ok: true, data: page };
  } catch (err) {
    if (isNetworkError(err)) {
      return { ok: false, data: null, errorKind: 'network', message: 'Network error' };
    }
    return {
      ok: false,
      data: null,
      errorKind: 'unknown',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export interface FetchFeedParams {
  feedType: WatchFeedType;
  cursor?: string | null;
  sessionId?: string;
  limit?: number;
}

/**
 * Fetch one page of the Watch fullscreen feed.
 * Returns a typed result; never throws.
 */
export async function fetchWatchFeed(params: FetchFeedParams): Promise<FeedServiceResult> {
  const token = await freshToken();
  if (!token) {
    return { ok: false, data: null, errorKind: 'auth', message: 'Not authenticated' };
  }

  try {
    const qs = new URLSearchParams({
      mode: 'fullscreen',
      feedType: params.feedType,          // 'for_you' | 'following' — underscore form per API contract
      sessionId: params.sessionId ?? '',
      limit: String(params.limit ?? 20),
    });
    if (params.cursor) qs.set('cursor', params.cursor);

    const res = await fetch(`${apiBase()}/api/media/feed?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, data: null, errorKind: 'auth', message: 'Unauthorized' };
    }

    if (!res.ok) {
      return {
        ok: false,
        data: null,
        errorKind: 'server',
        message: `HTTP ${res.status}`,
      };
    }

    const body: ServerFeedPage = await res.json();

    const page: WatchFeedPage = {
      items: body.items.map(mapServerFeedItem),
      nextCursor: body.nextCursor,
      sessionId: body.sessionId,
    };

    return { ok: true, data: page };
  } catch (err) {
    if (isNetworkError(err)) {
      return { ok: false, data: null, errorKind: 'network', message: 'Network error' };
    }
    return {
      ok: false,
      data: null,
      errorKind: 'unknown',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
