/**
 * Shared media visibility resolver.
 *
 * `circle_member_visibility_overrides` is directional:
 *   hide_from_me: user_id hides target_user_id from their own view.
 *   hide_me_from: user_id hides themselves from target_user_id's view.
 *
 * Reads are deliberately fail-closed. An error resolving an override is not
 * treated as "no override", because this helper sits before signing and
 * projection of private media.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

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
  if (visibility === "followers") {
    const { data, error } = await sc
      .from("user_follows")
      .select("id")
      .eq("follower_id", viewerId)
      .eq("following_id", ownerId)
      .maybeSingle();
    return !error && Boolean(data);
  }
  if (visibility === "following") {
    const { data, error } = await sc
      .from("user_follows")
      .select("id")
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
    let query = sc
      .from("media_attachments")
      .select("visibility_override")
      .eq("media_asset_id", mediaAssetId)
      .eq("entity_type", entity.entityType)
      .eq("entity_id", entity.entityId);
    const { data, error } = await query.maybeSingle();
    if (error) return false;
    if (!data || (data as any).visibility_override == null) return true;

    const override = String((data as any).visibility_override) as MediaVisibilityOverride;
    if (override === "trip_crew" || override === "shared_moment") {
      if (!context) return false;
      if (context.contextType === "trip") {
        const { data: member, error: memberError } = await sc
          .from("trip_members")
          .select("user_id")
          .eq("trip_id", context.contextId)
          .eq("user_id", viewerId)
          .in("role", ["owner", "co_host", "member", "viewer"])
          .maybeSingle();
        return !memberError && Boolean(member);
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

/**
 * Remove contextual media objects from an already-shaped projection. World
 * projections intentionally expose contributor ids and opaque post ids, so
 * this boundary can enforce directional circle overrides without adding
 * coordinates or trusting client-supplied ownership.
 */
export async function filterMediaProjectionVisibility(
  sc: SupabaseClient,
  viewerId: string,
  payload: unknown,
): Promise<unknown> {
  const media = new Map<string, { ownerId: string; tripId: string | null }>();
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
      item.contributor &&
      typeof item.contributor === "object" &&
      typeof (item.contributor as Record<string, unknown>).id === "string"
    ) {
      media.set(item.id, {
        ownerId: (item.contributor as Record<string, string>).id,
        tripId: typeof item.tripId === "string" ? item.tripId : null,
      });
    }
    for (const child of Object.values(item)) walk(child);
  };
  walk(payload);
  if (media.size === 0) return payload;

  let rows: any[] = [];
  try {
    const { data, error } = await sc
      .from("posts")
      .select("id, author_id, trip_id")
      .in("id", [...media.keys()]);
    if (error || !Array.isArray(data)) return null;
    rows = data;
  } catch {
    return null;
  }
  const denied = new Set<string>();
  for (const row of rows) {
    const ownerId = typeof row.author_id === "string" ? row.author_id : media.get(row.id)?.ownerId;
    const tripId = typeof row.trip_id === "string" ? row.trip_id : media.get(row.id)?.tripId;
    if (!ownerId || !tripId || ownerId === viewerId) continue;
    if (!(await authorizeMediaContext(sc, viewerId, ownerId, {
      contextType: "trip",
      contextId: tripId,
    }))) denied.add(String(row.id));
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