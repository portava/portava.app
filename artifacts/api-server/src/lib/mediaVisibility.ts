/**
 * mediaVisibility — the shared CONTEXTUAL media visibility resolver.
 *
 * Two independent axes, both of which sit BEFORE a media object is signed,
 * relayed or projected:
 *
 *   1. `media_attachments.visibility_override` (§6.1) — a per-attachment
 *      audience narrower than the parent entity's own visibility. A public post
 *      may carry a `private` / `followers` / `trip_crew` attachment, and the
 *      attachment wins.
 *   2. `circle_member_visibility_overrides` — directional, per (trip | event)
 *      context:
 *        hide_from_me: user_id hides target_user_id from their own view.
 *        hide_me_from: user_id hides themselves from target_user_id's view.
 *      Either row, in either direction, denies.
 *
 * Reads are deliberately fail-closed. An error resolving an override is not
 * treated as "no override", because this helper sits before signing and
 * projection of private media.
 *
 * `media_attachments` carries `UNIQUE (media_asset_id, entity_type, entity_id)`
 * (0191_media_assets.sql:54), so the `.maybeSingle()` below cannot be answered
 * by a resolved PGRST116 "multiple rows" the way an unconstrained table's can.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAcceptedTripMember } from "./http.js";

export type MediaContext = {
  contextType: "trip" | "event";
  contextId: string;
};

export type MediaVisibilityOverride =
  | "inherit"
  | "public"
  | "private"
  | "followers"
  | "following"
  | "trip_crew"
  | "shared_moment";

type OverrideResult = { allowed: boolean; resolved: boolean };

async function hasRelationship(
  sc: SupabaseClient,
  viewerId: string,
  ownerId: string,
  visibility: MediaVisibilityOverride,
): Promise<boolean> {
  if (viewerId === ownerId) return true;
  if (visibility === "public") return true;
  if (visibility === "private" || visibility === "inherit") return false;
  // `user_follows` is (follower_id, following_id, created_at) — there is NO `id`
  // column, in production or in CI. Selecting one raised 42703, PostgREST
  // RESOLVED that as `{ data: null, error }`, and `!error && Boolean(data)`
  // then answered FALSE for every viewer: the `followers` and `following`
  // attachment audiences resolved for NOBODY, including genuine followers.
  // It failed CLOSED, so it was a correctness defect and never a leak — but it
  // made two of the seven audiences dead letters. `follower_id` is the column
  // lib/mediaAccess.ts:~232 and lib/profileVisibility.ts:156 already spell for
  // the identical existence check.
  if (visibility === "followers") {
    const { data, error } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("follower_id", viewerId)
      .eq("following_id", ownerId)
      .maybeSingle();
    return !error && Boolean(data);
  }
  if (visibility === "following") {
    const { data, error } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("follower_id", ownerId)
      .eq("following_id", viewerId)
      .maybeSingle();
    return !error && Boolean(data);
  }
  return false;
}

/**
 * Resolve a canonical attachment's visibility override. Missing attachments
 * are not an error: callers may still be serving legacy media. A present
 * attachment with an unknown override is denied.
 */
export async function authorizeMediaAttachment(
  sc: SupabaseClient,
  viewerId: string,
  ownerId: string,
  mediaAssetId: string | null | undefined,
  entity: { entityType: string; entityId: string },
  context?: MediaContext,
): Promise<boolean> {
  if (!mediaAssetId) return true;
  try {
    const { data, error } = await sc
      .from("media_attachments")
      .select("visibility_override")
      .eq("media_asset_id", mediaAssetId)
      .eq("entity_type", entity.entityType)
      .eq("entity_id", entity.entityId)
      .maybeSingle();
    if (error) return false;
    if (!data || (data as any).visibility_override == null) return true;

    const override = String((data as any).visibility_override) as MediaVisibilityOverride;
    if (override === "trip_crew" || override === "shared_moment") {
      if (!context) return false;
      if (context.contextType === "trip") {
        // The repo has exactly ONE definition of "accepted trip member"
        // (lib/http.requireTripMember, mirrored by authz.is_trip_crew in
        // migrations 2334/2337): role IN (owner, co_host, member, viewer) AND
        // no explicit non-accepted status, with a trips.owner_id fallback when
        // no membership row exists. An inline role-only filter here would have
        // admitted a member whose row still says status='pending' and denied a
        // trip owner who has no trip_members row at all, so this branch calls
        // the canonical helper instead of restating half of it. A read failure
        // raises, and the enclosing catch denies — fail-closed as everywhere
        // else in this module.
        return isAcceptedTripMember(sc, context.contextId, viewerId);
      }
      const [{ data: rsvp, error: rsvpError }, { data: role, error: roleError }] =
        await Promise.all([
          sc.from("event_rsvps").select("status")
            .eq("event_id", context.contextId).eq("user_id", viewerId)
            .in("status", ["going", "maybe"]).maybeSingle(),
          sc.from("event_roles").select("role")
            .eq("event_id", context.contextId).eq("user_id", viewerId)
            .in("role", ["host", "co_host", "moderator"]).maybeSingle(),
        ]);
      return !rsvpError && !roleError && Boolean(rsvp || role);
    }
    if (!["inherit", "public", "private", "followers", "following"].includes(override)) {
      return false;
    }
    return hasRelationship(sc, viewerId, ownerId, override);
  } catch {
    return false;
  }
}

