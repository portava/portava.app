/**
 * Discovery cohort gate — WHO a non-legacy engine mode applies to. Ruling D6.
 *
 * WHY THIS EXISTS, AND WHY IT IS A PRECONDITION RATHER THAN A REFINEMENT
 * =====================================================================
 * D6=A stages shadow to INTERNAL ACCOUNTS FIRST, and only then to a fixed
 * user-id-hashed percentage (D6=B). C — everyone — is the owner's alone.
 *
 * `DISCOVERY_ENGINE_MODE` as built at Stage 1 is one global flag with one
 * global value. Setting it to `shadow` would therefore have shadowed EVERY
 * authenticated cache-A serve, not a cohort. That is not what D6 ruled, and the
 * gap is not cosmetic: each shadowed serve adds a follow-graph read, an
 * interests read and a DRS pass. Off the response path, but real database load
 * proportional to ALL traffic instead of to a chosen sample.
 *
 * Operator ruling, 2026-08-15: shadow must not be enabled for ANY traffic until
 * this gate exists. So it exists before the switch is reachable, rather than
 * after someone discovers the switch was bigger than it looked.
 *
 * WHERE THE CONFIGURATION LIVES — D2=A, unchanged
 * ==============================================
 * The same single `feature_flags` row, in the same `metadata` column that
 * already carries `mode`. No new table, no new column, no second source of
 * truth about who is in an experiment:
 *
 *   { "mode": "shadow", "cohort": { "kind": "users", "userIds": [ ... ] } }
 *   { "mode": "shadow", "cohort": { "kind": "percent", "percent": 5 } }
 *   { "mode": "pde",    "cohort": { "kind": "all" } }
 *
 * FAIL-CLOSED, AND NOTE THAT IT CLOSES THE OTHER WAY FROM THE MODE RESOLVER
 * ========================================================================
 * `resolveDiscoveryEngineMode` falls back to `legacy` — the CURRENT production
 * behaviour — because for a mode, "I could not read the configuration" and
 * "keep doing what you were doing" are the same safe answer.
 *
 * Here the safe answer is the opposite one: a cohort that cannot be read
 * includes NOBODY. An unreadable cohort under `mode: shadow` must not mean
 * "shadow everyone"; that is precisely the failure this gate was created to
 * prevent, and it would arrive silently, as extra load rather than as an error.
 *
 * So: absent cohort, malformed cohort, unknown kind, out-of-range percent, and
 * a request with no authenticated user all resolve to NOT INCLUDED. The
 * configuration must say who, affirmatively, or the answer is nobody.
 *
 * `kind: "all"` IS D6=C AND IS THE OWNER'S DECISION
 * ================================================
 * It exists so that "everyone" has to be TYPED, as a distinct value, rather
 * than being what you get by leaving the cohort out. Reaching every user should
 * be the most explicit thing in the file, not the default.
 *
 * WHY THE PERCENT BUCKET IS HASHED AND NOT SAMPLED
 * ===============================================
 * D6=B says a FIXED user-id-hashed percentage. Not random sampling per request:
 * a user must be in or out and stay there. Sampling per request would mean one
 * user's serves land on both sides of the comparison, so a divergence could
 * never be attributed to the engine rather than to which side that request
 * happened to fall on — and the population would drift every deploy.
 *
 * SHA-256 of a salted user id, first 4 bytes, mod 100. Stable across processes,
 * deploys and restarts, because it is a pure function of the id.
 */
import { createHash } from "node:crypto";

/**
 * Salt for the bucket hash.
 *
 * Fixed and named rather than derived, so the assignment is reproducible by
 * anyone reading this file. Changing it RESHUFFLES EVERY USER between buckets,
 * which invalidates any comparison spanning the change — treat it as a
 * versioned constant, not a tunable.
 *
 * Deliberately shared between shadow and pde. Under D6 these are stages of one
 * escalation, so the users a divergence was measured on are the users it is
 * then served to. A per-mode salt would silently swap the population at the
 * exact moment the measurement started to matter.
 */
const BUCKET_SALT = "discovery-engine-mode/v1";

export type DiscoveryCohort =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "users"; userIds: ReadonlySet<string> }
  | { kind: "percent"; percent: number };

export const COHORT_NONE: DiscoveryCohort = { kind: "none" };

/** Why the cohort parsed the way it did. Absence and rejection stay distinct. */
export type CohortParseReason =
  | "absent"          // no cohort key at all
  | "not_an_object"   // present but not an object
  | "kind_missing"
  | "kind_unknown"
  | "users_invalid"   // kind=users with no usable userIds array
  | "percent_invalid" // kind=percent with a non-finite or out-of-range percent
  | "parsed";

