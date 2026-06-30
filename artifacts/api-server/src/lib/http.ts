import type { Request, Response } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServiceClient, isServiceClientReady, _setTestServiceClient } from "./supabase";

// ---------------------------------------------------------------------------
// Test-only client injection — lets unit tests pass a fake Supabase client
// without module-level mocking. Never set in production (env has no test vars).
// ---------------------------------------------------------------------------
let _testClient: any = null;
let _testReady: boolean | null = null;

/** Call from test helpers before each test to inject a fake client.
 *  Also overrides the service client so routes that call getServiceClient()
 *  directly (e.g. for DOB lookups) hit the same fake instead of the real DB. */
export function _setTestClient(client: any, ready: boolean): void {
  _testClient = client;
  _testReady = ready;
  _setTestServiceClient(client);
}
/** Reset after tests if needed (makeApp re-injects, so usually unnecessary). */
export function _clearTestClient(): void {
  _testClient = null;
  _testReady = null;
}

/**
 * Standard error envelope used by all routes. The `error` field is a stable
 * machine-readable code; `message` is human-facing detail.
 *
 * Codes (per product spec):
 *   unauthenticated | forbidden | not_member | invalid_payload | db_error |
 *   not_found | server_not_configured
 */
export type ApiErrorCode =
  | "server_not_configured"
  | "unauthenticated"
  | "forbidden"
  | "not_member"
  | "invalid_payload"
  | "not_found"
  | "db_error"
  | "feature_disabled"
  | "rate_limited"
  | "comments_disabled"
  | "comments_limited"
  | "sharing_disabled"
  | "blocked_user";

const STATUS: Record<ApiErrorCode, number> = {
  server_not_configured: 503,
  unauthenticated: 401,
  forbidden: 403,
  not_member: 403,
  invalid_payload: 400,
  not_found: 404,
  db_error: 500,
  feature_disabled: 404,
  rate_limited: 429,
  comments_disabled: 403,
  comments_limited: 403,
  sharing_disabled: 403,
  blocked_user: 403,
};

export function sendError(res: Response, code: ApiErrorCode, message?: string) {
  res.status(STATUS[code]).json({ error: code, message: message ?? code });
}

/**
 * Resolve the authenticated user from the request, using the SERVICE-ROLE
 * client to verify the Bearer token via Supabase Auth (auth.getUser), which
 * verifies ECC P-256 tokens regardless of PostgREST's JWT support.
 *
 * Returns either { client, user } on success, or null after having already
 * written the appropriate error response. Callers should `return` on null.
 *
 * IMPORTANT: the token's user is the ONLY source of identity. Never trust any
 * user_id / author_id supplied in the request body.
 */
export async function requireUser(
  req: Request,
  res: Response,
): Promise<{ client: SupabaseClient; user: User } | null> {
  const ready = _testReady !== null ? _testReady : isServiceClientReady;
  if (!ready) {
    sendError(res, "server_not_configured", "SUPABASE_SERVICE_ROLE_KEY is missing");
    return null;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    sendError(res, "unauthenticated", "Missing or malformed Authorization header");
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    sendError(res, "unauthenticated", "Empty bearer token");
    return null;
  }

  const client = (_testClient ?? getServiceClient()!) as SupabaseClient;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    sendError(res, "unauthenticated", error?.message ?? "Invalid or expired token");
    return null;
  }

  return { client, user: data.user as User };
}

/**
 * Unified membership lookup for trip routes.
 *
 * Returns the membership row `{ role }` when the user is a trip member, or
 * `null` when they are not (or when a DB error occurs).
 *
 * Options:
 *   status: "accepted" (default) — only owner/member rows qualify.
 *   status: "any"                — any role including "invited" qualifies.
 *
 * Callers that only need a boolean can call `isAcceptedTripMember`, which
 * delegates here and is kept for back-compat.
 */
export async function requireTripMember(
  client: SupabaseClient,
  tripId: string,
  userId: string,
  options: { status?: "accepted" | "any" } = {},
): Promise<{ role: string } | null> {
  const { status = "accepted" } = options;

  let query = client
    .from("trip_members")
    .select("role")
    .eq("trip_id", tripId)
    .eq("user_id", userId);

  if (status === "accepted") {
    query = (query as any).in("role", ["owner", "member"]);
  }

  const { data, error } = await (query as any).maybeSingle();
  if (error || !data) return null;
  return { role: (data as { role: string }).role };
}

