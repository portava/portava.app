/**
 * Public Featured by Portava endpoint.
 *
 * No auth required — returns all live featured posts for consumer-facing
 * surfaces (Featured Hub screen, profile trophy deep-link).
 *
 * GET /featured
 *   Query params:
 *     creatorId  — optional UUID; filter to a specific creator's featured posts
 *
 * Response:
 *   {
 *     groups:           FeaturedGroup[]   — per-category arrays
 *     thisWeeksWinners: FeaturedPost[]    — posts featured in the last 7 days
 *     total:            number
 *     isFallback:       boolean           — true when portava_featured has no
 *                                           live rows and we synthesise from
 *                                           @Portava's own posts instead
 *   }
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";

const router = Router();

/**
 * Resolve @portava's profile row (id, username, display_name, name,
 * full_name, avatar_url, verified) by handle at request time — never
 * hardcode its UUID. Seeding
 * flows can assign @portava a different id per environment, so a fixed
 * constant would silently break the fallback wherever that id doesn't match.
 */
async function resolvePortavaProfile(sc: any): Promise<{ id: string; username: string | null; display_name: string | null; name: string | null; full_name: string | null; avatar_url: string | null; verified: boolean } | null> {
  const { data } = await sc
    .from("profiles")
    .select("id, username, display_name, name, full_name, avatar_url, verified")
    .eq("handle", "portava")
    .maybeSingle();
  return (data as any) ?? null;
}

/** Human-readable labels for each category. */
const CATEGORY_LABELS: Record<string, string> = {
  best_video:       "Best Video",
  best_hidden_gem:  "Best Hidden Gem",
  best_nightlife:   "Best Nightlife",
  best_restaurant:  "Best Restaurant",
  best_adventure:   "Best Adventure",
  best_photo:       "Best Photo",
  portava_picks:    "Portava's Picks",
};

/** Preferred display order for category groups. */
const CATEGORY_ORDER = [
  "best_video",
  "best_hidden_gem",
  "best_adventure",
  "best_restaurant",
  "best_nightlife",
  "best_photo",
];

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── GET /featured ─────────────────────────────────────────────────────────────

