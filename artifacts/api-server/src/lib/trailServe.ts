/**
 * Intelligence Gathering — Trail follow-up READ (IG-06, serve side).
 *
 * The production caller of lib/trailFollowup's aggregation (`aggregateNextMoves`)
 * and AT-10 block filter (`visibleTrailRows`). Derives origin → destination-area
 * cohorts from captured experience.next_move observations (the `trail` capture
 * surface, routes/intel.ts) for the INTERNAL dashboard — spec §29 Included:
 * "Internal coverage dashboard for pilot zones".
 *
 * WHAT THIS IS NOT. It is not movement publication. §29 EXCLUDES "Public Crowd
 * Movement output"; publication is gated by `intel_movement_prediction` (seeded
 * OFF, §26 flag table) and lib/trailFollowup.mayPublishMovement (the §13 privacy
 * threshold plus the 0.65 confidence floor), and NO route calls either. This
 * read therefore evaluates neither subject sensitivity nor confidence, returns
 * no actor identity, and is served only behind requireAdmin (routes/intel.ts).
 * `cohortFloorMet` reports the §13 k-anonymity COUNTS alone so an operator can
 * see whether cohorts are forming; it is not, and must not be read as, a
 * publishability verdict.
 *
 * FAIL-CLOSED ORDER — each refusal returns EMPTY, never partial:
 *   1. no client                 → "no_service_client"
 *   2. intel_trail_followup off  → "flag_off"          (nothing is read)
 *   3. blocked set unreadable    → "blocks_unreadable" (AT-10 cannot be honoured, so nothing is shown)
 *   4. observation read fails    → "read_failed"
 * A consent-read failure empties the cohort (parity with lib/crowdFlowProducer)
 * rather than refusing, because it can only shrink the result.
 *
 * Counting follows lib/trailFollowup.aggregateNextMoves exactly: a row without a
 * certified group key is DROPPED (`droppedUngrouped`), never counted as a
 * person. Note that the capture service derives a group key only for the
 * quick_signal surface today, so trail rows arrive ungrouped and the
 * independent-group floor cannot clear — safe, and visible in the numbers.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { fetchBlockedSet } from "./blocks.js";
import { CLAIM_TYPES, PILOT_CLAIMABLE_MODERATION_STATES } from "./intelContracts.js";
import {
  aggregateNextMoves,
  visibleTrailRows,
  MOVEMENT_PRIVACY_V1,
  type NextMoveRow,
  type OriginDestAggregate,
} from "./trailFollowup.js";
import { logger } from "./logger.js";

export type TrailReadRefusal = "no_service_client" | "flag_off" | "blocks_unreadable" | "read_failed";

export interface TrailMovementBucket extends OriginDestAggregate {
  /**
   * The §13 k-anonymity counts alone — unique actors, independent groups and the
   * dominant group's share — evaluated against MOVEMENT_PRIVACY_V1. NOT
   * publishability: subject sensitivity, publication delay and confidence are
   * deliberately not evaluated here (see the module docstring).
   */
  cohortFloorMet: boolean;
}

export interface TrailMovementRead {
  refusal: TrailReadRefusal | null;
  buckets: TrailMovementBucket[];
  /** Rows hidden from THIS viewer by the bidirectional block filter (AT-10). */
  hiddenByBlock: number;
  /** Rows dropped before aggregation: no valid consent, no actor, or no usable destination. */
  droppedIneligible: number;
}

export interface ReadTrailMovementOptions {
  /** Restrict to declarations made AT this origin place (intel_observations.subject_id). */
  originId?: string | null;
  now?: Date | number;
  /** Freshness window; defaults to the experience.next_move TTL (30 min). */
  maxAgeMinutes?: number;
}

/** Anchored to the experience.next_move TTL in the claim registry (2128: 1800 s). */
export const TRAIL_SIGNAL_MAX_AGE_MINUTES =
  (CLAIM_TYPES.find((c) => c.claimType === "experience.next_move")?.ttlSeconds ?? 1800) / 60;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toEpochMs(v: Date | number | undefined): number {
  if (v instanceof Date) return v.getTime();
  if (finite(v)) return v;
  return Date.now();
}

/** True iff the aggregate clears the three §13 cohort-size rules (counts only). */
export function cohortFloorMet(a: OriginDestAggregate): boolean {
  return (
    a.uniqueActors >= MOVEMENT_PRIVACY_V1.minUniqueActors &&
    a.groups >= MOVEMENT_PRIVACY_V1.minGroups &&
    a.maxSingleGroupShare <= MOVEMENT_PRIVACY_V1.maxSingleGroupShare
  );
}

