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
  | "reversal_failed"
  | "collection_create_failed"
  | "collection_lookup_failed"
  | "duplicate_event"
  | "conflict"
  | "gone"
  | "e2ee_thread"
  | "no_key_package"
  | "upstream_error"
  | "degraded_unavailable";

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
  reversal_failed: 422,
  collection_create_failed: 503,
  collection_lookup_failed: 503,
  duplicate_event: 409,
  conflict: 409,
  gone: 410,
  e2ee_thread: 422,
  no_key_package: 404,
  upstream_error: 502,
  degraded_unavailable: 503,
};

/**
 * Codes whose response signals the client should offer a retry action rather
 * than treat the request as rejected. `degraded_unavailable` is the case a
 * permission check could not be performed (not that it was performed and
 * failed) — see TrustRestrictionService's `degradedReason`.
 */
const RETRYABLE_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "degraded_unavailable",
  // A default-collection LOOKUP that failed is transient by definition: the row
  // may well exist and the read could not see it. Retrying is the correct
  // recovery and is safe, because the caller now refuses to create on an
  // unreadable lookup (routes/collections.ts) -- which is precisely what used
  // to turn a transient read failure into a permanent duplicate default.
  // collection_create_failed is deliberately NOT here: an insert that failed
  // for a reason other than the race is not known to be retry-safe.
  "collection_lookup_failed",
]);

/**
 * Does this code mean "retry", as opposed to "rejected"? Exported so the global
 * error handler (lib/errorEnvelope.ts) can put the same `retryable: true` on a
 * refusal that was THROWN as `sendError` puts on one that was SENT. One
 * envelope, one flag, one list of which codes carry it.
 */
