/**
 * occurrenceGate — §1 of
 * `docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt`,
 * made answerable on a route.
 *
 * THE RULE, VERBATIM
 * ==================
 * §1: "Planned, saved, or nearby must never be represented as experienced
 * without occurrence evidence or user confirmation."
 *
 * §6 already encodes that rule for the candidate pipeline:
 * `services/memoryProjections/evidence.ts` gives it a reason code,
 * `PLANNED_OR_SAVED_ONLY`, and `evaluateEligibility` refuses a signal set that
 * proves intent and nothing else. That engine is reachable from no route — it
 * reads `memory_evidence`, which no migration in this repository creates — so
 * every surface that mints a durable "you were here" artifact today decides the
 * question for itself, in its own words, or does not decide it at all.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 * ==================================================
 * It is the narrowest useful half of that rule: given an instant a caller
 * DECLARED something happened at, has it happened yet? That is not the whole of
 * §6 — it weighs no source strength, dedupes nothing and scores nothing — and
 * it must not be read as a substitute for `evaluateEligibility`. It is the
 * question a route can actually answer from what it holds in its hand, and the
 * one whose wrong answer was shipping: `POST /api/airport/sessions` validates
 * that the layover's DEPARTURE is in the future and then awarded a Passport
 * stamp with `verification_level: 'checkin'` for the layover's city, at session
 * creation, for an airport the traveller had not reached.
 *
 * IT REUSES §6'S REASON CODE RATHER THAN MINTING A SECOND ONE.
 * `PLANNED_OR_SAVED_ONLY` is imported from `evidence.ts`, not retyped, so the
 * engine's refusal and the route's refusal are the same string and a reader
 * grepping for it finds both halves. The two refusals this file adds —
 * `NO_DECLARED_OCCURRENCE` and `UNPARSEABLE_OCCURRENCE` — are NOT §6 reasons
 * and are named differently on purpose: §6's normalizer rejects an unparseable
 * `observed_at` before eligibility ever runs, so those cases have no eligibility
 * code to borrow.
 *
 * FAIL CLOSED, IN THE ONE DIRECTION THAT MATTERS
 * ==============================================
 * Absent, unparseable and not-yet-arrived all refuse. There is no clock-skew
 * allowance, and that is the opposite of `evidence.ts`'s `FUTURE_SKEW_MS`
 * deliberately: that constant forgives a PRODUCER whose clock runs fast when it
 * reports an observation, which costs nothing, because the observation still
 * describes something that happened. Forgiving skew HERE would admit an
 * occurrence that has not happened, which is precisely the claim §1 forbids. A
 * traveller whose declared arrival is two minutes away is refused, and is
 * refused again in two minutes' time by nothing at all — the caller decides
 * whether to re-ask, and no artifact is minted in the meantime.
 */
import type { EligibilityRejectionReason } from "../memoryProjections/evidence.js";

export const OCCURRENCE_GATE_VERSION = "memory-occurrence-gate@1";

/**
 * `PLANNED_OR_SAVED_ONLY` is §6's; the other two are this file's, because §6
 * rejects them at normalization rather than at eligibility.
 */
export type OccurrenceGateRefusal =
  | Extract<EligibilityRejectionReason, "PLANNED_OR_SAVED_ONLY">
  | "NO_DECLARED_OCCURRENCE"
  | "UNPARSEABLE_OCCURRENCE";

export type OccurrenceGateVerdict =
  | { occurred: true; occurredAt: string; policyVersion: string }
  | { occurred: false; reason: OccurrenceGateRefusal; detail: string; policyVersion: string };

/**
 * Has the instant a caller declared actually arrived?
 *
 * The boundary is `<=`: an instant equal to `nowMs` has occurred. A strict `<`
 * would refuse an artifact minted in the same millisecond as the event it
 * records, which is a real shape (a check-in that stamps itself) and is not the
 * shape this gate exists to refuse.
 *
 * @param declaredInstant an ISO-8601 instant the caller says something happened at
 * @param nowMs           the caller's clock, passed in so this is pure and replayable
 */
export function declaredOccurrenceHasHappened(
  declaredInstant: string | null | undefined,
  nowMs: number,
): OccurrenceGateVerdict {
  const policyVersion = OCCURRENCE_GATE_VERSION;
  if (typeof declaredInstant !== "string" || declaredInstant.trim() === "") {
    return {
      occurred: false,
      reason: "NO_DECLARED_OCCURRENCE",
      detail: "no instant was declared, so there is nothing to place before or after now",
      policyVersion,
    };
  }
  const ms = new Date(declaredInstant).getTime();
  if (!Number.isFinite(ms)) {
    return {
      occurred: false,
      reason: "UNPARSEABLE_OCCURRENCE",
      detail: `declared instant is not a date: ${declaredInstant}`,
      policyVersion,
    };
  }
  if (ms > nowMs) {
    return {
      occurred: false,
      reason: "PLANNED_OR_SAVED_ONLY",
      detail: `declared occurrence ${new Date(ms).toISOString()} is still in the future at ${new Date(nowMs).toISOString()}`,
      policyVersion,
    };
  }
  return { occurred: true, occurredAt: declaredInstant, policyVersion };
}
