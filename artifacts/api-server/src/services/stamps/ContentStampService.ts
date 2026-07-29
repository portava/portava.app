/**
 * ContentStampService — unified stamp interactions for all stampable entity types.
 *
 * Stamps are Portava's primary positive signal: "worth experiencing,
 * remembering, recommending." This service replaces the fragmented post_likes /
 * media_likes model with a single polymorphic table (content_stamps).
 *
 * Functions are intentionally stateless — callers supply the db client so
 * the service works in both user-RLS and service-role contexts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const STAMPABLE_TYPES = [
  "post",
  "media",
  "gem",
  "event",
  "trip",
  "guide",
  "profile",
  "buddy_profile",
  "hotel",
  "restaurant",
  "destination",
  "memory",
  "place",
] as const;

export type StampableEntityType = (typeof STAMPABLE_TYPES)[number];

export interface StampResult {
  stampCount: number;
  isStamped: boolean;
}

/**
 * Record a stamp for the given entity. Idempotent — duplicate stamps on the
 * same (user, type, entity) triple are silently collapsed.
 */
export async function stampEntity(
  db: SupabaseClient,
  userId: string,
  entityType: StampableEntityType,
  entityId: string,
): Promise<StampResult> {
  const { error } = await db
    .from("content_stamps")
    .upsert(
      { user_id: userId, entity_type: entityType, entity_id: entityId },
      { onConflict: "user_id,entity_type,entity_id", ignoreDuplicates: true },
    );
  if (error) throw error;

  const { count } = await db
    .from("content_stamps")
    .select("id", { count: "exact", head: true })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);

  return { stampCount: count ?? 0, isStamped: true };
}

/**
 * Remove a stamp. Idempotent — removing a stamp that doesn't exist is a
 * silent no-op.
 */
export async function unstampEntity(
  db: SupabaseClient,
  userId: string,
  entityType: StampableEntityType,
  entityId: string,
): Promise<StampResult> {
  const { error } = await db
    .from("content_stamps")
    .delete()
    .eq("user_id", userId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) throw error;

  const { count } = await db
    .from("content_stamps")
    .select("id", { count: "exact", head: true })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);

  return { stampCount: count ?? 0, isStamped: false };
}

/**
 * Count content_stamps received on a user's own posts/media (i.e. stamps
 * *given by other people* on this user's content) — this is the "Stamps
 * Earned" signal for the Passport/profile STAMPS stat, separate from
 * passport_stamps/user_stamps (milestone awards like "first trip", "Bohol").
 *
 * Bug fix (2026-07-28): profile/passport "Stamps Earned" previously only
 * counted passport_stamps milestone rows, so stamping someone's Watch post
 * never moved their STAMPS counter. This closes that gap.
 */
export async function countStampsReceived(
  db: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data: myPosts, error: postsErr } = await db
    .from("posts")
    .select("id")
    .eq("author_id", userId);
  if (postsErr || !myPosts || myPosts.length === 0) return 0;

  const postIds = myPosts.map((p: any) => p.id);
  const { count, error } = await db
    .from("content_stamps")
    .select("id", { count: "exact", head: true })
    .in("entity_type", ["post", "media"])
    .in("entity_id", postIds);
  if (error) return 0;
  return count ?? 0;
}

/**
 * Fetch current stamp count + viewer state for a single entity.
 */
export async function getStampState(
  db: SupabaseClient,
  userId: string,
  entityType: StampableEntityType,
  entityId: string,
): Promise<StampResult> {
  const [{ count }, { data: mine }] = await Promise.all([
    db
      .from("content_stamps")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", entityType)
      .eq("entity_id", entityId),
    db
      .from("content_stamps")
      .select("id")
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .maybeSingle(),
  ]);
  return { stampCount: count ?? 0, isStamped: !!mine };
}

/**
 * Count content stamps *received* by a user — i.e. stamps placed by anyone on
 * posts authored by that user. Used to compute the "Stamps Earned" profile stat
 * that reflects appreciation from peers, not just passport milestone awards.
 *
 * Counts ALL posts via a paged traversal (1 000 IDs per page) so the result is
 * always an exact lifetime total, not a capped lower bound. The loop terminates
 * as soon as a page returns fewer IDs than PAGE_SIZE.
 *
 * Fails open: returns 0 on any DB error so callers never surface a 500 because
 * the content-stamp count couldn't be fetched.
 */
export async function countContentStampsReceived(
  db: SupabaseClient,
  userId: string,
): Promise<number> {
  const PAGE_SIZE = 1000;
  let totalCount = 0;
  let offset = 0;

  try {
    while (true) {
      const { data: posts, error: postsErr } = await db
        .from("posts")
        .select("id")
        .eq("author_id", userId)
        .range(offset, offset + PAGE_SIZE - 1);

      if (postsErr || !posts || posts.length === 0) break;

      const postIds = (posts as any[]).map((p) => p.id as string);

      const { count, error: countErr } = await db
        .from("content_stamps")
        .select("id", { count: "exact", head: true })
        .eq("entity_type", "post")
        .in("entity_id", postIds);

      if (!countErr) {
        totalCount += count ?? 0;
      }

      if (posts.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  } catch {
    // Fail open — callers treat 0 as "unknown" rather than surfacing a 500.
    return 0;
  }

  return totalCount;
}

/**
 * Batch-fetch stamp counts and viewer stamp state for a list of entity IDs
 * of the same entity_type. Returns a map of entityId → StampResult.
 *
 * Used by feed serializers to enrich multiple posts/items in one pair of
 * queries rather than N+1 individual lookups.
 */
export async function batchGetStampState(
  db: SupabaseClient,
  userId: string,
  entityType: StampableEntityType,
  entityIds: string[],
): Promise<Record<string, StampResult>> {
  if (entityIds.length === 0) return {};

  const [{ data: allStamps }, { data: myStamps }] = await Promise.all([
    db
      .from("content_stamps")
      .select("entity_id")
      .eq("entity_type", entityType)
      .in("entity_id", entityIds),
    db
      .from("content_stamps")
      .select("entity_id")
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .in("entity_id", entityIds),
  ]);

  const mySet = new Set<string>((myStamps ?? []).map((r: any) => r.entity_id as string));
  const countMap: Record<string, number> = {};
  for (const r of (allStamps ?? []) as any[]) {
    countMap[r.entity_id] = (countMap[r.entity_id] ?? 0) + 1;
  }

  const result: Record<string, StampResult> = {};
  for (const id of entityIds) {
    result[id] = { stampCount: countMap[id] ?? 0, isStamped: mySet.has(id) };
  }
  return result;
}
