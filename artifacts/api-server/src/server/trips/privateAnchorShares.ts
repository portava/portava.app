/**
 * The I/O half of §14.1's private-anchor access (census-trips TR256, §80, §81):
 * reading and writing `trip_private_anchor_shares` (migration 3970) and the one
 * loader every reader of a plan item's location calls, `planItemAccessFor`.
 * The rule itself is domain/trips/policies/privateAnchorAccess.ts and is pure.
 *
 * Every read binds its error. The one error that is NOT a failure is the share
 * table being absent (3970 not applied): then no grant can exist, and "zero
 * grants" is exact — see lib/absentTableError.ts for why only 42P01 / PGRST205
 * qualify. Every other failure is `unread`: the grants are treated as none
 * (every other member's private item is withheld) AND the answer says so.
 *
 * A GRANT HAS EFFECT ONLY WHILE it is still true (census-trips §81.3):
 *   - sharing is ON (`trip_private_anchor_sharing_enabled`, read three-valued —
 *     an unreadable flag is `unread`, never a silent "off");
 *   - the grant's owner is still the item's creator (checked per row by the
 *     pure rule) and still an accepted member of the trip;
 *   - the grantee — the viewer — is still an accepted member of the trip;
 *   - the item is live and private (checked per row by the pure rule).
 * The rows that stop meeting this are also DELETED where the change happens
 * (`clearAnchorGrants*` below), so nothing revives later; the read-time check
 * is what holds in the window before a clearing lands or if one fails.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAbsentTableError } from "../../lib/absentTableError.js";
import {
  anchorsVisibleTo, ownerOnlyAccess, type AnchorGrantRead, type PlanItemAccess,
} from "../../domain/trips/policies/privateAnchorAccess.js";
import { ok, unread, type Layer, type MapPoint } from "../../domain/trips/projections/TripMapProjection.js";

export const ANCHOR_SHARING_FLAG = "trip_private_anchor_sharing_enabled";

const ACCEPTED_ROLES: ReadonlySet<string> = new Set(["owner", "co_host", "member", "viewer"]);

export type SharingFlag = "on" | "off" | "unread";

/** The sharing flag, three-valued. Absent row = off; an error = unread (never off). */
export async function readAnchorSharingFlag(sc: SupabaseClient): Promise<SharingFlag> {
  try {
    const { data, error } = await sc.from("feature_flags").select("enabled").eq("flag", ANCHOR_SHARING_FLAG).maybeSingle();
    if (error) return "unread";
    return (data as { enabled?: unknown } | null)?.enabled === true ? "on" : "off";
  } catch {
    return "unread";
  }
}

/** For GRANTING: only a flag read as ON permits it. */
export async function anchorSharingOn(sc: SupabaseClient): Promise<boolean> {
  return (await readAnchorSharingFlag(sc)) === "on";
}

/** The accepted members of a trip, as requireTripMember counts them (owner fallback included). */
export async function readAcceptedTripMembers(sc: SupabaseClient, tripId: string): Promise<Set<string> | null> {
  const [{ data: members, error: mErr }, { data: trip, error: tErr }] = await Promise.all([
    sc.from("trip_members").select("user_id, status, role").eq("trip_id", tripId),
    sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
  ]);
  if (mErr || tErr) return null;
  const out = new Set<string>();
  const withRow = new Set<string>();
  for (const m of (members ?? []) as Array<{ user_id: string; status?: string | null; role?: string | null }>) {
    withRow.add(String(m.user_id));
    // requireTripMember's rule exactly (lib/http.ts): one of the four accepted roles, status accepted or unset.
    if (ACCEPTED_ROLES.has(String(m.role)) && (m.status == null || m.status === "accepted")) out.add(String(m.user_id));
  }
  const owner = (trip as { owner_id?: unknown } | null)?.owner_id;
  if (typeof owner === "string" && !withRow.has(owner)) out.add(owner);
  return out;
}

/**
 * What `viewerId` may see of other members' private plan items on this trip.
 * The ONE loader every reader of a plan item's location calls (census-trips §81).
 */
