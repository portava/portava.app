/**
 * The I/O half of §14.1's private-anchor access (census-trips TR256): reading
 * and writing `trip_private_anchor_shares` (migration 3970). The rule itself is
 * domain/trips/policies/privateAnchorAccess.ts and is pure.
 *
 * Every read binds its error. The one error that is NOT a failure is the table
 * being absent (3970 not applied): then no grant can exist, and "zero grants"
 * is the exact answer rather than a guess — see lib/absentTableError.ts for why
 * only 42P01 / PGRST205 qualify. Every other error is `unread`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAbsentTableError } from "../../lib/absentTableError.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { anchorsVisibleTo, type AnchorGrantRead } from "../../domain/trips/policies/privateAnchorAccess.js";
import { ok, unread, type Layer, type MapPoint } from "../../domain/trips/projections/TripMapProjection.js";

export const ANCHOR_SHARING_FLAG = "trip_private_anchor_sharing_enabled";

/** Fail-closed: an unreadable flag is OFF, and OFF means owner-only. */
export async function anchorSharingOn(sc: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(sc, ANCHOR_SHARING_FLAG);
}

/** The anchors on this trip that were granted TO `viewerId`. */
export async function readAnchorGrantsForViewer(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
): Promise<AnchorGrantRead> {
  const { data, error } = await sc
    .from("trip_private_anchor_shares")
    .select("plan_item_id")
    .eq("trip_id", tripId)
    .eq("member_id", viewerId);
  if (error) {
    if (isAbsentTableError(error)) return { status: "ok", grantedToViewer: new Set(), tableAbsent: true };
    return { status: "unread", reason: "private-place shares could not be read" };
  }
  return {
    status: "ok",
    grantedToViewer: new Set(((data ?? []) as Array<{ plan_item_id: string }>).map((r) => String(r.plan_item_id))),
  };
}

export type GranteeRead =
  | { ok: true; memberIds: string[]; tableAbsent: boolean }
  | { ok: false };

/** Who one anchor is shared with. For its owner's eyes only (the route checks). */
export async function readAnchorGrantees(sc: SupabaseClient, planItemId: string): Promise<GranteeRead> {
  const { data, error } = await sc
    .from("trip_private_anchor_shares")
    .select("member_id")
    .eq("plan_item_id", planItemId);
  if (error) {
    if (isAbsentTableError(error)) return { ok: true, memberIds: [], tableAbsent: true };
    return { ok: false };
  }
  return {
    ok: true,
    memberIds: ((data ?? []) as Array<{ member_id: string }>).map((r) => String(r.member_id)).sort(),
    tableAbsent: false,
  };
}

/**
 * §14.1's `privateAnchors` layer, cut to what THIS viewer may see: their own
 * anchors, plus — only while sharing is on — the ones granted to them. Called
 * by the map projection in place of serving every member's anchors to every
 * member. An unreadable grant list is an unreadable layer, not a shorter one.
 */
export async function visiblePrivateAnchorLayer(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  anchors: readonly MapPoint[],
): Promise<Layer<MapPoint>> {
  const sharingOn = await anchorSharingOn(sc);
  const grants: AnchorGrantRead = sharingOn
    ? await readAnchorGrantsForViewer(sc, tripId, viewerId)
    : { status: "ok", grantedToViewer: new Set<string>() };
  const decided = anchorsVisibleTo(
    viewerId,
    anchors.map((a) => ({ ...a, ownerId: typeof a.meta?.ownerId === "string" ? a.meta.ownerId : null })),
    sharingOn,
    grants,
  );
  if (decided.status === "unread") return unread(decided.reason);
  const byId = new Map(anchors.map((a) => [a.id, a] as const));
  return ok(decided.items.map(({ anchor, relation }) => {
    const point = byId.get(anchor.id)!;
    return { ...point, meta: { ...(point.meta ?? {}), relation } };
  }));
}
