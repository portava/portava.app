/**
 * TrustRestrictionService
 *
 * Applies and removes behavioural restrictions:
 *   hosting              — cannot create new group trips
 *   private_plan_access  — excluded from private plans
 *   messaging            — cannot initiate new conversations
 *   location_plan_join   — cannot join location-based plans
 *
 * getRestrictionState() is the enforcement seam used by other routes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

// Exported — unlike the module-private child loggers in sibling trust services —
// so tests can assert which channel a degraded read reported on.
export const trustRestrictionLogger = rootLogger.child({
  service: "TrustRestrictionService",
});

export type RestrictionType =
  | "hosting"
  | "private_plan_access"
  | "messaging"
  | "location_plan_join";

export interface ApplyRestrictionInput {
  userId: string;
  restrictionType: RestrictionType;
  reason: string;
  sourceEventId?: string;
  expiresAt?: string | null;
}

export interface TrustRestriction {
  id: string;
  userId: string;
  restrictionType: RestrictionType;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface RestrictionState {
  canHost:              boolean;
  canJoinPrivatePlans:  boolean;
  canMessage:           boolean;
  canJoinLocationPlans: boolean;
  activeRestrictions:   RestrictionType[];
  /**
   * True when this state is a guess rather than an authoritative read of
   * trust_restrictions — set in BOTH directions, whether the guess failed open
   * (table not migrated) or failed closed (query error). Without it, "you cannot
   * message" from a real restriction and from an unreachable table are the same
   * object, and a fail-open guess is indistinguishable from a clean record.
   */
  degraded?: boolean;
  /**
   * Which way `degraded` failed. Only set alongside `degraded: true`.
   *
   *   'fail_open'   — trust_restrictions is unreachable (missing table). Every
   *                    can* flag is true; this is not a restriction and must
   *                    never produce a user-facing message — record telemetry
   *                    only.
   *   'fail_closed' — a real query error on a reachable table. canHost/canMessage
   *                    are false as a precaution, but that false does NOT mean
   *                    the user is restricted — it means the check could not be
   *                    performed. Callers must show a "try again" message, never
   *                    a restriction message, for this case.
   *
   * The bare `degraded` boolean alone cannot carry this: a caller checking only
   * `degraded && !canHost` happens to work today because fail-open always sets
   * every can* flag true and fail-closed sets exactly canHost/canMessage false —
   * but that is an incidental property of the current defaults, not a contract.
   * This field makes the distinction explicit and independent of those defaults.
   */
  degradedReason?: DegradedReason;
}

/**
 * Shared with any other trust_restrictions consumer that needs to carry the
 * open-vs-closed distinction — reuse this rather than a second string union.
 * See RestrictionState.degradedReason for what each value means.
 */
export type DegradedReason = "fail_open" | "fail_closed";

/**
 * Thrown by a permission check that could not be completed (fail-closed) and
 * needs to say so through an exception rather than a return value — e.g.
 * resolveInteractionPermissions, whose other safety checks (blocks) are
 * also throw-on-error by design. Carries the SAME degradedReason discriminator
 * RestrictionState uses, so a catcher can tell "the check failed" from
 * "the check ran and denied" without a second, differently-spelled signal.
 */
export class DegradedPermissionCheckError extends Error {
  readonly degradedReason: DegradedReason;
  constructor(message: string, degradedReason: DegradedReason) {
    super(message);
    this.name = "DegradedPermissionCheckError";
    this.degradedReason = degradedReason;
  }
}

/** Apply a restriction */
export async function applyRestriction(
  db: SupabaseClient,
  input: ApplyRestrictionInput,
): Promise<TrustRestriction> {
  const { data, error } = await db
    .from("trust_restrictions")
    .insert({
      user_id:          input.userId,
      restriction_type: input.restrictionType,
      reason:           input.reason,
      source_event_id:  input.sourceEventId ?? null,
      expires_at:       input.expiresAt ?? null,
    })
    .select("id, user_id, restriction_type, reason, expires_at, created_at")
    .single();

  if (error) throw new Error(`applyRestriction DB error: ${error.message}`);
  const d = data as any;
  return {
    id:              d.id,
    userId:          d.user_id,
    restrictionType: d.restriction_type as RestrictionType,
    reason:          d.reason,
    expiresAt:       d.expires_at,
    createdAt:       d.created_at,
  };
}

