import type { Request, Response } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServiceClient, isServiceClientReady } from "./supabase";

// ---------------------------------------------------------------------------
// Test-only client injection — lets unit tests pass a fake Supabase client
// without module-level mocking. Never set in production (env has no test vars).
// ---------------------------------------------------------------------------
let _testClient: any = null;
let _testReady: boolean | null = null;

/** Call from test helpers before each test to inject a fake client. */
export function _setTestClient(client: any, ready: boolean): void {
  _testClient = client;
  _testReady = ready;
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
  | "db_error";

const STATUS: Record<ApiErrorCode, number> = {
  server_not_configured: 503,
  unauthenticated: 401,
  forbidden: 403,
  not_member: 403,
  invalid_payload: 400,
  not_found: 404,
  db_error: 500,
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
 * Is `userId` an ACCEPTED participant (owner or member, NOT 'invited') of the
 * trip? Mirrors the DB helper is_accepted_trip_member(). Uses the service-role
 * client so it can read trip_members regardless of RLS.
 */
export async function isAcceptedTripMember(
  client: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("trip_members")
    .select("role")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .in("role", ["owner", "member"])
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
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
