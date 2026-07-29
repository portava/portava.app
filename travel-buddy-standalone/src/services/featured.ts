/**
 * Featured by Portava — client service.
 *
 * Wraps GET /api/featured (public endpoint — no auth required).
 * Returns live featured posts grouped by category for the Featured Hub screen.
 */

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type FeaturedCategory =
  | 'best_video'
  | 'best_hidden_gem'
  | 'best_nightlife'
  | 'best_restaurant'
  | 'best_adventure'
  | 'best_photo';

export interface FeaturedAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  verified?: boolean;
}

export interface FeaturedPost {
  id: string;
  postId: string;
  category: FeaturedCategory | string;
  categoryLabel: string;
  featuredAt: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaType: 'image' | 'video';
  author: FeaturedAuthor;
  locationCity: string | null;
  locationCountry: string | null;
}

export interface FeaturedGroup {
  category: FeaturedCategory | string;
  categoryLabel: string;
  posts: FeaturedPost[];
}

export interface FeaturedHubResult {
  groups: FeaturedGroup[];
  thisWeeksWinners: FeaturedPost[];
  total: number;
  /** True when portava_featured has no live rows and the API returned
   *  @Portava's own top posts as a temporary stand-in. */
  isFallback?: boolean;
}

export interface FeaturedResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: string;
  message?: string;
}

/**
 * Fetch all live featured posts grouped by category.
 * Public endpoint — no auth token required.
 * Optional `creatorId` filter to get a specific creator's featured posts.
 */
export async function getFeaturedHub(creatorId?: string): Promise<FeaturedResult<FeaturedHubResult>> {
  const base = apiBase();
  if (!base) {
    return { ok: false, data: null, errorKind: 'config_error', message: 'Backend not configured' };
  }

  try {
    const url = new URL(`${base}/api/featured`);
    if (creatorId) url.searchParams.set('creatorId', creatorId);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        ok: false,
        data: null,
        errorKind: (body as any)?.error ?? 'api_error',
        message: (body as any)?.message ?? `API ${res.status}`,
      };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed')) {
      return { ok: false, data: null, errorKind: 'network_unreachable', message: 'Network unavailable' };
    }
    return { ok: false, data: null, errorKind: 'fetch_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}
