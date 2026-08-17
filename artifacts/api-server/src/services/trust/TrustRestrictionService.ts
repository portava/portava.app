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
  await db
    .from("trust_restrictions")
    .update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy })
    .eq("user_id", userId)
    .eq("restriction_type", restrictionType)
    .is("lifted_at", null);
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
    };
  }
}

/** Expire restrictions whose expires_at has passed (call from cleanup job) */
export async function expireOldRestrictions(db: SupabaseClient): Promise<number> {
  try {
    const { data } = await db
      .from("trust_restrictions")
      .update({ lifted_at: new Date().toISOString() })
      .lt("expires_at", new Date().toISOString())
      .is("lifted_at", null)
      .select("id");
    return (data as any[])?.length ?? 0;
  } catch {
    return 0;
  }
}
