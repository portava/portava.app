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
 * Max restrictions lifted in ONE sweep.
 *
 * Bounded for the same reason the user-recalculation loop is bounded: an
 * unbounded statement against a table that only grows is a latent outage, and a
 * partial sweep that SAYS it is partial is worth more than a whole one that
 * times out and lifts nothing. The remainder is not dropped — it rolls to the
 * next pass, and the pass runs every six hours.
 */
export const RESTRICTION_EXPIRY_BATCH = 500;

/**
 * What one sweep did. Three outcomes the caller must be able to tell apart,
 * because the old `Promise<number>` collapsed two of them into the number 0.
 */
export interface ExpireRestrictionsResult {
  /** How many restrictions this pass actually lifted. */
  expired: number;
  /**
   * The batch cap was reached, so there may be more still due. Never read a
   * truncated sweep as full coverage.
   */
  truncated: boolean;
  /**
   * A read or a write errored, so this pass CANNOT SAY what is still due.
   * Distinct from `expired: 0`, which means the sweep worked and found nothing.
   */
  failed: boolean;
}

/**
 * Expire restrictions whose expires_at has passed.
 *
 * TWO DEFECTS THIS REPLACES, both of the same family.
 *
 * 1. IT HAD NO CALLER. Repo-wide, the identifier appeared exactly once — its own
 *    definition. Not the maintenance scheduler, not a route, not a startup job,
 *    no pg_cron, no trigger, not even a test. Its own docstring said "call from
 *    cleanup job"; the cleanup job that was later built picked up the two
 *    SIBLING time-based lifts (expireOldCaps, clearExpiredProbation) and missed
 *    this one.
 *
 *    HOW FAR THAT REACHED, stated precisely rather than at its worst: every
 *    read-side consumer (getRestrictionState, interactionPermissions) already
 *    filters on `expires_at`, so an expired restriction was never ENFORCED past
 *    its date. What stayed wrong is the ROW — `lifted_at IS NULL` forever — so
 *    the admin user views (routes/admin.ts, routes/trust-admin.ts) listed a
 *    lapsed sanction as active indefinitely. The row now agrees with the
 *    enforcement. It is called from lib/trustMaintenanceScheduler every pass.
 *
 * 2. IT SWALLOWED ITS OWN FAILURE. The old body destructured `const { data }`
 *    and discarded `error`, then returned `data?.length ?? 0`. supabase-js
 *    RETURNS errors rather than throwing, so a permissions failure, a schema
 *    drift or a timeout all produced the number 0 — identical to a clean sweep
 *    with nothing to do. A broken sweep and an idle one were the same
 *    observation, forever.
 *
 * Now: select-then-update in bounded batches, `error` read on BOTH halves, and a
 * result that separates "nothing to do" from "could not tell".
 *
 * Shape: select the due set (bounded, oldest term first) and then lift exactly
 * those ids. Two statements rather than one because the cap has to be applied
 * to a SELECT — PostgREST has no LIMIT on an UPDATE — and because the count of
 * what was lifted then comes from the write's own `.select("id")` rather than
 * from an assumption.
 *
 * NO STARVATION. The due-set read filters `lifted_at IS NULL`, so every row
 * this pass lifts leaves the due set; and it is ordered by `expires_at`
 * ascending, so the longest-overdue rows are taken first and nothing can be
 * overtaken indefinitely by newer arrivals. Repeated passes therefore drain the
 * backlog: whatever a bounded pass leaves behind is the head of the next one.
 */
export async function expireOldRestrictions(
  db: SupabaseClient,
  limit: number = RESTRICTION_EXPIRY_BATCH,
): Promise<ExpireRestrictionsResult> {
  const nowIso = new Date().toISOString();

  let due: any[];
  try {
    const { data, error } = await db
      .from("trust_restrictions")
      .select("id")
      .is("lifted_at", null)
      .lt("expires_at", nowIso)
      .order("expires_at", { ascending: true })
      .limit(limit);
    if (error) {
      trustRestrictionLogger.warn({ err: error }, "expireOldRestrictions: due-set read failed");
      return { expired: 0, truncated: false, failed: true };
    }
    due = (data as any[]) ?? [];
  } catch (err) {
    trustRestrictionLogger.warn({ err }, "expireOldRestrictions: due-set read threw");
    return { expired: 0, truncated: false, failed: true };
  }

  if (due.length === 0) return { expired: 0, truncated: false, failed: false };

  const ids = due.map((r) => String(r?.id ?? "")).filter(Boolean);
  // `>= limit` rather than `> limit`: a full batch is indistinguishable from a
  // full batch plus more, so a sweep that fills its cap reports truncation even
  // when it happened to drain the table exactly. Over-reporting "there may be
  // more" is the safe direction — the next pass confirms it with expired: 0.
  const truncated = ids.length >= limit;

  try {
    const { data, error } = await db
      .from("trust_restrictions")
      .update({ lifted_at: nowIso })
      .in("id", ids)
      // Re-assert the predicate the read used. A concurrent pass may have
      // lifted some of these between the read and this write, and lifting
      // twice would overwrite the FIRST lifted_at with a later instant —
      // moving the recorded moment a sanction ended. Do not remove this.
      .is("lifted_at", null)
      .select("id");
    if (error) {
      trustRestrictionLogger.warn({ err: error, due: ids.length }, "expireOldRestrictions: lift failed");
      return { expired: 0, truncated: false, failed: true };
    }
    return { expired: ((data as any[]) ?? []).length, truncated, failed: false };
  } catch (err) {
    trustRestrictionLogger.warn({ err, due: ids.length }, "expireOldRestrictions: lift threw");
    return { expired: 0, truncated: false, failed: true };
  }
}
