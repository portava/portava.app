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
import { logger } from "../../lib/logger.js";

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
  /**
   * True when `stampCount` is a PLACEHOLDER, not a measurement: the count read
   * resolved an error and there is no honest number to put here.
   *
   * supabase-js RESOLVES on a database error, and `select(…, { count: "exact",
   * head: true })` yields `count: null` when it does — so `count ?? 0` turned an
   * unreadable table into a confident `stampCount: 0`, returned alongside
   * `isStamped: true` from a stamp that had just SUCCEEDED. "0 people stamped
   * this, and you are one of them" is not a degraded answer, it is a
   * self-contradictory one, and nothing on the response said so. The field is
   * optional and additive: existing callers destructure `{ stampCount }` and are
   * unaffected.
   */
  countUnavailable?: boolean;
}

/**
 * The one count read, with its error OBSERVED. Returns the placeholder zero and
 * says that is what it is, rather than letting `count ?? 0` pass a failure off
 * as a measurement.
 */
async function countForEntity(
  db: SupabaseClient,
  entityType: StampableEntityType,
  entityId: string,
): Promise<{ count: number; unavailable: boolean }> {
  const { count, error } = await db
    .from("content_stamps")
    .select("id", { count: "exact", head: true })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (error) {
    logger.warn(
      { err: error, entityType, entityId },
      "content_stamps count unreadable — stampCount is a placeholder, not a measurement",
    );
    return { count: 0, unavailable: true };
  }
  return { count: count ?? 0, unavailable: false };
}

/** Attach `countUnavailable` only when it is true, so the healthy shape is unchanged. */
function withCount(
  c: { count: number; unavailable: boolean },
  isStamped: boolean,
): StampResult {
  return { stampCount: c.count, isStamped, ...(c.unavailable ? { countUnavailable: true } : {}) };
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

  return withCount(await countForEntity(db, entityType, entityId), true);
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

  return withCount(await countForEntity(db, entityType, entityId), false);
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
  const [c, mineRead] = await Promise.all([
    countForEntity(db, entityType, entityId),
    db
      .from("content_stamps")
      .select("id")
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .maybeSingle(),
  ]);
  // `isStamped` stays fail-closed on an unreadable own-stamp row (the user is
  // shown "not stamped" and a re-tap is an idempotent upsert), but the failure
  // is no longer silent, and the COUNT — which is the number this response
  // exists to carry — says when it is a placeholder.
  if ((mineRead as any).error) {
    logger.warn(
      { err: (mineRead as any).error, userId, entityType, entityId },
      "content_stamps own-stamp read unreadable — reporting isStamped:false",
    );
  }
  return withCount(c, !!(mineRead as any).data);
}

/**
 * Count content stamps *received* by a user — i.e. stamps placed by anyone on
 * posts authored by that user. Used to compute the "Stamps Earned" profile stat
 * that reflects appreciation from peers, not just passport milestone awards.
 *
 * Primary path: delegates to the `count_content_stamps_received` Postgres RPC
 * which does the join server-side in a single query, giving an exact lifetime
 * total regardless of how many posts the user has.
 *
 * Fallback (schema-drift safe): if the RPC does not exist yet (PGRST202), the
 * function falls back to a paged traversal (1 000 IDs per page) so the result
 * is still an exact total rather than the old 500-row cap.
 *
 * Fails open: returns 0 on any DB error so callers never surface a 500 because
 * the content-stamp count couldn't be fetched.
 */
export async function countContentStampsReceived(
  db: SupabaseClient,
  userId: string,
): Promise<number> {
  try {
    // --- Primary path: single server-side join via RPC ---
    const { data, error: rpcErr } = await db.rpc(
      "count_content_stamps_received",
      { p_user_id: userId },
    );

    // PGRST202 = function not found (migration not yet applied).
    // Any other error is also handled by falling through to the paged loop so
    // we never surface a 500 to callers.
    if (!rpcErr) {
      return typeof data === "number" ? data : Number(data ?? 0);
    }

    // If the error is NOT "function not found" we log and fall through anyway —
    // the paged loop is an exact fallback, not a degraded one. (This comment
    // used to promise a log that didn't exist; the RPC error vanished silently.)
    if (rpcErr.code !== "PGRST202") {
      logger.warn({ err: rpcErr, userId }, "countContentStampsReceived: RPC failed — using paged fallback");
    }
  } catch (err) {
    // Unexpected throw — fall through to the paged loop.
    logger.warn({ err, userId }, "countContentStampsReceived: unexpected throw — using paged fallback");
  }

  // --- Fallback path: paged traversal (schema-drift safe) ---
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
        .in("entity_type", ["post", "media"])
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

  const [allRead, myRead] = await Promise.all([
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

  // A failed batch read gave EVERY entity on the page `stampCount: 0` — one
  // hiccup rewriting a whole feed's worth of counts to zero, silently.
  const countsUnavailable = Boolean((allRead as any).error);
  if (countsUnavailable) {
    logger.warn(
      { err: (allRead as any).error, entityType, n: entityIds.length },
      "content_stamps batch count unreadable — every stampCount on this page is a placeholder",
    );
  }
  if ((myRead as any).error) {
    logger.warn(
      { err: (myRead as any).error, userId, entityType },
      "content_stamps batch own-stamp read unreadable — reporting isStamped:false",
    );
  }

  const mySet = new Set<string>((((myRead as any).data ?? []) as any[]).map((r: any) => r.entity_id as string));
  const countMap: Record<string, number> = {};
  for (const r of (((allRead as any).data ?? []) as any[])) {
    countMap[r.entity_id] = (countMap[r.entity_id] ?? 0) + 1;
  }

  const result: Record<string, StampResult> = {};
  for (const id of entityIds) {
    result[id] = {
      stampCount: countMap[id] ?? 0,
      isStamped: mySet.has(id),
      ...(countsUnavailable ? { countUnavailable: true } : {}),
    };
  }
  return result;
}