/** Lift a restriction */
export async function liftRestriction(
  db: SupabaseClient,
  restrictionId: string,
  liftedBy: string,
): Promise<void> {
  const { error } = await db
    .from("trust_restrictions")
    .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })
    .eq("id", restrictionId)
    .is("lifted_at", null);
  if (error) throw new Error(`liftRestriction DB error: ${error.message}`);
}

/** Lift all active restrictions of a specific type for a user */
export async function liftRestrictionsByType(
  db: SupabaseClient,
  userId: string,
  restrictionType: RestrictionType,
  liftedBy: string,
): Promise<void> {
  const { error } = await db
    .from("trust_restrictions")
    .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })
    .eq("user_id", userId)
    .eq("restriction_type", restrictionType)
    .is("lifted_at", null);
  // supabase-js resolves on a database error; unread, a failed lift was a
  // silent no-op that left the restriction enforced.
  if (error) throw new Error(`liftRestrictionsByType DB error: ${error.message}`);
}

/**
 * Same classifier as services/interactionPermissions.ts — it classifies this
 * very table, for the same reason: trust_restrictions may not be migrated yet.
 */
function isTableMissingError(error: any): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST204" ||
    String(error.message ?? "").toLowerCase().includes("does not exist")
  );
}

/**
 * Returns what the user can/cannot do.
 * Used by enforcement seams in other routes — always call this,
 * never query trust_restrictions directly in route code.
 */
