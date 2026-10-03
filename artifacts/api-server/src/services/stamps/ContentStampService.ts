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
 * A "Stamps Earned" component: a MEASURED count, or an explicit statement that
 * there is none. `count` is null exactly when `unavailable` is true, so a caller
 * cannot add a placeholder into a total without first deciding what to do with
 * the failure.
 */
export type ReceivedCount =
  | { count: number; unavailable: false }
  | { count: null; unavailable: true; reason: string };

/** Ids per `content_stamps … in (entity_id)` count — keeps the request URL small. */
const RECEIVED_ID_CHUNK = 150;
/** Posts per keyset page. The walk ends on an EMPTY page, never a short one. */
const RECEIVED_POST_PAGE = 1000;

/**
 * Count content stamps *received* by a user — i.e. stamps placed by anyone on
 * posts authored by that user. Used to compute the "Stamps Earned" stat on the
 * public passport, `/me/passport/stats` and `/me/profile`, alongside the
 * caller's own non-revoked `user_stamps`.
 *
 * Primary path: the `count_content_stamps_received` RPC — one server-side join.
 * It is in the FROZEN root folder (`supabase/migrations/20260811_…`) and not in
 * the canonical chain, and the hosted testing database does not have it
 * (read-only pg_proc SELECT, 2026-10-03), so the fallback is the live path there.
 *
 * Fallback: a keyset walk over the author's posts (ordered by id, `gt` the last
 * id seen) that ends only on an EMPTY page — a server `max-rows` lower than the
 * page size cannot end it early — with each page's ids counted in chunks.
 *
 * Every read's `error` is bound. ANY failed read makes the whole result
 * `unavailable`: a total over the pages that happened to load is not a count.
 * This used to walk by unordered OFFSET, break on a failed page, skip a failed
 * chunk, stop at the first short page, and answer 0 for a throw — and the
 * public passport used a second copy that read `posts` unbounded (PostgREST
 * cuts it at 1,000) and mapped every error to 0.
 */
export async function measureContentStampsReceived(
  db: SupabaseClient,
  userId: string,
): Promise<ReceivedCount> {
  const { data, error: rpcErr } = await db.rpc("count_content_stamps_received", { p_user_id: userId });
  if (!rpcErr) {
    const n = typeof data === "number" ? data : typeof data === "string" ? Number(data) : NaN;
    if (Number.isFinite(n)) return { count: n, unavailable: false };
    logger.warn({ userId, data }, "measureContentStampsReceived: RPC returned a non-number — using paged fallback");
  } else if ((rpcErr as any).code !== "PGRST202") {
    logger.warn({ err: rpcErr, userId }, "measureContentStampsReceived: RPC failed — using paged fallback");
  }

  const unavailable = (reason: string, err: unknown): ReceivedCount => {
    logger.warn({ err, userId, reason }, "content stamps received UNREADABLE — Stamps Earned is unavailable, not a count");
    return { count: null, unavailable: true, reason };
  };

  let total = 0;
  let after: string | null = null;
  for (;;) {
    let q = db.from("posts").select("id").eq("author_id", userId).order("id", { ascending: true });
    if (after !== null) q = q.gt("id", after);
    const { data: page, error: pageErr } = await q.limit(RECEIVED_POST_PAGE);
    if (pageErr) return unavailable("posts_read_failed", pageErr);
    if (!Array.isArray(page)) return unavailable("posts_read_no_rows", null);
    if (page.length === 0) break;

    const ids = (page as any[]).map((p) => String(p.id));
    for (let i = 0; i < ids.length; i += RECEIVED_ID_CHUNK) {
      const { count, error: countErr } = await db
        .from("content_stamps")
        .select("id", { count: "exact", head: true })
        .in("entity_type", ["post", "media"])
        .in("entity_id", ids.slice(i, i + RECEIVED_ID_CHUNK));
      if (countErr) return unavailable("content_stamps_count_failed", countErr);
      if (typeof count !== "number") return unavailable("content_stamps_count_missing", null);
      total += count;
    }
    // The page's greatest id (its last row while `order(id)` is honoured). A
    // walk that does not advance would count the same posts forever.
    const top = ids.reduce((m, id) => (id > m ? id : m), "");
    if (after !== null && top <= after) return unavailable("posts_keyset_stalled", null);
    after = top;
  }
  return { count: total, unavailable: false };
}

/**
 * "Stamps Earned" as every surface shows it: the person's non-revoked
 * `user_stamps` plus the content stamps they have received. Either half
 * unreadable makes the TOTAL unavailable — a sum that silently dropped a failed
 * half is the partial count this exists to stop. No service client is also
 * unavailable, not 0. A throw (rather than a resolved error) is caught here and
 * reported the same way, so a route can answer the rest of its payload.
 */
export async function measureStampsEarned(
  sc: SupabaseClient | null | undefined,
  userId: string,
): Promise<ReceivedCount> {
  if (!sc) return { count: null, unavailable: true, reason: "no_service_client" };
  try {
    const [owned, received] = await Promise.all([
      sc
        .from("user_stamps")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_revoked", false),
      measureContentStampsReceived(sc, userId),
    ]);
    if ((owned as any).error || typeof (owned as any).count !== "number") {
      logger.warn({ err: (owned as any).error, userId }, "user_stamps count UNREADABLE — Stamps Earned is unavailable, not a count");
      return { count: null, unavailable: true, reason: "user_stamps_count_failed" };
    }
    if (received.unavailable) return received;
    return { count: (owned as any).count + received.count, unavailable: false };
  } catch (err) {
    logger.warn({ err, userId }, "Stamps Earned read THREW — unavailable, not a count");
    return { count: null, unavailable: true, reason: "threw" };
  }
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