router.get("/featured", asyncHandler(async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return;
  }

  const creatorId = typeof req.query.creatorId === "string" ? req.query.creatorId : undefined;

  // Fetch all live featured entries with post + author data.
  // String must be a literal directly in .select() so the column-drift checker can parse it.
  let query = sc
    .from("portava_featured")
    .select("id, post_id, category, featured_at, posts!post_id(id, content, location_city, location_country, author_id, post_media(id, media_type, public_url, thumbnail_url, sort_order, processing_status, storage_path, storage_bucket), profiles!author_id(id, username, display_name, name, full_name, avatar_url, verified, is_private))")
    .eq("status", "live")
    .order("featured_at", { ascending: false })
    .limit(200);

  if (creatorId) {
    // Filter by author — use a sub-join approach via posts.author_id
    // We filter post-fetch since Supabase doesn't support nested eq on joined tables easily
  }

  const { data: rows, error } = await query;
  if (error) {
    req.log.error({ err: error }, "Featured posts query failed");
    sendError(res, "db_error", "Featured content is temporarily unavailable. Please try again later.", { exposeDetail: true });
    return;
  }

  const allRows = (rows ?? []) as any[];

  // Apply creatorId filter in-memory if requested
  const filtered = creatorId
    ? allRows.filter((r: any) => (r.posts as any)?.profiles?.id === creatorId || (r.posts as any)?.author_id === creatorId)
    : allRows;

  // Privacy guard: the Featured endpoint is public (no auth), so any post
  // from a private account must be excluded entirely — we cannot check
  // whether an anonymous viewer follows the author. is_private is now
  // included in the profiles join above.
  const visible = filtered.filter((r: any) => (r.posts as any)?.profiles?.is_private !== true);

  // ── Fallback: synthesise from @Portava's own posts when the table is empty ──
  //
  // This keeps the carousel populated when an admin revokes all featured posts
  // or a deployment bug clears portava_featured, rather than showing a blank UI.
  // The mobile client receives isFallback:true so it can display a subtle notice.
  if (visible.length === 0 && !creatorId) {
    return buildFallbackResponse(sc, res, req);
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Universal display-name rule: this endpoint is public (anonymous viewer),
  // so an author's real name only appears when they opted in via
  // profile_privacy_settings.show_real_name. One batched lookup, fail-closed.
  const allowed = await nameVisibilitySet(
    sc,
    visible.map((r: any) => ((r.posts as any)?.profiles?.id ?? (r.posts as any)?.author_id) as string | null),
  );

  // Map rows to FeaturedPost objects
  function mapRow(r: any): any {
    const post = r.posts ?? {};
    const profile = post.profiles ?? {};
    const postMedia: any[] = Array.isArray(post.post_media) ? post.post_media : [];
    const sortedMedia = postMedia
      .filter((m: any) => m.processing_status === "ready" || !m.processing_status)
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const primaryMedia = sortedMedia[0];

    // Resolve thumbnail URL from columns that exist in the live post_media schema.
    const thumbnailUrl: string | null = primaryMedia?.thumbnail_url ?? primaryMedia?.public_url ?? null;
    const mediaType: "image" | "video" = (primaryMedia?.media_type as any) ?? "image";

    const username = profile.username ?? null;
    const authorId = (profile.id ?? post.author_id ?? null) as string | null;
    const displayName = presentedName(profile, authorId != null && allowed.has(authorId)) ?? profile.username ?? null;

    return {
      id: r.id as string,
      postId: r.post_id as string,
      category: r.category as string,
      categoryLabel: categoryLabel(r.category as string),
      featuredAt: r.featured_at as string,
      caption: post.content ?? null,
      thumbnailUrl,
      mediaType,
      author: {
        id: (profile.id ?? post.author_id ?? "") as string,
        username: username ?? "",
        displayName: displayName ?? username ?? "",
        avatarUrl: (profile.avatar_url ?? null) as string | null,
        verified: Boolean(profile.verified),
      },
      locationCity: (post.location_city ?? null) as string | null,
      locationCountry: (post.location_country ?? null) as string | null,
    };
  }

  const posts = visible.map(mapRow);

  // This week's winners (featured within last 7 days)
  const thisWeeksWinners = posts.filter((p: any) => p.featuredAt >= sevenDaysAgo);

  // Group by category
  const groupMap = new Map<string, any[]>();
  for (const post of posts) {
    const cat = post.category as string;
    const group = groupMap.get(cat) ?? [];
    group.push(post);
    groupMap.set(cat, group);
  }

  // Build ordered groups
  const orderedGroups: any[] = [];
  // First, add known categories in order
  for (const cat of CATEGORY_ORDER) {
    const group = groupMap.get(cat);
    if (group && group.length > 0) {
      orderedGroups.push({ category: cat, categoryLabel: categoryLabel(cat), posts: group });
      groupMap.delete(cat);
    }
  }
  // Then add any remaining categories not in the known order
  for (const [cat, groupPosts] of groupMap) {
    orderedGroups.push({ category: cat, categoryLabel: categoryLabel(cat), posts: groupPosts });
  }

  res.json({
    groups: orderedGroups,
    thisWeeksWinners,
    total: posts.length,
    isFallback: false,
  });
}));

// ── Fallback builder ──────────────────────────────────────────────────────────
//
// Called when portava_featured has no live rows.  Fetches @Portava's own top
// posts (by like_count) and returns them as a single "portava_picks" group so
// the Discovery carousel always has something to display.