export async function getRestrictionState(
  db: SupabaseClient,
  userId: string,
): Promise<RestrictionState> {
  try {
    const now = new Date().toISOString();
    // postgrest-js resolves { data, error } instead of rejecting, so `error`
    // MUST be read: dropping it turns any failed read into "no restrictions".
    const { data, error } = await db
      .from("trust_restrictions")
      .select("restriction_type")
      .eq("user_id", userId)
      .is("lifted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${now}`);

    if (error) {
      if (isTableMissingError(error)) {
        // The feature was never migrated — that is not a restriction, so fail
        // OPEN. Still a guess, so it is flagged and reported.
        trustRestrictionLogger.warn(
          { err: error, userId },
          "trust_restrictions table missing — failing open (degraded)",
        );
        return {
          canHost:              true,
          canJoinPrivatePlans:  true,
          canMessage:           true,
          canJoinLocationPlans: true,
          activeRestrictions:   [],
          degraded:             true,
          degradedReason:       "fail_open",
        };
      }
      throw new Error(
        `getRestrictionState DB error: ${error.message ?? error.code ?? "db_error"}`,
      );
    }

    const activeTypes = new Set(
      ((data as any[]) ?? []).map((r) => r.restriction_type as RestrictionType),
    );

    return {
      canHost:              !activeTypes.has("hosting"),
      canJoinPrivatePlans:  !activeTypes.has("private_plan_access"),
      canMessage:           !activeTypes.has("messaging"),
      canJoinLocationPlans: !activeTypes.has("location_plan_join"),
      activeRestrictions:   [...activeTypes],
    };
  } catch (err) {
    // Fail-safe: for high-risk actions (messaging, hosting) return false on DB error
    // so a transient failure cannot bypass an active restriction.
    // Low-risk actions (private_plan_access, location_plan_join) stay open.
    // Logged at ERROR: a user losing messaging must leave server-side evidence.
    trustRestrictionLogger.error(
      { err, userId },
      "getRestrictionState failed — failing closed on hosting/messaging (degraded)",
    );
    return {
      canHost:              false,
      canJoinPrivatePlans:  true,
      canMessage:           false,
      canJoinLocationPlans: true,
      activeRestrictions:   [],
      degraded:             true,
      degradedReason:       "fail_closed",
    };
  }
}

/**
 * The AUDIT read of `trust_restrictions` — rows and reasons, for a screen a
 * moderator looks at rather than a gate the server evaluates.
 *
 * ── WHY THIS EXISTS RATHER THAN A ROUTE READING THE TABLE ────────────────────
 *
 * `getRestrictionState` is the ENFORCEMENT seam and its docblock is emphatic:
 * "always call this, never query trust_restrictions directly in route code."
 * `routes/admin.ts` did anyway, and the reason it did is real — the enforcement
 * seam answers in booleans, and an admin dossier needs the row: the id, the
 * reason, when it was created, whether it was lifted. There was no honest way to
 * obey the rule with the API the service offered.
 *
 * So the rule is kept and the API is widened, rather than the rule being bent.
 * Route code still never names the table; the service owns every read of it, and
 * the error handling for an audit read now lives beside the error handling for
 * an enforcement read instead of being reinvented per route.
 *
 * ── IT REFUSES RATHER THAN RETURNING AN EMPTY LIST ───────────────────────────
 *
 * `trust_restrictions` is an EXCLUSION table: a row means restricted, emptiness
 * means clear. supabase-js RESOLVES on a database error, so `data ?? []` renders
 * a CLEAN RECORD for a table nobody could read — and a fabricated clean record
 * is the one answer an admin screen must never show, because it invites lifting
 * a sanction that is still in force. `routes/trust-admin.ts` already reached
 * that conclusion for its own dossier and refuses with `degraded_unavailable`;
 * this returns the same three-state shape so the second screen cannot reach a
 * different one.
 */
export type RestrictionAuditRow = {
  id: string;
  restriction_type: string;
  reason: string | null;
  expires_at: string | null;
  lifted_at: string | null;
  created_at: string;
};

export type RestrictionAuditRead =
  | { state: "ok"; rows: RestrictionAuditRow[] }
  | { state: "unavailable"; reason: string };

export async function listRestrictionsForAudit(
  db: SupabaseClient,
  userId: string,
  opts: { activeOnly?: boolean; limit?: number } = {},
): Promise<RestrictionAuditRead> {
  let q = db
    .from("trust_restrictions")
    .select("id, restriction_type, reason, expires_at, lifted_at, created_at")
    .eq("user_id", userId);
  if (opts.activeOnly) q = q.is("lifted_at", null);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);

  if (error) {
    trustRestrictionLogger.error(
      { err: error, userId },
      "listRestrictionsForAudit: trust_restrictions unreadable — reporting unavailable rather than an empty (clean) record",
    );
    return { state: "unavailable", reason: String((error as any).message ?? (error as any).code ?? "db_error") };
  }
  return { state: "ok", rows: ((data as RestrictionAuditRow[]) ?? []) };
}

/**
 * Expire restrictions whose expires_at has passed.
 *
 * Called from lib/trustMaintenanceScheduler on every pass. This function
 * existed with the comment "call from cleanup job" and no caller: every
 * read-side consumer (getRestrictionState, interactionPermissions) already
 * filters on `expires_at`, so an expired restriction was never ENFORCED past
 * its date — but its row stayed `lifted_at IS NULL`, so the admin user view
 * (routes/admin.ts, routes/trust-admin.ts) listed it as active indefinitely.
 * The row now agrees with the enforcement.
 *
 * Reads `error`: postgrest-js resolves `{ data, error }` rather than rejecting,
 * so the previous `const { data }` turned any failed update into a silent 0.
 */
export async function expireOldRestrictions(db: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await db
      .from("trust_restrictions")
      .update({ lifted_at: new Date().toISOString() })
      .lt("expires_at", new Date().toISOString())
      .is("lifted_at", null)
      .select("id");
    if (error) {
      trustRestrictionLogger.warn({ err: error }, "expireOldRestrictions failed (non-fatal)");
      return 0;
    }
    return (data as any[])?.length ?? 0;
  } catch (err) {
    trustRestrictionLogger.warn({ err }, "expireOldRestrictions threw (non-fatal)");
    return 0;
  }
}