export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_CODES.has(code as ApiErrorCode);
}

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
  opts?: {
    exposeDetail?: boolean;
    /**
     * Trips spec Appendix B reason code (lib/tripReasonCodes.ts). ADDITIVE: the
     * envelope is unchanged when absent, so every existing call site emits
     * exactly what it emitted before. Set through `sendTripRefusal`, which also
     * refuses to put an internal-only reason on the wire.
     */
    reason?: string;
  },
) {
  const sanitize = SANITIZED_CODES.has(code) && !opts?.exposeDetail;
  const body = sanitize
    ? (GENERIC_MESSAGE[code] ?? code)
    : (message ?? code);
  const retryable = RETRYABLE_CODES.has(code) ? { retryable: true } : {};
  const reason = opts?.reason ? { reason: opts.reason } : {};
  res.status(STATUS[code]).json({ error: code, message: body, ...retryable, ...reason });
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

// ---------------------------------------------------------------------------
// The ban gate's input
// ---------------------------------------------------------------------------

/**
 * The three-state read of `profiles.account_status`: the status was READ, no
 * ban state is RECORDED, or the row could not be read AT ALL.
 *
 * SHAPE. This is deliberately the union PR #467 established for exactly this
 * distinction — `TrustProfileRead` / `getTrustProfileResult` in
 * `services/trust/TrustScoreService.ts`, `ok | absent | unavailable` with the
 * failure carrying its own reason. Inventing a second vocabulary for the same
 * three facts is how two call sites end up disagreeing about which is which.
 */
export type AccountStatusRead =
  | { state: "ok"; status: string }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

export async function readAccountStatus(
  client: SupabaseClient,
  userId: string,
): Promise<AccountStatusRead> {
  try {
    const result: any = await client
      .from("profiles")
      .select("account_status")
      .eq("id", userId)
      .maybeSingle();

    // supabase-js RESOLVES `{ data, error }` on a rejected PostgREST query — it
    // does not throw — so this branch is the only thing standing between a
    // failed read and a fabricated "active".
    if (!result || typeof result !== "object") {
      return { state: "unavailable", reason: "profiles read returned no result" };
    }
    if (result.error) {
      return {
        state: "unavailable",
        reason: String(result.error.message ?? result.error.code ?? "db_error"),
      };
    }
    const status = (result.data as any)?.account_status;
    // No row, or a row whose column is NULL: a SUCCESSFUL read that found no
    // ban state, which is a positive statement rather than a guess. An account
    // is banned by WRITING `account_status`, so a ban always leaves a row
    // behind and can never present as `absent`.
    if (status == null) return { state: "absent" };
    return { state: "ok", status: String(status) };
  } catch (err) {
    // Transport-level rejection only (socket, DNS). PostgREST failures arrive
    // through `error` above, which is why the pre-existing code could never
    // reach a catch written to handle them.
    return { state: "unavailable", reason: String((err as any)?.message ?? err) };
  }
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

  // ── THE BAN GATE ─────────────────────────────────────────────────────────
  // Banning writes `profiles.account_status` AND NOTHING ELSE. There is no
  // session revocation anywhere in this system — no token blocklist, no
  // `auth.users` ban, no refresh-token purge — so this read is the ONLY place a
  // ban is enforced, on every authenticated request, for as long as the ban
  // lasts.
  //
  // WHAT THIS USED TO DO. The read discarded `error` and defaulted to "active",
  // under the comment "Fail-open: if the profile query errors we still allow
  // the request through so a DB outage doesn't lock out all users". supabase-js
  // resolves rather than throws, so `{ data: null, error }` became "active" in
  // silence. That is not graceful degradation. It is an unannounced, unlogged,
  // open-ended revocation of every ban in the system — and the failure shapes
  // most likely to be SUSTAINED rather than transient (a dropped or renamed
  // `account_status` column, an RLS or grant change, a role misconfiguration)
  // are precisely the ones that would have failed open indefinitely while
  // reporting nothing at all.
  //
  // WHY THIS POSTURE, AND NOT SIMPLY "FAIL CLOSED". A hard refusal on every
  // unreadable read is itself a serious failure mode, so the direction was
  // chosen against the alternatives rather than by reflex:
  //
  //  1. IT REFUSES TO MAKE A CLAIM IT CANNOT SUPPORT, IN EITHER DIRECTION. A
  //     403 would assert this user is banned; a 200 would assert they are not.
  //     Neither fact is in evidence. `degraded_unavailable` is this codebase's
  //     own code for "the permission check was NOT PERFORMED" (see
  //     RETRYABLE_CODES above), and it is the only code marked retryable.
  //  2. IT DOES NOT MANUFACTURE THE OUTAGE IT IS ACCUSED OF. `profiles` is this
  //     API's core table: `requireAdmin` already fails CLOSED on this exact
  //     read (lib/requireAdmin.ts), and `lib/privacyFilter.ts` and
  //     `lib/profileVisibility.ts` both gate on it. A database in which
  //     `profiles` cannot be read is ALREADY an outage for authenticated
  //     traffic; what changes here is that the outage becomes loud, retryable
  //     and correctly coded instead of silently serving unchecked requests.
  //  3. IT IS DELIBERATELY NOT A 401. A 401 would make mobile clients discard
  //     the session and log the entire population out — a transient blip turned
  //     into a mass re-authentication event, which is the genuinely
  //     unrecoverable version of this failure. A 503 keeps the session intact
  //     and asks the client to try again.
  //
  // The blast radius is bounded to requests that ALREADY carry a valid bearer
  // token. `optionalUser` — the public and anonymous path — is untouched, so
  // unauthenticated reads keep serving throughout.
  //
  // NO EXCEPTION IS CARVED OUT FOR A MISSING TABLE OR COLUMN, unlike
  // `profileVisibility.ts`, which skips a genuinely absent
  // `user_account_states`. There, absence is a legitimate deploy state. Here it
  // is not: a `profiles` or `account_status` that PostgREST cannot see means
  // ban enforcement has been switched off system-wide, and `10` B-4 records
  // that this schema drifts in BOTH directions. Waiving the one error that
  // signals it is how it would go unnoticed.
  const statusRead = await readAccountStatus(client, data.user.id);
  if (statusRead.state === "unavailable") {
    (req as any).log?.error?.(
      { userId: data.user.id, reason: statusRead.reason },
      "account_status unreadable — refusing to serve an unchecked request",
    );
    sendError(
      res,
      "degraded_unavailable",
      "Could not verify account status. Please try again.",
    );
    return null;
  }

  // `absent` is a successful read that found no ban state, so the account is
  // active. Keeping it distinct from `ok` is what lets this stay safe: folding
  // it into the refusal would lock out every brand-new account, whose auth user
  // exists before its profile row does.
  const accountStatus: string = statusRead.state === "ok" ? statusRead.status : "active";
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

// ---------------------------------------------------------------------------
// Trip authorization inputs
// ---------------------------------------------------------------------------

/** Which trip authorization read failed. */
export type TripAccessInput = "trip_members" | "trips" | "plan_editors" | "trip_plan_items";

/**
 * A trip AUTHORIZATION INPUT could not be read. Deliberately distinct from "the
 * input is empty", because those two used to be the same observation and the
 * difference decides whether an access answer may be given at all.
 *
 * ── WHY AN EXCEPTION AND NOT A WIDER RETURN TYPE ────────────────────────────
 * This is the mechanism PR #458 established with `TrustInputUnavailableError`:
 * when an input cannot be read, refuse instead of answering. It has to be an
 * exception here for the same structural reason it had to be there — there is
 * nowhere else to put the third state. `requireTripMember` returns
 * `{ role } | null`, `isAcceptedTripMember` returns a bare `boolean`, and
 * `tripExists` returns a bare `boolean`; none of them has room for "unknown",
 * and widening their signatures would rewrite ~174 call sites spread across the
 * very route files the eleven open PRs of `11` §"The in-flight campaign" are
 * landing into. An exception changes these helpers and nothing else.
 *
 * `status` and `code` are read by the global error handler
 * (`lib/errorEnvelope.ts`), so an uncaught one becomes exactly the response a
 * route would have sent by hand: 503 `degraded_unavailable`, retryable. Express
 * 5 forwards a rejected async handler to that handler automatically, so no
 * route needs a `try`/`catch` for this to arrive correctly.
 *
 * The rule it enforces, from `11`: A FAILED READ MUST NEVER BE REPORTED AS
 * EMPTY, CLEAN, OR DONE. "You are not a member of this trip" and "this trip
 * does not exist" are confident claims about a person's access; neither may be
 * assembled out of a query that did not answer.
 */
export class TripAccessUnavailableError extends Error {
  /** Which input failed — 'trip_members' | 'trips' | 'plan_editors'. */
  readonly input: TripAccessInput;
  /** Read by the global error handler. */
  readonly status: number = 503;
  /** Read by the global error handler. */
  readonly code: ApiErrorCode = "degraded_unavailable";
  constructor(input: TripAccessInput, detail: string) {
    super(`trip access input ${input} unavailable — refusing to answer: ${detail}`);
    this.name = "TripAccessUnavailableError";
    this.input = input;
  }
}

/** Message text out of a PostgREST error object, for the exception detail. */
function describeReadError(error: any): string {
  return String(error?.message ?? error?.code ?? "db_error");
}

/**
 * Unified membership lookup for trip routes.
 *
 * Returns the membership row `{ role }` when the user is a trip member, or
 * `null` when they are NOT a member. A DB error is neither: it THROWS
 * `TripAccessUnavailableError`, because `null` used to mean both and every
 * caller reads `null` as a confident "not a member" and answers 403.
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

  if (error) throw new TripAccessUnavailableError("trip_members", describeReadError(error));

  if (!data) {
    // The trip owner is never given an explicit trip_members row on trip
    // creation (see POST /trips), so a missing row does NOT mean "not a
    // member" when the caller is the trip's owner_id — check that before
    // concluding no membership exists. Without this, every gate built on
    // requireTripMember (plan add/edit/reorder, etc.) incorrectly blocks
    // the trip owner.
    const { data: trip, error: tripErr } = await client
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    // Unbound before: an unreadable `trips` row denied the trip's own OWNER
    // every plan gate built on this helper, and said "not a member" to do it.
    if (tripErr) throw new TripAccessUnavailableError("trips", describeReadError(tripErr));
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

/**
 * Does the trip exist? (service-role read)
 *
 * `false` means the row is genuinely absent. An unreadable `trips` THROWS
 * rather than returning `false`, because every caller turns `false` into a 404
 * — so a failed read used to tell a user their trip did not exist.
 */
export async function tripExists(client: SupabaseClient, tripId: string): Promise<boolean> {
  const { data, error } = await client
    .from("trips")
    .select("id")
    .eq("id", tripId)
    .maybeSingle();
  if (error) throw new TripAccessUnavailableError("trips", describeReadError(error));
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
 * Returns null when the trip is genuinely NOT FOUND (caller treats as 403/404).
 *
 * Neither read bound `error` before, so an unreadable `trips` row produced
 * `null` — reported to the user as "trip not found" — and an unreadable
 * `plan_editors` produced `false`, reported as "you may not edit this". Both
 * now throw `TripAccessUnavailableError`; absent and unreadable are different
 * facts and only one of them is an answer.
 */
export async function canEditPlan(
  client: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<boolean | null> {
  const { data: trip, error: tripErr } = await client
    .from("trips")
    .select("owner_id, plan_edit_permission")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) throw new TripAccessUnavailableError("trips", describeReadError(tripErr));
  if (!trip) return null;

  const ownerId  = (trip as any).owner_id as string;
  const perm     = ((trip as any).plan_edit_permission as PlanEditPermission | null) ?? "all_members";

  if (userId === ownerId) return true;

  const membership = await requireTripMember(client, tripId, userId);
  if (!membership) return false;

  if (perm === "all_members") return true;
  if (perm === "owner_only")  return false;

  // specific_members: check plan_editors table
  const { data: editorRow, error: editorErr } = await client
    .from("plan_editors")
    .select("user_id")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();

  if (editorErr) throw new TripAccessUnavailableError("plan_editors", describeReadError(editorErr));
  return Boolean(editorRow);
}

/** Discriminated union returned by canEditPlanItem. */
export type CanEditPlanItemResult =
  | { permitted: true;  role: "owner" | "member"; creatorId: string; /** The item's current status, so a flag-off write can hold §3.3's arrows (TR48). */ status: string | null }
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
  // `error` bound for the reason this whole file records: this read decides
  // BOTH whether the item exists AND, through creator_id, whether the caller
  // may edit it. Unbound, a failed read answered "Plan item not found" — the
  // 404 an author would see for someone else's item, said about their own.
  // Refuse instead, the same way requireTripMember does: 503, retryable.
  const { data: item, error: itemErr } = await client
    .from("trip_plan_items")
    .select("creator_id, status")
    .eq("id", itemId)
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .maybeSingle();
  if (itemErr) throw new TripAccessUnavailableError("trip_plan_items", describeReadError(itemErr));
  if (!item) {
    return { permitted: false, code: "not_found", message: "Plan item not found" };
  }

  const membership = await requireTripMember(client, tripId, userId);
  if (!membership) {
    return { permitted: false, code: "not_member", message: "Not a trip member" };
  }

  const role = membership.role as "owner" | "member";
  const creatorId = (item as { creator_id: string }).creator_id;
  const status = (item as { status?: string | null }).status ?? null;

  if (ownerOnly) {
    if (role !== "owner") {
      return { permitted: false, code: "forbidden", message: "Only the trip owner can reorder plan items" };
    }
    return { permitted: true, role, creatorId, status };
  }

  if (role !== "owner" && creatorId !== userId) {
    return { permitted: false, code: "forbidden", message: "You can only edit your own plan items" };
  }

  return { permitted: true, role, creatorId, status };
}
