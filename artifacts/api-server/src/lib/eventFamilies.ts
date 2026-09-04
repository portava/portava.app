/**
 * Canonical-event families — Phase 0 roadmap item 10.
 *
 * The nine canonical verbs (canonicalEvents.ts) roll up into four families that
 * describe where an interaction sits in the funnel. This module is the ONE place
 * the verb -> family categorization lives; the SQL read model
 * `canonical_event_families` (migration 2123) mirrors this map exactly, and
 * eventFamilies.test.ts pins it. To re-file a verb, change it in BOTH places.
 *
 * The categorization (the one product judgement here, deliberately explicit and
 * one line to change):
 *   exposure     — the system surfaced something          (impression)
 *   action       — the traveler engaged with it           (open, save, join, direction)
 *   outcome      — a result followed                       (arrival, completion, rejection)
 *   satisfaction — an explicit satisfaction signal         (satisfaction)
 *   domain       — an intel pipeline transition, not a    (intel.observation.recorded,
 *                  traveler interaction (spec §21, 2277)    intel.claim.promoted,
 *                                                           intel.state.changed)
 */
import { type CanonicalEventVerb } from "./canonicalEvents.js";

export const EVENT_FAMILIES = ["exposure", "action", "outcome", "satisfaction", "domain"] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

/**
 * verb -> family. Typed as a total Record over the nine verbs, so the compiler
 * refuses to build if a new verb is added without a family here.
 */
export const VERB_FAMILY: Record<CanonicalEventVerb, EventFamily> = {
  impression: "exposure",
  open: "action",
  save: "action",
  join: "action",
  direction: "action",
  arrival: "outcome",
  completion: "outcome",
  rejection: "outcome",
  satisfaction: "satisfaction",
  "intel.observation.recorded": "domain",
  "intel.claim.promoted": "domain",
  "intel.state.changed": "domain",
};

/** The family for a verb, or null for a non-canonical verb (fail-closed). */
export function familyForVerb(verb: string): EventFamily | null {
  return (VERB_FAMILY as Record<string, EventFamily>)[verb] ?? null;
}
