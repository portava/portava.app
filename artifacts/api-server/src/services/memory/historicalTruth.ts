/**
 * historicalTruth — §14's fusion invariant, as a boundary the caller cannot
 * forget rather than a sentence the caller is asked to remember.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §1  "Historical truth and current-world truth are separate. A place
 *            remembered as visited in 2026 does not establish that it is open now."
 *       §14 "Historical Memory + current world intelligence + current user
 *            context + Temporal Freedom Engine -> executable current plan", and
 *            the invariant beneath it: "'You visited X in 2026' is a historical
 *            claim. 'X is open tonight' requires fresh world data. Never derive
 *            the latter from the former."
 *       §16 "may not use stale historical facts as current operational truth."
 *
 * CENSUS: H5 ("Historical truth and current-world truth are separate") and H109
 *         ("Historical/current fusion invariant") were both NOT-BUILT with the
 *         same evidence — "No mechanism encodes the boundary; §14's fusion path
 *         does not exist". H128 ("LLM may not use stale history as current
 *         truth") was NOT-BUILT because there was no memory-facing LLM surface
 *         for the rule to bind to. This module is the mechanism; the eight §16
 *         accessors in `compass/MemoryCompassTools.ts` are the surface.
 *
 * WHAT IS AND IS NOT BUILT HERE, SAID BEFORE THE CODE RATHER THAN AFTER
 * =====================================================================
 * BUILT: the separation and the refusal. A historical fact is a distinct shape
 * from a current-world reading, it carries `establishes_current_status: false`
 * on the datum itself, and `fuseHistoricalWithCurrent` returns the two halves
 * SIDE BY SIDE with `merged: false` — there is no code path in this module that
 * produces one merged claim, so there is nothing to review for whether it
 * merged correctly.
 *
 * NOT BUILT, and this module does not pretend otherwise: §14's Temporal Freedom
 * Engine leg, and the eight executable actions (Do Again, Take Me Back, …).
 * `FusedAnswer.executable_plan` does not exist. Census H107 and H108 stay
 * NOT-BUILT and section C says so. A "fusion" that has nothing to compile into
 * a plan is half of §14, and calling it §14 would be the exact overclaim this
 * census exists to catch.
 *
 * THE ONE RULE, MECHANICALLY
 * ==========================
 * A current-world statement may only be built from a source class that is a
 * reading of the world NOW. `historical` and `ai_inference` are refused as
 * sources of a current claim — not logged and allowed, refused — because those
 * are precisely the two ways "X is open tonight" gets derived from "you were
 * there in March": read the old row, or guess.
 */
import { logger as rootLogger } from "../../lib/logger.js";
import { makeConfidence, type Confidence, type SourceClass } from "../../lib/liveIntelligence.js";

const log = rootLogger.child({ mod: "memoryHistoricalTruth" });

export const HISTORICAL_TRUTH_ENGINE_VERSION = "memory-historical-truth@1";

/** §1's two kinds of truth, named so a value cannot be silently either. */
export type TruthClass = "historical" | "current_world";

/**
 * The source classes that are a reading of the world NOW.
 *
 * `historical` is excluded because it IS the past, and `ai_inference` because
 * §16's boundary forbids inventing "attendance ... or historical outcomes" —
 * inferring current status is the same move pointed forward instead of back.
 * `community_reported` is admitted: it is somebody actually looking at the
 * world, and the existing product already labels it as weaker than
 * `verified_live` (see `CONFIDENCE_LABELS`).
 */
export const CURRENT_WORLD_SOURCE_CLASSES: readonly SourceClass[] = Object.freeze([
  "verified_live",
  "community_reported",
]);

/** A claim about the past. Never a claim about now — the field says so. */
export interface HistoricalFact {
  truth_class: "historical";
  /** What the claim is about: a place name, a trip title, a person's label. */
  subject: string;
  /** The claim itself, in the past tense, built from canonical columns only. */
  claim: string;
  /** ISO instant the claim is ABOUT (not when it was read). Null when unknown. */
  as_of: string | null;
  /** Whole days between `as_of` and the reference instant. Null when `as_of` is. */
  age_days: number | null;
  /**
   * §14, carried on the datum. A consumer that serializes this object cannot
   * drop the caveat without dropping a field, and a model that is handed it
   * has the refusal in the same JSON object as the fact.
   */
  establishes_current_status: false;
  confidence: Confidence;
}