/**
 * Read the fresh, consented, moderation-eligible next_move observations a viewer
 * may see and aggregate them into origin → destination-area cohorts.
 */
export async function readTrailMovement(
  sc: any,
  viewerId: string,
  opts: ReadTrailMovementOptions = {},
): Promise<TrailMovementRead> {
  const empty = (refusal: TrailReadRefusal): TrailMovementRead => ({
    refusal, buckets: [], hiddenByBlock: 0, droppedIneligible: 0,
  });

  if (!sc) return empty("no_service_client");
  // Literal flag arg on purpose — check-flag-polarity resolves each stop statically.
  if (!(await isFlagEnabled(sc, "intel_trail_followup"))) return empty("flag_off");
  // AT-10: without a readable blocked set the filter cannot be honoured, so
  // nothing is shown. fetchBlockedSet returns null on read error and a viewer
  // without an id has no block relation to evaluate.
  if (typeof viewerId !== "string" || viewerId === "") return empty("blocks_unreadable");
  const blocked = await fetchBlockedSet(sc, viewerId);
  if (blocked === null) return empty("blocks_unreadable");

  const nowMs = toEpochMs(opts.now);
  const maxAgeMinutes =
    finite(opts.maxAgeMinutes) && opts.maxAgeMinutes > 0 ? opts.maxAgeMinutes : TRAIL_SIGNAL_MAX_AGE_MINUTES;
  const sinceIso = new Date(nowMs - maxAgeMinutes * 60_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  try {
    let query = sc
      .from("intel_observations")
      .select("actor_id, subject_id, value, group_key, observed_at, expires_at")
      .eq("claim_type", "experience.next_move")
      .in("moderation_state", PILOT_CLAIMABLE_MODERATION_STATES as unknown as string[])
      .gte("observed_at", sinceIso);
    if (typeof opts.originId === "string" && opts.originId !== "") query = query.eq("subject_id", opts.originId);
    const { data, error } = await query;
    if (error || !data) {
      logger.warn({ err: error }, "trailServe: next_move read failed");
      return empty("read_failed");
    }

    const fresh = (data as any[]).filter((o) => !o.expires_at || o.expires_at > nowIso);

    // D4 consent parity with system promotion (2174) and lib/crowdFlowProducer: an
    // actor who withdrew consent must not keep inflating a cohort. Fail-soft to EMPTY.
    const actorIds = [...new Set(fresh.map((o) => o.actor_id).filter((id) => typeof id === "string" && id !== ""))];
    let consented = new Set<string>();
    if (actorIds.length > 0) {
      const { data: consentRows, error: consentErr } = await sc
        .from("intel_contribution_consent")
        .select("user_id")
        .in("user_id", actorIds)
        .eq("enabled", true)
        .is("withdrawn_at", null);
      if (consentErr) {
        logger.warn({ err: consentErr }, "trailServe: consent read failed; cohort empty");
      } else {
        consented = new Set(((consentRows as any[]) ?? []).map((r) => r.user_id as string));
      }
    }

    let droppedIneligible = 0;
    const rows: NextMoveRow[] = [];
    for (const o of fresh) {
      const actorId = typeof o.actor_id === "string" && o.actor_id !== "" ? o.actor_id : null;
      const destinationArea =
        o.value && typeof o.value === "object" && typeof (o.value as any).destinationArea === "string"
          ? ((o.value as any).destinationArea as string)
          : null;
      const originId = typeof o.subject_id === "string" && o.subject_id !== "" ? o.subject_id : null;
      if (!actorId || !consented.has(actorId) || !destinationArea || !originId) { droppedIneligible++; continue; }
      rows.push({
        actorId,
        originId,
        destinationArea,
        groupId: typeof o.group_key === "string" && o.group_key !== "" ? o.group_key : null,
        observedAt: String(o.observed_at),
      });
    }

    const visible = visibleTrailRows(rows, blocked);
    const buckets = aggregateNextMoves(visible).map((a) => ({ ...a, cohortFloorMet: cohortFloorMet(a) }));
    return { refusal: null, buckets, hiddenByBlock: rows.length - visible.length, droppedIneligible };
  } catch (err) {
    logger.warn({ err }, "trailServe: next_move read threw");
    return empty("read_failed");
  }
}
