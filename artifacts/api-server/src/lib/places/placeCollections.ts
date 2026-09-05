/**
 * placeCollections — best-of collections for the Living Destination Page.
 *
 * getBestOf(placeId) reads from the precomputed `place_best_of` table first.
 * If missing or stale (> 6 h), falls back to a real-time ranking query over
 * posts + post_media, scoring by:
 *   (like_count * 0.4 + save_count * 0.3 + share_count * 0.2)
 *
 * Always returns the BestOf envelope regardless of source; callers never see
 * which path was taken.
 *
 * enqueueLivingCacheInvalidation(placeId) upserts into
 * place_cache_invalidation_queue so the precompute worker (Task 6) knows to
 * rebuild place_best_of for this place.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "../supabase.js";
import { isPostPublished, canReadPost, type ReadablePost } from "../postVisibility.js";

// ── Who may appear on a place's PUBLIC rails ─────────────────────────────────

/**
 * A place's public rails — Best-Of and the Top-Contributor credit — are
 * assembled for a PLACE, cached (`place_best_of`, `place_top_contributors`,
 * and the `place_living_cache` payload built from them) and served to every
 * viewer of that place. routes/placeLiving passes no viewer at all, so there is
 * no viewer whose trip membership or follow graph could unlock a restricted
 * post here: the only posts that belong on a public rail are the ones a
 * STRANGER may read.
 *
 * This sentinel is that stranger. It is deliberately not a uuid, so it can never
 * collide with a real `author_id` and accidentally admit a post through
 * decidePostReadable's author branch.
 */
const PLACE_RAIL_STRANGER = "place-rail:no-viewer";

/**
 * May this post feed a place's PUBLIC rails?
 *
 * ONE rule, the canonical one, not a second implementation:
 *   • lib/postVisibility.isPostPublished — the delayed-publish gate (§23/§37).
 *     `status = 'active'` is what POST /posts writes for a delayed post, so it
 *     was never a publication filter.
 *   • lib/postVisibility.canReadPost with the no-viewer stranger — the same
 *     predicate WallProjectionService.passesVisibility and GET /posts/:postId
 *     apply. It admits `public` (and legacy rows with no visibility column) and
 *     refuses `private`, `trip_only`, `followers_only` and any tier it does not
 *     recognise. FAIL CLOSED is its documented default, which is exactly what a
 *     rail with no viewer needs — a visibility tier added tomorrow is invisible
 *     to strangers until someone teaches decidePostReadable about it.
 */
export function isPublicPlaceRailPost(row: ReadablePost & { post_status?: string | null }): boolean {
  return isPostPublished(row) && canReadPost(row, PLACE_RAIL_STRANGER, false, false);
}

// ── Engagement score formula ──────────────────────────────────────────────────

/**
 * Composite engagement score for a post row.
 *
 * Weights:
 *   like_count           × 0.35
 *   save_count           × 0.30
 *   share_count          × 0.20
 *   view_count           × 0.10
 *   qualified_view_count × 0.05
 *
 * Used by the precompute worker (placeCollectionsWorker) for best-of ranking.
 * Pure — exported for tests.
 */
export function placePostScore(post: {
  like_count?: number | null;
  save_count?: number | null;
  share_count?: number | null;
  view_count?: number | null;
  qualified_view_count?: number | null;
}): number {
  return (
    (post.like_count           ?? 0) * 0.35 +
    (post.save_count           ?? 0) * 0.30 +
    (post.share_count          ?? 0) * 0.20 +
    (post.view_count           ?? 0) * 0.10 +
    (post.qualified_view_count ?? 0) * 0.05
  );
}

export interface BestOfItem {
  postId: string;
  mediaUrl: string | null;
  thumbnailUrl?: string | null;
  caption?: string | null;
  score?: number;
}

export interface BestOf {
  videos: BestOfItem[];
  photos: BestOfItem[];
  viewpoints: BestOfItem[];
  foodNearby: BestOfItem[];
  experiences: BestOfItem[];
  fromCache: boolean;
}

const BEST_OF_STALE_MS = 6 * 60 * 60 * 1_000; // 6 hours

function engagementScore(row: any): number {
  return (
    (row.like_count  ?? 0) * 0.4 +
    (row.save_count  ?? 0) * 0.3 +
    (row.share_count ?? 0) * 0.2
  );
}

