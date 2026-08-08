/**
 * requireAdmin — the single admin authorisation guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file there were 30 local `requireAdmin` definitions across 30
 * route files, under four different names (requireAdmin, requireAdminGuard,
 * requireAdminCtx, requireAdminForStamps). Thirty hand-rolled copies of an
 * authorisation check is thirty chances for one to drift weaker, and one weak
 * copy is the whole door.
 *
 * They were audited before consolidation rather than after. The result matters,
 * because it is the opposite of what the count suggests:
 *
 *   - ALL 30 fail closed. Twelve did not destructure `error` from the profile
 *     lookup, which looks alarming, but supabase-js returns `data: null` on
 *     error and every one of the twelve guards on `!data` or `?.role === …`.
 *     So the missing `error` check was untidy, never exploitable.
 *   - Every variant required exactly `role === 'admin'` EXCEPT ONE.
 *   - Only one variant used a different call shape.
 *
 * The two genuine divergences are preserved deliberately below. Consolidating
 * them away would have been a silent security change in one direction or a
 * silent feature break in the other:
 *
 *   1. rentABuddyRollout.ts accepted `admin` OR `owner`. Folding it onto the
 *      common implementation would have revoked `owner` access to a working
 *      feature; folding everything onto ITS implementation would have granted
 *      `owner` admin rights across 29 other route groups. Hence `roles`.
 *   2. hiddenGems.ts used `(sc, userId) => Promise<boolean>` — it does not own
 *      the response and never sends 403; its callers do. Hence `isAdmin`.
 *
 * CONTRACT
 * --------
 * requireAdmin(req, res)      → ctx | null. Sends 403 itself when it returns
 *                               null, so callers just `if (!ctx) return;`.
 * isAdmin(sc, userId)         → boolean. Sends nothing. For call sites that
 *                               already own their response.
 *
 * Both fail closed on a query error, a missing profile, or a non-matching role.
 */

import { requireUser } from "./http";
import { getServiceClient } from "./supabase";

export type AdminRole = "admin" | "owner";

export interface AdminContext {
  /** The authenticated admin's user id. */
  userId: string;
  /** Service-role client where available, else the caller's user client. */
  sc: any;
  /** The caller's own (RLS-scoped) client. */
  client: any;
  /** The matched role — 'admin' unless the route opted into a wider set. */
  role: AdminRole;
  /** display_name ?? username ?? handle ?? null. Only populated when asked for. */
  displayName: string | null;
}

export interface RequireAdminOptions {
  /**
   * Roles accepted by this route. Defaults to ['admin'].
   * Pass ['admin','owner'] to preserve the rentABuddyRollout behaviour.
   */
  roles?: readonly AdminRole[];
  /**
   * Fetch display_name/username/handle as well. Off by default so the common
   * case selects one column. admin.ts needs it for audit-log labelling.
   */
  withDisplayName?: boolean;
}

const DEFAULT_ROLES: readonly AdminRole[] = ["admin"];

/**
 * Authorise an admin request.
 *
 * Returns null AND sends 403 when the caller is not authorised, so the caller
 * pattern is simply:
 *
 *   const ctx = await requireAdmin(req, res);
 *   if (!ctx) return;
 *
 * requireUser() has already sent 401 if there was no valid session, so a null
 * return covers both cases and the caller never needs to distinguish them.
 */
export async function requireAdmin(
  req: any,
  res: any,
  opts: RequireAdminOptions = {},
): Promise<AdminContext | null> {
  const roles = opts.roles ?? DEFAULT_ROLES;

  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const columns = opts.withDisplayName
    ? "role, display_name, username, handle"
    : "role";

  // Read the role through the caller's own client, not the service client:
  // the profile row is the caller's own, so RLS is not an obstacle, and using
  // the user client keeps this testable without real Supabase credentials
  // (in tests the user client IS the injected _testClient).
  const { data, error } = await client
    .from("profiles")
    .select(columns)
    .eq("id", user.id)
    .maybeSingle();

  // Fail closed on all three: query error, absent profile, unmatched role.
  // `error` is checked explicitly even though `!data` already covers it in
  // supabase-js — an explicit check cannot be invalidated by a client-library
  // change, and this is the one place in the codebase where that matters.
  const role = (data as any)?.role;
  if (error || !data || !roles.includes(role)) {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  // Prefer the real service client in production; fall back to the user client
  // so routes stay fully testable without service credentials.
  const sc = getServiceClient() ?? client;

  const displayName: string | null = opts.withDisplayName
    ? ((data as any).display_name ?? (data as any).username ?? (data as any).handle ?? null)
    : null;

  return { userId: user.id, sc, client, role: role as AdminRole, displayName };
}

/**
 * Predicate form — answers "is this user an admin?" without owning the
 * response. For call sites that have already begun composing their own reply
 * and must not have a 403 written underneath them (hiddenGems.ts).
 *
 * Fails closed: any error, missing row, or unmatched role returns false.
 */
export async function isAdmin(
  sc: any,
  userId: string,
  roles: readonly AdminRole[] = DEFAULT_ROLES,
): Promise<boolean> {
  const { data, error } = await sc
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) return false;
  return roles.includes((data as any).role);
}