/**
 * Is `userId` an ACCEPTED participant (owner or member, NOT 'invited') of the
 * trip? Delegates to requireTripMember. Kept for back-compat.
 */
export async function isAcceptedTripMember(
  client: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<boolean> {
  return (await requireTripMember(client, tripId, userId)) !== null;
}

/** Does the trip exist? (service-role read) */
export async function tripExists(client: SupabaseClient, tripId: string): Promise<boolean> {
  const { data, error } = await client
    .from("trips")
    .select("id")
    .eq("id", tripId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

// ---------------------------------------------------------------------------
// Plan editing permission
// ---------------------------------------------------------------------------

export type PlanEditPermission = "owner_only" | "all_members" | "specific_members";

/**
 * Checks whether `userId` has trip-level permission to add or edit plan items.
 *
 * Rules:
 *   - Trip owner is always permitted.
 *   - 'all_members': any accepted member is permitted.
 *   - 'owner_only': only the owner is permitted.
 *   - 'specific_members': owner + users listed in plan_editors are permitted.
 *
 * Returns true/false. Does NOT write any HTTP response.
 * Returns null when the trip is not found (caller should treat as 403/404).
 */
export async function canEditPlan(
  client: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<boolean | null> {
  const { data: trip } = await client
    .from("trips")
    .select("owner_id, plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) return null;

  const ownerId  = (trip as any).owner_id as string;
  const perm     = ((trip as any).plan_edit_permission as PlanEditPermission | null) ?? "all_members";

  if (userId === ownerId) return true;

  const membership = await requireTripMember(client, tripId, userId);
  if (!membership) return false;

  if (perm === "all_members") return true;
  if (perm === "owner_only")  return false;

  // specific_members: check plan_editors table
  const { data: editorRow } = await client
    .from("plan_editors")
    .select("user_id")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();

  return Boolean(editorRow);
}

/** Discriminated union returned by canEditPlanItem. */
export type CanEditPlanItemResult =
  | { permitted: true;  role: "owner" | "member"; creatorId: string }
  | { permitted: false; code: ApiErrorCode; message: string };

/**
 * Single authoritative check for edit / remove / reorder operations on a
 * trip plan item.  Consolidates item-fetch + membership-check + ownership
 * rule so every mutating route applies the same logic from one place.
 *
 * Rules (default, ownerOnly = false):
 *   - Item must exist and not be soft-deleted  → not_found
 *   - Caller must be an accepted member         → not_member
 *   - Trip owner may edit any item              → permitted
 *   - Member may only edit their own item       → forbidden if creator_id ≠ userId
 *
 * When ownerOnly = true (reorder):
 *   - Item must exist and not be soft-deleted   → not_found
 *   - Caller must be accepted member            → not_member
 *   - Caller must be trip owner                 → forbidden otherwise
 *
 * No HTTP response is written; callers inspect the result and decide.
 */
export async function canEditPlanItem(
  client: SupabaseClient,
  tripId: string,
  itemId: string,
  userId: string,
  ownerOnly = false,
): Promise<CanEditPlanItemResult> {
  const { data: item } = await client
    .from("trip_plan_items")
    .select("creator_id")
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .maybeSingle();
  if (!item) {
    return { permitted: false, code: "not_found", message: "Plan item not found" };
  }

  const membership = await requireTripMember(client, tripId, userId);
  if (!membership) {
    return { permitted: false, code: "not_member", message: "Not a trip member" };
  }

  const role = membership.role as "owner" | "member";
  const creatorId = (item as { creator_id: string }).creator_id;

  if (ownerOnly) {
    if (role !== "owner") {
      return { permitted: false, code: "forbidden", message: "Only the trip owner can reorder plan items" };
    }
    return { permitted: true, role, creatorId };
  }

  if (role !== "owner" && creatorId !== userId) {
    return { permitted: false, code: "forbidden", message: "You can only edit your own plan items" };
  }

  return { permitted: true, role, creatorId };
}