/** Map raw post rows with optional media_type filter to BestOfItem[]. */
function rowsToBestOf(rows: any[], mediaType: string | null, limit: number): BestOfItem[] {
  const filtered = mediaType
    ? rows.filter((r) => (r.media_type ?? "").toLowerCase().includes(mediaType))
    : rows;
  return filtered
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .slice(0, limit)
    .map((r) => ({
      postId:       r.id as string,
      mediaUrl:     (r.media_url ?? r.thumbnail_url ?? null) as string | null,
      thumbnailUrl: (r.thumbnail_url ?? null) as string | null,
      caption:      (r.content ?? null) as string | null,
      score:        engagementScore(r),
    }));
}

/** Real-time best-of fallback query.
 *
 *  Delayed-publish gate (§23/§37): this read is keyed on canonical_place_id and
 *  its output is rendered on that place's page, so serving a post whose
 *  post_status is still pending announces "this person is at this place" —
 *  exactly what delayed geotagging exists to prevent. `status = 'active'` is
 *  what POST /posts writes for a delayed post, so it was not a publication
 *  filter. Same canonical predicate as every other serving surface, applied at
 *  the query and again in memory (lib/postVisibility.isPostPublished). */
async function fetchBestOfRealtime(sc: SupabaseClient, placeId: string): Promise<BestOf> {
  const { data, error } = await sc
    .from("posts")
    .select("id, content, media_type, media_urls, media_thumbnail_url, like_count, save_count, share_count, post_status")
    .eq("canonical_place_id", placeId)
    .eq("status", "active")
    .eq("post_status", "published")
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = error ? [] : ((data as any[]) ?? []).filter((r) => isPostPublished(r));

  // Extract the first media URL from media_urls array
  const enriched = rows.map((r) => ({
    ...r,
    media_url:     Array.isArray(r.media_urls) ? (r.media_urls[0] ?? null) : null,
    thumbnail_url: r.media_thumbnail_url ?? null,
  }));

  return {
    videos:      rowsToBestOf(enriched, "video",   25),
    photos:      rowsToBestOf(enriched, "photo",   25),
    viewpoints:  rowsToBestOf(enriched, "viewpoint", 5),
    foodNearby:  rowsToBestOf(enriched, "food",    10),
    experiences: rowsToBestOf(enriched, null,       10).filter(
      (item) => !["video", "photo", "viewpoint", "food"].some(
        (t) => (enriched.find((r) => r.id === item.postId)?.media_type ?? "").toLowerCase().includes(t),
      ),
    ),
    fromCache: false,
  };
}

/**
 * Returns the best-of collections for a place.
 * Reads from place_best_of (cached) first; falls back to real-time query.
 */
export async function getBestOf(placeId: string, sc?: SupabaseClient): Promise<BestOf> {
  const client = sc ?? getServiceClient();
  if (!client) {
    return { videos: [], photos: [], viewpoints: [], foodNearby: [], experiences: [], fromCache: false };
  }

  // 1. Try precomputed table
  const { data: cached } = await client
    .from("place_best_of")
    .select("top_videos, top_photos, top_viewpoints, food_nearby, top_experiences, updated_at")
    .eq("place_id", placeId)
    .maybeSingle();

  if (cached) {
    const ageMs = Date.now() - new Date((cached as any).updated_at).getTime();
    if (ageMs < BEST_OF_STALE_MS) {
      return {
        videos:      ((cached as any).top_videos       as BestOfItem[]) ?? [],
        photos:      ((cached as any).top_photos       as BestOfItem[]) ?? [],
        viewpoints:  ((cached as any).top_viewpoints   as BestOfItem[]) ?? [],
        foodNearby:  ((cached as any).food_nearby      as BestOfItem[]) ?? [],
        experiences: ((cached as any).top_experiences  as BestOfItem[]) ?? [],
        fromCache: true,
      };
    }
  }

  // 2. Fallback: real-time query
  return fetchBestOfRealtime(client, placeId);
}

/**
 * Upsert a place_cache_invalidation_queue row so the precompute worker
 * (Task 6) knows to rebuild place_best_of for this place.
 * Best-effort — never throws.
 */
export async function enqueueLivingCacheInvalidation(
  placeId: string,
  sc?: SupabaseClient,
): Promise<void> {
  const client = sc ?? getServiceClient();
  if (!client) return;
  try {
    await client
      .from("place_cache_invalidation_queue")
      .upsert(
        { place_id: placeId, queued_at: new Date().toISOString(), status: "pending" },
        { onConflict: "place_id" },
      );
  } catch {
    // best-effort
  }
}