export async function planItemAccessFor(sc: SupabaseClient, tripId: string, viewerId: string): Promise<PlanItemAccess> {
  const flag = await readAnchorSharingFlag(sc);
  if (flag === "off") return ownerOnlyAccess(viewerId);
  if (flag === "unread") return ownerOnlyAccess(viewerId, "unread", "the private-place sharing setting could not be read");
  const { data, error } = await sc
    .from("trip_private_anchor_shares")
    .select("plan_item_id, owner_id")
    .eq("trip_id", tripId)
    .eq("member_id", viewerId);
  if (error) {
    if (isAbsentTableError(error)) return ownerOnlyAccess(viewerId);
    return ownerOnlyAccess(viewerId, "unread", "private-place shares could not be read");
  }
  const rows = (data ?? []) as Array<{ plan_item_id: string; owner_id: string }>;
  if (rows.length === 0) return ownerOnlyAccess(viewerId);
  const accepted = await readAcceptedTripMembers(sc, tripId);
  if (!accepted) return ownerOnlyAccess(viewerId, "unread", "trip membership could not be read");
  if (!accepted.has(viewerId)) return ownerOnlyAccess(viewerId);
  const grants = new Map<string, string>();
  for (const r of rows) if (accepted.has(String(r.owner_id))) grants.set(String(r.plan_item_id), String(r.owner_id));
  return { viewerId, status: "ok", grants };
}

/** The anchors on this trip that were granted TO `viewerId` (validity applied). */
export async function readAnchorGrantsForViewer(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
): Promise<AnchorGrantRead> {
  const access = await planItemAccessFor(sc, tripId, viewerId);
  if (access.status === "unread") return { status: "unread", reason: access.reason ?? "private-place shares could not be read" };
  return { status: "ok", grantedToViewer: new Set(access.grants.keys()) };
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
    memberIds: [...new Set(((data ?? []) as Array<{ member_id: string }>).map((r) => String(r.member_id)))].sort(),
    tableAbsent: false,
  };
}

/**
 * §14.1's `privateAnchors` layer, cut to what THIS viewer may see: their own
 * anchors, plus — only while sharing is on and the grant is still valid — the
 * ones granted to them. An unreadable flag, grant list or membership is an
 * unreadable layer, not a shorter one.
 */
export async function visiblePrivateAnchorLayer(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  anchors: readonly MapPoint[],
): Promise<Layer<MapPoint>> {
  const access = await planItemAccessFor(sc, tripId, viewerId);
  const grants: AnchorGrantRead = access.status === "unread"
    ? { status: "unread", reason: access.reason ?? "private places could not be checked" }
    : { status: "ok", grantedToViewer: new Set(access.grants.keys()) };
  const decided = anchorsVisibleTo(
    viewerId,
    anchors.map((a) => ({ ...a, ownerId: typeof a.meta?.ownerId === "string" ? a.meta.ownerId : null })),
    true,
    grants,
  );
  if (decided.status === "unread") return unread(decided.reason);
  const byId = new Map(anchors.map((a) => [a.id, a] as const));
  return ok(decided.items
    .filter(({ anchor, relation }) => relation === "own" || access.grants.get(anchor.id) === anchor.ownerId)
    .map(({ anchor, relation }) => {
      const point = byId.get(anchor.id)!;
      return { ...point, meta: { ...(point.meta ?? {}), relation } };
    }));
}

// ── Clearing grants that stopped being true (census-trips §81.3) ─────────────
//
// Each returns whether the clearing landed. Callers do NOT fail their own
// primary write on a failed clearing (the read-time rule above already denies
// the grant); they log it, because a grant row left behind is exactly what
// would revive if the condition flipped back.

async function clearWhere(sc: SupabaseClient, apply: (q: any) => any): Promise<boolean> {
  const { error } = await apply(sc.from("trip_private_anchor_shares").delete());
  return !error || isAbsentTableError(error);
}

/** A member left or was removed: every grant TO them and every grant BY them on this trip. */
export async function clearAnchorGrantsForMember(sc: SupabaseClient, tripId: string, userId: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    clearWhere(sc, (q) => q.eq("trip_id", tripId).eq("member_id", userId)),
    clearWhere(sc, (q) => q.eq("trip_id", tripId).eq("owner_id", userId)),
  ]);
  return a && b;
}

/** An item stopped being private, or was removed: every grant on it. */
export async function clearAnchorGrantsForItem(sc: SupabaseClient, planItemId: string): Promise<boolean> {
  return clearWhere(sc, (q) => q.eq("plan_item_id", planItemId));
}