export interface ParsedCohort {
  cohort: DiscoveryCohort;
  reason: CohortParseReason;
}

const NOBODY = (reason: CohortParseReason): ParsedCohort => ({ cohort: COHORT_NONE, reason });

/**
 * Parse `metadata.cohort`. Never throws; anything unrecognised yields nobody.
 *
 * Note what is NOT accepted: a bare string, a number, `true`. Every one of
 * those is a plausible thing for a person to type into a jsonb field by hand,
 * and every one of them is ambiguous. An ambiguous cohort is not narrowed to a
 * guess here — it is rejected, and rejection means nobody.
 */
export function parseDiscoveryCohort(raw: unknown): ParsedCohort {
  if (raw === undefined || raw === null) return NOBODY("absent");
  if (typeof raw !== "object" || Array.isArray(raw)) return NOBODY("not_an_object");

  const kind = (raw as Record<string, unknown>).kind;
  if (typeof kind !== "string") return NOBODY("kind_missing");

  switch (kind) {
    case "none":
      return { cohort: { kind: "none" }, reason: "parsed" };

    case "all":
      return { cohort: { kind: "all" }, reason: "parsed" };

    case "users": {
      const ids = (raw as Record<string, unknown>).userIds;
      if (!Array.isArray(ids)) return NOBODY("users_invalid");
      const clean = ids.filter((v): v is string => typeof v === "string" && v.length > 0);
      // An empty list is NOT an error — "internal accounts, and there are none
      // configured yet" is a coherent state. It includes nobody, which is what
      // an empty list should mean and is already the safe direction.
      return { cohort: { kind: "users", userIds: new Set(clean) }, reason: "parsed" };
    }

    case "percent": {
      const pct = (raw as Record<string, unknown>).percent;
      if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        return NOBODY("percent_invalid");
      }
      return { cohort: { kind: "percent", percent: pct }, reason: "parsed" };
    }

    default:
      return NOBODY("kind_unknown");
  }
}

/**
 * Stable bucket 0–99 for a user id.
 *
 * Pure and deployment-independent: the same id yields the same bucket in every
 * process, forever, which is the whole point of "fixed" in D6=B.
 */
export function userBucket(userId: string): number {
  const digest = createHash("sha256").update(`${BUCKET_SALT}:${userId}`).digest();
  // First 4 bytes as an unsigned int. readUInt32BE rather than arithmetic on a
  // hex substring: no float precision to reason about.
  return digest.readUInt32BE(0) % 100;
}

export type CohortDecisionReason =
  | "no_user"           // unauthenticated — there is no one to include
  | "kind_none"
  | "kind_all"
  | "user_listed"
  | "user_not_listed"
  | "percent_in"
  | "percent_out";

export interface CohortDecision {
  included: boolean;
  reason: CohortDecisionReason;
  /** Present only for kind=percent, so a decision can be re-derived by hand. */
  bucket?: number;
}

/**
 * Is this user in the cohort?
 *
 * `userId` is nullable on purpose rather than by accident: discovery serves
 * anonymous traffic, `rank_events.user_id` is NOT NULL, and there is no follow
 * graph or interest set to rank an anonymous viewer with. An anonymous request
 * is not "outside the sample" — there is no one to include.
 */
export function isInDiscoveryCohort(
  cohort: DiscoveryCohort,
  userId: string | null | undefined,
): CohortDecision {
  if (!userId) return { included: false, reason: "no_user" };

  switch (cohort.kind) {
    case "none":
      return { included: false, reason: "kind_none" };

    case "all":
      return { included: true, reason: "kind_all" };

    case "users":
      return cohort.userIds.has(userId)
        ? { included: true,  reason: "user_listed" }
        : { included: false, reason: "user_not_listed" };

    case "percent": {
      const bucket = userBucket(userId);
      // Strict `<`, so percent: 0 includes nobody and percent: 100 includes
      // everybody. Buckets run 0–99, and `<=` would make 0 include bucket 0 —
      // a "disabled" setting that quietly shadows one user in a hundred.
      return bucket < cohort.percent
        ? { included: true,  reason: "percent_in",  bucket }
        : { included: false, reason: "percent_out", bucket };
    }
  }
}

/** Human-readable summary for logs and the flag admin surface. */
export function describeCohort(cohort: DiscoveryCohort): string {
  switch (cohort.kind) {
    case "none":    return "nobody";
    case "all":     return "everyone (D6=C — owner's decision)";
    case "users":   return `${cohort.userIds.size} listed user(s) (D6=A)`;
    case "percent": return `${cohort.percent}% by hashed user id (D6=B)`;
  }
}