async function buildFallbackResponse(sc: any, res: any, req: any): Promise<void> {
  const portavaProfile = await resolvePortavaProfile(sc);

  if (!portavaProfile) {
    // @portava's profile can't be resolved (not seeded yet) — return a clean
    // empty state rather than erroring.
    res.json({ groups: [], thisWeeksWinners: [], total: 0, isFallback: true });
    return;
  }

  const { data: portavaPosts, error } = await sc
    .from("posts")
    .select("id, content, location_city, location_country, author_id, like_count, post_media(id, media_type, public_url, thumbnail_url, sort_order, processing_status, storage_path, storage_bucket), profiles!author_id(id, username, display_name, name, full_name, avatar_url, verified, is_private)")
    .eq("author_id", portavaProfile.id)
    .eq("status", "active")
    .eq("post_status", "published")
    .order("like_count", { ascending: false })
    .limit(18);

  if (error) {
    req.log.error({ err: error }, "Featured fallback query failed");
    sendError(res, "db_error", "Featured content is temporarily unavailable. Please try again later.", { exposeDetail: true });
    return;
  }

  const rawPosts = (portavaPosts ?? []) as any[];

  if (rawPosts.length === 0) {
    // @Portava itself has no published posts — return a clean empty state.
    res.json({ groups: [], thisWeeksWinners: [], total: 0, isFallback: true });
    return;
  }

  const now = new Date().toISOString();

  // Universal display-name rule (same as the main route): real names are
  // opt-in even for @Portava's own account. Fail-closed batched lookup.
  const allowed = await nameVisibilitySet(sc, [
    portavaProfile.id,
    ...rawPosts.map((p: any) => ((p.profiles as any)?.id ?? p.author_id) as string | null),
  ]);

  // Synthesise FeaturedPost objects — use a synthetic ID so the shape matches
  // the normal response without colliding with real portava_featured PKs.
  const fallbackPosts = rawPosts.map((post: any, idx: number) => {
    const profile = post.profiles ?? {};
    const postMedia: any[] = Array.isArray(post.post_media) ? post.post_media : [];
    const sortedMedia = postMedia
      .filter((m: any) => m.processing_status === "ready" || !m.processing_status)
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const primaryMedia = sortedMedia[0];

    const thumbnailUrl: string | null = primaryMedia?.thumbnail_url ?? primaryMedia?.public_url ?? null;
    const mediaType: "image" | "video" = (primaryMedia?.media_type as any) ?? "image";
    const username = profile.username ?? null;
    const authorId = (profile.id ?? post.author_id ?? null) as string | null;
    const displayName = presentedName(profile, authorId != null && allowed.has(authorId)) ?? profile.username ?? null;

    return {
      // Use a deterministic synthetic ID so clients can key on it.
      id:            `fallback-${post.id}`,
      postId:        post.id as string,
      category:      "portava_picks",
      categoryLabel: categoryLabel("portava_picks"),
      featuredAt:    now,
      caption:       post.content ?? null,
      thumbnailUrl,
      mediaType,
      author: {
        id:          (profile.id ?? post.author_id ?? portavaProfile.id) as string,
        username:    (username ?? portavaProfile.username ?? "portava") as string,
        displayName: (displayName
          ?? presentedName(portavaProfile, allowed.has(portavaProfile.id))
          ?? portavaProfile.username
          ?? "Portava") as string,
        avatarUrl:   (profile.avatar_url ?? portavaProfile.avatar_url ?? null) as string | null,
        verified:    Boolean(profile.verified ?? portavaProfile.verified),
      },
      locationCity:    (post.location_city ?? null) as string | null,
      locationCountry: (post.location_country ?? null) as string | null,
    };
  });

  const groups = [
    {
      category:      "portava_picks",
      categoryLabel: categoryLabel("portava_picks"),
      posts:         fallbackPosts,
    },
  ];

  res.json({
    groups,
    thisWeeksWinners: [],
    total: fallbackPosts.length,
    isFallback: true,
  });
}

export default router;
