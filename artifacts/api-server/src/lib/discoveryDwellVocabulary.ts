/**
 * discoveryDwellVocabulary — the pure words of `04` §7 dwell quality
 * (census-discovery DV-41, §55), with no I/O, so the read-only reports can use
 * them without importing the writer.
 *
 * `04` §7: "Distinguish: active dwell, passive foreground dwell, idle dwell. Do
 * not infer interest from a phone sitting untouched."
 */

/** `04` §7's three kinds, in the specification's order — exactly 2890's `rank_events_dwell_kind_check`. */
export const DWELL_KINDS = ["active", "passive_foreground", "idle"] as const;
export type DwellKind = (typeof DWELL_KINDS)[number];

/** `event_type` of a dwell (attention) row. Not a funnel token, not a ranking analytic. */
export const DISCOVERY_DWELL_EVENT_TYPE = "place_dwell";

/**
 * `04` §7 "Do not infer interest from a phone sitting untouched". Only `active`
 * — foreground AND recently touched — is the attention input the spec names
 * (`04` §4 lists `active_dwell` alone among attention events; `01` §3 and `03`
 * §5 name "active dwell"). Passive-foreground dwell IS a phone sitting untouched
 * with the screen on; idle dwell is backgrounded or screen off. Neither, nor any
 * unknown value, is interest.
 */
export function dwellCountsAsInterest(kind: unknown): boolean {
  return kind === "active";
}
