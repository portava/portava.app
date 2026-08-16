import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServiceClient, isServiceClientReady, _setTestServiceClient } from "./supabase";
export { _setTestServiceClient } from "./supabase";

/**
 * Constant-time comparison for shared secrets (internal API keys, webhook
 * secrets). A plain `===` leaks how many leading characters match through
 * response timing. Hashing both sides first means timingSafeEqual always
 * compares equal-length buffers, so length differences leak nothing either.
 * Returns false (never throws) when either side is not a string.
 */
export function safeSecretEquals(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

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
  | "blocked_user"
  | "review_not_eligible"
  | "duplicate_review"
  | "duplicate_report"
  | "appeal_already_active"
  | "invalid_state_transition"
  | "collection_create_failed"
  | "duplicate_event"
  | "conflict"
  | "gone"
  | "e2ee_thread"
  | "no_key_package"
  | "upstream_error";

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
  review_not_eligible: 403,
  duplicate_review: 409,
  duplicate_report: 409,
  appeal_already_active: 409,
  invalid_state_transition: 409,
  collection_create_failed: 503,
  duplicate_event: 409,
  conflict: 409,
  gone: 410,
  e2ee_thread: 422,
  no_key_package: 404,
  upstream_error: 502,
};

/**
 * Error codes whose caller-supplied message must never reach the client.
 *
 * `db_error` is the problem case: ~750 call sites pass the raw PostgREST/
 * Postgres `error.message` straight through, which leaks table and column
 * names, constraint names, and occasionally row values to anyone who can
 * trigger a failed query. Every one of those call sites already logs the real
 * error server-side (`req.log.error({ err }, "...")`) immediately before the
 * send, so replacing the response body loses no operator-facing detail.
 *
 * Opt back in per-call with `{ exposeDetail: true }` — reserved for admin-only
 * diagnostic routes where surfacing the underlying failure is the point.
 */
const SANITIZED_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "db_error",
]);

const GENERIC_MESSAGE: Partial<Record<ApiErrorCode, string>> = {
  db_error: "A database error occurred. Please try again.",
};

export function sendError(
  res: Response,
  code: ApiErrorCode,
  message?: string,
  opts?: { exposeDetail?: boolean },
) {
  const sanitize = SANITIZED_CODES.has(code) && !opts?.exposeDetail;
  const body = sanitize
    ? (GENERIC_MESSAGE[code] ?? code)
    : (message ?? code);
  res.status(STATUS[code]).json({ error: code, message: body });
}

/**
 * Like requireUser but returns null (without writing a 401) when the request
 * has no auth header. Use for public endpoints that provide richer responses
 * to authenticated callers (e.g., public trip detail for visibility=public).
 */
export async function optionalUser(
  req: Request,
): Promise<{ client: SupabaseClient; user: User } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const client = (_testClient ?? getServiceClient()) as SupabaseClient | null;
  if (!client) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { client, user: data.user as User };
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

  // Enforce account ban/suspend — reject banned or suspended users immediately.
  // Fail-open: if the profile query errors we still allow the request through
  // so a DB outage doesn't lock out all users.
  const { data: profile } = await client
    .from("profiles")
    .select("account_status")
    .eq("id", data.user.id)
    .maybeSingle();

  const accountStatus: string = (profile as any)?.account_status ?? "active";
  if (accountStatus === "banned") {
    sendError(res, "forbidden", "Your account has been banned");
    return null;
  }
  if (accountStatus === "suspended") {
    sendError(res, "forbidden", "Your account is temporarily suspended");
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

  const { data, error } = await client
    .from("trip_members")
    .select("role, status")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return null;

  if (!data) {
    // The trip owner is never given an explicit trip_members row on trip
    // creation (see POST /trips), so a missing row does NOT mean "not a
    // member" when the caller is the trip's owner_id — check that before
    // concluding no membership exists. Without this, every gate built on
    // requireTripMember (plan add/edit/reorder, etc.) incorrectly blocks
    // the trip owner.
    const { data: trip } = await client
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if (trip && (trip as any).owner_id === userId) return { role: "owner" };
    return null;
  }

  const row = data as { role: string; status?: string | null };

  if (status === "accepted") {
    // Exclude pending "invited" rows by role.
    const acceptedRoles = ["owner", "co_host", "member", "viewer"];
    if (!acceptedRoles.includes(row.role)) return null;
    // Also exclude rows with an explicit non-accepted status.
    // Rows with no status column (null/undefined) are treated as accepted
    // for backwards compatibility with pre-migration data.
    if (row.status != null && row.status !== "accepted") return null;
  }

  return { role: row.role };
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