/**
 * Apply both directional circle overrides for a contextual media object.
 * The first query covers "viewer hides owner"; the second covers "owner hides
 * themselves from viewer". Any active row denies, and either query error
 * denies, preserving block-like fail-closed semantics.
 */
export async function resolveCircleVisibilityOverride(
  sc: SupabaseClient,
  viewerId: string,
  targetUserId: string,
  context: MediaContext,
): Promise<OverrideResult> {
  if (viewerId === targetUserId) return { allowed: true, resolved: true };
  try {
    const [viewerHidesTarget, targetHidesViewer] = await Promise.all([
      sc.from("circle_member_visibility_overrides")
        .select("id")
        .eq("user_id", viewerId)
        .eq("target_user_id", targetUserId)
        .eq("context_type", context.contextType)
        .eq("context_id", context.contextId)
        .eq("direction", "hide_from_me")
        .eq("hidden", true)
        .maybeSingle(),
      sc.from("circle_member_visibility_overrides")
        .select("id")
        .eq("user_id", targetUserId)
        .eq("target_user_id", viewerId)
        .eq("context_type", context.contextType)
        .eq("context_id", context.contextId)
        .eq("direction", "hide_me_from")
        .eq("hidden", true)
        .maybeSingle(),
    ]);
    if (viewerHidesTarget.error || targetHidesViewer.error) {
      return { allowed: false, resolved: false };
    }
    return {
      allowed: !viewerHidesTarget.data && !targetHidesViewer.data,
      resolved: true,
    };
  } catch {
    return { allowed: false, resolved: false };
  }
}

export async function authorizeMediaContext(
  sc: SupabaseClient,
  viewerId: string,
  ownerId: string,
  context: MediaContext | undefined,
): Promise<boolean> {
  if (!context || viewerId === ownerId) return true;
  return (await resolveCircleVisibilityOverride(sc, viewerId, ownerId, context)).allowed;
}

/** Max media objects one projection may carry before this filter refuses. */
const PROJECTION_MEDIA_CAP = 1000;

/**
 * Only a uuid is collected below. Every `MediaProjection.id` is a `posts.id`
 * (lib/media/mediaProjection.toMediaProjection) and therefore a uuid, and the
 * ownership read is `posts.id IN (…)`. A non-uuid smuggled into that list would
 * not merely fail to match — PostgREST would REJECT the whole query, the filter
 * would return null, and this router would refuse an otherwise good projection.
 * So the shape is checked rather than assumed.
 */
const PROJECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove contextual media objects from an already-shaped projection. World
 * projections intentionally expose contributor ids and opaque post ids, so
 * this boundary can enforce directional circle overrides without adding
 * coordinates or trusting client-supplied ownership.
 *
 * Returns `null` — NOT a partially-filtered payload — when the ownership read
 * cannot be completed. The caller must turn that into an error response: a
 * projection this function could not decide about is not a projection that may
 * be served.
 *
 * The walk does NOT require `contributor` to be present. `projectContributor`
 * returns null for a contributor it cannot attribute, and requiring it here
 * would have quietly skipped exactly those items — ownership is taken from
 * `posts.author_id`, never from the already-shaped payload, so the contributor
 * block is not needed to decide anything.
 */
export async function filterMediaProjectionVisibility(
  sc: SupabaseClient,
  viewerId: string,
  payload: unknown,
): Promise<unknown> {
  const mediaIds = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.id === "string" &&
      typeof item.mediaType === "string" &&
      PROJECTION_ID_RE.test(item.id)
    ) {
      mediaIds.add(item.id);
    }
    for (const child of Object.values(item)) walk(child);
  };
  walk(payload);
  if (mediaIds.size === 0) return payload;
  // A payload larger than the cap cannot be decided within one bounded read.
  // Refuse rather than filter a truncated page, which would serve exactly the
  // items that did not fit.
  if (mediaIds.size > PROJECTION_MEDIA_CAP) return null;

  let rows: any[] = [];
  try {
    const { data, error } = await sc
      .from("posts")
      .select("id, author_id, trip_id")
      .in("id", [...mediaIds]);
    if (error || !Array.isArray(data)) return null;
    rows = data;
  } catch {
    return null;
  }
  // One projection repeats the same (owner, trip) pair across many items —
  // a lens is a handful of trips, not a hundred. Memoise so the override reads
  // are per DISTINCT context, not per media object.
  const contextCache = new Map<string, Promise<boolean>>();
  const allowedIn = (ownerId: string, tripId: string): Promise<boolean> => {
    const key = `${ownerId}:${tripId}`;
    let hit = contextCache.get(key);
    if (!hit) {
      hit = authorizeMediaContext(sc, viewerId, ownerId, {
        contextType: "trip",
        contextId: tripId,
      });
      contextCache.set(key, hit);
    }
    return hit;
  };
  const denied = new Set<string>();
  for (const row of rows) {
    const ownerId = typeof row.author_id === "string" ? row.author_id : null;
    const tripId = typeof row.trip_id === "string" ? row.trip_id : null;
    if (!ownerId || !tripId || ownerId === viewerId) continue;
    if (!(await allowedIn(ownerId, tripId))) denied.add(String(row.id));
  }
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => {
      if (item && typeof item === "object" && typeof (item as any).id === "string" &&
        typeof (item as any).mediaType === "string") {
        return !denied.has((item as any).id);
      }
      return true;
    }).map(prune);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, prune(v)]));
  };
  return prune(payload);
}