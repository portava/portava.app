/**
 * Trips §17 on the SAFETY leg — commercial and entertainment recommendations
 * withheld while a SEVERE SAFETY STATE has the traveller's attention.
 *
 * WHY THIS EXISTS SEPARATELY FROM TripAttentionFilter
 * ===================================================
 * `domain/trips/policies/TripAttentionFilter.ts` applies the §17.2 priority
 * switch, and it is the right module for the OPERATIONAL leg: a disrupted trip.
 * It cannot carry the safety leg, for two reasons that are facts about the code
 * and not preferences:
 *
 *   1. The switch it reads lives on the trip HEALTH projection, behind
 *      `trip_operational_projections_enabled` — seeded FALSE, off on every
 *      deployment — and that module's own header states it does NOT suppress
 *      when the gate is closed. So on every deployment today nothing is
 *      withheld, whatever the traveller's safety state.
 *   2. It is keyed on a TRIP. A safe-return session is a property of the
 *      PERSON: it exists with no trip at all, and census-compass CT-11 named
 *      exactly that leg — *"nothing suppresses paid/featured items when
 *      `safeReturnActive`"* — as the unguarded one.
 *
 * This module is the safety leg, and it is UNGATED: no feature flag, no
 * projection, no migration. Its input is `safe_return_sessions.status =
 * 'active'`, the same row `CompassProfileService` already reads into
 * `CompassProfile.safeReturnActive`, which is why the feed path needs no extra
 * query at all.
 *
 * WHAT IT REUSES, DELIBERATELY
 * ============================
 * The question "is this candidate commercial/entertainment or safety/logistics?"
 * is answered by `classifyForAttention` — TripAttentionFilter's exported pure
 * classifier — and NOT by a second vocabulary of its own. Two modules deciding
 * what "commercial" means is the defect census-compass CTG-08 scores against
 * `sharesSocialContext`; there is one classifier and this module calls it.
 *
 * THE TWO ASYMMETRIES, STATED
 * ===========================
 *   • FAIL-CLOSED ON CLASSIFICATION. While suppression is on, a candidate that
 *     names nothing safety- or logistics-shaped is withheld. An unclassifiable
 *     place is far more likely a cocktail bar than a pharmacy.
 *   • FAIL-OPEN ON THE READ. A safety state that could not be read is reported
 *     as `consulted: false` and suppresses nothing. Withholding every
 *     recommendation from everyone because one table was unreadable would make
 *     an outage into a product decision. This is the same posture, said the
 *     same way, as the operational module's "WHAT COULD NOT BE READ IS NOT
 *     SUPPRESSED".
 *
 * WHAT IS *NOT* SUPPRESSED, AND WHY IT IS NOT A LOOPHOLE
 * ======================================================
 * Suppression applies to the candidate types that ARE a "go out and spend
 * this evening" recommendation (`SUPPRESSIBLE_ITEM_TYPES`). A notification, a
 * person, a trip, a post, a stamp is not a commercial recommendation, and
 * emptying a traveller's whole feed the moment they start a safe-return timer
 * would be a different and much worse behaviour than the clause asks for. The
 * feed's own `safety_mode` context affinity already boosts `notification`
 * items; this module leaves that boost standing and removes what competes
 * with it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyForAttention } from "../domain/trips/policies/TripAttentionFilter.js";
import type { CompassItemType } from "./types.js";
import { logger } from "../lib/logger.js";

/** The single reason string this module ever reports. */
export const SAFE_RETURN_SUPPRESSED = "SAFE_RETURN_SUPPRESSED" as const;

/** The human sentence that travels with a suppressed reading. */
export const SAFE_RETURN_DETAIL =
  "a Safe Return session is active — only safety and logistics suggestions are offered until it ends";

/**
 * Compass item types that are a commercial/entertainment recommendation and so
 * are subject to the switch. Everything else passes untouched.
 */
export const SUPPRESSIBLE_ITEM_TYPES: ReadonlySet<CompassItemType> = new Set<CompassItemType>([
  "place",
  "hidden_gem",
  "event",
  "suggestion",
  "buddy",
]);