/** A reading of the world now — or an honest statement that there is none. */
export type CurrentWorldReading =
  | {
      truth_class: "current_world";
      available: true;
      statement: string;
      confidence: Confidence;
    }
  | {
      truth_class: "current_world";
      available: false;
      reason: string;
      /**
       * There is deliberately NO `confidence` on this branch. A Confidence
       * carries a `sourceClass` and a human `label`, and every one of the four
       * classes would be a lie here: there is no reading, so it is neither
       * verified, reported, historical nor inferred. Giving an absent datum a
       * confidence object is how an absence starts being rendered as a weak
       * presence.
       */
      checked_at: string;
    };

/**
 * The two halves, side by side. There is deliberately no third field holding a
 * combined sentence: `merged` is the literal `false`, so a caller that wants a
 * merged claim has to write it themselves and cannot blame this module.
 */
export interface FusedAnswer {
  historical: HistoricalFact;
  current: CurrentWorldReading;
  merged: false;
  /** True only when a fresh reading exists. Never inferred from `historical`. */
  may_state_current_status: boolean;
  /**
   * NAMED `fusion_note` AND NOT `note` ON PURPOSE. `compass/CompassTools.ts`
   * `sanitizeToolResult` deletes any key matching `PRIVATE_KEY_RE`, which
   * includes the bare key `note` — it exists to stop a private venue note
   * reaching the model. A field called `note` here would therefore be silently
   * removed from every tool result carrying a fused answer, and the §14 caveat
   * would vanish from exactly the payload it exists to accompany. A test
   * asserts the sanitizer leaves this object intact.
   */
  fusion_note: string;
}

export const FUSION_NOTE_NO_CURRENT_DATA =
  "Historical only. This says where the user has been, not what is true there now — no fresh world reading was available, so no current claim may be made.";

export const FUSION_NOTE_BOTH =
  "Two separate claims: one historical, one a fresh reading of the world. Do not present either as evidence for the other.";

function wholeDaysBetween(fromIso: string, toMs: number): number | null {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((toMs - t) / 86_400_000);
}

/**
 * Build a historical fact.
 *
 * `nowMs` is a parameter rather than a `Date.now()` inside, so the shape is
 * deterministic in a test and in §25's replay harness — the same reason
 * `getLiveVenueStatus` takes a single clock read.
 */
export function asHistoricalFact(input: {
  subject: string;
  claim: string;
  asOf: string | null;
  nowMs?: number;
  note?: string;
}): HistoricalFact {
  const nowMs = input.nowMs ?? Date.now();
  return {
    truth_class: "historical",
    subject: input.subject,
    claim: input.claim,
    as_of: input.asOf,
    age_days: input.asOf ? wholeDaysBetween(input.asOf, nowMs) : null,
    establishes_current_status: false,
    confidence: makeConfidence("historical", input.note),
  };
}

/** No fresh reading. The reason is carried, because "unknown" and "closed" differ. */
export function currentWorldUnknown(reason: string, nowIso?: string): CurrentWorldReading {
  return {
    truth_class: "current_world",
    available: false,
    reason,
    checked_at: nowIso ?? new Date().toISOString(),
  };
}

/**
 * A fresh reading of the world.
 *
 * REFUSES rather than trusts. A caller that passes `sourceClass: "historical"`
 * here is doing the exact thing §14 forbids — dressing an old row as a current
 * one — and it gets back an UNAVAILABLE reading, not a warning it can ignore.
 * `ai_inference` is refused for the same reason in the other direction.
 */
export function currentWorldReading(
  statement: string,
  sourceClass: SourceClass,
  note?: string,
): CurrentWorldReading {
  if (!CURRENT_WORLD_SOURCE_CLASSES.includes(sourceClass)) {
    log.warn(
      { sourceClass, statement: statement.slice(0, 120) },
      "historicalTruth: refused a current-world claim built from a non-current source class (§14: never derive 'open tonight' from 'visited in 2026')",
    );
    return currentWorldUnknown(
      `A current-world claim cannot be built from a '${sourceClass}' source. §14: historical facts never establish current status.`,
    );
  }
  return {
    truth_class: "current_world",
    available: true,
    statement,
    confidence: makeConfidence(sourceClass, note),
  };
}

/**
 * §14's fusion, which is a JUXTAPOSITION and says so.
 *
 * The function's whole content is that it does NOT do the thing its name might
 * suggest: it returns both halves, marks `merged: false`, and sets
 * `may_state_current_status` from the CURRENT half alone. A historical fact,
 * however recent, moves that flag not at all.
 */
export function fuseHistoricalWithCurrent(
  historical: HistoricalFact,
  current: CurrentWorldReading,
): FusedAnswer {
  return {
    historical,
    current,
    merged: false,
    may_state_current_status: current.available,
    fusion_note: current.available ? FUSION_NOTE_BOTH : FUSION_NOTE_NO_CURRENT_DATA,
  };
}