/** The safety switch as consulted for one viewer, ready for the wire. */
export interface SafetyAttentionReading {
  /** False when the state could not be read; nothing is suppressed then. */
  consulted: boolean;
  suppressed: boolean;
  reason: typeof SAFE_RETURN_SUPPRESSED | null;
  detail: string | null;
  /** Why the switch could not be consulted; null when it was. */
  info: string | null;
}

export function safetyAttentionNotConsulted(info: string): SafetyAttentionReading {
  return { consulted: false, suppressed: false, reason: null, detail: null, info };
}

/**
 * The reading for a viewer whose safe-return state is already known — the feed
 * path, where `CompassProfile.safeReturnActive` was loaded with the profile.
 */
export function safetyAttentionFrom(safeReturnActive: boolean): SafetyAttentionReading {
  return safeReturnActive
    ? { consulted: true, suppressed: true, reason: SAFE_RETURN_SUPPRESSED, detail: SAFE_RETURN_DETAIL, info: null }
    : { consulted: true, suppressed: false, reason: null, detail: null, info: null };
}

/**
 * Read the viewer's severe-safety state directly — the tool path, which has a
 * user id and no Compass profile guaranteed. `error` is BOUND: supabase-js
 * resolves on a database error, so an unbound read would turn an outage into a
 * confident "no safe-return session" and silently re-open the very candidates
 * this module exists to withhold. Never throws.
 */
export async function readSafetyAttention(
  sc: SupabaseClient,
  userId: string,
): Promise<SafetyAttentionReading> {
  try {
    const { data, error } = await sc
      .from("safe_return_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1);
    if (error) {
      logger.warn(
        { err: error, userId },
        "Compass safety attention: safe_return_sessions unreadable — the switch was not consulted; nothing withheld",
      );
      return safetyAttentionNotConsulted("The Safe Return state could not be read; the safety switch was not consulted.");
    }
    return safetyAttentionFrom(((data ?? []) as unknown[]).length > 0);
  } catch (err) {
    logger.warn({ err, userId }, "Compass safety attention: safe-return read threw — switch not consulted");
    return safetyAttentionNotConsulted("The Safe Return state could not be read; the safety switch was not consulted.");
  }
}

export interface SafetyFilterResult<T> {
  kept: T[];
  withheld: number;
  reason: typeof SAFE_RETURN_SUPPRESSED | null;
  detail: string | null;
}

export interface SafetyFilterOptions<T> {
  /**
   * Whether this candidate is the kind of thing the switch governs. Defaults to
   * "every candidate is", which is right for a place/event search; the feed
   * passes `SUPPRESSIBLE_ITEM_TYPES` membership instead.
   */
  suppressible?: (item: T) => boolean;
}

/**
 * Keep the safety/logistics candidates and withhold the commercial ones while
 * the switch suppresses; keep everything otherwise. `termsOf` names the fields
 * that describe a candidate (category, tags, title) — the shared classifier
 * reads whole tokens from all of them.
 */
export function applySafetyAttention<T>(
  items: readonly T[],
  reading: SafetyAttentionReading | null,
  termsOf: (item: T) => ReadonlyArray<string | null | undefined>,
  opts: SafetyFilterOptions<T> = {},
): SafetyFilterResult<T> {
  if (!reading || !reading.consulted || !reading.suppressed) {
    return { kept: [...items], withheld: 0, reason: null, detail: null };
  }
  const governed = opts.suppressible ?? (() => true);
  const kept = items.filter(
    (it) => !governed(it) || classifyForAttention(termsOf(it)) === "safety_logistics",
  );
  const withheld = items.length - kept.length;
  return {
    kept,
    withheld,
    reason: SAFE_RETURN_SUPPRESSED,
    detail:
      withheld > 0
        ? `${withheld} commercial or entertainment candidate${withheld === 1 ? "" : "s"} withheld — ${SAFE_RETURN_DETAIL}`
        : SAFE_RETURN_DETAIL,
  };
}

/** The reading plus the count, as a search tool or the feed reports it. */
export function safetyAttentionOnTheWire(reading: SafetyAttentionReading, withheld: number) {
  return {
    consulted: reading.consulted,
    suppressed: reading.suppressed,
    reason: reading.reason,
    withheld,
    detail: reading.detail,
    info: reading.info,
  };
}
